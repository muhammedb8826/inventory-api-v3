import { MigrationInterface, QueryRunner } from 'typeorm';

export class CommonCustomUnits1749160000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(`INSERT INTO units_of_measure(id,code,name,symbol,category,decimal_places) VALUES
      ('10000000-0000-4000-8000-000000000015','PACK','Pack','pack','COUNT',0),
      ('10000000-0000-4000-8000-000000000016','DOZEN','Dozen','doz','COUNT',0),
      ('10000000-0000-4000-8000-000000000017','CM2','Square centimetre','cm2','AREA',3),
      ('10000000-0000-4000-8000-000000000018','MIN','Minute','min','TIME',3)
      ON CONFLICT(code) DO NOTHING`);
  }
  async down() {
    // Catalog entries may already be referenced by items or historical documents.
  }
}
