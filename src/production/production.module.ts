import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BomsModule } from '../boms/boms.module';
import { Bom } from '../database/entities/bom.entity';
import { CustomerInquiry } from '../database/entities/customer-inquiry.entity';
import { Item } from '../database/entities/item.entity';
import { Location } from '../database/entities/location.entity';
import { ProductionOrderLine } from '../database/entities/production-order-line.entity';
import { ProductionOrder } from '../database/entities/production-order.entity';
import { Sale } from '../database/entities/sale.entity';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProductionController } from './production.controller';
import { ProductionService } from './production.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProductionOrder,
      ProductionOrderLine,
      Bom,
      Location,
      Item,
      CustomerInquiry,
      Sale,
    ]),
    InventoryModule,
    NotificationsModule,
    BomsModule,
  ],
  controllers: [ProductionController],
  providers: [ProductionService],
  exports: [ProductionService],
})
export class ProductionModule {}
