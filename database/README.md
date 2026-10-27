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

## Production checklist

- [ ] `NODE_ENV=production`
- [ ] `DB_SYNCHRONIZE=false` (ignored in production even if set to `true`)
- [ ] Run `npm run migration:run` on **every** deploy / before start
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
