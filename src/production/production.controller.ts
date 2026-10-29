import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermissions,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import {
  CompleteProductionDto,
  CreateProductionOrderDto,
  IssueProductionDto,
  ProductionOrderListQueryDto,
  ScrapProductionDto,
  StartProductionFromInquiryDto,
  UnbuildProductionDto,
} from './dto/production-order.dto';
import { ProductionService } from './production.service';

@Controller('production-orders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ProductionController {
  constructor(private readonly productionService: ProductionService) {}

  @Get()
  @RequirePermissions('production.read')
  findAll(@Query() query: ProductionOrderListQueryDto) {
    return this.productionService.findAll(query);
  }

  @Post('from-inquiry')
  @RequirePermissions('production.write')
  fromInquiry(
    @Body() dto: StartProductionFromInquiryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.productionService.createFromInquiry(dto, user.sub);
  }

  @Get(':id/material-requirements')
  @RequirePermissions('production.read')
  materialRequirements(@Param('id') id: string) {
    return this.productionService.materialRequirements(id);
  }

  @Get(':id')
  @RequirePermissions('production.read')
  findOne(@Param('id') id: string) {
    return this.productionService.findOne(id);
  }

  @Post()
  @RequirePermissions('production.write')
  create(
    @Body() dto: CreateProductionOrderDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.productionService.create(dto, user.sub);
  }

  @Post(':id/release')
  @RequirePermissions('production.write')
  release(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.productionService.release(id, user.sub);
  }

  /** Warehouse issue — production.write or dedicated production.issue. */
  @Post(':id/issue')
  @RequireAnyPermissions('production.write', 'production.issue')
  issue(@Param('id') id: string, @Body() dto: IssueProductionDto) {
    return this.productionService.issue(id, dto ?? {});
  }

  @Post(':id/complete')
  @RequirePermissions('production.write')
  complete(
    @Param('id') id: string,
    @Body() dto: CompleteProductionDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.productionService.complete(id, dto, user.sub);
  }

  @Post(':id/unbuild')
  @RequirePermissions('production.write')
  unbuild(@Param('id') id: string, @Body() dto: UnbuildProductionDto) {
    return this.productionService.unbuild(id, dto);
  }

  @Post(':id/scrap')
  @RequirePermissions('production.write')
  scrap(@Param('id') id: string, @Body() dto: ScrapProductionDto) {
    return this.productionService.scrap(id, dto);
  }

  @Post(':id/cancel')
  @RequirePermissions('production.write')
  cancel(@Param('id') id: string) {
    return this.productionService.cancel(id);
  }
}
