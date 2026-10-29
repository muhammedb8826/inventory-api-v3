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
