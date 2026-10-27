import { MigrationInterface, QueryRunner } from 'typeorm';

export class IndustryInventoryUpgrades1749070000000
  implements MigrationInterface
{
  name = 'IndustryInventoryUpgrades1749070000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TYPE "locations_type_enum" ADD VALUE IF NOT EXISTS 'BIN';
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "stocktakes_status_enum" AS ENUM (
          'DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TYPE "stock_movements_type_enum" ADD VALUE IF NOT EXISTS 'STOCKTAKE';
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "locations"
        ADD COLUMN IF NOT EXISTS "parent_id" uuid NULL
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "locations"
          ADD CONSTRAINT "FK_locations_parent"
          FOREIGN KEY ("parent_id") REFERENCES "locations"("id")
          ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_locations" (
        "user_id" uuid NOT NULL,
        "location_id" uuid NOT NULL,
        CONSTRAINT "PK_user_locations" PRIMARY KEY ("user_id", "location_id"),
        CONSTRAINT "FK_user_locations_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_user_locations_location"
          FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "stocktakes" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "location_id" uuid NOT NULL,
        "status" "stocktakes_status_enum" NOT NULL DEFAULT 'DRAFT',
        "notes" text NULL,
        "created_by_id" uuid NULL,
        "completed_at" TIMESTAMPTZ NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "FK_stocktakes_location"
          FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_stocktakes_user"
          FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "stocktake_lines" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "stocktake_id" uuid NOT NULL,
        "item_id" uuid NOT NULL,
        "system_qty" numeric(14,3) NOT NULL,
        "counted_qty" numeric(14,3) NULL,
        CONSTRAINT "FK_stocktake_lines_session"
          FOREIGN KEY ("stocktake_id") REFERENCES "stocktakes"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_stocktake_lines_item"
          FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "stock_lots" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "location_id" uuid NOT NULL,
        "item_id" uuid NOT NULL,
        "lot_number" varchar(80) NOT NULL,
        "expiry_date" date NULL,
        "quantity" numeric(14,3) NOT NULL DEFAULT 0,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_stock_lots_loc_item_lot"
          UNIQUE ("location_id", "item_id", "lot_number"),
        CONSTRAINT "FK_stock_lots_location"
          FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_stock_lots_item"
          FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "stock_movements"
        ADD COLUMN IF NOT EXISTS "lot_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "lot_number" varchar(80) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP COLUMN IF EXISTS "lot_number"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP COLUMN IF EXISTS "lot_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "stock_lots"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "stocktake_lines"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "stocktakes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_locations"`);
    await queryRunner.query(
      `ALTER TABLE "locations" DROP CONSTRAINT IF EXISTS "FK_locations_parent"`,
    );
    await queryRunner.query(
      `ALTER TABLE "locations" DROP COLUMN IF EXISTS "parent_id"`,
    );
  }
}
