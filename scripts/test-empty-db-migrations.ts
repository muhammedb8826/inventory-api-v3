/**
 * Smoke: create empty DB → migration:run → expect success.
 * Usage: npx ts-node scripts/test-empty-db-migrations.ts
 */
import { Client } from 'pg';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const admin = {
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  user: process.env.DB_USERNAME ?? 'postgres',
  password: String(process.env.DB_PASSWORD ?? ''),
};

const dbName = 'stock_migration_smoke';

async function main() {
  const client = new Client({ ...admin, database: 'postgres' });
  await client.connect();
  await client.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [dbName],
  );
  await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await client.query(`CREATE DATABASE "${dbName}"`);
  await client.end();

  const env = {
    ...process.env,
    DB_DATABASE: dbName,
    DB_SYNCHRONIZE: 'false',
  };

  const result = spawnSync(
    'npx',
    [
      'typeorm-ts-node-commonjs',
      'migration:run',
      '-d',
      'src/database/data-source.ts',
    ],
    { env, encoding: 'utf8', shell: true },
  );

  console.log(result.stdout);
  console.error(result.stderr);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  console.log('Empty-DB migration:run OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
