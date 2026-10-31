# Database schema

**Source of truth:** TypeORM migrations in `src/database/migrations/`.

There is no checked-in `schema.sql`. Apply schema only via migrations.

The first migration (`1748800000000-InitialSchema`) bootstraps an **empty** database from entity metadata (CI / fresh installs). Later migrations are incremental and idempotent. Databases that already have core tables skip the bootstrap.

## Local / CI setup

```bash
# Create empty database (once)
# createdb stock_management

# Apply all migrations (works on empty Postgres)
npm run migration:run

# Optional seed (admin, roles, Main Warehouse, Cash/Bank)
DB_SEED=true npm run seed
# or set DB_SEED=true so SeedService runs on app boot
```

## Production checklist (cPanel / server)

Upload the source and workspace files: `src/`, `nest-cli.json`, `tsconfig.json`, `tsconfig.build.json`, `package.json`, and the lockfile. Dependencies, including the build tools and TypeScript migration runner, must already be installed in the cPanel Node environment.

```bash
npm run build
npm run migration:run
```

Use these same commands locally and on cPanel. `build` compiles the application. `migration:run` reads the source migrations in `src/database/migrations/`, so migration discovery does not depend on the contents of `dist`. Neither command automatically restarts the application; use cPanel's Restart button after both succeed.

- [ ] `NODE_ENV=production`
- [ ] `DB_SYNCHRONIZE=false` (ignored in production even if set to `true`)
- [ ] Run `npm run build`, then `npm run migration:run` on every deploy
- [ ] Set `DB_SEED=false` after the first seed
- [ ] Never use TypeORM `synchronize` against production data
- [ ] API clients use `/api/v1` (OpenAPI at `/api/docs`)
- [ ] After `HashRefreshTokens` migration, users must log in again (refresh rows cleared)

## Why not synchronize?

`synchronize` mutates tables from entity metadata without a reviewable history. Concurrent stock writes and ledger constraints (P0) depend on explicit indexes and enums from migrations (e.g. `1749020000000-StockMovementsAndSkuUnique`).

## Optional migration maintenance (not deployment steps)

```bash
npm run migration:show
npm run migration:run
npm run migration:revert
npm run migration:generate -- src/database/migrations/NameOfChange
```
