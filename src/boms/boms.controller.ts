import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { BomsService } from './boms.service';
import {
  BomExplodeQueryDto,
  BomListQueryDto,
  CreateBomDto,
  ReviseBomDto,
  UpdateBomDto,
} from './dto/bom.dto';

@Controller('boms')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class BomsController {
  constructor(private readonly bomsService: BomsService) {}

  @Get()
  @RequirePermissions('bom.read')
  findAll(@Query() query: BomListQueryDto) {
    return this.bomsService.findAll(query);
  }

  @Get('where-used/:itemId')
  @RequirePermissions('bom.read')
  whereUsed(@Param('itemId', ParseUUIDPipe) itemId: string) {
    return this.bomsService.whereUsed(itemId);
  }

  @Get(':id')
  @RequirePermissions('bom.read')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.bomsService.findOne(id);
  }

  @Get(':id/explode')
  @RequirePermissions('bom.read')
  explode(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: BomExplodeQueryDto,
  ) {
    return this.bomsService.explode(id, query);
  }

  @Get(':id/cost-rollup')
  @RequirePermissions('bom.read')
  costRollup(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('quantity') quantity?: string,
    @Query('mode') mode?: string,
  ) {
    const qty = quantity ? parseFloat(quantity) : 1;
    const fullExplode = mode === 'leaves' || mode === 'full';
    return this.bomsService.costRollup(
      id,
      Number.isFinite(qty) && qty > 0 ? qty : 1,
      fullExplode,
    );
  }

  @Post()
  @RequirePermissions('bom.write')
  create(@Body() dto: CreateBomDto) {
    return this.bomsService.create(dto);
  }

  @Post(':id/revise')
  @RequirePermissions('bom.write')
  revise(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviseBomDto) {
    return this.bomsService.revise(id, dto);
  }

  @Post(':id/set-default')
  @RequirePermissions('bom.write')
  setDefault(@Param('id', ParseUUIDPipe) id: string) {
    return this.bomsService.setDefault(id);
  }

  @Patch(':id')
  @RequirePermissions('bom.write')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBomDto) {
    return this.bomsService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('bom.write')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.bomsService.remove(id);
  }
}
