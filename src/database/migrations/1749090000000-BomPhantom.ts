import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Industry phantom / non-stocked assembly:
 * - items.is_phantom: default manufacturing policy for the item
 * - bom_lines.is_phantom: per-BOM override (true = pass-through to child BOM)
 */
export class BomPhantom1749090000000 implements MigrationInterface {
  name = 'BomPhantom1749090000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "items"
        ADD COLUMN IF NOT EXISTS "is_phantom" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "bom_lines"
        ADD COLUMN IF NOT EXISTS "is_phantom" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bom_lines" DROP COLUMN IF EXISTS "is_phantom"`,
    );
    await queryRunner.query(
      `ALTER TABLE "items" DROP COLUMN IF EXISTS "is_phantom"`,
    );
  }
}
