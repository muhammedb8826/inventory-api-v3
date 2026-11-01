import { MigrationInterface, QueryRunner } from 'typeorm';
export class FamilyPricing1749260000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(
      `ALTER TABLE product_families ADD COLUMN IF NOT EXISTS price_rules jsonb NOT NULL DEFAULT '{"basePrice":null,"extras":[]}'`,
    );
  }
  async down() {
    /* Preserve configured prices. */
  }
}
