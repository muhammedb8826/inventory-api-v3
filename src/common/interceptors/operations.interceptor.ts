import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { from, lastValueFrom, Observable } from 'rxjs';
import type { Request, Response } from 'express';

@Injectable()
export class OperationsInterceptor implements NestInterceptor {
  private readonly logger = new Logger(OperationsInterceptor.name);
  private readonly counters = new Map<
    string,
    { count: number; errors: number; seconds: number }
  >();
  constructor(@InjectDataSource() private readonly db: DataSource) {}
  metrics() {
    const lines = [
      '# TYPE inventory_http_requests_total counter',
      '# TYPE inventory_http_errors_total counter',
      '# TYPE inventory_http_duration_seconds_sum counter',
    ];
    for (const [labels, value] of this.counters) {
      lines.push(
        `inventory_http_requests_total{${labels}} ${value.count}`,
        `inventory_http_errors_total{${labels}} ${value.errors}`,
        `inventory_http_duration_seconds_sum{${labels}} ${value.seconds}`,
      );
    }
    return lines.join('\n') + '\n';
  }
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: { sub: string }; id?: string }>();
    const res = context.switchToHttp().getResponse<Response>();
    return from(
      (async () => {
        const started = performance.now();
        let status = res.statusCode;
        try {
          return await lastValueFrom(next.handle());
        } catch (error) {
          status = (error as { getStatus?: () => number }).getStatus?.() ?? 500;
          throw error;
        } finally {
          const route = `${req.baseUrl}${req.route?.path ?? '/unknown'}`;
          const labels = `method=${JSON.stringify(req.method)},route=${JSON.stringify(route)}`;
          const metric = this.counters.get(labels) ?? {
            count: 0,
            errors: 0,
            seconds: 0,
          };
          metric.count++;
          if (status >= 500) metric.errors++;
          metric.seconds += (performance.now() - started) / 1000;
          this.counters.set(labels, metric);
          if (
            req.user &&
            ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)
          ) {
            try {
              await this.db.query(
                `INSERT INTO audit_events (actor_id, method, route, resource_id, request_id, status_code) VALUES ($1,$2,$3,$4,$5,$6)`,
                [
                  req.user.sub,
                  req.method,
                  route,
                  req.params.id?.slice(0, 128) ?? null,
                  String(req.id ?? '').slice(0, 128),
                  status,
                ],
              );
            } catch {
              this.logger.error(
                'Audit event could not be persisted; check database availability',
              );
            }
          }
        }
      })(),
    );
  }
}
