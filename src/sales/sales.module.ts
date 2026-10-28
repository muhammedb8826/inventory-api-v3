import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BanksModule } from '../banks/banks.module';
import { CustomerCredit } from '../database/entities/customer-credit.entity';
import { CustomerInquiry } from '../database/entities/customer-inquiry.entity';
import { ProductionOrder } from '../database/entities/production-order.entity';
import { Sale } from '../database/entities/sale.entity';
import { SaleReturn } from '../database/entities/sale-return.entity';
import { User } from '../database/entities/user.entity';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Sale,
      SaleReturn,
      CustomerCredit,
      User,
      CustomerInquiry,
      ProductionOrder,
    ]),
    InventoryModule,
    BanksModule,
    NotificationsModule,
  ],
  controllers: [SalesController],
  providers: [SalesService],
})
export class SalesModule {}
