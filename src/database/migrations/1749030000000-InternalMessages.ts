import { MigrationInterface, QueryRunner } from 'typeorm';
import { randomUUID } from 'crypto';

export class InternalMessages1749030000000 implements MigrationInterface {
  name = 'InternalMessages1749030000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "internal_messages" (
        "id" uuid NOT NULL,
        "sender_id" uuid NOT NULL,
        "recipient_id" uuid NOT NULL,
        "subject" character varying(200) NOT NULL,
        "body" text NOT NULL,
        "is_read" boolean NOT NULL DEFAULT false,
        "read_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_internal_messages" PRIMARY KEY ("id"),
        CONSTRAINT "FK_internal_messages_sender" FOREIGN KEY ("sender_id")
          REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_internal_messages_recipient" FOREIGN KEY ("recipient_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_internal_messages_recipient_read"
      ON "internal_messages" ("recipient_id", "is_read")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_internal_messages_recipient_created"
      ON "internal_messages" ("recipient_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_internal_messages_sender_created"
      ON "internal_messages" ("sender_id", "created_at")
    `);

    const readId = randomUUID();
    const writeId = randomUUID();
    await queryRunner.query(
      `
      INSERT INTO "permissions" ("id", "code", "name", "module", "created_at", "updated_at")
      SELECT $1, 'messages.read', 'View internal messages', 'messages', now(), now()
      WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "code" = 'messages.read')
    `,
      [readId],
    );
    await queryRunner.query(
      `
      INSERT INTO "permissions" ("id", "code", "name", "module", "created_at", "updated_at")
      SELECT $1, 'messages.write', 'Send internal messages', 'messages', now(), now()
      WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "code" = 'messages.write')
    `,
      [writeId],
    );

    // Grant to Admin and every existing role (staff messaging is universal)
    await queryRunner.query(`
      INSERT INTO "role_permissions" ("role_id", "permission_id")
      SELECT r.id, p.id
      FROM "roles" r
      CROSS JOIN "permissions" p
      WHERE p.code IN ('messages.read', 'messages.write')
        AND NOT EXISTS (
          SELECT 1 FROM "role_permissions" rp
          WHERE rp.role_id = r.id AND rp.permission_id = p.id
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "role_permissions"
      WHERE "permission_id" IN (
        SELECT id FROM "permissions" WHERE code IN ('messages.read', 'messages.write')
      )
    `);
    await queryRunner.query(`
      DELETE FROM "permissions" WHERE code IN ('messages.read', 'messages.write')
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "internal_messages"`);
  }
}
