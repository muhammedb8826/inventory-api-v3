import 'reflect-metadata';
import { locationContext } from '../src/common/location-scope';
import { SalesOrdersController } from '../src/sales/sales-orders.controller';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { DataSource, In } from 'typeorm';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';
import {
  Item,
  Location,
  Customer,
  Role,
  Permission,
  User,
  StockLevel,
  StockMovement,
} from '../src/database/entities';
import { ItemType, LocationType } from '../src/common/enums';
import { InventoryService } from '../src/inventory/inventory.service';
import { StockService } from '../src/inventory/stock.service';
import { ProductFamily, Supplier } from '../src/database/entities';
const PCS = '10000000-0000-4000-8000-000000000001',
  CM = '10000000-0000-4000-8000-000000000005';
describe('Catalog access, controlled sales and warehouse handover', () => {
  let app: NestExpressApplication,
    db: DataSource,
    admin: string,
    seller: string,
    warehouse: string,
    manager: string,
    locationId: string,
    customerId: string,
    item: Item;
  const password = 'WorkflowTest123!';
  const call = (
    method: 'get' | 'post' | 'patch',
    path: string,
    body?: unknown,
    token = admin,
  ) =>
    request(app.getHttpServer())
      [method]('/api/v1' + path)
      .auth(token, { type: 'bearer' })
      .send(body);
  async function actor(codes: string[]) {
    const repo = db.getRepository(Role),
      role = await repo.save(
        repo.create({
          name: 'Workflow ' + randomUUID(),
          permissions: await db
            .getRepository(Permission)
            .findBy({ code: In([...codes, 'locations.all']) }),
        }),
      );
    const users = db.getRepository(User),
      u = await users.save(
        users.create({
          email: randomUUID() + '@example.test',
          fullName: role.name,
          passwordHash: await bcrypt.hash(password, 4),
          roleId: role.id,
        }),
      );
    return (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: u.email, password })
        .expect(201)
    ).body.accessToken as string;
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    setupApp(app);
    await app.init();
    db = app.get(DataSource);
    admin = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          email: process.env.SEED_ADMIN_EMAIL,
          password: process.env.SEED_ADMIN_PASSWORD,
        })
        .expect(201)
    ).body.accessToken;
    seller = await actor([
      'sales.read',
      'sales.write',
      'inventory.read',
      'inventory.write',
    ]);
    warehouse = await actor([
      'production.read',
      'production.issue',
      'sales.read',
      'sales.deliver',
      'purchase.read',
      'purchase.receive',
    ]);
    manager = await actor([
      'production.read',
      'production.write',
      'bom.read',
      'bom.write',
      'inventory.read',
    ]);
    const locations = db.getRepository(Location);
    locationId = (
      await locations.save(
        locations.create({
          name: 'Workflow ' + randomUUID(),
          type: LocationType.WAREHOUSE,
        }),
      )
    ).id;
    const customers = db.getRepository(Customer);
    customerId = (
      await customers.save(customers.create({ name: 'Workflow customer' }))
    ).id;
    const items = db.getRepository(Item);
    item = await items.save(
      items.create({
        description: 'Workflow chair',
        sku: 'WORK-' + randomUUID(),
        unitId: PCS,
        unit: 'pcs',
        itemType: ItemType.FINISHED,
        salesPrice: '100.00',
      }),
    );
    await app.get(StockService).adjust({
      itemId: item.id,
      locationId,
      quantityDelta: 100,
      purchasePrice: 40,
    });
  }, 60000);
  afterAll(async () => {
    await app?.close();
  });
  function payload(price = 100) {
    return {
      customerId,
      locationId,
      paymentMethod: 'CREDIT',
      lines: [{ itemId: item.id, quantity: 2, unitPrice: price }],
    };
  }
  async function quote(price = 100) {
    return (
      await call('post', '/sales-orders', payload(price), seller).expect(201)
    ).body;
  }
  it('finds and edits a historical item without creating stock or changing its unit', async () => {
    const repo = db.getRepository(Item),
      orphan = await repo.save(
        repo.create({
          description: 'Hidden cloth',
          sku: 'HIDDEN-' + randomUUID(),
          unitId: CM,
          unit: 'cm',
          itemType: ItemType.RAW,
        }),
      );
    await db.query(
      `INSERT INTO stock_movements(id,location_id,item_id,type,quantity_delta,quantity_before,quantity_after,unit_cost,ref_type) VALUES($1,$2,$3,'ADJUSTMENT',-8000,8000,0,0,'stock_adjustment')`,
      [randomUUID(), locationId, orphan.id],
    );
    const list = await call('get', `/items?search=${orphan.sku}`).expect(200);
    expect(list.body.data[0].id).toBe(orphan.id);
    expect(
      (await call('get', `/items/${orphan.id}`).expect(200)).body
        .stockUnitLocked,
    ).toBe(true);
    await call(
      'patch',
      `/items/${orphan.id}`,
      { description: 'Updated cloth' },
      seller,
    ).expect(200);
    await call('patch', `/items/${orphan.id}`, { unitId: PCS }, seller).expect(
      400,
    );
    expect(
      await db.getRepository(StockLevel).countBy({ itemId: orphan.id }),
    ).toBe(0);
  });
  it('image changes preserve prices updated concurrently by the pricing manager', async () => {
    const repo = db.getRepository(Item),
      i = await repo.save(
        repo.create({
          description: 'Image pricing',
          unitId: PCS,
          unit: 'pcs',
          itemType: ItemType.FINISHED,
          salesPrice: '10',
        }),
      );
    await app
      .get(StockService)
      .adjust({ locationId, itemId: i.id, quantityDelta: 1, purchasePrice: 1 });
    const record = await db
      .getRepository(StockLevel)
      .findOneByOrFail({ locationId, itemId: i.id });
    const inventory = app.get(InventoryService),
      original = inventory.findOne.bind(inventory);
    const spy = jest.spyOn(inventory, 'findOne');
    spy.mockImplementationOnce(async (id, base) => {
      const row = await original(id, base);
      await repo.update(i.id, { salesPrice: '20' });
      return row;
    });
    const buffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    try {
      await inventory.uploadItemImage(record.id, {
        buffer,
        mimetype: 'image/png',
        size: buffer.length,
      });
      expect(
        Number((await repo.findOneByOrFail({ id: i.id })).salesPrice),
      ).toBe(20);
      spy.mockImplementationOnce(async (id, base) => {
        const row = await original(id, base);
        await repo.update(i.id, { salesPrice: '30' });
        return row;
      });
      await inventory.clearItemImage(record.id);
      expect(
        Number((await repo.findOneByOrFail({ id: i.id })).salesPrice),
      ).toBe(30);
    } finally {
      spy.mockRestore();
      await inventory.clearItemImage(record.id);
    }
  });
  it('clears a price when correcting an unused item stock unit', async () => {
    const repo = db.getRepository(Item),
      i = await repo.save(
        repo.create({
          description: 'Unused priced cloth',
          unitId: CM,
          unit: 'cm',
          itemType: ItemType.RAW,
          salesPrice: '1',
        }),
      );
    const corrected = await call(
      'patch',
      `/items/${i.id}`,
      { unitId: '10000000-0000-4000-8000-000000000004' },
      seller,
    ).expect(200);
    expect(corrected.body.salesPrice).toBeNull();
    expect(corrected.body.effectiveSalesPrice).toBeNull();
  });
  it('prevents sales staff changing configured prices or bypassing approvals through direct sale posting', async () => {
    await call(
      'patch',
      `/items/${item.id}/price`,
      { salesPrice: 1 },
      seller,
    ).expect(403);
    await call('post', '/sales', payload(1), seller).expect(403);
    await call('post', '/sales', payload(1), admin).expect(400);
    await call(
      'post',
      '/sales',
      { ...payload(), commissionPercent: 100 },
      admin,
    ).expect(400);
    const commissionOrder = (
      await call(
        'post',
        '/sales-orders',
        { ...payload(), commissionPercent: 100 },
        seller,
      ).expect(201)
    ).body;
    const submitted = (
      await call(
        'post',
        `/sales-orders/${commissionOrder.id}/submit`,
        {},
        seller,
      ).expect(201)
    ).body;
    expect(submitted.state).toBe('PENDING_APPROVAL');
    expect(submitted.priceExceptions.join(' ')).toContain('Commission');

    expect(
      (
        await db
          .getRepository(StockLevel)
          .findOneByOrFail({ itemId: item.id, locationId })
      ).quantity,
    ).toBe('100.000');
  });
  it('requires separate approval for a price exception and resets approval on revision', async () => {
    const q = await quote(90);
    await expect(
      locationContext.run([], () =>
        app.get(SalesOrdersController).detail(q.id),
      ),
    ).rejects.toThrow('Sales order not found');
    expect(
      (
        await call('post', `/sales-orders/${q.id}/submit`, {}, seller).expect(
          201,
        )
      ).body.state,
    ).toBe('PENDING_APPROVAL');
    await call('post', `/sales-orders/${q.id}/confirm`, {}, seller).expect(400);
    await call(
      'post',
      `/sales-orders/${q.id}/approve`,
      { note: 'discount' },
      seller,
    ).expect(403);
    expect(
      (
        await call(
          'post',
          `/sales-orders/${q.id}/approve`,
          { note: 'Authorized customer discount' },
          admin,
        ).expect(201)
      ).body.state,
    ).toBe('APPROVED');
    const revised = await call(
      'patch',
      `/sales-orders/${q.id}`,
      payload(80),
      seller,
    ).expect(200);
    expect(revised.body.state).toBe('DRAFT');
    expect(revised.body.approvedById).toBeNull();
  });
  it('blocks approving your own exception even with approval permission', async () => {
    const q = (
      await call('post', '/sales-orders', payload(1), admin).expect(201)
    ).body;
    await call('post', `/sales-orders/${q.id}/submit`, {}, admin).expect(201);
    await call(
      'post',
      `/sales-orders/${q.id}/approve`,
      { note: 'Self approval' },
      admin,
    ).expect(403);
  });
  it('reserves on confirmation, posts exactly once at warehouse delivery and freezes delivered lines', async () => {
    const q = await quote();
    await call('post', `/sales-orders/${q.id}/submit`, {}, seller).expect(201);
    await call('post', `/sales-orders/${q.id}/confirm`, {}, seller).expect(201);
    let s = await db
      .getRepository(StockLevel)
      .findOneByOrFail({ itemId: item.id, locationId });
    expect(s.quantity).toBe('100.000');
    expect(s.reserved).toBe('2.000');
    await call('post', `/sales-orders/${q.id}/deliver`, {}, seller).expect(403);
    const delivered = await call(
      'post',
      `/sales-orders/${q.id}/deliver`,
      {},
      warehouse,
    ).expect(201);
    expect(delivered.body.state).toBe('DELIVERED');
    expect(delivered.body.saleId).toBeTruthy();
    await request(app.getHttpServer())
      .delete(`/api/v1/sales/${delivered.body.saleId}`)
      .auth(admin, { type: 'bearer' })
      .expect(400);
    await call(
      'patch',
      `/sales/${delivered.body.saleId}`,
      { notes: 'Delivery note' },
      seller,
    ).expect(200);
    expect(
      (await call('get', `/sales/${delivered.body.saleId}`).expect(200)).body
        .commercialLocked,
    ).toBe(true);
    await call(
      'patch',
      `/sales/${delivered.body.saleId}`,
      { commissionPercent: 100 },
      seller,
    ).expect(400);
    await call('post', `/sales-orders/${q.id}/deliver`, {}, warehouse).expect(
      201,
    );
    s = await db
      .getRepository(StockLevel)
      .findOneByOrFail({ itemId: item.id, locationId });
    expect(s.quantity).toBe('98.000');
    expect(s.reserved).toBe('0.000');
    expect(
      await db
        .getRepository(StockMovement)
        .countBy({ refId: delivered.body.saleId }),
    ).toBe(1);
    await call(
      'patch',
      `/sales/${delivered.body.saleId}`,
      { lines: payload().lines },
      seller,
    ).expect(400);
  });
  it('releases reservations on cancellation and rejects stale standard-price approvals', async () => {
    const q = await quote();
    await call('post', `/sales-orders/${q.id}/submit`, {}, seller).expect(201);
    await call(
      'patch',
      `/items/${item.id}/price`,
      { salesPrice: 110 },
      admin,
    ).expect(200);
    await call('post', `/sales-orders/${q.id}/confirm`, {}, seller).expect(400);
    await call(
      'patch',
      `/items/${item.id}/price`,
      { salesPrice: 100 },
      admin,
    ).expect(200);
    await call('post', `/sales-orders/${q.id}/confirm`, {}, seller).expect(201);
    await call('post', `/sales-orders/${q.id}/cancel`, {}, seller).expect(201);
    expect(
      (
        await db
          .getRepository(StockLevel)
          .findOneByOrFail({ itemId: item.id, locationId })
      ).reserved,
    ).toBe('0.000');
  });
  it('uses configured prices in the transaction unit, not the stock cost', async () => {
    const repo = db.getRepository(Item),
      cloth = await repo.save(
        repo.create({
          description: 'Priced cm cloth',
          unitId: CM,
          unit: 'cm',
          itemType: ItemType.RAW,
          salesPrice: '1.00',
        }),
      );
    const q = (
      await call(
        'post',
        '/sales-orders',
        {
          ...payload(),
          lines: [
            {
              itemId: cloth.id,
              unitId: '10000000-0000-4000-8000-000000000004',
              quantity: 1,
              unitPrice: 100,
            },
          ],
        },
        seller,
      ).expect(201)
    ).body;
    expect(q.priceExceptions).toEqual([]);
    expect(q.normalizedLines[0].quantity).toBe(100);
    expect(q.normalizedLines[0].unitPrice).toBe(1);
  });
  it('derives variant prices from family base price and attribute extras with protected overrides', async () => {
    const attributeId = randomUUID(),
      families = db.getRepository(ProductFamily);
    const f = await families.save(
      families.create({
        name: 'Pricing family ' + randomUUID(),
        itemType: ItemType.FINISHED,
        unitId: PCS,
        attributes: [{ attributeId, values: ['Premium', 'Basic'] }],
      }),
    );
    const items = db.getRepository(Item),
      variant = await items.save(
        items.create({
          description: 'Premium variant',
          sku: 'VP-' + randomUUID(),
          unitId: PCS,
          unit: 'pcs',
          itemType: ItemType.FINISHED,
          productFamilyId: f.id,
          variantKey: 'premium',
          variantValues: [{ attributeId, name: 'Finish', value: 'Premium' }],
        }),
      );
    await call(
      'patch',
      `/product-families/${f.id}/pricing`,
      {
        basePrice: 100,
        extras: [{ attributeId, value: 'Premium', extra: 25 }],
      },
      seller,
    ).expect(403);
    await call(
      'patch',
      `/product-families/${f.id}/pricing`,
      {
        basePrice: 100,
        extras: [{ attributeId, value: 'Premium', extra: 25 }],
      },
      admin,
    ).expect(200);
    expect(
      Number(
        (await call('get', `/items/${variant.id}`).expect(200)).body
          .effectiveSalesPrice,
      ),
    ).toBe(125);
    let q = (
      await call(
        'post',
        '/sales-orders',
        {
          ...payload(),
          lines: [{ itemId: variant.id, quantity: 1, unitPrice: 125 }],
        },
        seller,
      ).expect(201)
    ).body;
    expect(q.priceExceptions).toEqual([]);
    await call(
      'patch',
      `/items/${variant.id}/price`,
      { salesPrice: 130 },
      admin,
    ).expect(200);
    q = (
      await call(
        'post',
        '/sales-orders',
        {
          ...payload(),
          lines: [{ itemId: variant.id, quantity: 1, unitPrice: 125 }],
        },
        seller,
      ).expect(201)
    ).body;
    expect(q.priceExceptions).toHaveLength(1);
  });
  it('keeps purchases unposted until warehouse receipt and receives each order exactly once', async () => {
    const suppliers = db.getRepository(Supplier),
      supplier = await suppliers.save(
        suppliers.create({ name: 'Workflow supplier ' + randomUUID() }),
      );
    const body = {
      supplierId: supplier.id,
      locationId,
      paymentMethod: 'CREDIT',
      lines: [{ itemId: item.id, quantity: 3, unitPrice: 40 }],
    };
    const before = Number(
      (
        await db
          .getRepository(StockLevel)
          .findOneByOrFail({ itemId: item.id, locationId })
      ).quantity,
    );
    const o = (await call('post', '/purchase-orders', body, admin).expect(201))
      .body;
    await call(
      'post',
      `/purchase-orders/${o.id}/receive`,
      {},
      warehouse,
    ).expect(400);
    await call('post', `/purchase-orders/${o.id}/confirm`, {}, admin).expect(
      201,
    );
    expect(
      Number(
        (
          await db
            .getRepository(StockLevel)
            .findOneByOrFail({ itemId: item.id, locationId })
        ).quantity,
      ),
    ).toBe(before);
    await call('post', `/purchase-orders/${o.id}/receive`, {}, seller).expect(
      403,
    );
    const received = (
      await call(
        'post',
        `/purchase-orders/${o.id}/receive`,
        {},
        warehouse,
      ).expect(201)
    ).body;
    expect(received.state).toBe('RECEIVED');
    expect(received.purchaseId).toBeTruthy();
    await request(app.getHttpServer())
      .delete(`/api/v1/purchases/${received.purchaseId}`)
      .auth(admin, { type: 'bearer' })
      .expect(400);
    await call(
      'patch',
      `/purchases/${received.purchaseId}`,
      { notes: 'Receipt note' },
      admin,
    ).expect(200);
    await call(
      'post',
      `/purchase-orders/${o.id}/receive`,
      {},
      warehouse,
    ).expect(201);
    expect(
      Number(
        (
          await db
            .getRepository(StockLevel)
            .findOneByOrFail({ itemId: item.id, locationId })
        ).quantity,
      ),
    ).toBe(before + 3);
    expect(
      await db
        .getRepository(StockMovement)
        .countBy({ refId: received.purchaseId }),
    ).toBe(1);
    expect(
      received.history.every(
        (h: { actorId: string; actorName: string }) => h.actorId && h.actorName,
      ),
    ).toBe(true);
    await call('post', `/purchase-orders/${o.id}/cancel`, {}, admin).expect(
      400,
    );
  });
  it('requires production request, storekeeper handover, start and then completion with actor metadata', async () => {
    const items = db.getRepository(Item),
      raw = await items.save(
        items.create({
          description: 'Component',
          unitId: PCS,
          unit: 'pcs',
          itemType: ItemType.RAW,
        }),
      );
    const fg = await items.save(
      items.create({
        description: 'Manufactured chair',
        unitId: PCS,
        unit: 'pcs',
        itemType: ItemType.FINISHED,
      }),
    );
    await app.get(StockService).adjust({
      locationId,
      itemId: raw.id,
      quantityDelta: 20,
      purchasePrice: 7,
    });
    const bom = (
      await call(
        'post',
        '/boms',
        {
          name: 'Workflow BOM',
          finishedItemId: fg.id,
          lines: [{ componentItemId: raw.id, quantity: 2 }],
        },
        manager,
      ).expect(201)
    ).body;
    const order = (
      await call(
        'post',
        '/production-orders',
        { bomId: bom.id, locationId, quantityPlanned: 2 },
        manager,
      ).expect(201)
    ).body;
    await call(
      'post',
      `/production-orders/${order.id}/release`,
      {},
      manager,
    ).expect(201);
    await call(
      'post',
      `/production-orders/${order.id}/start`,
      {},
      manager,
    ).expect(400);
    await call(
      'post',
      `/production-orders/${order.id}/issue`,
      {},
      manager,
    ).expect(403);
    const handover = await call(
      'post',
      `/production-orders/${order.id}/issue`,
      {},
      warehouse,
    ).expect(201);
    expect(handover.body.status).toBe('RELEASED');
    expect(handover.body.handedOverById).toBeTruthy();
    await call(
      'post',
      `/production-orders/${order.id}/complete`,
      { quantity: 1, autoIssue: false },
      manager,
    ).expect(400);
    await call(
      'post',
      `/production-orders/${order.id}/start`,
      {},
      manager,
    ).expect(201);
    await call(
      'post',
      `/production-orders/${order.id}/complete`,
      { quantity: 1, autoIssue: true },
      manager,
    ).expect(400);
    await call(
      'post',
      `/production-orders/${order.id}/complete`,
      { quantity: 1, autoIssue: false },
      manager,
    ).expect(201);
    const done = await call(
      'post',
      `/production-orders/${order.id}/complete`,
      { quantity: 1, autoIssue: false },
      manager,
    ).expect(201);
    expect(done.body.status).toBe('COMPLETED');
    expect(
      done.body.workflowHistory.every((h: { actorId: string }) => h.actorId),
    ).toBe(true);
    const stock = await db
      .getRepository(StockLevel)
      .findOneByOrFail({ itemId: fg.id, locationId });
    expect(stock.quantity).toBe('2.000');
    expect(Number(stock.purchasePrice)).toBe(14);
  });
});
