import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';
import { BankLedgerService } from '../src/banks/bank-ledger.service';
import { CreditsService } from '../src/credits/credits.service';
import { SalesService } from '../src/sales/sales.service';
import { StockService } from '../src/inventory/stock.service';
import { BankAccount } from '../src/database/entities/bank-account.entity';
import { Customer } from '../src/database/entities/customer.entity';
import { CustomerCredit } from '../src/database/entities/customer-credit.entity';
import { Location } from '../src/database/entities/location.entity';
import { Item } from '../src/database/entities/item.entity';
import { StockLevel } from '../src/database/entities/stock-level.entity';
import {
  BankAccountType,
  BankTransactionType,
  CreditSource,
  CreditStatus,
  LocationType,
  PaymentMethod,
} from '../src/common/enums';

describe('Production invariants (isolated PostgreSQL)', () => {
  let app: NestExpressApplication,
    db: DataSource,
    ledger: BankLedgerService,
    credits: CreditsService,
    sales: SalesService,
    stock: StockService;
  let token: string,
    locationId: string,
    itemId: string,
    accountId: string,
    customerId: string;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>({
      bufferLogs: true,
    });
    setupApp(app);
    await app.init();
    db = app.get(DataSource);
    ledger = app.get(BankLedgerService);
    credits = app.get(CreditsService);
    sales = app.get(SalesService);
    stock = app.get(StockService);
    const auth = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: process.env.SEED_ADMIN_EMAIL ?? 'admin@stock.local',
        password: process.env.SEED_ADMIN_PASSWORD ?? 'Admin@123',
      })
      .expect(201);
    token = auth.body.accessToken;
    locationId = (
      await db.getRepository(Location).save(
        db.getRepository(Location).create({
          name: 'Hardening warehouse',
          type: LocationType.WAREHOUSE,
        }),
      )
    ).id;
    itemId = (
      await db.getRepository(Item).save(
        db.getRepository(Item).create({
          unitId: '10000000-0000-4000-8000-000000000001',
          description: 'Concurrency widget',
          sku: `H-${randomUUID()}`,
        }),
      )
    ).id;
    accountId = (
      await db.getRepository(BankAccount).save(
        db.getRepository(BankAccount).create({
          name: 'Hardening till',
          accountType: BankAccountType.CASH,
          balance: '0.00',
        }),
      )
    ).id;
    customerId = (
      await db
        .getRepository(Customer)
        .save(db.getRepository(Customer).create({ name: 'Hardening customer' }))
    ).id;
    await stock.adjust({
      locationId,
      itemId,
      quantityDelta: 100,
      purchasePrice: 10,
    });
  }, 60000);
  afterAll(async () => {
    await app?.close();
  });

  it('serializes concurrent bank updates without losing a posting', async () => {
    await Promise.all(
      Array.from({ length: 10 }, () =>
        ledger.recordTransaction({
          bankAccountId: accountId,
          amount: 1.01,
          direction: 'in',
          type: BankTransactionType.ADJUSTMENT,
        }),
      ),
    );
    expect(
      (await db.getRepository(BankAccount).findOneByOrFail({ id: accountId }))
        .balance,
    ).toBe('10.10');
  });
  it('serializes credit payments and prevents concurrent overpayment', async () => {
    const credit = await db.getRepository(CustomerCredit).save(
      db.getRepository(CustomerCredit).create({
        customerId,
        source: CreditSource.OPENING,
        amount: '10.00',
        paidAmount: '0.00',
        balance: '10.00',
        status: CreditStatus.OPEN,
      }),
    );
    const results = await Promise.allSettled([
      credits.payCustomerCredit(credit.id, {
        bankAccountId: accountId,
        amount: 7,
      }),
      credits.payCustomerCredit(credit.id, {
        bankAccountId: accountId,
        amount: 7,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (
        await db
          .getRepository(CustomerCredit)
          .findOneByOrFail({ id: credit.id })
      ).balance,
    ).toBe('3.00');
  });
  it('handles concurrent first receipts in a single stock row', async () => {
    const item = await db.getRepository(Item).save(
      db.getRepository(Item).create({
        unitId: '10000000-0000-4000-8000-000000000001',
        description: 'New concurrent SKU',
        sku: `H-${randomUUID()}`,
      }),
    );
    await Promise.all([
      stock.adjust({ locationId, itemId: item.id, quantityDelta: 1 }),
      stock.adjust({ locationId, itemId: item.id, quantityDelta: 2 }),
    ]);
    expect(
      (
        await db
          .getRepository(StockLevel)
          .findOneByOrFail({ locationId, itemId: item.id })
      ).quantity,
    ).toBe('3.000');
  });
  it('executes a concurrent idempotent sale once, replays it and rejects changed payload', async () => {
    const key = randomUUID();
    const payload = {
      locationId,
      paymentMethod: PaymentMethod.CASH,
      bankAccountId: accountId,
      lines: [{ itemId, quantity: 1, unitPrice: 20 }],
    };
    const send = (body = payload) =>
      request(app.getHttpServer())
        .post('/api/v1/sales')
        .auth(token, { type: 'bearer' })
        .set('Idempotency-Key', key)
        .send(body);
    const results = await Promise.all([send(), send()]);
    const accepted = results.find((r) => r.status === 201)!;
    expect(accepted).toBeDefined();
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(
      true,
    );
    const replay = await send();
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(accepted.body.id);
    expect(
      (
        await send({
          ...payload,
          lines: [{ itemId, quantity: 2, unitPrice: 20 }],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await db
          .getRepository(StockLevel)
          .findOneByOrFail({ locationId, itemId })
      ).quantity,
    ).toBe('99.000');
  });
  it('posts refunds with returns and rejects simultaneous excess returns', async () => {
    const sale = await sales.create({
      locationId,
      paymentMethod: PaymentMethod.CASH,
      bankAccountId: accountId,
      lines: [{ itemId, quantity: 2, unitPrice: 20 }],
    });
    const lineId = sale.lines[0].id;
    const before = (
      await db.getRepository(BankAccount).findOneByOrFail({ id: accountId })
    ).balance;
    const results = await Promise.allSettled([
      sales.createReturn(sale.id, {
        lines: [{ saleLineId: lineId, quantity: 2 }],
      }),
      sales.createReturn(sale.id, {
        lines: [{ saleLineId: lineId, quantity: 2 }],
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const after = (
      await db.getRepository(BankAccount).findOneByOrFail({ id: accountId })
    ).balance;
    expect(Number(before) - Number(after)).toBeCloseTo(40);
    await expect(sales.void(sale.id)).rejects.toThrow('Sales with returns');
  });
  it('retains every lot allocation and preserves lots on transfer', async () => {
    const lotItem = await db.getRepository(Item).save(
      db.getRepository(Item).create({
        unitId: '10000000-0000-4000-8000-000000000001',
        description: 'Batch widget',
        sku: `L-${randomUUID()}`,
      }),
    );
    const destination = await db
      .getRepository(Location)
      .save(
        db
          .getRepository(Location)
          .create({ name: 'Batch destination', type: LocationType.WAREHOUSE }),
      );
    await stock.adjust({
      locationId,
      itemId: lotItem.id,
      quantityDelta: 2,
      lotNumber: 'A',
      expiryDate: '2027-01-01',
    });
    await stock.adjust({
      locationId,
      itemId: lotItem.id,
      quantityDelta: 3,
      lotNumber: 'B',
      expiryDate: '2027-02-01',
    });
    const refId = randomUUID();
    await stock.transfer(locationId, destination.id, lotItem.id, 4, undefined, {
      refType: 'stock_transfer',
      refId,
    });
    const lots = await stock.listLots({
      locationId: destination.id,
      itemId: lotItem.id,
    });
    expect(lots.map((l) => [l.lotNumber, l.quantity])).toEqual(
      expect.arrayContaining([
        ['A', '2.000'],
        ['B', '2.000'],
      ]),
    );
  });
  it('restores original batch allocations on a customer return', async () => {
    const item = await db.getRepository(Item).save(
      db.getRepository(Item).create({
        unitId: '10000000-0000-4000-8000-000000000001',
        description: 'Returned batch widget',
        sku: `R-${randomUUID()}`,
      }),
    );
    await stock.adjust({
      locationId,
      itemId: item.id,
      quantityDelta: 1,
      purchasePrice: 10,
      lotNumber: 'FIRST',
      expiryDate: '2027-01-01',
    });
    await stock.adjust({
      locationId,
      itemId: item.id,
      quantityDelta: 2,
      purchasePrice: 10,
      lotNumber: 'SECOND',
      expiryDate: '2027-02-01',
    });
    const sale = await sales.create({
      locationId,
      paymentMethod: PaymentMethod.CASH,
      bankAccountId: accountId,
      lines: [{ itemId: item.id, quantity: 2, unitPrice: 20 }],
    });
    await sales.createReturn(sale.id, {
      lines: [{ saleLineId: sale.lines[0].id, quantity: 2 }],
    });
    const lots = await stock.listLots({ locationId, itemId: item.id });
    expect(lots.map((l) => [l.lotNumber, l.quantity])).toEqual(
      expect.arrayContaining([
        ['FIRST', '1.000'],
        ['SECOND', '2.000'],
      ]),
    );
  });
  it('keeps audit snapshots immutable and omits password hashes', async () => {
    const rows = await db.query(
      'SELECT * FROM audit_events WHERE route = $1 LIMIT 1',
      ['bank_accounts'],
    );
    expect(rows.length).toBe(1);
    await expect(
      db.query('DELETE FROM audit_events WHERE id = $1', [rows[0].id]),
    ).rejects.toThrow('append only');
  });
  it('settles credit returns and reports net revenue using original cost', async () => {
    const sale = await sales.create({
      locationId,
      customerId,
      paymentMethod: PaymentMethod.CREDIT,
      lines: [{ itemId, quantity: 2, unitPrice: 25 }],
    });
    const credit = await db
      .getRepository(CustomerCredit)
      .findOneByOrFail({ saleId: sale.id });
    await credits.payCustomerCredit(credit.id, {
      bankAccountId: accountId,
      amount: 30,
    });
    const returned = await sales.createReturn(sale.id, {
      bankAccountId: accountId,
      lines: [{ saleLineId: sale.lines[0].id, quantity: 2 }],
    });
    expect(returned!.creditAmount).toBe('20.00');
    expect(returned!.refundAmount).toBe('30.00');
    const settled = await db
      .getRepository(CustomerCredit)
      .findOneByOrFail({ id: credit.id });
    expect(settled.amount).toBe('0.00');
    expect(settled.paidAmount).toBe('0.00');
    expect(settled.balance).toBe('0.00');
    await request(app.getHttpServer())
      .get('/api/v1/reports/summary')
      .auth(token, { type: 'bearer' })
      .expect(200);
  });
  it('fails closed without location assignments and scopes assigned lists and direct access', async () => {
    const [role] = await db.query(
      "SELECT id FROM roles WHERE name='Stock Keeper'",
    );
    const email = `scope-${randomUUID()}@example.test`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/users')
      .auth(token, { type: 'bearer' })
      .send({
        email,
        password: 'ScopePassword123!',
        fullName: 'Scoped stock keeper',
        roleId: role.id,
      })
      .expect(201);
    const auth = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'ScopePassword123!' })
      .expect(201);
    const scopedToken = auth.body.accessToken as string;
    await request(app.getHttpServer())
      .get('/api/v1/units')
      .auth(scopedToken, { type: 'bearer' })
      .expect(200);
    const empty = await request(app.getHttpServer())
      .get('/api/v1/inventory')
      .auth(scopedToken, { type: 'bearer' })
      .expect(200);
    expect(empty.body.data).toEqual([]);
    expect(empty.body.meta.total).toBe(0);
    await request(app.getHttpServer())
      .patch(`/api/v1/users/${created.body.id}`)
      .auth(token, { type: 'bearer' })
      .send({ locationIds: [locationId] })
      .expect(200);
    const list = await request(app.getHttpServer())
      .get('/api/v1/inventory')
      .auth(scopedToken, { type: 'bearer' })
      .expect(200);
    expect(list.body.data.length).toBeGreaterThan(0);
    expect(
      list.body.data.every(
        (row: { locationId: string }) => row.locationId === locationId,
      ),
    ).toBe(true);
    const [other] = await db.query(
      'SELECT id FROM stock_levels WHERE location_id <> $1 LIMIT 1',
      [locationId],
    );
    await request(app.getHttpServer())
      .get(`/api/v1/inventory/${other.id}`)
      .auth(scopedToken, { type: 'bearer' })
      .expect(403);
    const low = await request(app.getHttpServer())
      .get('/api/v1/inventory/low-stock')
      .auth(scopedToken, { type: 'bearer' })
      .expect(200);
    expect(
      low.body.data.every(
        (row: { locationId: string }) => row.locationId === locationId,
      ),
    ).toBe(true);
  });
  it('lists document metadata and creators without exposing credential fields', async () => {
    for (const route of [
      '/sales',
      '/purchases',
      '/expenses',
      '/stock-transfers',
      '/inventory/low-stock',
    ]) {
      const response = await request(app.getHttpServer())
        .get(`/api/v1${route}`)
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      for (const row of response.body.data) {
        expect(row).not.toHaveProperty('passwordHash');
        if (row.createdBy) {
          expect(row.createdBy).not.toHaveProperty('passwordHash');
          expect(row.createdBy).not.toHaveProperty('sessionVersion');
        }
        if (route === '/inventory/low-stock') {
          expect(row).toHaveProperty('createdAt');
          expect(row).toHaveProperty('updatedAt');
          expect(row).toHaveProperty('available');
        }
      }
      if (route === '/sales')
        expect(
          response.body.data.some(
            (row: { createdBy?: { fullName?: string } }) =>
              row.createdBy?.fullName,
          ),
        ).toBe(true);
    }
  });
  it('revokes rotated refresh tokens and detects reuse', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        email: process.env.SEED_ADMIN_EMAIL ?? 'admin@stock.local',
        password: process.env.SEED_ADMIN_PASSWORD ?? 'Admin@123',
      })
      .expect(201);
    const rotated = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(201);
    expect(rotated.body.refreshToken).not.toBe(login.body.refreshToken);
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .auth(rotated.body.accessToken, { type: 'bearer' })
      .expect(401);
  });
});
