import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/http-exception.filter';
import { SeedService } from '../src/database/seed.service';
import { LocationType, PaymentMethod } from '../src/common/enums';

/**
 * Smoke e2e against a real Postgres database.
 *
 * Prerequisites:
 *   - Migrated DB (npm run migration:run)
 *   - Env vars for DB_* / JWT_* (see .env.example)
 *
 * Skip with: E2E_SKIP=true npm run test:e2e
 */
describe('Inventory API smoke (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@stock.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@123';

  const skip = process.env.E2E_SKIP === 'true';

  beforeAll(async () => {
    if (skip) return;

    process.env.DB_SEED = process.env.DB_SEED ?? 'true';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();

    dataSource = app.get(DataSource);
    const seeder = app.get(SeedService);
    await seeder.seed();
  }, 60_000);

  afterAll(async () => {
    if (skip) return;
    if (app) await app.close();
  });

  const itDb = skip ? it.skip : it;

  itDb('GET /api/health', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  itDb('rejects unauthenticated inventory list with 401', async () => {
    await request(app.getHttpServer()).get('/api/inventory').expect(401);
  });

  itDb('login → create stock → sale → qty drops; bad auth stays 401', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: adminEmail, password: adminPassword });
    expect([200, 201]).toContain(login.status);
    expect(login.body.accessToken).toBeTruthy();

    const token = login.body.accessToken as string;
    const auth = { Authorization: `Bearer ${token}` };

    const locations = await request(app.getHttpServer())
      .get('/api/locations')
      .set(auth)
      .expect(200);

    const list = Array.isArray(locations.body)
      ? locations.body
      : (locations.body.data ?? []);
    let locationId = list[0]?.id as string | undefined;

    if (!locationId) {
      const createdLoc = await request(app.getHttpServer())
        .post('/api/locations')
        .set(auth)
        .send({
          name: `E2E Warehouse ${Date.now()}`,
          type: LocationType.WAREHOUSE,
        })
        .expect(201);
      locationId = createdLoc.body.id;
    }

    const banks = await request(app.getHttpServer())
      .get('/api/banks/accounts')
      .set(auth)
      .expect(200);
    const bankList = Array.isArray(banks.body)
      ? banks.body
      : (banks.body.data ?? []);
    const cashAccount =
      bankList.find(
        (b: { accountType?: string; name?: string }) =>
          b.accountType === 'CASH' || b.name === 'Cash',
      ) ?? bankList[0];
    expect(cashAccount?.id).toBeTruthy();

    const sku = `E2E-${Date.now()}`;
    const openingQty = 10;
    const saleQty = 3;

    const stockRes = await request(app.getHttpServer())
      .post('/api/inventory')
      .set(auth)
      .send({
        description: 'E2E Widget',
        sku,
        locationId,
        quantity: openingQty,
        purchasePrice: 25,
      });
    expect([200, 201]).toContain(stockRes.status);

    const itemId = stockRes.body.itemId ?? stockRes.body.item?.id;
    expect(itemId).toBeTruthy();
    expect(parseFloat(stockRes.body.quantity)).toBe(openingQty);

    const saleRes = await request(app.getHttpServer())
      .post('/api/sales')
      .set(auth)
      .send({
        locationId,
        paymentMethod: PaymentMethod.CASH,
        bankAccountId: cashAccount.id,
        lines: [{ itemId, quantity: saleQty, unitPrice: 40 }],
      });
    expect([200, 201]).toContain(saleRes.status);
    expect(saleRes.body.id).toBeTruthy();

    const after = await request(app.getHttpServer())
      .get(`/api/inventory/${stockRes.body.id}`)
      .set(auth)
      .expect(200);

    expect(parseFloat(after.body.quantity)).toBe(openingQty - saleQty);

    const movements = await request(app.getHttpServer())
      .get('/api/inventory/movements')
      .query({ search: sku, limit: 20 })
      .set(auth)
      .expect(200);

    const movementRows = Array.isArray(movements.body)
      ? movements.body
      : (movements.body.data ?? []);
    const types = movementRows.map((m: { type: string }) => m.type);
    expect(types).toEqual(expect.arrayContaining(['OPENING', 'SALE']));

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: adminEmail, password: 'wrong-password' })
      .expect(401);

    const roles = await request(app.getHttpServer())
      .get('/api/roles')
      .set(auth)
      .expect(200);
    const roleList = Array.isArray(roles.body)
      ? roles.body
      : (roles.body.data ?? []);
    const salesRole = roleList.find(
      (r: { name?: string }) => r.name === 'Sales Representative',
    );
    expect(salesRole?.id).toBeTruthy();

    const limitedEmail = `e2e-sales-${Date.now()}@stock.local`;
    const limitedPassword = 'E2eSales@123';
    const createdUser = await request(app.getHttpServer())
      .post('/api/users')
      .set(auth)
      .send({
        email: limitedEmail,
        password: limitedPassword,
        fullName: 'E2E Sales Rep',
        roleId: salesRole.id,
      });
    expect([200, 201]).toContain(createdUser.status);

    const limitedLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: limitedEmail, password: limitedPassword });
    expect([200, 201]).toContain(limitedLogin.status);
    const limitedAuth = {
      Authorization: `Bearer ${limitedLogin.body.accessToken}`,
    };

    // Authenticated but missing inventory.write → 403
    await request(app.getHttpServer())
      .post('/api/inventory')
      .set(limitedAuth)
      .send({
        description: 'Forbidden Widget',
        sku: `E2E-403-${Date.now()}`,
        locationId,
        quantity: 1,
        purchasePrice: 1,
      })
      .expect(403);

    expect(dataSource.isInitialized).toBe(true);
  });
});
