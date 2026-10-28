import {
  BadRequestException,
  ConflictException,
  HttpException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { Observable, from, lastValueFrom } from 'rxjs';
import { Repository } from 'typeorm';
import { IdempotencyKey } from '../../database/entities/idempotency-key.entity';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ':' +
            canonical((value as Record<string, unknown>)[k]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @InjectRepository(IdempotencyKey)
    private readonly repo: Repository<IdempotencyKey>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: { sub?: string } }>();
    const res = context.switchToHttp().getResponse<Response>();
    const key = req.header('idempotency-key')?.trim();
    if (
      !key ||
      !req.user?.sub ||
      !['POST', 'PATCH', 'DELETE'].includes(req.method)
    )
      return next.handle();
    if (key.length > 128)
      throw new BadRequestException('Idempotency-Key exceeds 128 characters');
    return from(this.execute(req, res, key, next));
  }

  private async execute(
    req: Request & { user?: { sub?: string } },
    res: Response,
    key: string,
    next: CallHandler,
  ) {
    const scope = {
      key,
      userId: req.user!.sub!,
      method: req.method,
      route: req.originalUrl.split('?')[0],
    };
    const requestHash = createHash('sha256')
      .update(canonical({ body: req.body, query: req.query }))
      .digest('hex');
    // Commit a unique claim BEFORE business work. Pending/uncertain requests are never executed again.
    const inserted = await this.repo
      .createQueryBuilder()
      .insert()
      .values({
        id: randomUUID(),
        ...scope,
        requestHash,
        statusCode: 0,
        responseBody: () => 'NULL',
      })
      .orIgnore()
      .returning('id')
      .execute();
    if (inserted.raw.length === 0) {
      const existing = await this.repo.findOneByOrFail(scope);
      if (existing.requestHash && existing.requestHash !== requestHash)
        throw new ConflictException(
          'Idempotency key was used with a different request',
        );
      if (existing.statusCode === 0)
        throw new ConflictException(
          'Request is in progress or requires reconciliation. Do not submit with a new key.',
        );
      res.status(existing.statusCode);
      return existing.responseBody;
    }
    try {
      const body = await lastValueFrom(next.handle());
      await this.repo.update(scope, {
        statusCode: res.statusCode,
        responseBody: body ?? null,
      });
      return body;
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500) {
        await this.repo.update(scope, {
          statusCode: error.getStatus(),
          responseBody: error.getResponse(),
        });
      }
      // Keep uncertain claims: a failure may occur AFTER a business transaction committed.
      // An operator reconciles pending claims against the audit trail before retrying.
      throw error;
    }
  }
}
