import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { from, lastValueFrom, Observable } from 'rxjs';
import { locationContext } from '../location-scope';
import type { Request } from 'express';

@Injectable()
export class LocationContextInterceptor implements NestInterceptor {
  constructor(@InjectDataSource() private readonly db: DataSource) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context
      .switchToHttp()
      .getRequest<
        Request & { user?: { sub: string }; permissions?: string[] }
      >();
    if (
      !req.user ||
      !req.permissions ||
      req.permissions.includes('locations.all')
    )
      return next.handle();
    return from(
      (async () => {
        const assigned: { id: string }[] = await this.db.query(
          `SELECT l.id FROM locations l
        WHERE l.id IN (SELECT location_id FROM user_locations WHERE user_id = $1)
        OR l.parent_id IN (SELECT location_id FROM user_locations WHERE user_id = $1)`,
          [req.user!.sub],
        );
        const allowed = assigned.map((row) => row.id);
        const path = req.path.replace(/^\/api\/v1\//, '');
        // These views contain business-wide financial figures, including opening credits.
        if (
          /^(dashboard|reports|profit-loss|banks|credits|audit-events)(\/|$)/.test(
            path,
          )
        ) {
          throw new ForbiddenException(
            'Business-wide financial access requires locations.all',
          );
        }
        const check = (value: unknown) => {
          if (typeof value === 'string' && value && !allowed.includes(value))
            throw new ForbiddenException('Location access denied');
        };
        for (const source of [req.body, req.query])
          for (const key of [
            'locationId',
            'fromLocationId',
            'toLocationId',
            'finishedLocationId',
          ])
            check(source?.[key]);
        const resource = path.match(
          /^(inventory|sales|purchases|production-orders|stock-transfers|stocktakes)\/([0-9a-f-]{36})(?:\/|$)/i,
        );
        const tables: Record<string, { name: string; fields: string[] }> = {
          inventory: { name: 'stock_levels', fields: ['location_id'] },
          sales: { name: 'sales', fields: ['location_id'] },
          purchases: { name: 'purchases', fields: ['location_id'] },
          'production-orders': {
            name: 'production_orders',
            fields: ['location_id', 'finished_location_id'],
          },
          'stock-transfers': {
            name: 'stock_transfers',
            fields: ['from_location_id', 'to_location_id'],
          },
          stocktakes: { name: 'stocktakes', fields: ['location_id'] },
        };
        if (resource) {
          const table = tables[resource[1]];
          const [row] = await this.db.query(
            `SELECT ${table.fields.join(',')} FROM ${table.name} WHERE id = $1`,
            [resource[2]],
          );
          if (row) table.fields.forEach((field) => check(row[field]));
        }
        return locationContext.run(allowed, () => lastValueFrom(next.handle()));
      })(),
    );
  }
}
