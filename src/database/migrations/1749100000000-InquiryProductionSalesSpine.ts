import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Link inquiry → production → sale for make-to-order furniture flow.
 */
export class InquiryProductionSalesSpine1749100000000 implements MigrationInterface {
  name = 'InquiryProductionSalesSpine1749100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "production_orders"
        ADD COLUMN IF NOT EXISTS "inquiry_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "sale_id" uuid NULL
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "production_orders"
          ADD CONSTRAINT "FK_production_orders_inquiry"
          FOREIGN KEY ("inquiry_id") REFERENCES "customer_inquiries"("id")
          ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "production_orders"
          ADD CONSTRAINT "FK_production_orders_sale"
          FOREIGN KEY ("sale_id") REFERENCES "sales"("id")
          ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_production_orders_inquiry"
        ON "production_orders" ("inquiry_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_production_orders_sale"
        ON "production_orders" ("sale_id")
    `);

    await queryRunner.query(`
      ALTER TABLE "customer_inquiries"
        ADD COLUMN IF NOT EXISTS "ready_for_sale_at" TIMESTAMPTZ NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "sales"
        ADD COLUMN IF NOT EXISTS "inquiry_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "production_order_id" uuid NULL
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "sales"
          ADD CONSTRAINT "FK_sales_inquiry"
          FOREIGN KEY ("inquiry_id") REFERENCES "customer_inquiries"("id")
          ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "sales"
          ADD CONSTRAINT "FK_sales_production_order"
          FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id")
          ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT IF EXISTS "FK_sales_production_order"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT IF EXISTS "FK_sales_inquiry"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP COLUMN IF EXISTS "production_order_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP COLUMN IF EXISTS "inquiry_id"`,
    );

    await queryRunner.query(
      `ALTER TABLE "customer_inquiries" DROP COLUMN IF EXISTS "ready_for_sale_at"`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_production_orders_sale"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_production_orders_inquiry"`,
    );
    await queryRunner.query(
      `ALTER TABLE "production_orders" DROP CONSTRAINT IF EXISTS "FK_production_orders_sale"`,
    );
    await queryRunner.query(
      `ALTER TABLE "production_orders" DROP CONSTRAINT IF EXISTS "FK_production_orders_inquiry"`,
    );
    await queryRunner.query(
      `ALTER TABLE "production_orders" DROP COLUMN IF EXISTS "sale_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "production_orders" DROP COLUMN IF EXISTS "inquiry_id"`,
    );
  }
}
