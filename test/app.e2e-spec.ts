import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { LocationType, PaymentMethod } from '../src/common/enums';
import { SeedService } from '../src/database/seed.service';
import { setupApp } from '../src/setup-app';

const API = '/api/v1';

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

    app = moduleFixture.createNestApplication<NestExpressApplication>({
      bufferLogs: true,
    });
    setupApp(app as NestExpressApplication);
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

  itDb('GET /api/v1/health/live (liveness)', async () => {
    const res = await request(app.getHttpServer())
      .get(`${API}/health/live`)
      .expect(200);
    expect(res.body.status).toBe('ok');
  });

  itDb('GET /api/v1/health (readiness + DB)', async () => {
    const res = await request(app.getHttpServer())
      .get(`${API}/health`)
      .expect(200);
    expect(res.body.status).toBe('ok');
  });

  itDb('rejects unauthenticated inventory list with 401', async () => {
    await request(app.getHttpServer()).get(`${API}/inventory`).expect(401);
  });

  itDb(
    'login → create stock → sale → qty drops; bad auth stays 401',
    async () => {
      const login = await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: adminEmail, password: adminPassword });
      expect([200, 201]).toContain(login.status);
      expect(login.body.accessToken).toBeTruthy();

      const token = login.body.accessToken as string;
      const auth = { Authorization: `Bearer ${token}` };

      const locations = await request(app.getHttpServer())
        .get(`${API}/locations`)
        .set(auth)
        .expect(200);

      const list = Array.isArray(locations.body)
        ? locations.body
        : (locations.body.data ?? []);
      let locationId = list[0]?.id as string | undefined;

      if (!locationId) {
        const createdLoc = await request(app.getHttpServer())
          .post(`${API}/locations`)
          .set(auth)
          .send({
            name: `E2E Warehouse ${Date.now()}`,
            type: LocationType.WAREHOUSE,
          })
          .expect(201);
        locationId = createdLoc.body.id;
      }

      const banks = await request(app.getHttpServer())
        .get(`${API}/banks/accounts`)
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
        .post(`${API}/inventory`)
        .set(auth)
        .send({
          description: 'E2E Widget',
          unit: 'pcs',
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
        .post(`${API}/sales`)
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
        .get(`${API}/inventory/${stockRes.body.id}`)
        .set(auth)
        .expect(200);

      expect(parseFloat(after.body.quantity)).toBe(openingQty - saleQty);

      const movements = await request(app.getHttpServer())
        .get(`${API}/inventory/movements`)
        .query({ search: sku, limit: 20 })
        .set(auth)
        .expect(200);

      const movementRows = Array.isArray(movements.body)
        ? movements.body
        : (movements.body.data ?? []);
      const types = movementRows.map((m: { type: string }) => m.type);
      expect(types).toEqual(expect.arrayContaining(['OPENING', 'SALE']));

      await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: adminEmail, password: 'wrong-password' })
        .expect(401);

      const roles = await request(app.getHttpServer())
        .get(`${API}/roles`)
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
        .post(`${API}/users`)
        .set(auth)
        .send({
          email: limitedEmail,
          password: limitedPassword,
          fullName: 'E2E Sales Rep',
          roleId: salesRole.id,
        });
      expect([200, 201]).toContain(createdUser.status);

      const limitedLogin = await request(app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: limitedEmail, password: limitedPassword });
      expect([200, 201]).toContain(limitedLogin.status);
      const limitedAuth = {
        Authorization: `Bearer ${limitedLogin.body.accessToken}`,
      };

      await request(app.getHttpServer())
        .get(`${API}/units`)
        .set(limitedAuth)
        .expect(200);
      await request(app.getHttpServer())
        .post(`${API}/units`)
        .set(limitedAuth)
        .send({
          code: 'DENIED',
          name: 'Denied',
          symbol: 'x',
          category: 'COUNT',
          decimalPlaces: 0,
        })
        .expect(403);
      await request(app.getHttpServer())
        .post(`${API}/inventory`)
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
    },
  );
  itDb(
    'converts purchases, sales, BOMs and transfers; returns retain the original factor',
    async () => {
      const server = app.getHttpServer();
      const login = await request(server)
        .post(`${API}/auth/login`)
        .send({ email: adminEmail, password: adminPassword })
        .expect(201);
      const auth = { Authorization: `Bearer ${login.body.accessToken}` };
      const units = (
        await request(server).get(`${API}/units`).set(auth).expect(200)
      ).body as { id: string; code: string }[];
      const id = (code: string) => units.find((u) => u.code === code)!.id;
      const loc = (
        await request(server)
          .post(`${API}/locations`)
          .set(auth)
          .send({ name: `Conversion ${Date.now()}`, type: 'WAREHOUSE' })
          .expect(201)
      ).body;
      const dest = (
        await request(server)
          .post(`${API}/locations`)
          .set(auth)
          .send({
            name: `Conversion destination ${Date.now()}`,
            type: 'WAREHOUSE',
          })
          .expect(201)
      ).body;
      const banks = (
        await request(server).get(`${API}/banks/accounts`).set(auth).expect(200)
      ).body;
      const bank = (Array.isArray(banks) ? banks : banks.data).find(
        (b: { accountType: string }) => b.accountType === 'CASH',
      );
      const supplier = (
        await request(server)
          .post(`${API}/suppliers`)
          .set(auth)
          .send({ name: `Conversion Supplier ${Date.now()}` })
          .expect(201)
      ).body;
      const stock = (
        await request(server)
          .post(`${API}/inventory`)
          .set(auth)
          .send({
            description: 'Conversion parts',
            unitId: id('PCS'),
            locationId: loc.id,
            quantity: 0,
            purchasePrice: 0,
          })
          .expect(201)
      ).body;
      const itemId = stock.itemId;
      const settings = (factor: number) =>
        request(server)
          .patch(`${API}/units/items/${itemId}`)
          .set(auth)
          .send({
            conversions: [{ unitId: id('BOX'), factor, purchaseDefault: true }],
          });
      await settings(12).expect(200);
      await request(server)
        .patch(`${API}/units/items/${itemId}`)
        .set(auth)
        .send({ conversions: [{ unitId: id('M'), factor: 2 }] })
        .expect(400);
      await settings(12).expect(200);
      const purchase = (
        await request(server)
          .post(`${API}/purchases`)
          .set(auth)
          .send({
            supplierId: supplier.id,
            locationId: loc.id,
            paymentMethod: 'CASH',
            bankAccountId: bank.id,
            lines: [{ itemId, unitId: id('BOX'), quantity: 2, unitPrice: 120 }],
          })
          .expect(201)
      ).body;
      expect(Number(purchase.lines[0].quantity)).toBe(24);
      expect(Number(purchase.lines[0].unitPrice)).toBe(10);
      expect(Number(purchase.total)).toBe(240);
      expect(purchase.lines[0].unitSnapshot.quantity).toBe('2');
      const sale = (
        await request(server)
          .post(`${API}/sales`)
          .set(auth)
          .send({
            locationId: loc.id,
            paymentMethod: 'CASH',
            bankAccountId: bank.id,
            lines: [{ itemId, unitId: id('BOX'), quantity: 1, unitPrice: 180 }],
          })
          .expect(201)
      ).body;
      expect(Number(sale.total)).toBe(180);
      expect(Number(sale.lines[0].quantity)).toBe(12);
      await settings(24).expect(200);
      const updated = (
        await request(server)
          .patch(`${API}/sales/${sale.id}`)
          .set(auth)
          .send({ paymentMethod: 'CASH' })
          .expect(200)
      ).body;
      expect(updated.lines[0].unitSnapshot.factor).toBe('12');
      expect(Number(updated.total)).toBe(180);
      await request(server)
        .post(`${API}/sales/${sale.id}/returns`)
        .set(auth)
        .send({
          lines: [
            { saleLineId: updated.lines[0].id, unitId: id('BOX'), quantity: 1 },
          ],
        })
        .expect(201);
      const after = (
        await request(server)
          .get(`${API}/inventory/${stock.id}`)
          .set(auth)
          .expect(200)
      ).body;
      expect(Number(after.quantity)).toBe(24);
      const transfer = (
        await request(server)
          .post(`${API}/stock-transfers`)
          .set(auth)
          .send({
            fromLocationId: loc.id,
            toLocationId: dest.id,
            lines: [{ itemId, unitId: id('BOX'), quantity: 1 }],
          })
          .expect(201)
      ).body;
      expect(Number(transfer.lines[0].quantity)).toBe(24);
      const fg = (
        await request(server)
          .post(`${API}/inventory`)
          .set(auth)
          .send({
            description: 'Conversion assembly',
            unitId: id('PCS'),
            itemType: 'FINISHED',
            locationId: loc.id,
            quantity: 0,
            purchasePrice: 0,
          })
          .expect(201)
      ).body;
      const bom = (
        await request(server)
          .post(`${API}/boms`)
          .set(auth)
          .send({
            finishedItemId: fg.itemId,
            name: 'Conversion BOM',
            lines: [
              { componentItemId: itemId, unitId: id('BOX'), quantity: 1 },
            ],
          })
          .expect(201)
      ).body;
      expect(Number(bom.lines[0].quantity)).toBe(24);
      expect(bom.lines[0].unitSnapshot.factor).toBe('24');
      const mass = (
        await request(server)
          .post(`${API}/inventory`)
          .set(auth)
          .send({
            description: 'Conversion mass',
            unitId: id('KG'),
            locationId: loc.id,
            quantity: 2,
            purchasePrice: 10,
          })
          .expect(201)
      ).body;
      const massSale = (
        await request(server)
          .post(`${API}/sales`)
          .set(auth)
          .send({
            locationId: loc.id,
            paymentMethod: 'CASH',
            bankAccountId: bank.id,
            lines: [
              {
                itemId: mass.itemId,
                unitId: id('G'),
                quantity: 500,
                unitPrice: 0.02,
              },
            ],
          })
          .expect(201)
      ).body;
      expect(Number(massSale.lines[0].quantity)).toBe(0.5);
      expect(Number(massSale.total)).toBe(10);
      await request(server)
        .patch(`${API}/units/items/${mass.itemId}`)
        .set(auth)
        .send({ conversions: [{ unitId: id('G'), factor: 2 }] })
        .expect(400);
      await request(server)
        .patch(`${API}/units/items/${mass.itemId}`)
        .set(auth)
        .send({ conversions: [] })
        .expect(200);
      const areaStock = (
        await request(server)
          .post(`${API}/inventory`)
          .set(auth)
          .send({
            description: 'Conversion fabric',
            unitId: id('M2'),
            locationId: loc.id,
            quantity: 20,
            purchasePrice: 10,
          })
          .expect(201)
      ).body;
      const areaLine = {
        itemId: areaStock.itemId,
        unitId: id('M2'),
        quantity: 6,
        unitPrice: 15,
        dimensions: { widthMetres: 1.5, lengthMetres: 2, count: 2 },
      };
      const areaSale = (
        await request(server)
          .post(`${API}/sales`)
          .set(auth)
          .send({
            locationId: loc.id,
            paymentMethod: 'CASH',
            bankAccountId: bank.id,
            lines: [areaLine],
          })
          .expect(201)
      ).body;
      expect(Number(areaSale.lines[0].quantity)).toBe(6);
      expect(areaSale.lines[0].unitSnapshot.dimensions).toEqual(
        areaLine.dimensions,
      );
      await request(server)
        .post(`${API}/sales`)
        .set(auth)
        .send({
          locationId: loc.id,
          paymentMethod: 'CASH',
          bankAccountId: bank.id,
          lines: [{ ...areaLine, quantity: 5 }],
        })
        .expect(400);
    },
    60000,
  );
  itDb(
    'corrects only unused base units and trades fixed-size pieces by area without rewriting stock history',
    async () => {
      const server = app.getHttpServer();
      const login = await request(server)
        .post(`${API}/auth/login`)
        .send({ email: adminEmail, password: adminPassword })
        .expect(201);
      const auth = { Authorization: `Bearer ${login.body.accessToken}` };
      const units = (
        await request(server).get(`${API}/units`).set(auth).expect(200)
      ).body as { id: string; code: string }[];
      const unitId = (code: string) => units.find((u) => u.code === code)!.id;
      const loc = (
        await request(server)
          .post(`${API}/locations`)
          .set(auth)
          .send({ name: `Area pieces ${Date.now()}`, type: 'WAREHOUSE' })
          .expect(201)
      ).body;
      const create = async (quantity: number) =>
        (
          await request(server)
            .post(`${API}/inventory`)
            .set(auth)
            .send({
              description: 'Fixed-size fabric piece',
              unitId: unitId('PCS'),
              locationId: loc.id,
              quantity,
              purchasePrice: 90,
            })
            .expect(201)
        ).body;
      const empty = await create(0);
      expect(
        (
          await request(server)
            .get(`${API}/units/items/${empty.itemId}`)
            .set(auth)
            .expect(200)
        ).body.canChangeBaseUnit,
      ).toBe(true);
      const corrected = (
        await request(server)
          .patch(`${API}/inventory/${empty.id}`)
          .set(auth)
          .send({ unitId: unitId('M2'), purchasePrice: 30 })
          .expect(200)
      ).body;
      expect(corrected.item.unitId).toBe(unitId('M2'));
      expect(Number(corrected.quantity)).toBe(0);
      expect(Number(corrected.purchasePrice)).toBe(30);
      await request(server)
        .patch(`${API}/units/items/${empty.itemId}`)
        .set(auth)
        .send({
          conversions: [{ unitId: unitId('CM2'), factor: 0.0001 }],
        })
        .expect(200);
      await request(server)
        .patch(`${API}/inventory/${empty.id}`)
        .set(auth)
        .send({ unitId: unitId('PCS') })
        .expect(400);
      await request(server)
        .patch(`${API}/units/items/${empty.itemId}`)
        .set(auth)
        .send({ conversions: [] })
        .expect(200);
      await request(server)
        .patch(`${API}/inventory/${empty.id}`)
        .set(auth)
        .send({ unitId: unitId('PCS') })
        .expect(200);
      const alternative = (
        await request(server)
          .post(`${API}/units`)
          .set(auth)
          .send({
            code: `THIRD_${Date.now()}`,
            name: 'Third of a piece',
            symbol: 'third',
            category: 'COUNT',
            decimalPlaces: 0,
          })
          .expect(201)
      ).body;
      const stocked = await create(20);
      const configure = (unitQuantity: number) =>
        request(server)
          .patch(`${API}/units/items/${stocked.itemId}`)
          .set(auth)
          .send({
            conversions: [
              {
                unitId: alternative.id,
                stockQuantity: 1,
                unitQuantity,
                salesDefault: true,
              },
            ],
          });
      const configured = (await configure(3).expect(200)).body;
      expect(configured.canChangeBaseUnit).toBe(false);
      expect(configured.conversions[0]).toMatchObject({
        stockQuantity: '1',
        unitQuantity: '3',
      });
      expect(
        (
          await request(server)
            .get(`${API}/inventory/${stocked.id}`)
            .set(auth)
            .expect(200)
        ).body.quantity,
      ).toBe('20.000');
      await request(server)
        .patch(`${API}/inventory/${stocked.id}`)
        .set(auth)
        .send({ unitId: unitId('M2') })
        .expect(400);
      const banks = (
        await request(server).get(`${API}/banks/accounts`).set(auth).expect(200)
      ).body;
      const bank = (Array.isArray(banks) ? banks : banks.data).find(
        (b: { accountType: string }) => b.accountType === 'CASH',
      );
      const saleBody = {
        locationId: loc.id,
        paymentMethod: 'CASH',
        bankAccountId: bank.id,
        lines: [
          {
            itemId: stocked.itemId,
            unitId: alternative.id,
            quantity: 6,
            unitPrice: 30,
          },
        ],
      };
      const sale = (
        await request(server)
          .post(`${API}/sales`)
          .set(auth)
          .send(saleBody)
          .expect(201)
      ).body;
      expect(Number(sale.lines[0].quantity)).toBe(2);
      expect(Number(sale.lines[0].unitPrice)).toBe(90);
      expect(Number(sale.total)).toBe(180);
      await request(server)
        .post(`${API}/sales`)
        .set(auth)
        .send({ ...saleBody, lines: [{ ...saleBody.lines[0], quantity: 1 }] })
        .expect(400);
      await configure(4).expect(200);
      await request(server)
        .post(`${API}/sales/${sale.id}/returns`)
        .set(auth)
        .send({
          lines: [
            {
              saleLineId: sale.lines[0].id,
              unitId: alternative.id,
              quantity: 6,
            },
          ],
        })
        .expect(201);
      expect(
        Number(
          (
            await request(server)
              .get(`${API}/inventory/${stocked.id}`)
              .set(auth)
              .expect(200)
          ).body.quantity,
        ),
      ).toBe(20);
      await request(server)
        .patch(`${API}/units/items/${stocked.itemId}`)
        .set(auth)
        .send({ conversions: [] })
        .expect(200);
      await request(server)
        .patch(`${API}/inventory/${stocked.id}`)
        .set(auth)
        .send({ unitId: unitId('M2') })
        .expect(400);
      await expect(
        dataSource.query('UPDATE items SET unit_id=$1 WHERE id=$2', [
          unitId('M2'),
          stocked.itemId,
        ]),
      ).rejects.toMatchObject({
        driverError: { constraint: 'item_stock_unit_locked' },
      });
    },
    60000,
  );
});
