import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BanksModule } from '../banks/banks.module';
import { Purchase } from '../database/entities/purchase.entity';
import { SupplierCredit } from '../database/entities/supplier-credit.entity';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchasesController } from './purchases.controller';
import { PurchasesService } from './purchases.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Purchase, SupplierCredit]),
    InventoryModule,
    BanksModule,
    NotificationsModule,
  ],
  controllers: [PurchasesController, PurchaseOrdersController],
  providers: [PurchasesService],
})
export class PurchasesModule {}
