import { MigrationInterface, QueryRunner } from 'typeorm';

export class P2ReservationsTransfersBarcodeIdempotency1749060000000
  implements MigrationInterface
{
  name = 'P2ReservationsTransfersBarcodeIdempotency1749060000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "stock_levels"
      ADD COLUMN IF NOT EXISTS "reserved" numeric(14,3) NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      ALTER TABLE "items"
      ADD COLUMN IF NOT EXISTS "barcode" character varying(80)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_items_barcode_not_null"
      ON "items" ("barcode")
      WHERE "barcode" IS NOT NULL
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TYPE "stock_transfers_status_enum" ADD VALUE IF NOT EXISTS 'IN_TRANSIT';
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "stock_transfer_lines"
      ADD COLUMN IF NOT EXISTS "unit_cost" numeric(14,2)
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TYPE "stock_movements_type_enum" ADD VALUE IF NOT EXISTS 'SALE_RETURN';
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "idempotency_keys" (
        "id" uuid NOT NULL,
        "key" character varying(128) NOT NULL,
        "user_id" uuid,
        "method" character varying(16) NOT NULL,
        "route" character varying(200) NOT NULL,
        "status_code" integer NOT NULL,
        "response_body" jsonb,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_idempotency_keys" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_idempotency_keys_scope" UNIQUE ("key", "user_id", "method", "route")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_idempotency_keys_created"
      ON "idempotency_keys" ("created_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sale_returns" (
        "id" uuid NOT NULL,
        "sale_id" uuid NOT NULL,
        "location_id" uuid NOT NULL,
        "notes" text,
        "status" character varying(20) NOT NULL DEFAULT 'ACTIVE',
        "created_by_id" uuid,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sale_returns" PRIMARY KEY ("id"),
        CONSTRAINT "FK_sale_returns_sale" FOREIGN KEY ("sale_id")
          REFERENCES "sales"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_sale_returns_location" FOREIGN KEY ("location_id")
          REFERENCES "locations"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_sale_returns_user" FOREIGN KEY ("created_by_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sale_return_lines" (
        "id" uuid NOT NULL,
        "return_id" uuid NOT NULL,
        "sale_line_id" uuid,
        "item_id" uuid NOT NULL,
        "quantity" numeric(14,3) NOT NULL,
        "unit_price" numeric(14,2) NOT NULL DEFAULT 0,
        CONSTRAINT "PK_sale_return_lines" PRIMARY KEY ("id"),
        CONSTRAINT "FK_sale_return_lines_return" FOREIGN KEY ("return_id")
          REFERENCES "sale_returns"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_sale_return_lines_item" FOREIGN KEY ("item_id")
          REFERENCES "items"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sale_returns_sale"
      ON "sale_returns" ("sale_id", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sale_return_lines"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sale_returns"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "idempotency_keys"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_items_barcode_not_null"`);
    await queryRunner.query(`
      ALTER TABLE "items" DROP COLUMN IF EXISTS "barcode"
    `);
    await queryRunner.query(`
      ALTER TABLE "stock_levels" DROP COLUMN IF EXISTS "reserved"
    `);
  }
}
