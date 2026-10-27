import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StockAdjustment } from '../database/entities/stock-adjustment.entity';
import { StockLevel } from '../database/entities/stock-level.entity';
import { Stocktake } from '../database/entities/stocktake.entity';
import { StocktakeLine } from '../database/entities/stocktake-line.entity';
import { InventoryModule } from '../inventory/inventory.module';
import { LocationsModule } from '../locations/locations.module';
import { StocktakesController } from './stocktakes.controller';
import { StocktakesService } from './stocktakes.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Stocktake,
      StocktakeLine,
      StockLevel,
      StockAdjustment,
    ]),
    InventoryModule,
    LocationsModule,
  ],
  controllers: [StocktakesController],
  providers: [StocktakesService],
  exports: [StocktakesService],
})
export class StocktakesModule {}
