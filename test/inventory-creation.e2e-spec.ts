import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';
import {
  Item,
  Location,
  StockLevel,
  StockMovement,
  StockLot,
  Bom,
} from '../src/database/entities';
import { ItemType, LocationType } from '../src/common/enums';
import { StockService } from '../src/inventory/stock.service';
import { LowStockService } from '../src/notifications/low-stock.service';

const M = '10000000-0000-4000-8000-000000000004';
const CM = '10000000-0000-4000-8000-000000000005';
describe('Atomic inventory creation and incomplete-item recovery', () => {
  let app: NestExpressApplication,
    db: DataSource,
    locationId: string,
    token: string,
    stock: StockService;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    setupApp(app);
    await app.init();
    db = app.get(DataSource);
    stock = app.get(StockService);
    token = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          email: process.env.SEED_ADMIN_EMAIL,
          password: process.env.SEED_ADMIN_PASSWORD,
        })
        .expect(201)
    ).body.accessToken;
    const locations = db.getRepository(Location);
    locationId = (
      await locations.save(
        locations.create({
          name: 'Atomic inventory ' + randomUUID(),
          type: LocationType.WAREHOUSE,
        }),
      )
    ).id;
  }, 60000);
  afterAll(async () => {
    await app?.close();
  });
  function post(body: object) {
    return request(app.getHttpServer())
      .post('/api/v1/inventory')
      .auth(token, { type: 'bearer' })
      .send({
        description: 'Cloth',
        locationId,
        unitId: M,
        quantity: 80,
        purchasePrice: 100,
        itemType: 'RAW',
        ...body,
      });
  }
  async function incomplete(itemType = ItemType.RAW) {
    const items = db.getRepository(Item);
    return items.save(
      items.create({
        description: 'Cinema Cloth (Cream)',
        sku: 'CC-' + randomUUID(),
        unitId: CM,
        unit: 'cm',
        itemType,
        unitConversions: [],
        imagePath: '/uploads/items/existing.webp',
      }),
    );
  }
  it('completes the same unposted CM item in M without converting any historical quantity', async () => {
    const old = await incomplete();
    const group = (
      await request(app.getHttpServer())
        .post('/api/v1/units/groups')
        .auth(token, { type: 'bearer' })
        .send({
          name: 'Metres ' + randomUUID(),
          category: 'LENGTH',
          baseUnitId: M,
          conversions: [{ unitId: CM, factor: 0.01 }],
        })
        .expect(201)
    ).body;
    const response = await post({
      sku: old.sku,
      description: 'Cinema Cloth - Cream',
      unitGroupId: group.id,
      reorderPoint: 100,
    }).expect(201);
    expect(response.body.itemId).toBe(old.id);
    expect(response.body.item.unitId).toBe(M);
    expect(response.body.item.unitGroupId).toBe(group.id);
    expect(response.body.quantity).toBe('80.000');
    expect(Number(response.body.purchasePrice)).toBe(100);
    expect(response.body.reorderPoint).toBe('100.000');
    const saved = await db.getRepository(Item).findOneByOrFail({ id: old.id });
    expect(saved.createdAt).toEqual(old.createdAt);
    expect(saved.imagePath).toBe(old.imagePath);
    expect(await db.getRepository(Item).countBy({ sku: old.sku })).toBe(1);
  });
  it('rolls back a new item, stock, lots and ledger when a stock write fails', async () => {
    const sku = 'FAILED-' + randomUUID();
    let itemId = '';
    const adjust = stock.adjust.bind(stock);
    const spy = jest
      .spyOn(stock, 'adjust')
      .mockImplementationOnce(async (args, manager) => {
        itemId = args.itemId;
        await adjust(args, manager);
        throw new BadRequestException('Injected stock-write failure');
      });
    try {
      await post({ sku }).expect(400);
    } finally {
      spy.mockRestore();
    }
    expect(await db.getRepository(Item).countBy({ sku })).toBe(0);
    for (const entity of [StockLevel, StockMovement, StockLot])
      expect(await db.getRepository(entity).countBy({ itemId })).toBe(0);
  });
  it('rolls back a partial-item correction when the receipt fails', async () => {
    const old = await incomplete();
    const adjust = stock.adjust.bind(stock);
    const spy = jest
      .spyOn(stock, 'adjust')
      .mockImplementationOnce(async (args, manager) => {
        await adjust(args, manager);
        throw new BadRequestException('Injected receipt failure');
      });
    try {
      await post({ sku: old.sku }).expect(400);
    } finally {
      spy.mockRestore();
    }
    const saved = await db.getRepository(Item).findOneByOrFail({ id: old.id });
    expect(saved.unitId).toBe(CM);
    expect(saved.description).toBe(old.description);
    expect(await db.getRepository(StockLevel).countBy({ itemId: old.id })).toBe(
      0,
    );
    expect(
      await db.getRepository(StockMovement).countBy({ itemId: old.id }),
    ).toBe(0);
  });
  it('does not reinterpret an item that has stock or a BOM, even if it has no visible stock row', async () => {
    const stocked = await incomplete();
    await stock.adjust({
      locationId,
      itemId: stocked.id,
      quantityDelta: 50,
      purchasePrice: 2,
    });
    const blocked = await post({ sku: stocked.sku }).expect(400);
    expect(blocked.body.message).toContain('cm');
    expect(
      (
        await db
          .getRepository(StockLevel)
          .findOneByOrFail({ itemId: stocked.id, locationId })
      ).quantity,
    ).toBe('50.000');
    expect(
      (await db.getRepository(Item).findOneByOrFail({ id: stocked.id })).unitId,
    ).toBe(CM);
    const parent = await incomplete(ItemType.FINISHED);
    const component = await incomplete();
    const boms = db.getRepository(Bom);
    await boms.save(
      boms.create({
        name: 'Existing recipe',
        finishedItemId: parent.id,
        lines: [{ componentItemId: component.id, quantity: '1' }],
      }),
    );
    await post({ sku: parent.sku, itemType: 'FINISHED' }).expect(400);
    expect(
      (await db.getRepository(Item).findOneByOrFail({ id: parent.id })).unitId,
    ).toBe(CM);
  });
  it('serializes simultaneous entries for the same SKU without losing stock', async () => {
    const sku = 'SIMULTANEOUS-' + randomUUID();
    const responses = await Promise.all([
      post({ sku, quantity: 2, purchasePrice: 10 }),
      post({ sku, quantity: 3, purchasePrice: 20 }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    expect(responses[0].body.itemId).toBe(responses[1].body.itemId);
    const row = await db
      .getRepository(StockLevel)
      .findOneByOrFail({ id: responses[0].body.id });
    expect(row.quantity).toBe('5.000');
    expect(Number(row.purchasePrice)).toBe(16);
    expect(await db.getRepository(Item).countBy({ sku })).toBe(1);
    expect(
      await db.getRepository(StockMovement).countBy({ itemId: row.itemId }),
    ).toBe(2);
  }, 20000);
  it('can queue more receipts than database connections without starving the transaction pool', async () => {
    const sku = 'QUEUED-' + randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        post({ sku, quantity: 1, purchasePrice: 10 }),
      ),
    );
    expect(responses.every((r) => r.status === 201)).toBe(true);
    const ids = new Set(responses.map((r) => r.body.itemId));
    expect(ids.size).toBe(1);
    const row = await db
      .getRepository(StockLevel)
      .findOneByOrFail({ id: responses[0].body.id });
    expect(row.quantity).toBe('12.000');
  }, 30000);
  it('rejects a conflicting configuration base before creating an item', async () => {
    const group = (
      await request(app.getHttpServer())
        .post('/api/v1/units/groups')
        .auth(token, { type: 'bearer' })
        .send({
          name: 'Centimetres ' + randomUUID(),
          category: 'LENGTH',
          baseUnitId: CM,
          conversions: [],
        })
        .expect(201)
    ).body;
    const sku = 'MISMATCH-' + randomUUID();
    const result = await post({ sku, unitGroupId: group.id }).expect(400);
    expect(result.body.message).toContain('base stock unit');
    expect(await db.getRepository(Item).countBy({ sku })).toBe(0);
  });
  it('returns successful stock creation even if a secondary notification fails', async () => {
    const notifications = app.get(LowStockService);
    const spy = jest
      .spyOn(notifications, 'evaluateInitialStock')
      .mockRejectedValueOnce(new Error('Notification unavailable'));
    try {
      const result = await post({ sku: 'NOTIFY-' + randomUUID() }).expect(201);
      expect(
        (
          await db
            .getRepository(StockLevel)
            .findOneByOrFail({ id: result.body.id })
        ).quantity,
      ).toBe('80.000');
    } finally {
      spy.mockRestore();
    }
  });
});
