import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  type JwtPayload,
} from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import {
  CreateStocktakeDto,
  SubmitStocktakeCountsDto,
} from './dto/stocktake.dto';
import { StocktakesService } from './stocktakes.service';

@Controller('stocktakes')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class StocktakesController {
  constructor(private readonly stocktakesService: StocktakesService) {}

  @Get()
  @RequirePermissions('stocktake.read')
  findAll(@CurrentUser() user: JwtPayload) {
    return this.stocktakesService.findAll(user.sub);
  }

  @Get(':id')
  @RequirePermissions('stocktake.read')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.stocktakesService.findOne(id, user.sub);
  }

  @Post()
  @RequirePermissions('stocktake.write')
  create(
    @Body() dto: CreateStocktakeDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.stocktakesService.create(dto, user.sub);
  }

  @Post(':id/counts')
  @RequirePermissions('stocktake.write')
  submitCounts(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitStocktakeCountsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.stocktakesService.submitCounts(id, dto, user.sub);
  }

  @Post(':id/complete')
  @RequirePermissions('stocktake.write')
  complete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.stocktakesService.complete(id, user.sub);
  }

  @Post(':id/cancel')
  @RequirePermissions('stocktake.write')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.stocktakesService.cancel(id, user.sub);
  }
}
