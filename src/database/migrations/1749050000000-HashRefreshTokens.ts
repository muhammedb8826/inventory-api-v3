import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Store only SHA-256 hashes of refresh JWTs.
 * Existing raw tokens cannot be re-hashed → delete rows that still hold raw JWTs.
 * Idempotent when `token_hash` already exists (fresh schema / re-run).
 */
export class HashRefreshTokens1749050000000 implements MigrationInterface {
  name = 'HashRefreshTokens1749050000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('refresh_tokens');
    if (!table) return;

    const hasTokenHash = table.findColumnByName('token_hash');
    const hasToken = table.findColumnByName('token');

    if (hasTokenHash && !hasToken) {
      // Already migrated (or created via InitialSchema sync from entities).
      await queryRunner.query(`
        ALTER TABLE "refresh_tokens"
        ALTER COLUMN "token_hash" TYPE character varying(64)
      `);
      return;
    }

    if (!hasToken) return;

    // Raw JWTs are longer than 64 chars; drop them before shrinking the column.
    await queryRunner.query(`DELETE FROM "refresh_tokens"`);
    await queryRunner.query(`
      ALTER TABLE "refresh_tokens"
      RENAME COLUMN "token" TO "token_hash"
    `);
    await queryRunner.query(`
      ALTER TABLE "refresh_tokens"
      ALTER COLUMN "token_hash" TYPE character varying(64)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('refresh_tokens');
    if (!table?.findColumnByName('token_hash')) return;
    if (table.findColumnByName('token')) return;

    await queryRunner.query(`
      ALTER TABLE "refresh_tokens"
      ALTER COLUMN "token_hash" TYPE character varying(500)
    `);
    await queryRunner.query(`
      ALTER TABLE "refresh_tokens"
      RENAME COLUMN "token_hash" TO "token"
    `);
  }
}
