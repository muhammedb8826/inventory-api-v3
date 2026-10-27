import { MigrationInterface, QueryRunner } from 'typeorm';

export class StockMovementsAndSkuUnique1749020000000
  implements MigrationInterface
{
  name = 'StockMovementsAndSkuUnique1749020000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "stock_movements_type_enum" AS ENUM (
          'SALE',
          'SALE_VOID',
          'SALE_REVERSAL',
          'PURCHASE',
          'PURCHASE_VOID',
          'PURCHASE_REVERSAL',
          'TRANSFER_OUT',
          'TRANSFER_IN',
          'ADJUSTMENT',
          'PRODUCTION_ISSUE',
          'PRODUCTION_RECEIPT',
          'PRODUCTION_REVERSE',
          'OPENING',
          'IMPORT'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "stock_movements" (
        "id" uuid NOT NULL,
        "location_id" uuid NOT NULL,
        "item_id" uuid NOT NULL,
        "type" "stock_movements_type_enum" NOT NULL,
        "quantity_delta" numeric(14,3) NOT NULL,
        "quantity_before" numeric(14,3) NOT NULL,
        "quantity_after" numeric(14,3) NOT NULL,
        "unit_cost" numeric(14,2),
        "ref_type" character varying(40),
        "ref_id" uuid,
        "notes" text,
        "created_by_id" uuid,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_stock_movements" PRIMARY KEY ("id"),
        CONSTRAINT "FK_stock_movements_location" FOREIGN KEY ("location_id")
          REFERENCES "locations"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_stock_movements_item" FOREIGN KEY ("item_id")
          REFERENCES "items"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_stock_movements_user" FOREIGN KEY ("created_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stock_movements_location_created"
      ON "stock_movements" ("location_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stock_movements_item_created"
      ON "stock_movements" ("item_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stock_movements_ref"
      ON "stock_movements" ("ref_type", "ref_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_stock_movements_type_created"
      ON "stock_movements" ("type", "created_at")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_items_sku_not_null"
      ON "items" ("sku")
      WHERE "sku" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_items_sku_not_null"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "stock_movements"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "stock_movements_type_enum"`);
  }
}
