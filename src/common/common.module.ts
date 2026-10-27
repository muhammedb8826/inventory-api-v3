import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyKey } from '../database/entities/idempotency-key.entity';
import { User } from '../database/entities/user.entity';
import { PermissionsGuard } from './guards/permissions.guard';
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([User, IdempotencyKey])],
  providers: [
    PermissionsGuard,
    IdempotencyInterceptor,
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
  exports: [PermissionsGuard, TypeOrmModule],
})
export class CommonModule {}
