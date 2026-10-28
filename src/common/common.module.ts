import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LocationContextInterceptor } from './interceptors/location-context.interceptor';
import { AuditController } from './audit.controller';
import { OperationsInterceptor } from './interceptors/operations.interceptor';
import { IdempotencyKey } from '../database/entities/idempotency-key.entity';
import { User } from '../database/entities/user.entity';
import { PermissionsGuard } from './guards/permissions.guard';
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([User, IdempotencyKey])],
  controllers: [AuditController],
  providers: [
    PermissionsGuard,
    LocationContextInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: LocationContextInterceptor },
    OperationsInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: OperationsInterceptor },
    IdempotencyInterceptor,
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
  exports: [PermissionsGuard, TypeOrmModule, OperationsInterceptor],
})
export class CommonModule {}
