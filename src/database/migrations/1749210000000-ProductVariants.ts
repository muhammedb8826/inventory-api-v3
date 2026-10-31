import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductVariants1749210000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS product_attributes (
      id uuid PRIMARY KEY, name varchar(80) NOT NULL UNIQUE, "values" jsonb NOT NULL DEFAULT '[]',
      is_active boolean NOT NULL DEFAULT true, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now())`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS product_attribute_name_ci ON product_attributes (lower(name))`,
    );
    await q.query(`CREATE TABLE IF NOT EXISTS product_families (
      id uuid PRIMARY KEY, name varchar(160) NOT NULL, description text NOT NULL DEFAULT '',
      item_type items_item_type_enum NOT NULL DEFAULT 'FINISHED', unit_id uuid NOT NULL REFERENCES units_of_measure(id),
      unit_group_id uuid REFERENCES unit_groups(id), attributes jsonb NOT NULL DEFAULT '[]',
      is_active boolean NOT NULL DEFAULT true, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now())`);
    await q.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS product_family_id uuid REFERENCES product_families(id),
      ADD COLUMN IF NOT EXISTS variant_key text, ADD COLUMN IF NOT EXISTS variant_values jsonb NOT NULL DEFAULT '[]'`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS item_family_variant_unique ON items (product_family_id, variant_key) WHERE product_family_id IS NOT NULL`,
    );
    await q.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='item_variant_membership' AND conrelid='items'::regclass) THEN ALTER TABLE items ADD CONSTRAINT item_variant_membership CHECK ((product_family_id IS NULL AND variant_key IS NULL) OR (product_family_id IS NOT NULL AND variant_key IS NOT NULL)); END IF; END $$`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE items DROP CONSTRAINT item_variant_membership');
    await q.query(
      'ALTER TABLE items DROP COLUMN variant_values, DROP COLUMN variant_key, DROP COLUMN product_family_id',
    );
    await q.query('DROP TABLE product_families');
    await q.query('DROP TABLE product_attributes');
  }
}
