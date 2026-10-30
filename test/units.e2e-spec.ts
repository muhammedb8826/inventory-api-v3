import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';
import { Item, Location } from '../src/database/entities';
import { UnitOfMeasure } from '../src/database/entities/unit-of-measure.entity';
import { UnitGroup } from '../src/database/entities/unit-group.entity';
import { LocationType } from '../src/common/enums';
import { StockService } from '../src/inventory/stock.service';
const PCS = '10000000-0000-4000-8000-000000000001';
const KG = '10000000-0000-4000-8000-000000000002';
describe('Structured units (isolated PostgreSQL)', () => {
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
        email: process.env.SEED_ADMIN_EMAIL ?? 'admin@stock.local',
        password: process.env.SEED_ADMIN_PASSWORD ?? 'Admin@123',
      })
      .expect(201);
    token = auth.body.accessToken;
    locationId = (
      await db
        .getRepository(Location)
        .save(
          db
            .getRepository(Location)
            .create({ name: 'UOM testing', type: LocationType.WAREHOUSE }),
        )
    ).id;
  }, 60000);
  afterAll(async () => {
    await app?.close();
  });
  const post = (body: object) =>
    request(app.getHttpServer())
      .post('/api/v1/inventory')
      .auth(token, { type: 'bearer' })
      .send({
        description: 'UOM ' + randomUUID(),
        locationId,
        quantity: 1,
        purchasePrice: 10,
        ...body,
      });
  it('catalog requires authentication and exposes seeded unit definitions', async () => {
    await request(app.getHttpServer()).get('/api/v1/units').expect(401);
    const res = await request(app.getHttpServer())
      .get('/api/v1/units')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: PCS, code: 'PCS', decimalPlaces: 0 }),
        expect.objectContaining({ id: KG, code: 'KG', decimalPlaces: 3 }),
      ]),
    );
  });
  it('separates standard categories from explicit packaging profiles and flags legacy mixes', async () => {
    const call = (
      method: 'get' | 'post' | 'patch',
      path: string,
      body?: object,
    ) => {
      const r = request(app.getHttpServer())
        [method]('/api/v1' + path)
        .auth(token, { type: 'bearer' });
      return body ? r.send(body) : r;
    };
    const units = (await call('get', '/units').expect(200))
      .body as UnitOfMeasure[];
    const id = (code: string) => units.find((u) => u.code === code)!.id;
    const definition = {
      name: 'Boundary ' + randomUUID(),
      category: 'LENGTH',
      baseUnitId: id('M'),
      conversions: [{ unitId: KG, factor: 2 }],
    };
    await call('post', '/units/groups', {
      ...definition,
      baseUnitId: KG,
    }).expect(400);
    await call('post', '/units/groups', definition).expect(400);
    await call('post', '/units/groups', {
      ...definition,
      kind: 'PACKAGING',
    }).expect(400);
    await call('post', '/units/groups', {
      ...definition,
      conversions: [{ unitId: id('CM'), factor: 0.02 }],
    }).expect(400);
    await call('patch', `/units/${id('M')}`, { category: 'MASS' }).expect(400);
    const legacy = await db.getRepository(UnitGroup).save(
      db.getRepository(UnitGroup).create({
        ...definition,
        conversions: [{ unitId: KG, factor: '2' }],
      }),
    );
    const groups = (await call('get', '/units/groups').expect(200)).body;
    expect(
      groups.find((g: { id: string }) => g.id === legacy.id).requiresReview,
    ).toBe(true);
    await post({ unitGroupId: legacy.id, unitId: id('M') }).expect(400);
    const existing = (await post({ unitId: id('M'), quantity: 10 }).expect(201))
      .body;
    await db.query('UPDATE items SET unit_group_id=$1 WHERE id=$2', [
      legacy.id,
      existing.itemId,
    ]);
    const context = (
      await call('get', `/units/items/${existing.itemId}`).expect(200)
    ).body;
    expect(context.requiresReview).toBe(true);
    expect(
      context.options.map((o: { unit: { id: string } }) => o.unit.id),
    ).toEqual([id('M')]);
    await call('post', '/inquiries', {
      lines: [{ itemId: existing.itemId, unitId: KG, quantity: 1 }],
    }).expect(400);
    const repaired = (
      await call('patch', `/units/groups/${legacy.id}`, {
        ...definition,
        kind: 'PACKAGING',
        conversions: [
          { unitId: id('ROLL'), factor: 50 },
          { unitId: id('CM'), factor: 0.01 },
        ],
      }).expect(200)
    ).body;
    expect(repaired.kind).toBe('PACKAGING');
    const future = (
      await call('post', '/inquiries', {
        lines: [{ itemId: existing.itemId, unitId: id('ROLL'), quantity: 2 }],
      }).expect(201)
    ).body;
    expect(future.lines[0].quantity).toBe('100.000');
    expect(
      (await call('get', `/inventory/${existing.id}`).expect(200)).body
        .quantity,
    ).toBe('10.000');
  });
  it('requires a known unit and rejects fractional pieces and excess precision', async () => {
    await post({}).expect(400);
    await post({ unit: 'arbitrary free text' }).expect(400);
    await post({ unitId: randomUUID() }).expect(400);
    await post({ unitId: PCS, quantity: 1.5 }).expect(400);
    await post({ unitId: KG, quantity: 1.1234 }).expect(400);
  });
  it('persists and returns a structured unit and validates stock operations', async () => {
    const res = await post({ unitId: KG, quantity: 1.125 }).expect(201);
    expect(res.body.item.stockUnit).toMatchObject({ id: KG, decimalPlaces: 3 });
    expect(res.body.quantity).toBe('1.125');
    const count = await post({ unitId: PCS }).expect(201);
    await expect(
      db.query('UPDATE stock_levels SET quantity=1.5 WHERE id=$1', [
        count.body.id,
      ]),
    ).rejects.toMatchObject({
      driverError: { constraint: 'stock_unit_precision' },
    });
    await expect(
      app.get(StockService).reserve(locationId, count.body.itemId, 0.5),
    ).rejects.toThrow('whole number');
    await expect(
      app
        .get(StockService)
        .adjust({ locationId, itemId: count.body.itemId, quantityDelta: 0.5 }),
    ).rejects.toThrow('whole number');
    await request(app.getHttpServer())
      .patch(`/api/v1/inventory/${count.body.id}`)
      .auth(token, { type: 'bearer' })
      .send({ reorderPoint: 0.5 })
      .expect(400);
  });
  it('cannot change the base unit after real movements, even when stock returns to zero', async () => {
    const res = await post({ unitId: PCS, quantity: 1 }).expect(201);
    await app
      .get(StockService)
      .adjust({ locationId, itemId: res.body.itemId, quantityDelta: -1 });
    await request(app.getHttpServer())
      .patch(`/api/v1/inventory/${res.body.id}`)
      .auth(token, { type: 'bearer' })
      .send({ unitId: KG })
      .expect(400);
    const item = await db
      .getRepository(Item)
      .findOneByOrFail({ id: res.body.itemId });
    expect(item.unitId).toBe(PCS);
  });
  it('manages units without mutating a definition already in use', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/units')
      .auth(token, { type: 'bearer' })
      .send({
        code:
          'TEST_' + randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase(),
        name: 'Test length',
        symbol: 'tu',
        category: 'LENGTH',
        decimalPlaces: 2,
      })
      .expect(201);
    await post({ unitId: res.body.id, quantity: 1.25 }).expect(201);
    await request(app.getHttpServer())
      .patch(`/api/v1/units/${res.body.id}`)
      .auth(token, { type: 'bearer' })
      .send({ decimalPlaces: 0 })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/api/v1/units/${res.body.id}`)
      .auth(token, { type: 'bearer' })
      .send({ isActive: false })
      .expect(200);
    await post({ unitId: res.body.id }).expect(400);
  });
  it('preserves and explicitly reviews legacy quantities without converting them', async () => {
    const repo = db.getRepository(UnitOfMeasure);
    const legacy = await repo.save(
      repo.create({
        code: 'LEGACY_TEST_' + randomUUID().slice(0, 8).toUpperCase(),
        name: 'Old pack label',
        symbol: 'pack',
        category: 'OTHER',
        decimalPlaces: 3,
        requiresReview: true,
      }),
    );
    const item = await db.getRepository(Item).save(
      db.getRepository(Item).create({
        description: 'Legacy test',
        unitId: legacy.id,
        unit: 'pack',
      }),
    );
    await app
      .get(StockService)
      .adjust({ locationId, itemId: item.id, quantityDelta: 2.5 });
    await post({ unitId: legacy.id }).expect(400);
    await request(app.getHttpServer())
      .patch(`/api/v1/units/${legacy.id}`)
      .auth(token, { type: 'bearer' })
      .send({ decimalPlaces: 0, confirmLegacyReview: true })
      .expect(400);
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/units/${legacy.id}`)
      .auth(token, { type: 'bearer' })
      .send({ category: 'OTHER', decimalPlaces: 3, confirmLegacyReview: true })
      .expect(200);
    expect(res.body.requiresReview).toBe(false);
    expect(await app.get(StockService).getQuantity(locationId, item.id)).toBe(
      2.5,
    );
  });
  it('rechecks committed stock history after a concurrent unit correction waits on a stock write', async () => {
    const created = await post({ unitId: PCS, quantity: 0 }).expect(201);
    const writer = db.createQueryRunner(),
      corrector = db.createQueryRunner();
    await writer.connect();
    await corrector.connect();
    try {
      const [{ pid }] = await corrector.query('SELECT pg_backend_pid() AS pid');
      await writer.startTransaction();
      await app
        .get(StockService)
        .adjust(
          { locationId, itemId: created.body.itemId, quantityDelta: 1 },
          writer.manager,
        );
      const mutation = corrector
        .query('UPDATE items SET unit_id=$1 WHERE id=$2', [
          KG,
          created.body.itemId,
        ])
        .then(
          () => null,
          (error: unknown) => error,
        );
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [state] = await db.query(
          'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',
          [pid],
        );
        if (state?.wait_event_type === 'Lock') {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await writer.commitTransaction();
      const error = await mutation;
      expect(blocked).toBe(true);
      expect(error).toMatchObject({
        driverError: { constraint: 'item_stock_unit_locked' },
      });
      expect(
        (
          await db
            .getRepository(Item)
            .findOneByOrFail({ id: created.body.itemId })
        ).unitId,
      ).toBe(PCS);
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction();
      await writer.release();
      await corrector.release();
    }
  }, 15000);
  it('corrects unit, cost and reorder point together and rolls back an invalid correction', async () => {
    const created = await post({
      unitId: KG,
      quantity: 0,
      reorderPoint: 0.5,
    }).expect(201);
    await request(app.getHttpServer())
      .patch(`/api/v1/inventory/${created.body.id}`)
      .auth(token, { type: 'bearer' })
      .send({
        unitId: PCS,
        purchasePrice: 99,
        reorderPoint: 0.5,
        description: 'Must roll back',
      })
      .expect(400);
    const unchanged = (
      await request(app.getHttpServer())
        .get(`/api/v1/inventory/${created.body.id}`)
        .auth(token, { type: 'bearer' })
        .expect(200)
    ).body;
    expect(unchanged.item.unitId).toBe(KG);
    expect(unchanged.item.description).toBe(created.body.item.description);
    expect(Number(unchanged.purchasePrice)).toBe(
      Number(created.body.purchasePrice),
    );
    const corrected = (
      await request(app.getHttpServer())
        .patch(`/api/v1/inventory/${created.body.id}`)
        .auth(token, { type: 'bearer' })
        .send({ unitId: PCS, purchasePrice: 99, reorderPoint: 1 })
        .expect(200)
    ).body;
    expect(corrected.item.unitId).toBe(PCS);
    expect(Number(corrected.purchasePrice)).toBe(99);
    expect(Number(corrected.reorderPoint)).toBe(1);
    expect(Number(corrected.quantity)).toBe(0);
  });
});
