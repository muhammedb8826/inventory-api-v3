import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';
import { Item, Location } from '../src/database/entities';
import { UnitOfMeasure } from '../src/database/entities/unit-of-measure.entity';
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
  it('cannot change the base unit after history exists, including opening zero', async () => {
    const res = await post({ unitId: PCS, quantity: 0 }).expect(201);
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
});
