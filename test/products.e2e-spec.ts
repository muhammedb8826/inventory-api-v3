import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';
import { Item, Location, StockLevel } from '../src/database/entities';
import { ItemType, LocationType } from '../src/common/enums';
import { StockService } from '../src/inventory/stock.service';

const PCS = '10000000-0000-4000-8000-000000000001';
const KG = '10000000-0000-4000-8000-000000000002';
describe('Product variants (isolated PostgreSQL)', () => {
  let app: NestExpressApplication,
    db: DataSource,
    token: string,
    locationId: string;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    setupApp(app);
    await app.init();
    db = app.get(DataSource);
    const auth = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: process.env.SEED_ADMIN_EMAIL,
        password: process.env.SEED_ADMIN_PASSWORD,
      })
      .expect(201);
    token = auth.body.accessToken;
    const repo = db.getRepository(Location);
    locationId = (
      await repo.save(
        repo.create({
          name: 'Variant ' + randomUUID(),
          type: LocationType.WAREHOUSE,
        }),
      )
    ).id;
  }, 60000);
  afterAll(async () => {
    await app?.close();
  });
  function call(method: 'get' | 'post' | 'patch', path: string, body?: object) {
    const r = request(app.getHttpServer())
      [method]('/api/v1' + path)
      .auth(token, { type: 'bearer' });
    return body ? r.send(body) : r;
  }
  async function fixture() {
    const attribute = (
      await call('post', '/product-families/attributes', {
        name: 'Finish ' + randomUUID(),
        values: ['Black', 'White', 'Natural'],
      }).expect(201)
    ).body;
    const definition = {
      name: 'Chair ' + randomUUID(),
      itemType: 'FINISHED',
      unitId: PCS,
      attributes: [
        { attributeId: attribute.id, values: ['Black', 'White', 'Natural'] },
      ],
    };
    const family = (
      await call('post', '/product-families', definition).expect(201)
    ).body;
    const values = (value: string) => [{ attributeId: attribute.id, value }];
    return { attribute, definition, family, values };
  }
  it('requires authentication and validates reusable attribute values', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/product-families')
      .expect(401);
    await call('post', '/product-families/attributes', {
      name: 'Duplicate ' + randomUUID(),
      values: ['Black', ' black '],
    }).expect(400);
    const { attribute, definition } = await fixture();
    await call('post', '/product-families', {
      ...definition,
      attributes: [{ attributeId: attribute.id, values: ['Unknown'] }],
    }).expect(400);
    await call('patch', `/product-families/attributes/${attribute.id}`, {
      name: attribute.name,
      values: ['Black'],
    }).expect(400);
  });
  it('creates separate stock records, preserves costs and guards combination identities', async () => {
    const { family, values, definition } = await fixture();
    const sku = 'VAR-' + randomUUID();
    const res = await call('post', `/product-families/${family.id}/variants`, {
      locationId,
      variants: [
        { values: values('Black'), sku },
        { values: values('White'), sku: 'VAR-' + randomUUID() },
      ],
    }).expect(201);
    expect(res.body.variants).toHaveLength(2);
    const black = res.body.variants.find((v: Item) => v.sku === sku),
      white = res.body.variants.find((v: Item) => v.sku !== sku);
    expect(black.stocks[0]).toMatchObject({
      quantity: '0.000',
      purchasePrice: '0.0000000000',
    });
    const inventory = await call(
      'get',
      `/inventory/${black.stocks[0].id}`,
    ).expect(200);
    expect(inventory.body.item.productFamilyId).toBe(family.id);
    expect(inventory.body.createdBy.fullName).toBeTruthy();
    await call('patch', `/inventory/${black.stocks[0].id}`, {
      sku: null,
    }).expect(400);
    await app.get(StockService).adjust({
      locationId,
      itemId: black.id,
      quantityDelta: 5,
      purchasePrice: 40,
    });
    const detail = (
      await call('get', `/product-families/${family.id}`).expect(200)
    ).body;
    expect(
      detail.variants.find((v: Item) => v.id === black.id).stocks[0],
    ).toMatchObject({ quantity: '5.000', purchasePrice: '40.0000000000' });
    expect(
      detail.variants.find((v: Item) => v.id === white.id).stocks[0].quantity,
    ).toBe('0.000');
    expect(
      detail.variants.find((v: Item) => v.id === black.id).createdBy.fullName,
    ).toBeTruthy();
    await call('post', `/product-families/${family.id}/variants`, {
      locationId,
      variants: [{ values: values('Black'), sku: 'OTHER' }],
    }).expect(409);
    await call('post', `/product-families/${family.id}/variants`, {
      locationId,
      variants: [{ values: values('Natural'), sku }],
    }).expect(409);
    await call('patch', `/product-families/${family.id}`, {
      ...definition,
      unitId: KG,
    }).expect(400);
    await call('patch', `/inventory/${black.stocks[0].id}`, {
      unitId: KG,
    }).expect(400);
    await call('patch', `/units/items/${black.id}`, { conversions: [] }).expect(
      400,
    );
    await call('patch', `/product-families/${family.id}/variants/${black.id}`, {
      isActive: false,
    }).expect(400);
    await call('patch', `/product-families/${family.id}/variants/${white.id}`, {
      isActive: false,
    }).expect(200);
    await call('post', `/product-families/${family.id}/variants`, {
      locationId,
      variants: [{ values: values('White'), sku: 'ANOTHER' }],
    }).expect(409);
    const itemRepo = db.getRepository(Item);
    const raw = await itemRepo.save(
      itemRepo.create({
        description: 'Chair material',
        unitId: PCS,
        itemType: ItemType.RAW,
      }),
    );
    await call('post', '/boms', {
      name: 'Black chair',
      finishedItemId: white.id,
      version: '1',
      lines: [{ componentItemId: raw.id, quantity: 1 }],
    }).expect(400);
    await call('patch', `/product-families/${family.id}/variants/${white.id}`, {
      isActive: true,
    }).expect(200);
    const bom = await call('post', '/boms', {
      name: 'Black chair',
      finishedItemId: black.id,
      version: '1',
      lines: [{ componentItemId: raw.id, quantity: 1 }],
    }).expect(201);
    expect(bom.body.finishedItemId).toBe(black.id);
  });
  it('links an existing item without replacing its stock, SKU or history', async () => {
    const { family, values } = await fixture();
    const old = (
      await call('post', '/inventory', {
        description: 'Existing chair',
        sku: 'OLD-' + randomUUID(),
        locationId,
        quantity: 3,
        purchasePrice: 25,
        unitId: PCS,
        itemType: 'FINISHED',
      }).expect(201)
    ).body;
    const before = await db.query(
      'SELECT * FROM stock_movements WHERE item_id=$1 ORDER BY id',
      [old.itemId],
    );
    await call('post', `/product-families/${family.id}/variants`, {
      locationId,
      variants: [{ values: values('Natural'), existingItemId: old.itemId }],
    }).expect(201);
    const saved = await db
      .getRepository(StockLevel)
      .findOneByOrFail({ id: old.id });
    expect(saved.quantity).toBe('3.000');
    expect(saved.purchasePrice).toBe('25.0000000000');
    expect(saved.item.sku).toBe(old.item.sku);
    expect(saved.item.description).toBe('Existing chair');
    expect(saved.item.productFamilyId).toBe(family.id);
    expect(
      await db.query(
        'SELECT * FROM stock_movements WHERE item_id=$1 ORDER BY id',
        [old.itemId],
      ),
    ).toEqual(before);
    const repo = db.getRepository(Item);
    const wrong = await repo.save(
      repo.create({
        description: 'Wrong category',
        sku: 'WRONG-' + randomUUID(),
        unitId: KG,
        itemType: ItemType.FINISHED,
      }),
    );
    await call('post', `/product-families/${family.id}/variants`, {
      locationId,
      variants: [{ values: values('White'), existingItemId: wrong.id }],
    }).expect(400);
  });
  it('rolls back an entire batch when a later combination is invalid', async () => {
    const { family, values } = await fixture();
    await call('post', `/product-families/${family.id}/variants`, {
      locationId,
      variants: [
        { values: values('Black'), sku: 'ATOMIC-' + randomUUID() },
        { values: values('Unknown'), sku: 'ATOMIC-' + randomUUID() },
      ],
    }).expect(400);
    expect(
      await db.getRepository(Item).countBy({ productFamilyId: family.id }),
    ).toBe(0);
  });
  it('serializes simultaneous creation of the same combination', async () => {
    const { family, values } = await fixture();
    const results = await Promise.all(
      [1, 2].map(() =>
        call('post', `/product-families/${family.id}/variants`, {
          locationId,
          variants: [{ values: values('Black'), sku: 'RACE-' + randomUUID() }],
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await db.getRepository(Item).countBy({ productFamilyId: family.id }),
    ).toBe(1);
  });
});
