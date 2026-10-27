import { MigrationInterface, QueryRunner } from 'typeorm';
import { DataSource } from 'typeorm';
import { entities } from '../entities';

/**
 * Baseline for empty databases (CI / fresh installs).
 *
 * Historical migrations only ALTER tables that were created via early
 * synchronize in local/prod. On a blank Postgres they fail (e.g. no "sales").
 *
 * If core tables are missing, this migration builds the full current schema
 * from entity metadata (one-shot synchronize). Later migrations are written
 * to be idempotent (`IF NOT EXISTS` / guarded renames).
 *
 * On databases that already have `sales`, this is a no-op.
 */
export class InitialSchema1748800000000 implements MigrationInterface {
  name = 'InitialSchema1748800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasSales = await queryRunner.hasTable('sales');
    if (hasSales) return;

    const opts = queryRunner.connection.options;
    if (opts.type !== 'postgres') {
      throw new Error('InitialSchema only supports postgres');
    }

    const syncDs = new DataSource({
      type: 'postgres',
      host: opts.host,
      port: opts.port,
      username: opts.username,
      password: opts.password,
      database: opts.database,
      ssl: 'ssl' in opts ? opts.ssl : undefined,
      entities,
      synchronize: true,
      migrationsRun: false,
      logging: false,
    });

    await syncDs.initialize();
    await syncDs.destroy();
  }

  public async down(): Promise<void> {
    // Irreversible baseline — do not drop the whole schema from here.
  }
}
