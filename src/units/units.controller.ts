import { SaveUnitGroupDto } from './dto/unit-group.dto';
import { UpdateItemConversionsDto } from './dto/item-conversion.dto';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CreateUnitDto, UpdateUnitDto } from './dto/unit.dto';
import { UnitsService } from './units.service';
@Controller('units')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class UnitsController {
  constructor(private readonly units: UnitsService) {}
  // Every authenticated transaction user needs the catalog; writes require inventory administration.
  @Get() list() {
    return this.units.list();
  }
  @Get('groups') groups() {
    return this.units.groups();
  }
  @Post('groups') @RequirePermissions('inventory.write') createGroup(
    @Body() dto: SaveUnitGroupDto,
  ) {
    return this.units.saveGroup(undefined, dto);
  }
  @Patch('groups/:id') @RequirePermissions('inventory.write') updateGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveUnitGroupDto,
  ) {
    return this.units.saveGroup(id, dto);
  }
  @Get('items/:id') options(@Param('id', ParseUUIDPipe) id: string) {
    return this.units.itemOptions(id);
  }
  @Patch('items/:id') @RequirePermissions('inventory.write') configure(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateItemConversionsDto,
  ) {
    return this.units.configureItem(id, dto);
  }
  @Post() @RequirePermissions('inventory.write') create(
    @Body() dto: CreateUnitDto,
  ) {
    return this.units.create(dto);
  }
  @Patch(':id') @RequirePermissions('inventory.write') update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUnitDto,
  ) {
    return this.units.update(id, dto);
  }
}
