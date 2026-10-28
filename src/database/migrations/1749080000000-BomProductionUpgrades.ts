import { MigrationInterface, QueryRunner } from 'typeorm';

export class BomProductionUpgrades1749080000000 implements MigrationInterface {
  name = 'BomProductionUpgrades1749080000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "boms"
        ADD COLUMN IF NOT EXISTS "is_default" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "yield_percent" numeric(7,2) NOT NULL DEFAULT 100,
        ADD COLUMN IF NOT EXISTS "effective_from" date NULL,
        ADD COLUMN IF NOT EXISTS "effective_to" date NULL,
        ADD COLUMN IF NOT EXISTS "revised_from_id" uuid NULL
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "boms"
          ADD CONSTRAINT "FK_boms_revised_from"
          FOREIGN KEY ("revised_from_id") REFERENCES "boms"("id")
          ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_boms_default_finished"
        ON "boms" ("finished_item_id")
        WHERE "is_default" = true AND "is_active" = true
    `);

    await queryRunner.query(`
      ALTER TABLE "production_orders"
        ADD COLUMN IF NOT EXISTS "order_number" varchar(40) NULL,
        ADD COLUMN IF NOT EXISTS "finished_location_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "quantity_scrapped" numeric(14,3) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "materials_reserved" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "production_orders"
          ADD CONSTRAINT "FK_production_orders_finished_location"
          FOREIGN KEY ("finished_location_id") REFERENCES "locations"("id")
          ON DELETE RESTRICT;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      UPDATE "production_orders"
      SET "finished_location_id" = "location_id"
      WHERE "finished_location_id" IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_production_orders_order_number"
        ON "production_orders" ("order_number")
        WHERE "order_number" IS NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "production_order_lines"
        ADD COLUMN IF NOT EXISTS "issued_value" numeric(14,2) NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "production_order_lines" DROP COLUMN IF EXISTS "issued_value"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_production_orders_order_number"`,
    );
    await queryRunner.query(
      `ALTER TABLE "production_orders" DROP CONSTRAINT IF EXISTS "FK_production_orders_finished_location"`,
    );
    await queryRunner.query(`
      ALTER TABLE "production_orders"
        DROP COLUMN IF EXISTS "order_number",
        DROP COLUMN IF EXISTS "finished_location_id",
        DROP COLUMN IF EXISTS "quantity_scrapped",
        DROP COLUMN IF EXISTS "materials_reserved"
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_boms_default_finished"`);
    await queryRunner.query(
      `ALTER TABLE "boms" DROP CONSTRAINT IF EXISTS "FK_boms_revised_from"`,
    );
    await queryRunner.query(`
      ALTER TABLE "boms"
        DROP COLUMN IF EXISTS "is_default",
        DROP COLUMN IF EXISTS "yield_percent",
        DROP COLUMN IF EXISTS "effective_from",
        DROP COLUMN IF EXISTS "effective_to",
        DROP COLUMN IF EXISTS "revised_from_id"
    `);
  }
}
