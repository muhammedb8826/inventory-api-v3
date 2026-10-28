import { AsyncLocalStorage } from 'async_hooks';
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
export const locationContext = new AsyncLocalStorage<string[] | null>();
export function applyLocationScope<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
) {
  const allowed = locationContext.getStore();
  if (allowed == null) return qb;
  const alias = qb.expressionMap.mainAlias;
  if (!alias?.hasMetadata) return qb;
  const table = alias.metadata.tableName;
  const columns: Record<string, string[]> = {
    stock_levels: ['location_id'],
    stock_lots: ['location_id'],
    stock_movements: ['location_id'],
    stock_adjustments: ['location_id'],
    sales: ['location_id'],
    purchases: ['location_id'],
    production_orders: ['location_id', 'finished_location_id'],
    stock_transfers: ['from_location_id', 'to_location_id'],
    stocktakes: ['location_id'],
  };
  if (!columns[table]) return qb;
  if (!allowed.length) return qb.andWhere('1 = 0');
  for (const column of columns[table])
    qb.andWhere(
      `(${alias.name}.${column} IS NULL OR ${alias.name}.${column} IN (:...scopeLocations))`,
      { scopeLocations: allowed },
    );
  return qb;
}
