import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  type JwtPayload,
} from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { CreateLocationDto, UpdateLocationDto } from './dto/location.dto';
import { LocationListQueryDto } from './dto/location-list-query.dto';
import { LocationsService } from './locations.service';

@Controller('locations')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Get()
  @RequirePermissions('locations.read')
  findAll(
    @Query() query: LocationListQueryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.locationsService.findAll(query, user.sub);
  }

  @Get(':id')
  @RequirePermissions('locations.read')
  findOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.locationsService.findOne(id, user.sub);
  }

  @Post()
  @RequirePermissions('locations.write')
  create(@Body() dto: CreateLocationDto) {
    return this.locationsService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('locations.write')
  update(@Param('id') id: string, @Body() dto: UpdateLocationDto) {
    return this.locationsService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('locations.write')
  remove(@Param('id') id: string) {
    return this.locationsService.remove(id);
  }
}
