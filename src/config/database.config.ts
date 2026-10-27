import { registerAs } from '@nestjs/config';

/**
 * Schema changes must go through TypeORM migrations (`npm run migration:run`).
 * `synchronize` is never enabled in production — even if DB_SYNCHRONIZE=true.
 */
export default registerAs('database', () => {
  const isProd = process.env.NODE_ENV === 'production';
  const syncRequested = process.env.DB_SYNCHRONIZE === 'true';
  if (isProd && syncRequested) {
    console.warn(
      '[database] DB_SYNCHRONIZE=true ignored in production; use migrations only.',
    );
  }

  return {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_DATABASE ?? 'stock_management',
    synchronize: !isProd && syncRequested,
    logging: process.env.DB_LOGGING === 'true',
  };
});
