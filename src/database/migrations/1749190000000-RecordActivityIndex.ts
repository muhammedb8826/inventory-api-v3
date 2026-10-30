import { MigrationInterface, QueryRunner } from 'typeorm';

export class RecordActivityIndex1749190000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE INDEX IF NOT EXISTS audit_events_resource_actor_idx
      ON audit_events(resource_id, created_at DESC, id DESC) WHERE actor_id IS NOT NULL`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP INDEX IF EXISTS audit_events_resource_actor_idx');
  }
}
