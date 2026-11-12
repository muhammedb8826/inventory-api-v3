import { effectiveSalesPrice } from '../products/family-pricing';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { FileInterceptor } from '@nestjs/platform-express';
import { Item } from '../database/entities/item.entity';
import { UnitOfMeasure } from '../database/entities/unit-of-measure.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { ItemType } from '../common/enums';
import { imageUploadOptions } from '../common/upload/multer-options';
import type { UploadedImageFile } from './dto/uploaded-file.interface';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { UnitsService } from '../units/units.service';
import { normalizeUsableWidthMetres } from '../units/usable-width';
import { UnitGroup } from '../database/entities/unit-group.entity';
import { randomUUID } from 'crypto';
import { addRecordActivity } from '../common/record-activity';
import { StockLevel } from '../database/entities/stock-level.entity';
import { applyLocationScope } from '../common/location-scope';
class CatalogQuery {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(1)
  page?: number;
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(1)
  limit?: number;
}
export class EditCatalogItemDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MaxLength(80) sku?: string | null;
  @IsOptional() @IsString() @MaxLength(80) barcode?: string | null;
  @IsOptional() @IsEnum(ItemType) itemType?: ItemType;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsUUID() unitId?: string;
  @IsOptional() @IsUUID() unitGroupId?: string | null;
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  defaultWidthMetres?: number | null;
}
class PriceDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 10 })
  @Min(0)
  @Max(99999999999)
  salesPrice: number | null;
}
@Controller('items')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ItemCatalogController {
  constructor(
    private readonly db: DataSource,
    private readonly units: UnitsService,
  ) {}
  private async stockSummary(ids: string[], locationId?: string) {
    if (!ids.length) return [];
    const qb = applyLocationScope(
      this.db.getRepository(StockLevel).createQueryBuilder('s'),
    )
      .select('s.itemId', 'itemId')
      .addSelect('SUM(s.quantity)::text', 'onHand')
      .addSelect('SUM(s.reserved)::text', 'reserved')
      .addSelect('SUM(s.quantity - s.reserved)::text', 'available')
      .addSelect('SUM(s.quantity * s.purchasePrice)::text', 'stockValue')
      .andWhere('s.itemId IN (:...ids)', { ids })
      .groupBy('s.itemId');
    if (locationId) qb.andWhere('s.locationId = :locationId', { locationId });
    return qb.getRawMany<{
      itemId: string;
      onHand: string;
      reserved: string;
      available: string;
      stockValue: string;
    }>();
  }
  @Get() @RequirePermissions('inventory.read') async list(
    @Query() query: CatalogQuery,
  ) {
    const qb = this.db
      .getRepository(Item)
      .createQueryBuilder('i')
      .leftJoinAndSelect('i.stockUnit', 'stockUnit')
      .leftJoinAndSelect('i.unitGroup', 'unitGroup')
      .leftJoinAndSelect('i.productFamily', 'productFamily')
      .orderBy('i.createdAt', 'DESC')
      .addOrderBy('i.id', 'DESC');
    if (query.search?.trim())
      qb.where(
        '(i.description ILIKE :q OR i.sku ILIKE :q OR i.barcode ILIKE :q)',
        { q: `%${query.search.trim()}%` },
      );
    const page = query.page ?? 1,
      limit = Math.min(query.limit ?? 20, 100);
    const [data, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    await addRecordActivity(this.db, data, '/items');
    const summaries = new Map(
      (
        await this.stockSummary(
          data.map((i) => i.id),
          query.locationId,
        )
      ).map((s) => [s.itemId, s]),
    );
    return {
      data: data.map((i) => ({
        ...i,
        imageUrl: i.imagePath,
        effectiveSalesPrice: effectiveSalesPrice(i),
        stock: summaries.get(i.id) ?? {
          onHand: '0',
          reserved: '0',
          available: '0',
          stockValue: '0',
        },
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }
  @Get(':id') @RequirePermissions('inventory.read') async detail(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const item = await this.db
      .getRepository(Item)
      .findOne({ where: { id }, relations: { productFamily: true } });
    if (!item) throw new NotFoundException('Item not found');
    const [{ used }] = await this.db.query(
      'SELECT item_stock_unit_in_use($1) AS used',
      [id],
    );
    await addRecordActivity(this.db, item, '/items');
    const stock = (await this.stockSummary([id]))[0] ?? {
      onHand: '0',
      reserved: '0',
      available: '0',
      stockValue: '0',
    };
    const stockBalances = await applyLocationScope(
      this.db.getRepository(StockLevel).createQueryBuilder('s'),
    )
      .leftJoinAndSelect('s.location', 'location')
      .andWhere('s.itemId = :id', { id })
      .orderBy('location.name', 'ASC')
      .getMany();
    return {
      ...item,
      stock,
      stockBalances,
      imageUrl: item.imagePath,
      effectiveSalesPrice: effectiveSalesPrice(item),
      stockUnitLocked:
        used || !!item.productFamilyId || !!item.unitConversions?.length,
    };
  }
  @Patch(':id') @RequirePermissions('inventory.write') async edit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditCatalogItemDto,
  ) {
    try {
      await this.db.transaction(async (m) => {
        await m.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [id]);
        const repo = m.getRepository(Item),
          item = await repo.findOneBy({ id });
        if (!item) throw new NotFoundException('Item not found');
        const changes: Partial<Item> = {};
        if (dto.description !== undefined) {
          if (!dto.description.trim())
            throw new BadRequestException('Item name is required');
          changes.description = dto.description.trim();
        }
        for (const k of ['sku', 'barcode'] as const)
          if (dto[k] !== undefined) changes[k] = dto[k]?.trim() || null;
        if (dto.itemType !== undefined) changes.itemType = dto.itemType;
        if (dto.isActive !== undefined) changes.isActive = dto.isActive;
        if (
          item.productFamilyId &&
          (dto.unitId !== undefined ||
            dto.unitGroupId !== undefined ||
            dto.itemType !== undefined)
        )
          throw new BadRequestException(
            'Variants inherit type and units from their product family. Edit the family instead.',
          );
        let unitId = dto.unitId ?? item.unitId;
        if (dto.unitGroupId !== undefined) {
          const group = dto.unitGroupId
            ? await this.units.group(dto.unitGroupId, m)
            : null;
          if (dto.unitGroupId && !group)
            throw new BadRequestException(
              'Select an active unit configuration',
            );
          if (group) {
            if (dto.unitId && dto.unitId !== group.baseUnitId)
              throw new BadRequestException(
                'Stock unit must match the configuration base unit',
              );
            unitId = group.baseUnitId;
          }
          changes.unitGroupId = group?.id ?? null;
        }
        if (unitId !== item.unitId) {
          const [{ used }] = await m.query(
            'SELECT item_stock_unit_in_use($1) AS used',
            [id],
          );
          if (used || item.unitConversions?.length)
            throw new BadRequestException(
              used
                ? 'Reduce on-hand quantity to zero and remove the item from open documents before correcting the stock unit.'
                : 'Remove alternative unit settings before correcting the stock unit.',
            );
          const unit = await m
            .getRepository(UnitOfMeasure)
            .findOneBy({ id: unitId, isActive: true, requiresReview: false });
          if (!unit)
            throw new BadRequestException(
              'Select an active reviewed stock unit',
            );
          if (dto.unitGroupId === undefined && item.unitGroupId)
            throw new BadRequestException(
              'Select a matching unit configuration when changing stock unit',
            );
          changes.unitId = unit.id;
          changes.unit = unit.symbol;
          changes.salesPrice = null; // A price per the old unit must not become a price per the new unit.
        }
        const effectiveUnitId = changes.unitId ?? item.unitId;
        const effectiveGroupId =
          changes.unitGroupId !== undefined
            ? changes.unitGroupId
            : item.unitGroupId;
        const group = effectiveGroupId
          ? await m.getRepository(UnitGroup).findOneBy({ id: effectiveGroupId })
          : null;
        const stockUnit = await m
          .getRepository(UnitOfMeasure)
          .findOneByOrFail({ id: effectiveUnitId });
        const category = group?.category ?? stockUnit.category;
        if (dto.defaultWidthMetres !== undefined || category !== 'LENGTH') {
          changes.defaultWidthMetres = normalizeUsableWidthMetres(
            category,
            dto.defaultWidthMetres !== undefined
              ? dto.defaultWidthMetres
              : item.defaultWidthMetres,
          );
        }
        if (Object.keys(changes).length) await repo.update(id, changes);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException(
          'SKU or barcode already belongs to another item',
        );
      throw error;
    }
    return this.detail(id);
  }
  @Patch(':id/price') @RequirePermissions('pricing.write') async price(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PriceDto,
  ) {
    if (dto.salesPrice === undefined)
      throw new BadRequestException(
        'salesPrice is required (or null to require approval)',
      );
    const result = await this.db.getRepository(Item).update(id, {
      salesPrice: dto.salesPrice === null ? null : dto.salesPrice.toFixed(10),
    });
    if (!result.affected) throw new NotFoundException('Item not found');
    return this.detail(id);
  }
  @Post(':id/image')
  @RequirePermissions('inventory.write')
  @UseInterceptors(FileInterceptor('file', imageUploadOptions))
  async image(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedImageFile,
  ) {
    if (!file) throw new BadRequestException('Image required');
    if (!(await this.db.getRepository(Item).existsBy({ id })))
      throw new NotFoundException('Item not found');
    const extension = (
      {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
      } as Record<string, string>
    )[file.mimetype];
    if (!extension) throw new BadRequestException('Unsupported image');
    const folder = join(process.cwd(), 'uploads', 'items');
    mkdirSync(folder, { recursive: true });
    const name = `item-${randomUUID()}.${extension}`;
    writeFileSync(join(folder, name), file.buffer);
    await this.db
      .getRepository(Item)
      .update(id, { imagePath: `/uploads/items/${name}` });
    return this.detail(id);
  }
}
