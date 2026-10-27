import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Location } from '../database/entities/location.entity';
import { User } from '../database/entities/user.entity';
import { UserLocation } from '../database/entities/user-location.entity';
import { LocationAccessService } from './location-access.service';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';

@Module({
  imports: [TypeOrmModule.forFeature([Location, UserLocation, User])],
  controllers: [LocationsController],
  providers: [LocationsService, LocationAccessService],
  exports: [LocationsService, LocationAccessService],
})
export class LocationsModule {}
