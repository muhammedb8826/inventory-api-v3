import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnitOfMeasure } from '../database/entities/unit-of-measure.entity';
import { UnitsController } from './units.controller';
import { UnitsService } from './units.service';
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([UnitOfMeasure])],
  controllers: [UnitsController],
  providers: [UnitsService],
  exports: [UnitsService],
})
export class UnitsModule {}
