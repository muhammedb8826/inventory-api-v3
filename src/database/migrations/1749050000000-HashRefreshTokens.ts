import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Store only SHA-256 hashes of refresh JWTs.
 * Existing raw tokens cannot be re-hashed → delete all rows (force re-login).
 */
export class HashRefreshTokens1749050000000 implements MigrationInterface {
  name = 'HashRefreshTokens1749050000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
