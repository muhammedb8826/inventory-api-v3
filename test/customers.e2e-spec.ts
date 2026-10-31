import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';
import { Customer } from '../src/database/entities/customer.entity';
import { RemoveCustomerPhoneValidation1749240000000 } from '../src/database/migrations/1749240000000-RemoveCustomerPhoneValidation';
import { CustomerPhoneIdentity1749230000000 } from '../src/database/migrations/1749230000000-CustomerPhoneIdentity';

function phone() {
  return (
    '2547' +
    String(parseInt(randomUUID().replaceAll('-', '').slice(0, 10), 16))
      .padStart(12, '0')
      .slice(-8)
  );
}
describe('Customer directory and optional phone numbers', () => {
  let app: NestExpressApplication, db: DataSource, token: string;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    setupApp(app);
    await app.init();
    db = app.get(DataSource);
    token = (
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          email: process.env.SEED_ADMIN_EMAIL,
          password: process.env.SEED_ADMIN_PASSWORD,
        })
        .expect(201)
    ).body.accessToken;
  }, 60000);
  afterAll(async () => {
    await app?.close();
  });
  function call(
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    body?: object,
  ) {
    const r = request(app.getHttpServer())
      [method]('/api/v1' + path)
      .auth(token, { type: 'bearer' });
    return body ? r.send(body) : r;
  }
  it('allows optional, free-text and duplicate phone numbers on create and edit', async () => {
    const noPhone = (
      await call('post', '/customers', { name: 'No phone' }).expect(201)
    ).body;
    expect(noPhone.phone).toBeNull();
    const value = 'Office phone ext 42';
    for (const name of ['Shared phone A', 'Shared phone B']) {
      const created = (
        await call('post', '/customers', { name, phone: value }).expect(201)
      ).body;
      expect(created.phone).toBe(value);
    }
    await call('patch', `/customers/${noPhone.id}`, { phone: value }).expect(
      200,
    );
    await call('patch', `/customers/${noPhone.id}`, { phone: null }).expect(
      200,
    );
    const repo = db.getRepository(Customer);
    await repo.save(repo.create({ name: 'Direct missing phone' }));
    await repo.save(repo.create({ name: 'Direct duplicate', phone: value }));
  });
  it('lists newly created customers first and finds records beyond the first page', async () => {
    const prefix = 'Directory-' + randomUUID();
    for (let index = 0; index < 13; index++)
      await call('post', '/customers', {
        name: `${prefix}-${index}`,
        phone: phone(),
      }).expect(201);
    const latest = (
      await call('post', '/customers', {
        name: `${prefix}-Latest`,
        phone: phone(),
      }).expect(201)
    ).body;
    const page1 = await call(
      'get',
      `/customers?search=${prefix}&page=1&limit=10`,
    ).expect(200);
    expect(page1.body.data[0].id).toBe(latest.id);
    expect(page1.body.meta.total).toBe(14);
    const page2 = await call(
      'get',
      `/customers?search=${prefix}&page=2&limit=10`,
    ).expect(200);
    expect(page2.body.data).toHaveLength(4);
    expect(
      new Set(
        [...page1.body.data, ...page2.body.data].map((c: Customer) => c.id),
      ).size,
    ).toBe(14);
    const searched = await call(
      'get',
      `/customers?search=${latest.phone}`,
    ).expect(200);
    expect(searched.body.data.some((c: Customer) => c.id === latest.id)).toBe(
      true,
    );
  });
  it('removes already-applied phone restrictions without rewriting customers or history', async () => {
    const q = db.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      const schema = 'customer_phone_test_' + randomUUID().replaceAll('-', '');
      await q.query(`CREATE SCHEMA "${schema}"`);
      await q.query(`SET LOCAL search_path TO "${schema}",public`);
      await q.query(
        'CREATE TABLE customers (LIKE public.customers INCLUDING ALL)',
      );
      const digits = phone(),
        ids = [randomUUID(), randomUUID(), randomUUID()];
      await q.query(
        `INSERT INTO customers(id,name,phone) VALUES ($1,'Legacy one',$4),($2,'Legacy two',$5),($3,'Legacy missing',NULL)`,
        [...ids, digits, '+' + digits],
      );
      const before = await q.query(
        'SELECT id,name,phone,created_at FROM customers ORDER BY id',
      );
      await new CustomerPhoneIdentity1749230000000().up(q);
      await new RemoveCustomerPhoneValidation1749240000000().up(q);
      await new RemoveCustomerPhoneValidation1749240000000().up(q);
      expect(
        await q.query(
          'SELECT id,name,phone,created_at FROM customers ORDER BY id',
        ),
      ).toEqual(before);
      await q.manager
        .getRepository(Customer)
        .save(
          q.manager
            .getRepository(Customer)
            .create({ name: 'Duplicate after removal', phone: digits }),
        );
      await q.manager
        .getRepository(Customer)
        .save(
          q.manager
            .getRepository(Customer)
            .create({ name: 'Missing after removal' }),
        );
    } finally {
      await q.rollbackTransaction();
      await q.release();
    }
  });
});
