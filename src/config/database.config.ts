import { registerAs } from '@nestjs/config';

/**
 * Schema changes must go through TypeORM migrations (`npm run migration:run`).
 * Startup synchronization is disabled in every environment, including development.
 * Shared enums, triggers and other migration-managed objects cannot be safely
 * maintained by TypeORM's automatic schema synchronization.
 */
export default registerAs('database', () => {
  const syncRequested = process.env.DB_SYNCHRONIZE === 'true';
  if (syncRequested) {
    console.warn(
      '[database] DB_SYNCHRONIZE=true ignored; use npm run migration:run.',
    );
  }

  return {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_DATABASE ?? 'stock_management',
    synchronize: false,
    logging: process.env.DB_LOGGING === 'true',
  };
});
