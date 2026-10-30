import { MigrationInterface, QueryRunner } from 'typeorm';
export class UnitCategoryBoundaries1749200000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE unit_groups ADD COLUMN IF NOT EXISTS kind varchar(20) NOT NULL DEFAULT 'CATEGORY'
      CONSTRAINT unit_group_kind CHECK (kind IN ('CATEGORY','PACKAGING'))`);
    await q.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='unit_group_kind' AND conrelid='unit_groups'::regclass)
      THEN ALTER TABLE unit_groups ADD CONSTRAINT unit_group_kind CHECK (kind IN ('CATEGORY','PACKAGING')); END IF; END $$`);
    await q.query(`UPDATE units_of_measure u SET requires_review=true FROM (VALUES
      ('KG','MASS'),('G','MASS'),('MG','MASS'),('M','LENGTH'),('CM','LENGTH'),('MM','LENGTH'),
      ('M2','AREA'),('CM2','AREA'),('M3','VOLUME'),('L','VOLUME'),('ML','VOLUME'),
      ('H','TIME'),('MIN','TIME'),('PCS','COUNT'),('DOZEN','COUNT')) s(code,category)
      WHERE u.code=s.code AND u.category<>s.category`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE unit_groups DROP COLUMN kind');
  }
}
