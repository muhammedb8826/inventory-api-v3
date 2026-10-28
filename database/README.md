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

Build tools (`@nestjs/cli`, `typescript`, …) are in **dependencies** so the server can compile. `npm run build` writes to `.dist-staging` then swaps into `dist/` — a failed build does **not** wipe the live `dist/`.

```bash
# after git pull / upload of source
npm install
npm run deploy:prod   # build → migration:run:prod → touch tmp/restart.txt
```

Or step-by-step: `npm run build` → `npm run migration:run:prod` → `touch tmp/restart.txt`.

- [ ] `NODE_ENV=production`
- [ ] `DB_SYNCHRONIZE=false` (ignored in production even if set to `true`)
- [ ] Run migrations on every deploy (`deploy:prod` or `migration:run:prod`)
- [ ] Set `DB_SEED=false` after the first seed
- [ ] Never use TypeORM `synchronize` against production data
- [ ] API clients use `/api/v1` (OpenAPI at `/api/docs`)
- [ ] After `HashRefreshTokens` migration, users must log in again (refresh rows cleared)

## Why not synchronize?

`synchronize` mutates tables from entity metadata without a reviewable history. Concurrent stock writes and ledger constraints (P0) depend on explicit indexes and enums from migrations (e.g. `1749020000000-StockMovementsAndSkuUnique`).

## Useful commands

```bash
npm run migration:show
npm run migration:run
npm run migration:revert
npm run migration:generate -- src/database/migrations/NameOfChange
```
