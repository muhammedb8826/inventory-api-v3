import { MigrationInterface, QueryRunner } from 'typeorm';

/** Textile-style fabric: stock in LENGTH; width/shade as characteristics. */
export class FabricLengthIndustryModel1749280000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(
      `ALTER TABLE items ADD COLUMN IF NOT EXISTS default_width_metres numeric(14,3) CHECK (default_width_metres IS NULL OR default_width_metres > 0)`,
    );
    await q.query(
      `ALTER TABLE product_families ADD COLUMN IF NOT EXISTS default_width_metres numeric(14,3) CHECK (default_width_metres IS NULL OR default_width_metres > 0)`,
    );
    await q.query(
      `ALTER TABLE stock_lots ADD COLUMN IF NOT EXISTS width_metres numeric(14,3) CHECK (width_metres IS NULL OR width_metres > 0)`,
    );
    await q.query(
      `ALTER TABLE stock_lots ADD COLUMN IF NOT EXISTS shade varchar(80)`,
    );
  }

  async down(q: QueryRunner) {
    await q.query(`ALTER TABLE stock_lots DROP COLUMN IF EXISTS shade`);
    await q.query(`ALTER TABLE stock_lots DROP COLUMN IF EXISTS width_metres`);
    await q.query(
      `ALTER TABLE product_families DROP COLUMN IF EXISTS default_width_metres`,
    );
    await q.query(
      `ALTER TABLE items DROP COLUMN IF EXISTS default_width_metres`,
    );
  }
}
