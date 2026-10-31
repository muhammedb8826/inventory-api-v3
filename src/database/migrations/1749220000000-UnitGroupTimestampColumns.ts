import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 174917 created camelCase timestamps on upgraded databases. Fresh databases
 * already had snake_case timestamps from InitialSchema's entity metadata.
 * Repair the upgrade path without replacing the original timestamp values.
 */
export class UnitGroupTimestampColumns1749220000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    for (const [legacy, canonical] of [
      ['createdAt', 'created_at'],
      ['updatedAt', 'updated_at'],
    ]) {
      await q.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='unit_groups'::regclass
          AND attname='${canonical}' AND NOT attisdropped) THEN
          IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='unit_groups'::regclass
            AND attname='${legacy}' AND NOT attisdropped) THEN
            ALTER TABLE unit_groups RENAME COLUMN "${legacy}" TO "${canonical}";
          ELSE
            ALTER TABLE unit_groups ADD COLUMN "${canonical}" timestamptz NOT NULL DEFAULT now();
          END IF;
        ELSIF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='unit_groups'::regclass
          AND attname='${legacy}' AND NOT attisdropped) THEN
          UPDATE unit_groups SET "${canonical}"="${legacy}"
            WHERE "${canonical}" IS NULL AND "${legacy}" IS NOT NULL;
        END IF;
      END $$`);
    }
  }

  async down(): Promise<void> {
    // Retain the repaired names and historical values. Renaming on rollback
    // would break databases that already used canonical columns before up().
  }
}
