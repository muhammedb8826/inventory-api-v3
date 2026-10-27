import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request, Response } from 'express';
import { Observable, from, of, switchMap, tap } from 'rxjs';
import { IsNull, Repository } from 'typeorm';
import { IdempotencyKey } from '../../database/entities/idempotency-key.entity';

const IDEMPOTENT_ROUTES = [
  { method: 'POST', match: /^\/api\/v1\/sales\/?$/ },
  { method: 'POST', match: /^\/api\/v1\/purchases\/?$/ },
  { method: 'POST', match: /^\/api\/v1\/inventory\/adjustments\/?$/ },
  { method: 'POST', match: /^\/api\/v1\/sales\/[^/]+\/returns\/?$/ },
];

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @InjectRepository(IdempotencyKey)
    private readonly repo: Repository<IdempotencyKey>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<
      Request & { user?: { sub?: string }; idempotencyReplay?: boolean }
    >();
    const res = http.getResponse<Response>();

    const keyHeader = req.headers['idempotency-key'];
    const key =
      typeof keyHeader === 'string'
        ? keyHeader.trim()
        : Array.isArray(keyHeader)
          ? keyHeader[0]?.trim()
          : '';

    if (!key) return next.handle();

    const method = req.method.toUpperCase();
    const route = (req.originalUrl ?? req.url).split('?')[0];
    const applies = IDEMPOTENT_ROUTES.some(
      (r) => r.method === method && r.match.test(route),
    );
    if (!applies) return next.handle();

    const userId = req.user?.sub ?? null;

    return from(
      this.repo.findOne({
        where: {
          key,
          userId: userId === null ? IsNull() : userId,
          method,
          route,
        },
      }),
    ).pipe(
      switchMap((existing) => {
        if (existing) {
          req.idempotencyReplay = true;
          res.status(existing.statusCode);
          return of(existing.responseBody);
        }

        return next.handle().pipe(
          tap(async (body) => {
            if (req.idempotencyReplay) return;
            const statusCode = res.statusCode || 201;
            try {
              await this.repo.save(
                this.repo.create({
                  key,
                  userId,
                  method,
                  route,
                  statusCode,
                  responseBody: body ?? null,
                }),
              );
            } catch {
              // Unique race: another request stored first — ignore
            }
          }),
        );
      }),
    );
  }
}
