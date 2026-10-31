import { randomUUID } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import db from '../src/database/data-source';
import { Item, StockLevel } from '../src/database/entities';
import { UnitGroup } from '../src/database/entities/unit-group.entity';
import { UnitGroupTimestampColumns1749220000000 } from '../src/database/migrations/1749220000000-UnitGroupTimestampColumns';

describe('Unit-group timestamps on upgraded PostgreSQL databases', () => {
  let connection: DataSource, q: QueryRunner;
  const migration = new UnitGroupTimestampColumns1749220000000();
  const created = '2021-02-03T04:05:06.000Z';
  const updated = '2023-07-08T09:10:11.000Z';
  beforeAll(async () => {
    connection = await db.initialize();
  });
  afterAll(async () => {
    if (connection?.isInitialized) await connection.destroy();
  });
  beforeEach(async () => {
    q = connection.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    const schema = 'timestamp_repair_' + randomUUID().replaceAll('-', '');
    await q.query(`CREATE SCHEMA "${schema}"`);
    await q.query(`SET LOCAL search_path TO "${schema}", public`);
    for (const table of ['unit_groups', 'items', 'stock_levels'])
      await q.query(
        `CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    await q.query(`ALTER TABLE unit_groups
      ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
      ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC'`);
  });
  afterEach(async () => {
    await q.rollbackTransaction();
    await q.release();
  });
  async function insertGroup() {
    const id = randomUUID();
    await q.query(
      `INSERT INTO unit_groups(id,name,category,base_unit_id,created_at,updated_at)
      VALUES ($1,'Test family','COUNT','10000000-0000-4000-8000-000000000001',$2,$3)`,
      [id, created, updated],
    );
    return id;
  }
  it('repairs the historical layout and allows group, item and dashboard stock queries', async () => {
    const id = await insertGroup();
    await q.query(
      'ALTER TABLE unit_groups RENAME COLUMN created_at TO "createdAt"',
    );
    await q.query(
      'ALTER TABLE unit_groups RENAME COLUMN updated_at TO "updatedAt"',
    );
    const itemId = randomUUID();
    await q.query(
      `INSERT INTO items(id,description,unit_id,unit_group_id,item_type)
      VALUES ($1,'Existing item','10000000-0000-4000-8000-000000000001',$2,'FINISHED')`,
      [itemId, id],
    );
    await q.query(
      `INSERT INTO stock_levels(id,item_id,location_id,quantity,purchase_price) VALUES ($1,$2,$3,7,12.5)`,
      [randomUUID(), itemId, randomUUID()],
    );
    await q.query('SAVEPOINT before_legacy_query');
    await expect(
      q.manager.getRepository(UnitGroup).findOneByOrFail({ id }),
    ).rejects.toMatchObject({ driverError: { code: '42703' } });
    await q.query('ROLLBACK TO SAVEPOINT before_legacy_query');
    await migration.up(q);
    await migration.up(q); // Safe even after a manual repair or successful prior run.
    const group = await q.manager
      .getRepository(UnitGroup)
      .findOneByOrFail({ id });
    expect(group.createdAt.toISOString()).toBe(created);
    expect(group.updatedAt.toISOString()).toBe(updated);
    const item = await q.manager
      .getRepository(Item)
      .findOneByOrFail({ id: itemId });
    expect(item.unitGroup!.createdAt.toISOString()).toBe(created);
    const stocks = await q.manager
      .getRepository(StockLevel)
      .find({ relations: { item: true, location: true } });
    expect(stocks[0].item.unitGroup!.updatedAt.toISOString()).toBe(updated);
    expect(stocks[0].quantity).toBe('7.000');
    expect(stocks[0].purchasePrice).toBe('12.5000000000');
  });
  it('keeps canonical timestamps unchanged on already-correct databases', async () => {
    const id = await insertGroup();
    await migration.up(q);
    const group = await q.manager
      .getRepository(UnitGroup)
      .findOneByOrFail({ id });
    expect(group.createdAt.toISOString()).toBe(created);
    expect(group.updatedAt.toISOString()).toBe(updated);
  });
  it('preserves both layouts and fills only missing canonical values', async () => {
    const id = await insertGroup();
    await q.query(
      'ALTER TABLE unit_groups ADD COLUMN "createdAt" timestamptz, ADD COLUMN "updatedAt" timestamptz',
    );
    await q.query(
      `UPDATE unit_groups SET "createdAt"='2000-01-01T00:00:00Z', "updatedAt"='2000-01-01T00:00:00Z'`,
    );
    await q.query(
      'ALTER TABLE unit_groups ALTER COLUMN updated_at DROP NOT NULL',
    );
    await q.query('UPDATE unit_groups SET updated_at=NULL');
    await migration.up(q);
    const row = (
      await q.query('SELECT * FROM unit_groups WHERE id=$1', [id])
    )[0];
    expect(row.created_at.toISOString()).toBe(created);
    expect(row.createdAt.toISOString()).toBe('2000-01-01T00:00:00.000Z');
    expect(row.updated_at.toISOString()).toBe('2000-01-01T00:00:00.000Z');
  });
});
