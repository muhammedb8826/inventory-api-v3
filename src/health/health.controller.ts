import {
  Controller,
  Get,
  Header,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import { OperationsInterceptor } from '../common/interceptors/operations.interceptor';
import { getAppCurrency } from '../common/utils/currency.util';

@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly config: ConfigService,
    private readonly operations: OperationsInterceptor,
  ) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics(@Headers('authorization') authorization?: string) {
    const token = this.config.get<string>('METRICS_TOKEN');
    const expected = Buffer.from(`Bearer ${token ?? ''}`);
    const actual = Buffer.from(authorization ?? '');
    if (
      !token ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new UnauthorizedException();
    return this.operations.metrics();
  }

  /** Liveness — process is up (no dependency checks). */
  @Get('live')
  live() {
    return {
      status: 'ok',
      service: 'inventory-api',
      currency: getAppCurrency(this.config),
    };
  }

  /** Readiness — Postgres must respond (`GET /health` and `/health/ready`). */
  @Get()
  @HealthCheck()
  ready() {
    return this.health.check([() => this.db.pingCheck('database')]);
  }

  @Get('ready')
  @HealthCheck()
  readyAlias() {
    return this.ready();
  }
}
