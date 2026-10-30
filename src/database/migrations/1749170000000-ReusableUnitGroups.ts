import { randomUUID } from 'crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';
export class ReusableUnitGroups1749170000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`CREATE TABLE IF NOT EXISTS unit_groups (
      id uuid PRIMARY KEY, name varchar(100) NOT NULL UNIQUE,
      category varchar(20) NOT NULL, base_unit_id uuid NOT NULL REFERENCES units_of_measure(id),
      conversions jsonb NOT NULL DEFAULT '[]', is_active boolean NOT NULL DEFAULT true,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now())`);
    await q.query(
      'ALTER TABLE items ADD COLUMN IF NOT EXISTS unit_group_id uuid REFERENCES unit_groups(id)',
    );
    await q.query(`INSERT INTO units_of_measure(id,code,name,symbol,category,decimal_places) VALUES
      ('10000000-0000-4000-8000-000000000019','MG','Milligram','mg','MASS',3)
      ON CONFLICT(code) DO NOTHING`);
    for (const [name, category, base, members] of [
      [
        'Mass',
        'MASS',
        'KG',
        [
          ['G', '0.001'],
          ['MG', '0.000001'],
        ],
      ],
      [
        'Length',
        'LENGTH',
        'M',
        [
          ['CM', '0.01'],
          ['MM', '0.001'],
        ],
      ],
      ['Area', 'AREA', 'M2', [['CM2', '0.0001']]],
      [
        'Volume',
        'VOLUME',
        'L',
        [
          ['ML', '0.001'],
          ['M3', '1000'],
        ],
      ],
      ['Time', 'TIME', 'H', [['MIN', '0.016666666666666667']]],
      ['Pieces', 'COUNT', 'PCS', [['DOZEN', '12']]],
    ] as [string, string, string, string[][]][]) {
      await q.query(
        `INSERT INTO unit_groups(id,name,category,base_unit_id,conversions)
        SELECT $5::uuid,$1,$2,b.id,COALESCE((SELECT jsonb_agg(jsonb_build_object('unitId',u.id,'factor',v.factor))
        FROM jsonb_to_recordset($4::jsonb) AS v(code text,factor text)
        JOIN units_of_measure u ON u.code=v.code),'[]'::jsonb)
        FROM units_of_measure b WHERE b.code=$3 ON CONFLICT(name) DO NOTHING`,
        [
          name,
          category,
          base,
          JSON.stringify(members.map(([code, factor]) => ({ code, factor }))),
          randomUUID(),
        ],
      );
    }
    await q.query(`CREATE FUNCTION check_item_unit_group() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE base uuid;
      BEGIN
        IF NEW.unit_group_id IS NOT NULL THEN
          SELECT base_unit_id INTO base FROM unit_groups WHERE id=NEW.unit_group_id FOR SHARE;
          IF base IS DISTINCT FROM NEW.unit_id THEN RAISE EXCEPTION 'Item stock unit must match its unit group base unit' USING ERRCODE='23514'; END IF;
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(
      `CREATE TRIGGER item_unit_group_check BEFORE INSERT OR UPDATE OF unit_id,unit_group_id ON items FOR EACH ROW EXECUTE FUNCTION check_item_unit_group()`,
    );
    await q.query(`CREATE FUNCTION protect_unit_group_base() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.base_unit_id IS DISTINCT FROM OLD.base_unit_id AND EXISTS(SELECT 1 FROM items WHERE unit_group_id=OLD.id) THEN
          RAISE EXCEPTION 'Assigned unit group base cannot change' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(
      `CREATE TRIGGER unit_group_base_lock BEFORE UPDATE OF base_unit_id ON unit_groups FOR EACH ROW EXECUTE FUNCTION protect_unit_group_base()`,
    );
  }
  async down(q: QueryRunner) {
    await q.query('DROP TRIGGER item_unit_group_check ON items');
    await q.query('DROP FUNCTION check_item_unit_group()');
    await q.query('ALTER TABLE items DROP COLUMN unit_group_id');
    await q.query('DROP TABLE unit_groups');
    await q.query('DROP FUNCTION protect_unit_group_base()');
  }
}
