import { MigrationInterface, QueryRunner } from 'typeorm';
export class SessionRevocation1749120000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version int NOT NULL DEFAULT 0',
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE users DROP COLUMN session_version');
  }
}
