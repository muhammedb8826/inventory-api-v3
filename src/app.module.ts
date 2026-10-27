import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { BanksModule } from './banks/banks.module';
import { BomsModule } from './boms/boms.module';
import { CommonModule } from './common/common.module';
import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import jwtConfig from './config/jwt.config';
import { CreditsModule } from './credits/credits.module';
import { CustomersModule } from './customers/customers.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DatabaseModule } from './database/database.module';
import { ExpensesModule } from './expenses/expenses.module';
import { HealthModule } from './health/health.module';
import { InventoryModule } from './inventory/inventory.module';
import { InquiriesModule } from './inquiries/inquiries.module';
import { LocationsModule } from './locations/locations.module';
import { MessagesModule } from './messages/messages.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PermissionsModule } from './permissions/permissions.module';
import { ProductionModule } from './production/production.module';
import { ProfitLossModule } from './profit-loss/profit-loss.module';
import { PurchasesModule } from './purchases/purchases.module';
import { ReportsModule } from './reports/reports.module';
import { RolesModule } from './roles/roles.module';
import { SalesModule } from './sales/sales.module';
import { SettingsModule } from './settings/settings.module';
import { StockTransfersModule } from './stock-transfers/stock-transfers.module';
import { StocktakesModule } from './stocktakes/stocktakes.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, jwtConfig],
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        genReqId: (req, res) => {
          const existing = req.headers['x-request-id'];
          const id =
            typeof existing === 'string' && existing.length > 0
              ? existing
              : randomUUID();
          res.setHeader('x-request-id', id);
          return id;
        },
        customProps: (req) => ({
          requestId: req.id,
        }),
        transport:
          process.env.NODE_ENV !== 'production'
            ? {
                target: 'pino-pretty',
                options: { singleLine: true, colorize: true },
              }
            : undefined,
      },
    }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 120,
      },
    ]),
    CommonModule,
    DatabaseModule,
    HealthModule,
    AuthModule,
    UsersModule,
    RolesModule,
    PermissionsModule,
    LocationsModule,
    NotificationsModule,
    MessagesModule,
    InventoryModule,
    BomsModule,
    ProductionModule,
    StockTransfersModule,
    StocktakesModule,
    SuppliersModule,
    CustomersModule,
    InquiriesModule,
    PurchasesModule,
    SalesModule,
    CreditsModule,
    ExpensesModule,
    BanksModule,
    DashboardModule,
    ProfitLossModule,
    ReportsModule,
    SettingsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
