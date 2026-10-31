import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import {
  CurrentUser,
  type JwtPayload,
} from '../common/decorators/current-user.decorator';
import { ProductsService } from './products.service';
import {
  CreateVariantsDto,
  SaveAttributeDto,
  SaveFamilyDto,
  VariantStatusDto,
  ProductCatalogQueryDto,
} from './products.dto';

@ApiTags('product-families')
@ApiBearerAuth()
@Controller('product-families')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ProductsController {
  constructor(private readonly products: ProductsService) {}
  @Get('attributes') @RequirePermissions('inventory.read') attributes() {
    return this.products.attributes();
  }
  @Post('attributes') @RequirePermissions('inventory.write') createAttribute(
    @Body() dto: SaveAttributeDto,
  ) {
    return this.products.saveAttribute(undefined, dto);
  }
  @Patch('attributes/:id')
  @RequirePermissions('inventory.write')
  updateAttribute(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveAttributeDto,
  ) {
    return this.products.saveAttribute(id, dto);
  }
  @Get('catalog') @RequirePermissions('inventory.read') catalog(
    @Query() query: ProductCatalogQueryDto,
  ) {
    return this.products.catalog(query.q);
  }
  @Get() @RequirePermissions('inventory.read') list() {
    return this.products.families();
  }
  @Post() @RequirePermissions('inventory.write') create(
    @Body() dto: SaveFamilyDto,
  ) {
    return this.products.saveFamily(undefined, dto);
  }
  @Get(':id') @RequirePermissions('inventory.read') detail(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.products.detail(id);
  }
  @Patch(':id') @RequirePermissions('inventory.write') update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveFamilyDto,
  ) {
    return this.products.saveFamily(id, dto);
  }
  @Post(':id/variants') @RequirePermissions('inventory.write') variants(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateVariantsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.products.createVariants(id, dto, user.sub);
  }
  @Patch(':id/variants/:itemId') @RequirePermissions('inventory.write') status(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: VariantStatusDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.products.status(id, itemId, dto.isActive, user.sub);
  }
}
