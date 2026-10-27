import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { getAppCurrency } from '../common/utils/currency.util';

@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly config: ConfigService,
  ) {}

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
