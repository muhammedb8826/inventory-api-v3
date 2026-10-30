import { hash } from 'bcrypt';
import { In } from 'typeorm';
import { Item, Role, Permission, User } from '../src/database/entities';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';
import { CustomerInquiry } from '../src/database/entities/customer-inquiry.entity';
import { CustomerInquiryLine } from '../src/database/entities/customer-inquiry-line.entity';

describe('Inquiry measurements and private reference files', () => {
  let app: NestExpressApplication,
    db: DataSource,
    token: string,
    locationId: string,
    customerId: string;
  let units: { id: string; code: string }[],
    groupId: string,
    fabricId: string,
    otherId: string;
  const api = '/api/v1';
  const call = (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    body?: object,
  ) => {
    const r = request(app.getHttpServer())
      [method](api + path)
      .auth(token, { type: 'bearer' });
    return body ? r.send(body) : r;
  };
  const u = (code: string) => units.find((unit) => unit.code === code)!.id;
  const inquiry = (lines: object[], extra: object = {}) =>
    call('post', '/inquiries', {
      contactName: 'Inquiry test',
      phone: '0911000000',
      subject: 'Custom furniture request',
      lines,
      ...extra,
    });
  async function stock(unitId: string, extra: object = {}) {
    return (
      await call('post', '/inventory', {
        description: 'Inquiry ' + randomUUID(),
        locationId,
        unitId,
        quantity: 200,
        purchasePrice: 10,
        itemType: 'FINISHED',
        ...extra,
      }).expect(201)
    ).body;
  }
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
        .post(api + '/auth/login')
        .send({
          email: process.env.SEED_ADMIN_EMAIL,
          password: process.env.SEED_ADMIN_PASSWORD,
        })
        .expect(201)
    ).body.accessToken;
    units = (await call('get', '/units').expect(200)).body;
    locationId = (
      await call('post', '/locations', {
        name: 'Inquiry tests ' + randomUUID(),
        type: 'WAREHOUSE',
      }).expect(201)
    ).body.id;
    customerId = (
      await call('post', '/customers', {
        name: 'Inquiry customer ' + randomUUID(),
      }).expect(201)
    ).body.id;
    groupId = (
      await call('post', '/units/groups', {
        name: 'Roll group ' + randomUUID(),
        category: 'LENGTH',
        baseUnitId: u('M'),
        conversions: [
          { unitId: u('ROLL'), factor: 50 },
          { unitId: u('CM'), factor: 0.01 },
        ],
      }).expect(201)
    ).body.id;
    fabricId = (await stock(u('M'), { unitGroupId: groupId })).itemId;
    otherId = (await stock(u('PCS'), { quantity: 1000, itemType: 'RAW' }))
      .itemId;
  }, 60000);
  afterAll(async () => {
    await app?.close();
  });
  async function factor(value: number) {
    await call('patch', '/units/groups/' + groupId, {
      name: 'Roll group ' + groupId,
      category: 'LENGTH',
      baseUnitId: u('M'),
      conversions: [
        { unitId: u('ROLL'), factor: value },
        { unitId: u('CM'), factor: 0.01 },
      ],
    }).expect(200);
  }
  it('creates an internal request without duplicate contact fields and records real action users', async () => {
    const created = (
      await call('post', '/inquiries', {
        customerId,
        lines: [{ itemId: fabricId, quantity: 2, unitId: u('ROLL') }],
      }).expect(201)
    ).body;
    expect(created.contactName).toContain('Inquiry customer');
    expect(created.phone).toBeNull();
    expect(created.email).toBeNull();
    expect(created.subject).toContain('Inquiry ');
    expect(created.createdBy.id).toBe(created.createdById);
    const updated = (
      await call('patch', '/inquiries/' + created.id, {
        message: 'Revised finish',
      }).expect(200)
    ).body;
    expect(updated.updatedBy.id).toBe(created.createdById);
    const read = (await call('get', '/inquiries/' + created.id).expect(200))
      .body;
    expect(read.activity.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['Created', 'Updated']),
    );
    expect(read.actionUsers.Updated.fullName).toBeTruthy();
    const creator = await db
      .getRepository(User)
      .findOneByOrFail({ id: created.createdById });
    const email = randomUUID() + '@example.test';
    const editor = await db.getRepository(User).save(
      db.getRepository(User).create({
        email,
        fullName: 'Different inquiry editor',
        passwordHash: await hash('EditorTest123!', 10),
        roleId: creator.roleId,
      }),
    );
    const editorToken = (
      await request(app.getHttpServer())
        .post(api + '/auth/login')
        .send({ email, password: 'EditorTest123!' })
        .expect(201)
    ).body.accessToken;
    await request(app.getHttpServer())
      .patch(api + '/inquiries/' + created.id)
      .auth(editorToken, { type: 'bearer' })
      .send({ message: 'Another employee updated this' })
      .expect(200);
    const revised = (await call('get', '/inquiries/' + created.id).expect(200))
      .body;
    expect(revised.createdBy.id).toBe(created.createdById);
    expect(revised.updatedBy.id).toBe(editor.id);
    const destination = (
      await call('post', '/locations', {
        name: 'Receiving ' + randomUUID(),
        type: 'WAREHOUSE',
      }).expect(201)
    ).body.id;
    const transfer = (
      await call('post', '/stock-transfers', {
        fromLocationId: locationId,
        toLocationId: destination,
        lines: [{ itemId: otherId, quantity: 1 }],
      }).expect(201)
    ).body;
    await call('post', `/stock-transfers/${transfer.id}/ship`).expect(201);
    await request(app.getHttpServer())
      .post(api + `/stock-transfers/${transfer.id}/receive`)
      .auth(editorToken, { type: 'bearer' })
      .expect(201);
    const received = (
      await call('get', `/stock-transfers/${transfer.id}`).expect(200)
    ).body;
    expect(received.createdBy.id).toBe(created.createdById);
    expect(received.actionUsers.Dispatched.id).toBe(created.createdById);
    expect(received.actionUsers.Received.id).toBe(editor.id);
    const immediate = (
      await call('post', '/stock-transfers', {
        fromLocationId: locationId,
        toLocationId: destination,
        shipImmediately: true,
        lines: [{ itemId: otherId, quantity: 1 }],
      }).expect(201)
    ).body;
    expect(immediate.actionUsers.Received.id).toBe(created.createdById);
    const general = (
      await call('post', '/inquiries', {
        message: 'Internal material question',
      }).expect(201)
    ).body;
    expect(general.subject).toBe('General inquiry');
    expect(general.createdBy.id).toBe(general.createdById);
  });
  it('offers unstocked catalog products to inquiry staff without exposing inventory or costs', async () => {
    const item = await db.getRepository(Item).save(
      db.getRepository(Item).create({
        description: 'Unstocked ' + randomUUID(),
        unitId: u('PCS'),
        unit: 'pcs',
        itemType: 'FINISHED' as never,
      }),
    );
    const permissions = await db
      .getRepository(Permission)
      .findBy({ code: In(['inquiries.read', 'inquiries.write']) });
    const role = await db
      .getRepository(Role)
      .save(
        db
          .getRepository(Role)
          .create({ name: 'Inquiry clerk ' + randomUUID(), permissions }),
      );
    const email = randomUUID() + '@example.test',
      password = 'InquiryClerkTest123!';
    await db.getRepository(User).save(
      db.getRepository(User).create({
        email,
        fullName: 'Inquiry clerk',
        passwordHash: await hash(password, 10),
        roleId: role.id,
      }),
    );
    const clerk = (
      await request(app.getHttpServer())
        .post(api + '/auth/login')
        .send({ email, password })
        .expect(201)
    ).body.accessToken;
    await request(app.getHttpServer())
      .get(api + '/inventory')
      .auth(clerk, { type: 'bearer' })
      .expect(403);
    const catalog = await request(app.getHttpServer())
      .get(api + '/inquiries/catalog')
      .query({ search: item.description })
      .auth(clerk, { type: 'bearer' })
      .expect(200);
    expect(catalog.body.data[0]).toMatchObject({
      id: item.id,
      itemType: 'FINISHED',
      unitId: u('PCS'),
    });
    expect(catalog.body.data[0].quantity).toBeUndefined();
    expect(catalog.body.data[0].purchasePrice).toBeUndefined();
  });
  it('summarizes all filtered records across pages without double-counting products', async () => {
    const tag = 'Inquiry summary ' + randomUUID();
    const records = [] as { id: string }[];
    for (let i = 0; i < 3; i++)
      records.push(
        (
          await call('post', '/inquiries', {
            message: tag,
            customerId,
            lines: [
              { itemId: fabricId, quantity: 1 },
              { itemId: otherId, quantity: 1 },
            ],
          }).expect(201)
        ).body,
      );
    await call('post', `/inquiries/${records[0].id}/claim`).expect(201);
    await call('post', `/inquiries/${records[1].id}/confirm`).expect(201);
    const result = (
      await call(
        'get',
        `/inquiries?search=${encodeURIComponent(tag)}&limit=1`,
      ).expect(200)
    ).body;
    expect(result.data).toHaveLength(1);
    const nextPage = (
      await call(
        'get',
        `/inquiries?search=${encodeURIComponent(tag)}&limit=1&page=2`,
      ).expect(200)
    ).body;
    expect(nextPage.data[0].id).not.toBe(result.data[0].id);
    expect(result.meta.total).toBe(3);
    expect(result.totals).toEqual({
      total: 3,
      converted: 0,
      byStatus: { NEW: 1, IN_PROGRESS: 1, QUOTED: 1 },
    });
    const filtered = (
      await call(
        'get',
        `/inquiries?search=${encodeURIComponent(tag)}&status=QUOTED`,
      ).expect(200)
    ).body;
    expect(filtered.meta.total).toBe(1);
    expect(filtered.totals.byStatus).toEqual({ QUOTED: 1 });
    const reference = (
      await call(
        'get',
        `/inquiries?search=INQ-${records[0].id.slice(0, 8)}`,
      ).expect(200)
    ).body;
    expect(
      reference.data.some((r: { id: string }) => r.id === records[0].id),
    ).toBe(true);
  });
  it('uses explicit workflow actions and closes without pretending a sale was created', async () => {
    const source = (
      await call('post', '/inquiries', { message: 'Review then close' }).expect(
        201,
      )
    ).body;
    await call('patch', `/inquiries/${source.id}`, { status: 'QUOTED' }).expect(
      400,
    );
    const closed = (
      await call('post', `/inquiries/${source.id}/close`).expect(201)
    ).body;
    expect(closed.status).toBe('CLOSED');
    expect(closed.convertedSaleId).toBeNull();
    expect(closed.actionUsers.Closed.id).toBe(source.createdById);
    await call('post', `/inquiries/${source.id}/close`).expect(201);
    await call('post', `/inquiries/${source.id}/claim`).expect(400);
    await call('post', `/inquiries/${source.id}/confirm`).expect(400);
    await call('delete', `/inquiries/${source.id}`).expect(400);
    await call('patch', `/inquiries/${source.id}`, { status: 'NEW' }).expect(
      400,
    );
    const cancelled = (
      await call('post', '/inquiries', { message: 'Cancelled request' }).expect(
        201,
      )
    ).body;
    await call('delete', `/inquiries/${cancelled.id}`).expect(200);
    await call('post', `/inquiries/${cancelled.id}/close`).expect(400);
  });
  it('stores entered units and normalized stock quantities without moving inventory', async () => {
    await factor(50);
    const result = await inquiry(
      [{ itemId: fabricId, unitId: u('ROLL'), quantity: 2 }],
      { requestedDeliveryDate: '2030-11-15' },
    ).expect(201);
    expect(result.body.lines[0]).toMatchObject({
      quantity: '100.000',
      unitSnapshot: { quantity: '2', factor: '50', unitId: u('ROLL') },
    });
    expect(result.body.requestedDeliveryDate).toBe('2030-11-15');
    await factor(40);
    const header = await call('patch', '/inquiries/' + result.body.id, {
      subject: 'Updated header',
    }).expect(200);
    expect(header.body.lines[0].id).toBe(result.body.lines[0].id);
    expect(header.body.lines[0].unitSnapshot.factor).toBe('50');
    const notes = await call('patch', '/inquiries/' + result.body.id, {
      lines: [
        { itemId: fabricId, unitId: u('ROLL'), quantity: 2, notes: 'Blue' },
      ],
    }).expect(200);
    expect(notes.body.lines[0].quantity).toBe('100.000');
    const next = await inquiry([
      { itemId: fabricId, unitId: u('ROLL'), quantity: 2 },
    ]).expect(201);
    expect(next.body.lines[0].quantity).toBe('80.000');
  });
  it('normalizes width x length into the preferred area reference unit', async () => {
    const group = (
      await call('post', '/units/groups', {
        name: 'CM2 group ' + randomUUID(),
        category: 'AREA',
        baseUnitId: u('CM2'),
        conversions: [{ unitId: u('M2'), factor: 10000 }],
      }).expect(201)
    ).body;
    const item = (
      await stock(u('CM2'), { unitGroupId: group.id, quantity: 60000 })
    ).itemId;
    const result = await inquiry([
      {
        itemId: item,
        unitId: u('M2'),
        quantity: 3,
        dimensions: { widthMetres: 1.5, lengthMetres: 2, count: 1 },
      },
    ]).expect(201);
    expect(result.body.lines[0]).toMatchObject({
      quantity: '30000.000',
      unitSnapshot: {
        quantity: '3',
        factor: '10000',
        squareMetreFactor: '10000',
        dimensions: { widthMetres: 1.5, lengthMetres: 2, count: 1 },
      },
    });
    await call('patch', '/units/groups/' + group.id, {
      name: group.name,
      category: 'AREA',
      baseUnitId: u('CM2'),
      conversions: [{ unitId: u('M2'), factor: 20000 }],
    }).expect(200);
    await call('post', `/inquiries/${result.body.id}/confirm`).expect(201);
    const areaSale = await call('post', '/sales', {
      inquiryId: result.body.id,
      customerId,
      locationId,
      paymentMethod: 'CREDIT',
      lines: [
        {
          itemId: item,
          unitId: u('M2'),
          inquiryLineId: result.body.lines[0].id,
          quantity: 3,
          unitPrice: 15,
          dimensions: { widthMetres: 1.5, lengthMetres: 2, count: 1 },
        },
      ],
    }).expect(201);
    expect(areaSale.body.lines[0].quantity).toBe('30000.000');
    await inquiry([
      {
        itemId: item,
        unitId: u('M2'),
        quantity: 4,
        dimensions: { widthMetres: 1.5, lengthMetres: 2, count: 1 },
      },
    ]).expect(400);
  });
  it('rejects invalid lines atomically and retains old lines after failed updates', async () => {
    const before = await db.getRepository(CustomerInquiry).count();
    await inquiry([
      { itemId: fabricId, quantity: 2 },
      { itemId: randomUUID(), quantity: 1 },
    ]).expect(400);
    expect(await db.getRepository(CustomerInquiry).count()).toBe(before);
    const result = await inquiry([{ itemId: fabricId, quantity: 2 }]).expect(
      201,
    );
    await call('patch', '/inquiries/' + result.body.id, {
      subject: 'Must roll back',
      lines: [{ itemId: randomUUID(), quantity: 1 }],
    }).expect(400);
    const existing = await call('get', '/inquiries/' + result.body.id).expect(
      200,
    );
    expect(existing.body.subject).toBe('Custom furniture request');
    expect(existing.body.lines).toHaveLength(1);
    await inquiry([{ itemId: otherId, quantity: 1.5 }]).expect(400);
    await inquiry([{ itemId: fabricId, quantity: 0 }]).expect(400);
    await inquiry([{ itemId: fabricId, quantity: 1 }], {
      requestedDeliveryDate: '2030-02-31',
    }).expect(400);
  });
  it('preserves unknown quantities on legacy/general interest and requires them for confirmation', async () => {
    const result = await inquiry([{ itemId: fabricId }]).expect(201);
    expect(result.body.lines[0].quantity).toBeNull();
    await call('post', `/inquiries/${result.body.id}/confirm`).expect(400);
    await call('patch', '/inquiries/' + result.body.id, {
      subject: 'Interest only',
    }).expect(200);
    expect(
      (await call('get', '/inquiries/' + result.body.id)).body.lines[0]
        .quantity,
    ).toBeNull();
  });
  it('keeps inquiry conversion and price totals when creating a sale after group changes', async () => {
    await factor(50);
    const source = (
      await inquiry([{ itemId: fabricId, unitId: u('ROLL'), quantity: 1 }], {
        customerId,
      }).expect(201)
    ).body;
    await call('post', `/inquiries/${source.id}/confirm`).expect(201);
    await factor(40);
    const sale = await call('post', '/sales', {
      locationId,
      customerId,
      inquiryId: source.id,
      paymentMethod: 'CREDIT',
      lines: [
        {
          itemId: fabricId,
          unitId: u('ROLL'),
          inquiryLineId: source.lines[0].id,
          quantity: 1,
          unitPrice: 100,
        },
      ],
    }).expect(201);
    expect(sale.body.lines[0]).toMatchObject({
      quantity: '50.000',
      unitSnapshot: { factor: '50', quantity: '1', unitPrice: '100' },
    });
    expect(Number(sale.body.subtotal)).toBe(100);
    await call('patch', '/inquiries/' + source.id, {
      convertedSaleId: sale.body.id,
      lines: [{ itemId: fabricId, quantity: 50 }],
    }).expect(200);
    expect(
      (await call('get', '/inquiries/' + source.id)).body.lines[0].unitSnapshot
        .factor,
    ).toBe('50');
    await call('patch', '/inquiries/' + source.id, {
      convertedSaleId: randomUUID(),
    }).expect(400);
  });
  it('serializes concurrent sale handoffs for the same inquiry', async () => {
    const source = (
      await inquiry([{ itemId: fabricId, quantity: 1 }], { customerId }).expect(
        201,
      )
    ).body;
    await call('post', `/inquiries/${source.id}/confirm`).expect(201);
    const body = {
      inquiryId: source.id,
      customerId,
      locationId,
      paymentMethod: 'CREDIT',
      lines: [
        {
          itemId: fabricId,
          unitId: u('M'),
          inquiryLineId: source.lines[0].id,
          quantity: 1,
          unitPrice: 10,
        },
      ],
    };
    const results = await Promise.all([
      call('post', '/sales', body),
      call('post', '/sales', body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    await call('post', `/inquiries/${source.id}/confirm`).expect(400);
    await call('patch', `/inquiries/${source.id}`, { status: 'NEW' }).expect(
      400,
    );
    expect(
      (await call('get', `/inquiries/${source.id}`)).body.convertedSaleId,
    ).toBeTruthy();
    const closed = (
      await call('post', `/inquiries/${source.id}/close`).expect(201)
    ).body;
    expect(closed.convertedSaleId).toBeTruthy();
    const convertedSummary = (
      await call(
        'get',
        `/inquiries?search=INQ-${source.id.slice(0, 8)}`,
      ).expect(200)
    ).body;
    expect(convertedSummary.totals.converted).toBeGreaterThanOrEqual(1);
  });
  it('rejects stale inquiry line references and manual conversion status changes', async () => {
    const source = (
      await inquiry([{ itemId: fabricId, unitId: u('ROLL'), quantity: 1 }], {
        customerId,
      }).expect(201)
    ).body;
    await call('patch', '/inquiries/' + source.id, {
      status: 'CONVERTED',
    }).expect(400);
    await call('patch', '/inquiries/' + source.id, {
      lines: [{ itemId: fabricId, unitId: u('ROLL'), quantity: 2 }],
    }).expect(200);
    await call('patch', `/inquiries/${source.id}`, {
      convertedSaleId: null,
    }).expect(200);
    await call('post', `/inquiries/${source.id}/confirm`).expect(201);
    await call('post', '/sales', {
      locationId,
      customerId,
      inquiryId: source.id,
      paymentMethod: 'CREDIT',
      lines: [
        {
          itemId: fabricId,
          unitId: u('ROLL'),
          inquiryLineId: source.lines[0].id,
          quantity: 1,
          unitPrice: 100,
        },
      ],
    }).expect(400);
  });
  it('creates production for the selected inquiry product using base quantities and its saved snapshot', async () => {
    await factor(50);
    await call('post', '/boms', {
      name: 'Fabric BOM ' + randomUUID(),
      finishedItemId: fabricId,
      isDefault: true,
      lines: [{ componentItemId: otherId, quantity: 1 }],
    }).expect(201);
    const source = (
      await inquiry([
        { itemId: otherId, quantity: 7 },
        { itemId: fabricId, unitId: u('ROLL'), quantity: 2 },
      ]).expect(201)
    ).body;
    await call('post', `/inquiries/${source.id}/confirm`).expect(201);
    await factor(40);
    const order = await call('post', '/production-orders/from-inquiry', {
      inquiryId: source.id,
      itemId: fabricId,
      locationId,
    }).expect(201);
    expect(order.body.quantityPlanned).toBe('100.000');
    expect(order.body.unitSnapshot.factor).toBe('50');
    expect(order.body.lines[0].quantityRequired).toBe('100.000');
    const detail = (await call('get', `/inquiries/${source.id}`).expect(200))
      .body;
    expect(detail.productionOrders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: order.body.id, status: 'DRAFT' }),
      ]),
    );
    expect(detail.productionOrders[0].lines).toBeUndefined();
    const list = (
      await call(
        'get',
        `/inquiries?search=INQ-${source.id.slice(0, 8)}`,
      ).expect(200)
    ).body;
    expect(
      list.data.find((r: { id: string }) => r.id === source.id).hasProduction,
    ).toBe(true);
  });
  it('stores reference files privately, deduplicates retries and rejects invalid files', async () => {
    const source = (
      await inquiry([{ itemId: fabricId, quantity: 1 }]).expect(201)
    ).body;
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
      'base64',
    );
    const upload = () =>
      call('post', `/inquiries/${source.id}/attachments`).attach('files', png, {
        filename: 'reference.png',
        contentType: 'image/png',
      });
    const result = await upload().expect(201);
    expect(result.body).toHaveLength(1);
    expect(result.body[0].data).toBeUndefined();
    expect(result.body[0].hash).toBeUndefined();
    await upload().expect(201);
    const fileId = result.body[0].id;
    const download = await call(
      'get',
      `/inquiries/${source.id}/attachments/${fileId}`,
    ).expect(200);
    expect(download.body).toEqual(png);
    await request(app.getHttpServer())
      .get(`${api}/inquiries/${source.id}/attachments/${fileId}`)
      .expect(401);
    await call(
      'get',
      `/inquiries/${randomUUID()}/attachments/${fileId}`,
    ).expect(404);
    await call('post', `/inquiries/${source.id}/attachments`)
      .attach('files', Buffer.from('<script>bad</script>'), {
        filename: 'bad.png',
        contentType: 'image/png',
      })
      .expect(400);
    await call('post', `/inquiries/${source.id}/attachments`)
      .attach('files', Buffer.alloc(6 * 1024 * 1024), {
        filename: 'large.png',
        contentType: 'image/png',
      })
      .expect(413);
    const capped = call('post', `/inquiries/${source.id}/attachments`);
    for (let i = 0; i < 4; i++)
      capped.attach('files', Buffer.from('%PDF-1.4\nReference ' + i), {
        filename: `reference-${i}.pdf`,
        contentType: 'application/pdf',
      });
    expect((await capped.expect(201)).body).toHaveLength(5);
    await call('post', `/inquiries/${source.id}/attachments`)
      .attach('files', Buffer.from('%PDF-1.4\nExtra'), {
        filename: 'extra.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);
    expect(
      (await call('get', '/inquiries/' + source.id)).body.attachments,
    ).toHaveLength(5);
    await call(
      'delete',
      `/inquiries/${source.id}/attachments/${fileId}`,
    ).expect(200);
    await call('get', `/inquiries/${source.id}/attachments/${fileId}`).expect(
      404,
    );
    expect(
      await db
        .getRepository(CustomerInquiryLine)
        .countBy({ inquiryId: source.id }),
    ).toBe(1);
  });
});
