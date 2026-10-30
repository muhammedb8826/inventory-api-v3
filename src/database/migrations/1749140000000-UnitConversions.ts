import { MigrationInterface, QueryRunner } from 'typeorm';
export class UnitConversions1749140000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(
      `ALTER TABLE items ADD COLUMN IF NOT EXISTS unit_conversions jsonb NOT NULL DEFAULT '[]'::jsonb`,
    );
    for (const table of [
      'purchase_lines',
      'sale_lines',
      'bom_lines',
      'stock_transfer_lines',
      'production_orders',
    ])
      await q.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS unit_snapshot jsonb`,
      );
    for (const table of ['purchase_lines', 'sale_lines', 'sale_return_lines'])
      await q.query(
        `ALTER TABLE ${table} ALTER COLUMN unit_price TYPE numeric(22,10)`,
      );
    for (const [table, column] of [
      ['stock_levels', 'purchase_price'],
      ['stock_movements', 'unit_cost'],
      ['stock_transfer_lines', 'unit_cost'],
      ['sale_lines', 'purchase_cost'],
    ])
      await q.query(
        `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE numeric(22,10)`,
      );
    await q.query(`INSERT INTO units_of_measure(id,code,name,symbol,category,decimal_places) VALUES
      ('10000000-0000-4000-8000-000000000011','BOX','Box','box','COUNT',0),
      ('10000000-0000-4000-8000-000000000012','CARTON','Carton','ctn','COUNT',0),
      ('10000000-0000-4000-8000-000000000013','ROLL','Roll','roll','COUNT',0),
      ('10000000-0000-4000-8000-000000000014','MM','Millimetre','mm','LENGTH',3)
      ON CONFLICT(code) DO NOTHING`);
  }
  async down(q: QueryRunner) {
    for (const table of [
      'purchase_lines',
      'sale_lines',
      'bom_lines',
      'stock_transfer_lines',
      'production_orders',
    ])
      await q.query(`ALTER TABLE ${table} DROP COLUMN unit_snapshot`);
    await q.query('ALTER TABLE items DROP COLUMN unit_conversions');
    // Do not delete catalog units or round historical prices during rollback.
  }
}
