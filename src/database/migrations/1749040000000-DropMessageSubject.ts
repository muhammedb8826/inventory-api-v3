import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropMessageSubject1749040000000 implements MigrationInterface {
  name = 'DropMessageSubject1749040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "internal_messages" DROP COLUMN IF EXISTS "subject"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "internal_messages"
      ADD COLUMN IF NOT EXISTS "subject" character varying(200) NOT NULL DEFAULT ''
    `);
    await queryRunner.query(`
      ALTER TABLE "internal_messages" ALTER COLUMN "subject" DROP DEFAULT
    `);
  }
}
