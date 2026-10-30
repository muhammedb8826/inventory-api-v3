import { UnitsService } from '../units/units.service';
import { assertUnitQuantity } from '../units/unit-quantity';
import { applyLocationScope } from '../common/location-scope';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { DataSource, Not, QueryFailedError, Repository } from 'typeorm';
import {
  ItemType,
  LocationType,
  StockAdjustmentDirection,
  StockAdjustmentReason,
  StockMovementType,
} from '../common/enums';
import {
  absoluteMediaUrl,
  publicBaseFromConfig,
} from '../common/utils/media-url.util';
import {
  applyDateRangeToQb,
  applyIlikeSearch,
  applyRelatedIlikeSearch,
  paginatedQueryBuilder,
  sumFilteredQueryBuilder,
} from '../common/utils/query.util';
import { Item } from '../database/entities/item.entity';
import { Location } from '../database/entities/location.entity';
import { StockAdjustment } from '../database/entities/stock-adjustment.entity';
import { StockLevel } from '../database/entities/stock-level.entity';
import { StockMovement } from '../database/entities/stock-movement.entity';
import { StockService } from './stock.service';
import { LowStockService } from '../notifications/low-stock.service';
import { CreateInventoryDto, UpdateInventoryDto } from './dto/inventory.dto';
import { InventoryListQueryDto } from './dto/inventory-list-query.dto';
import {
  CreateStockAdjustmentDto,
  StockAdjustmentListQueryDto,
} from './dto/stock-adjustment.dto';
import { StockMovementListQueryDto } from './dto/stock-movement.dto';
import type {
  UploadedExcelFile,
  UploadedImageFile,
} from './dto/uploaded-file.interface';

const ITEM_IMAGE_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const ITEM_IMAGE_EXT_MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

const ITEM_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

@Injectable()
export class InventoryService {
  private readonly itemUploadDir = join(process.cwd(), 'uploads', 'items');

  constructor(
    private readonly units: UnitsService,
    @InjectRepository(StockLevel)
    private readonly stockRepo: Repository<StockLevel>,
    @InjectRepository(Item)
    private readonly itemRepo: Repository<Item>,
    @InjectRepository(Location)
    private readonly locationRepo: Repository<Location>,
    @InjectRepository(StockAdjustment)
    private readonly adjustmentRepo: Repository<StockAdjustment>,
    @InjectRepository(StockMovement)
    private readonly movementRepo: Repository<StockMovement>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly stockService: StockService,
    private readonly lowStockService: LowStockService,
    private readonly config: ConfigService,
  ) {}

  private mediaBase(requestBaseUrl?: string) {
    return {
      publicBaseUrl: publicBaseFromConfig(this.config),
      requestBaseUrl,
    };
  }

  private attachItemImageUrl<
    T extends {
      item?: {
        imagePath?: string | null;
        imageUrl?: string | null;
      } | null;
    },
  >(row: T, requestBaseUrl?: string): T {
    if (row.item) {
      row.item.imageUrl = absoluteMediaUrl(
        row.item.imagePath ?? null,
        this.mediaBase(requestBaseUrl),
      );
    }
    return row;
  }

  private attachItemImageUrls<
    T extends {
      item?: {
        imagePath?: string | null;
        imageUrl?: string | null;
      } | null;
    },
  >(rows: T[], requestBaseUrl?: string): T[] {
    return rows.map((row) => this.attachItemImageUrl(row, requestBaseUrl));
  }

  async findAll(query: InventoryListQueryDto, requestBaseUrl?: string) {
    const filteredQb = this.buildInventoryFilterQb(query);
    const [totals, page] = await Promise.all([
      sumFilteredQueryBuilder(filteredQb, [
        {
          key: 'quantity',
          sql: 'COALESCE(SUM(stock.quantity::numeric), 0)',
          decimals: 3,
        },
        {
          key: 'inventoryValue',
          sql: 'COALESCE(SUM(stock.quantity::numeric * stock.purchase_price::numeric), 0)',
        },
      ]),
      paginatedQueryBuilder(
        filteredQb
          .clone()
          .leftJoinAndSelect('stock.item', 'item')
          .leftJoinAndSelect('item.stockUnit', 'stockUnit')
          .leftJoinAndSelect('stock.location', 'location')
          .orderBy('stock.updated_at', 'DESC'),
        query.page,
        query.limit,
      ),
    ]);

    return {
      ...page,
      data: this.attachItemImageUrls(page.data, requestBaseUrl),
      totals,
    };
  }
  private buildInventoryFilterQb(query: InventoryListQueryDto) {
    const qb = this.stockRepo.createQueryBuilder('stock');

    if (query.locationId) {
      qb.andWhere('stock.location_id = :locationId', {
        locationId: query.locationId,
      });
    }
    applyRelatedIlikeSearch(qb, query.search, [], {
      table: 'items',
      alias: 'item_filter',
      parentKey: 'stock.item_id',
      relatedKey: 'id',
      columns: ['description', 'sku'],
    });

    return qb;
  }

  async findLowStock(
    query: {
      locationId?: string;
      page?: number;
      limit?: number;
    },
    requestBaseUrl?: string,
  ) {
    const page = await this.lowStockService.findAllLowStock(query);
    return {
      ...page,
      data: this.attachItemImageUrls(page.data, requestBaseUrl),
    };
  }

  async findOne(id: string, requestBaseUrl?: string) {
    const stock = await this.stockRepo.findOne({
      where: { id },
      relations: { item: true, location: true },
    });
    if (!stock) throw new NotFoundException('Inventory record not found');
    return this.withAvailability(
      this.attachItemImageUrl(stock, requestBaseUrl),
    );
  }

  /** Lookup stock rows by barcode (or SKU fallback) for POS scan. */
  async findByBarcode(
    code: string,
    locationId?: string,
    requestBaseUrl?: string,
  ) {
    const trimmed = code.trim();
    if (!trimmed) throw new BadRequestException('code is required');

    const qb = this.stockRepo
      .createQueryBuilder('stock')
      .leftJoinAndSelect('stock.item', 'item')
      .leftJoinAndSelect('item.stockUnit', 'stockUnit')
      .leftJoinAndSelect('stock.location', 'location')
      .where('(item.barcode = :code OR item.sku = :code)', { code: trimmed })
      .andWhere('item.is_active = true');

    if (locationId) {
      qb.andWhere('stock.location_id = :locationId', { locationId });
    }

    const rows = await applyLocationScope(qb).getMany();
    if (!rows.length) {
      throw new NotFoundException('No item found for barcode/SKU');
    }
    return this.attachItemImageUrls(rows, requestBaseUrl).map((r) =>
      this.withAvailability(r),
    );
  }

  private withAvailability<T extends StockLevel>(stock: T) {
    const qty = parseFloat(stock.quantity);
    const reserved = parseFloat(stock.reserved ?? '0');
    return Object.assign(stock, {
      available: (qty - reserved).toFixed(3),
    });
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof QueryFailedError &&
      typeof (err as QueryFailedError & { code?: string }).code === 'string' &&
      (err as QueryFailedError & { code?: string }).code === '23505'
    );
  }

  async create(dto: CreateInventoryDto, requestBaseUrl?: string) {
    await this.ensureLocation(dto.locationId);
    const sku =
      dto.sku === undefined || dto.sku.trim() === '' ? null : dto.sku.trim();
    const barcode =
      dto.barcode === undefined || dto.barcode.trim() === ''
        ? null
        : dto.barcode.trim();

    let item = sku ? await this.itemRepo.findOne({ where: { sku } }) : null;
    if (!item && barcode) {
      item = await this.itemRepo.findOne({ where: { barcode } });
    }
    const group = dto.unitGroupId
      ? await this.units.group(dto.unitGroupId)
      : null;
    const unit = await this.units.resolve(
      group?.baseUnitId ?? dto.unitId,
      dto.unit,
    );
    assertUnitQuantity(unit, dto.quantity);
    if (dto.reorderPoint != null)
      assertUnitQuantity(unit, dto.reorderPoint, 'Reorder point');
    if (item && item.unitId !== unit.id)
      throw new BadRequestException(
        'Selected unit does not match this existing item stock unit',
      );
    if (!item) {
      try {
        item = await this.itemRepo.save(
          this.itemRepo.create({
            sku,
            barcode,
            description: dto.description,
            unitId: unit.id,
            unitGroupId: group?.id ?? null,
            unit: unit.symbol,
            itemType: dto.itemType,
            isPhantom: dto.isPhantom === true,
          }),
        );
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          const msg = String(
            (err as QueryFailedError).message ?? '',
          ).toLowerCase();
          if (msg.includes('barcode')) {
            throw new ConflictException(
              'Barcode already in use by another item',
            );
          }
          if (sku) {
            item = await this.itemRepo.findOne({ where: { sku } });
            if (!item) {
              throw new ConflictException('SKU already in use by another item');
            }
          } else {
            throw new ConflictException('SKU already in use by another item');
          }
        } else {
          throw err;
        }
      }
    } else if (barcode && !item.barcode) {
      item.barcode = barcode;
      try {
        await this.itemRepo.save(item);
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw new ConflictException('Barcode already in use by another item');
        }
        throw err;
      }
    }

    if (dto.unitGroupId && item.unitGroupId !== dto.unitGroupId)
      throw new BadRequestException(
        'Existing item uses a different unit group',
      );
    if (item.unitId !== unit.id)
      throw new BadRequestException(
        'Selected unit does not match the existing item',
      );
    const adjusted = await this.stockService.adjust({
      locationId: dto.locationId,
      itemId: item.id,
      quantityDelta: dto.quantity,
      purchasePrice: dto.purchasePrice,
      movement: {
        type: StockMovementType.OPENING,
        notes: 'Opening / create inventory',
      },
    });

    if (dto.reorderPoint !== undefined) {
      adjusted.reorderPoint = dto.reorderPoint.toFixed(3);
      const saved = await this.stockRepo.save(adjusted);
      await this.lowStockService.evaluateAfterReorderPointChange(saved.id);
      return this.findOne(saved.id, requestBaseUrl);
    }

    await this.lowStockService.evaluateInitialStock(adjusted.id);
    return this.findOne(adjusted.id, requestBaseUrl);
  }

  async update(id: string, dto: UpdateInventoryDto, requestBaseUrl?: string) {
    const savedId = await this.dataSource.transaction(async (manager) => {
      const itemRepo = manager.getRepository(Item),
        stockRepo = manager.getRepository(StockLevel);
      const stock = await stockRepo.findOne({
        where: { id },
        relations: { item: true },
      });
      if (!stock) throw new NotFoundException('Inventory record not found');
      const previousUnitId = stock.item.unitId;

      const itemChanged =
        dto.description !== undefined ||
        dto.sku !== undefined ||
        dto.barcode !== undefined ||
        dto.unit !== undefined ||
        dto.unitGroupId !== undefined ||
        dto.unitId !== undefined ||
        dto.itemType !== undefined ||
        dto.isPhantom !== undefined;

      if (itemChanged) {
        if (dto.description !== undefined) {
          const description = dto.description.trim();
          if (!description) {
            throw new BadRequestException('description cannot be empty');
          }
          stock.item.description = description;
        }
        if (dto.sku !== undefined) {
          const sku =
            dto.sku === null || dto.sku.trim() === '' ? null : dto.sku.trim();
          if (sku) {
            const existing = await itemRepo.findOne({
              where: { sku, id: Not(stock.itemId) },
            });
            if (existing) {
              throw new ConflictException('SKU already in use by another item');
            }
          }
          stock.item.sku = sku;
        }
        if (dto.barcode !== undefined) {
          const barcode =
            dto.barcode === null || dto.barcode.trim() === ''
              ? null
              : dto.barcode.trim();
          if (barcode) {
            const existing = await itemRepo.findOne({
              where: { barcode, id: Not(stock.itemId) },
            });
            if (existing) {
              throw new ConflictException(
                'Barcode already in use by another item',
              );
            }
          }
          stock.item.barcode = barcode;
        }
        if (
          dto.unitGroupId !== undefined &&
          dto.unitGroupId !== stock.item.unitGroupId
        ) {
          const group = dto.unitGroupId
            ? await this.units.group(dto.unitGroupId)
            : null;
          stock.item.unitGroupId = group?.id ?? null;
          if (group) dto.unitId = group.baseUnitId;
        }
        if (dto.unit !== undefined || dto.unitId !== undefined) {
          if (dto.unitId === stock.item.unitId && dto.unit === undefined) {
            /* Existing legacy units may be retained while editing metadata. */
          } else {
            const unit = await this.units.resolve(dto.unitId, dto.unit);
            if (
              stock.item.unitId !== unit.id &&
              stock.item.unitConversions?.length
            )
              throw new BadRequestException(
                'Remove alternative unit settings before changing an unused base unit',
              );
            stock.item.unitId = unit.id;
            stock.item.stockUnit = unit;
            stock.item.unit = unit.symbol;
          }
        }
        if (dto.itemType !== undefined) {
          stock.item.itemType = dto.itemType;
        }
        if (dto.isPhantom !== undefined) {
          stock.item.isPhantom = dto.isPhantom;
        }
        if (dto.reorderPoint != null)
          assertUnitQuantity(
            stock.item.stockUnit,
            dto.reorderPoint,
            'Reorder point',
          );
        if (
          previousUnitId !== stock.item.unitId &&
          dto.reorderPoint !== undefined
        ) {
          // Clear the old threshold inside this transaction before changing its unit.
          await stockRepo.update(id, { reorderPoint: null });
        }
        try {
          await itemRepo.update(stock.itemId, {
            ...(dto.unitGroupId !== undefined
              ? { unitGroupId: stock.item.unitGroupId }
              : {}),
            ...(dto.description !== undefined
              ? { description: stock.item.description }
              : {}),
            ...(dto.sku !== undefined ? { sku: stock.item.sku } : {}),
            ...(dto.barcode !== undefined
              ? { barcode: stock.item.barcode }
              : {}),
            ...(dto.unitId !== undefined || dto.unit !== undefined
              ? { unitId: stock.item.unitId, unit: stock.item.unit }
              : {}),
            ...(dto.itemType !== undefined
              ? { itemType: stock.item.itemType }
              : {}),
            ...(dto.isPhantom !== undefined
              ? { isPhantom: stock.item.isPhantom }
              : {}),
          });
        } catch (err) {
          if (this.isUniqueViolation(err)) {
            const msg = String(
              (err as QueryFailedError).message ?? '',
            ).toLowerCase();
            throw new ConflictException(
              msg.includes('barcode')
                ? 'Barcode already in use by another item'
                : 'SKU already in use by another item',
            );
          }
          throw err;
        }
      }

      if (dto.reorderPoint != null)
        assertUnitQuantity(
          stock.item.stockUnit,
          dto.reorderPoint,
          'Reorder point',
        );
      const fields: Partial<StockLevel> = {};
      if (dto.purchasePrice !== undefined)
        fields.purchasePrice = dto.purchasePrice.toFixed(10);
      if (dto.reorderPoint !== undefined)
        fields.reorderPoint =
          dto.reorderPoint === null ? null : dto.reorderPoint.toFixed(3);
      // Update only editable fields; never save a stale quantity/reservation snapshot.
      if (Object.keys(fields).length) await stockRepo.update(id, fields);
      return stock.id;
    });
    if (dto.reorderPoint !== undefined)
      await this.lowStockService.evaluateAfterReorderPointChange(savedId);
    return this.findOne(savedId, requestBaseUrl);
  }

  async uploadItemImage(
    stockId: string,
    file: UploadedImageFile | undefined,
    requestBaseUrl?: string,
  ) {
    if (!file) throw new BadRequestException('File is required');
    if (file.size > ITEM_IMAGE_MAX_BYTES) {
      throw new BadRequestException('Image must be 5 MB or smaller');
    }
    const ext = ITEM_IMAGE_MIME[file.mimetype];
    if (!ext) {
      throw new BadRequestException('Image must be JPEG, PNG, WebP, or GIF');
    }

    const stock = await this.findOne(stockId, requestBaseUrl);
    if (!existsSync(this.itemUploadDir)) {
      mkdirSync(this.itemUploadDir, { recursive: true });
    }

    this.deleteItemImageFile(stock.item.imagePath);

    const filename = `item-${randomUUID()}${ext}`;
    writeFileSync(join(this.itemUploadDir, filename), file.buffer);
    stock.item.imagePath = `/uploads/items/${filename}`;
    await this.itemRepo.save(stock.item);

    return this.findOne(stockId, requestBaseUrl);
  }

  async clearItemImage(stockId: string, requestBaseUrl?: string) {
    const stock = await this.findOne(stockId, requestBaseUrl);
    this.deleteItemImageFile(stock.item.imagePath);
    stock.item.imagePath = null;
    await this.itemRepo.save(stock.item);
    return this.findOne(stockId, requestBaseUrl);
  }

  private deleteItemImageFile(storedPath: string | null | undefined) {
    if (!storedPath) return;
    const match = storedPath.match(/\/uploads\/items\/([^/]+)$/);
    if (!match) return;
    const diskPath = join(this.itemUploadDir, match[1]);
    if (existsSync(diskPath)) {
      try {
        unlinkSync(diskPath);
      } catch {
        // ignore missing/locked file
      }
    }
  }

  async findAdjustments(
    query: StockAdjustmentListQueryDto,
    requestBaseUrl?: string,
  ) {
    const qb = this.adjustmentRepo
      .createQueryBuilder('adj')
      .leftJoinAndSelect('adj.item', 'item')
      .leftJoinAndSelect('adj.location', 'location')
      .leftJoinAndSelect('adj.createdBy', 'createdBy')
      .orderBy('adj.created_at', 'DESC');

    if (query.locationId) {
      qb.andWhere('adj.location_id = :locationId', {
        locationId: query.locationId,
      });
    }
    if (query.itemId) {
      qb.andWhere('adj.item_id = :itemId', { itemId: query.itemId });
    }
    if (query.direction) {
      qb.andWhere('adj.direction = :direction', {
        direction: query.direction,
      });
    }
    if (query.reason) {
      qb.andWhere('adj.reason = :reason', { reason: query.reason });
    }
    applyIlikeSearch(qb, query.search, [
      'adj.notes',
      'adj.reference',
      'item.description',
      'item.sku',
    ]);
    applyDateRangeToQb(qb, 'adj.created_at', query.from, query.to);

    const page = await paginatedQueryBuilder(qb, query.page, query.limit);
    return {
      ...page,
      data: this.attachItemImageUrls(page.data, requestBaseUrl),
    };
  }

  async findMovements(
    query: StockMovementListQueryDto,
    requestBaseUrl?: string,
  ) {
    const qb = this.movementRepo
      .createQueryBuilder('mv')
      .leftJoinAndSelect('mv.item', 'item')
      .leftJoinAndSelect('mv.location', 'location')
      .leftJoinAndSelect('mv.createdBy', 'createdBy')
      .orderBy('mv.created_at', 'DESC');

    if (query.locationId) {
      qb.andWhere('mv.location_id = :locationId', {
        locationId: query.locationId,
      });
    }
    if (query.itemId) {
      qb.andWhere('mv.item_id = :itemId', { itemId: query.itemId });
    }
    if (query.type) {
      qb.andWhere('mv.type = :type', { type: query.type });
    }
    if (query.refType) {
      qb.andWhere('mv.ref_type = :refType', { refType: query.refType });
    }
    if (query.refId) {
      qb.andWhere('mv.ref_id = :refId', { refId: query.refId });
    }
    applyIlikeSearch(qb, query.search, [
      'mv.notes',
      'mv.ref_type',
      'item.description',
      'item.sku',
    ]);
    applyDateRangeToQb(qb, 'mv.created_at', query.from, query.to);

    const page = await paginatedQueryBuilder(qb, query.page, query.limit);
    return {
      ...page,
      data: this.attachItemImageUrls(page.data, requestBaseUrl),
    };
  }

  async createAdjustment(dto: CreateStockAdjustmentDto, userId?: string) {
    await this.ensureLocation(dto.locationId);
    const item = await this.itemRepo.findOne({ where: { id: dto.itemId } });
    if (!item) throw new BadRequestException('Item not found');

    if (
      dto.direction === StockAdjustmentDirection.OUT &&
      (dto.reason === StockAdjustmentReason.FOUND ||
        dto.reason === StockAdjustmentReason.OPENING)
    ) {
      throw new BadRequestException(
        `${dto.reason} adjustments must use direction "in"`,
      );
    }
    if (
      dto.direction === StockAdjustmentDirection.IN &&
      (dto.reason === StockAdjustmentReason.DAMAGE ||
        dto.reason === StockAdjustmentReason.LOSS)
    ) {
      throw new BadRequestException(
        `${dto.reason} adjustments must use direction "out"`,
      );
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const adjustmentRepo = manager.getRepository(StockAdjustment);
      const quantityBefore = await this.stockService.getQuantity(
        dto.locationId,
        dto.itemId,
        manager,
        { forUpdate: true },
      );

      const delta =
        dto.direction === StockAdjustmentDirection.IN
          ? Math.abs(dto.quantity)
          : -Math.abs(dto.quantity);

      if (dto.direction === StockAdjustmentDirection.OUT) {
        if (quantityBefore < Math.abs(dto.quantity)) {
          throw new BadRequestException(
            `Insufficient stock for adjustment. Available: ${quantityBefore}, requested: ${dto.quantity}`,
          );
        }
      }

      const saved = await adjustmentRepo.save(
        adjustmentRepo.create({
          locationId: dto.locationId,
          itemId: dto.itemId,
          direction: dto.direction,
          quantity: Math.abs(dto.quantity).toFixed(3),
          quantityBefore: quantityBefore.toFixed(3),
          quantityAfter: (quantityBefore + delta).toFixed(3),
          reason: dto.reason,
          notes: dto.notes?.trim() || null,
          reference: dto.reference?.trim() || null,
          createdById: userId ?? null,
        }),
      );

      await this.stockService.adjust(
        {
          locationId: dto.locationId,
          itemId: dto.itemId,
          quantityDelta: delta,
          purchasePrice:
            dto.direction === StockAdjustmentDirection.IN
              ? dto.purchasePrice
              : undefined,
          movement: {
            type:
              dto.reason === StockAdjustmentReason.OPENING
                ? StockMovementType.OPENING
                : StockMovementType.ADJUSTMENT,
            refType: 'stock_adjustment',
            refId: saved.id,
            createdById: userId ?? null,
            notes:
              [dto.reason, dto.reference?.trim(), dto.notes?.trim()]
                .filter(Boolean)
                .join(' — ') || null,
          },
        },
        manager,
      );

      return { id: saved.id, quantityBefore };
    });

    await this.lowStockService.evaluate(
      dto.locationId,
      dto.itemId,
      result.quantityBefore,
    );

    return this.adjustmentRepo.findOne({
      where: { id: result.id },
      relations: { item: true, location: true, createdBy: true },
    });
  }

  listLots(filters: {
    locationId?: string;
    itemId?: string;
    expiringBefore?: string;
  }) {
    return this.stockService.listLots(filters);
  }

  /** Move stock into a BIN (putaway) or out of a BIN (pick). */
  async warehouseMove(
    dto: {
      fromLocationId: string;
      toLocationId: string;
      itemId: string;
      quantity: number;
      lotNumber?: string;
      notes?: string;
    },
    mode: 'putaway' | 'pick',
    userId?: string,
  ) {
    if (dto.fromLocationId === dto.toLocationId) {
      throw new BadRequestException('from and to locations must differ');
    }
    const from = await this.locationRepo.findOne({
      where: { id: dto.fromLocationId },
    });
    const to = await this.locationRepo.findOne({
      where: { id: dto.toLocationId },
    });
    if (!from || !to) {
      throw new BadRequestException('Location not found');
    }

    if (mode === 'putaway') {
      if (to.type !== LocationType.BIN) {
        throw new BadRequestException('Putaway destination must be a BIN');
      }
      if (to.parentId && to.parentId !== from.id) {
        throw new BadRequestException(
          'Putaway BIN must belong to the source warehouse/showroom',
        );
      }
    } else {
      if (from.type !== LocationType.BIN) {
        throw new BadRequestException('Pick source must be a BIN');
      }
    }

    await this.dataSource.transaction(async (manager) => {
      // Explicit lot moves preserve expiry and enforce unreserved availability.
      if (dto.lotNumber?.trim()) {
        const source = await this.stockService.getStock(
          dto.fromLocationId,
          dto.itemId,
          manager,
          { forUpdate: true },
        );
        const unitCost = source ? parseFloat(source.purchasePrice) : 0;
        const available = await this.stockService.getAvailable(
          dto.fromLocationId,
          dto.itemId,
          manager,
          { forUpdate: true },
        );
        if (available < dto.quantity)
          throw new BadRequestException('Insufficient available stock');
        const [sourceLot] = await manager.query(
          'SELECT expiry_date FROM stock_lots WHERE location_id=$1 AND item_id=$2 AND lot_number=$3',
          [dto.fromLocationId, dto.itemId, dto.lotNumber.trim()],
        );
        await this.stockService.adjust(
          {
            locationId: dto.fromLocationId,
            itemId: dto.itemId,
            quantityDelta: -dto.quantity,
            lotNumber: dto.lotNumber,
            movement: {
              type: StockMovementType.TRANSFER_OUT,
              refType: mode,
              createdById: userId ?? null,
              notes: dto.notes ?? null,
            },
          },
          manager,
        );
        await this.stockService.adjust(
          {
            locationId: dto.toLocationId,
            itemId: dto.itemId,
            quantityDelta: dto.quantity,
            purchasePrice: unitCost,
            lotNumber: dto.lotNumber,
            expiryDate: sourceLot?.expiry_date ?? null,
            movement: {
              type: StockMovementType.TRANSFER_IN,
              refType: mode,
              createdById: userId ?? null,
              notes: dto.notes ?? null,
            },
          },
          manager,
        );
      } else {
        await this.stockService.transfer(
          dto.fromLocationId,
          dto.toLocationId,
          dto.itemId,
          dto.quantity,
          manager,
          {
            refType: mode,
            createdById: userId ?? null,
            notes: dto.notes ?? null,
          },
        );
      }
    });

    return {
      mode,
      fromLocationId: dto.fromLocationId,
      toLocationId: dto.toLocationId,
      itemId: dto.itemId,
      quantity: dto.quantity,
      lotNumber: dto.lotNumber ?? null,
    };
  }

  async remove(id: string) {
    const stock = await this.findOne(id);
    if (Number(stock.quantity) !== 0 || Number(stock.reserved ?? 0) !== 0)
      throw new BadRequestException(
        'Only zero-balance, unreserved stock records can be deleted',
      );
    await this.stockRepo.remove(stock);
    return { success: true };
  }

  async bulkImport(locationId: string, file: UploadedExcelFile) {
    await this.ensureLocation(locationId);
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
    const embeddedByExcelRow = await this.loadEmbeddedImagesByExcelRow(
      file.buffer,
    );

    const results: { row: number; status: string; id?: string }[] = [];

    const cell = (value: unknown, fallback = ''): string => {
      if (value == null) return fallback;
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        return String(value);
      }
      return fallback;
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const excelRow = i + 2;
      const description = cell(
        row.description ?? row.Description ?? row.item,
      ).trim();
      const quantity = parseFloat(
        cell(row.quantity ?? row.Quantity ?? row.qty, '0'),
      );
      const purchasePrice = parseFloat(
        cell(
          row.purchasePrice ??
            row.purchase_price ??
            row.price ??
            row.PurchasePrice,
          '0',
        ),
      );
      const reorderPointRaw = row.reorderPoint ?? row.reorder_point;
      const reorderPoint =
        reorderPointRaw !== undefined && reorderPointRaw !== ''
          ? parseFloat(cell(reorderPointRaw))
          : undefined;
      const imageUrlRaw = cell(
        row.imageUrl ?? row.image_url ?? row.ImageUrl,
      ).trim();
      const itemTypeRaw = cell(row.itemType ?? row.item_type ?? row.ItemType)
        .trim()
        .toUpperCase();
      const itemType = Object.values(ItemType).includes(itemTypeRaw as ItemType)
        ? (itemTypeRaw as ItemType)
        : undefined;

      if (!description || Number.isNaN(quantity)) {
        results.push({ row: excelRow, status: 'skipped: invalid row' });
        continue;
      }

      try {
        const skuCell = cell(row.sku).trim();
        const saved = await this.create({
          description,
          locationId,
          quantity,
          purchasePrice: Number.isNaN(purchasePrice) ? 0 : purchasePrice,
          sku: skuCell || undefined,
          itemType,
          reorderPoint:
            reorderPoint !== undefined && !Number.isNaN(reorderPoint)
              ? reorderPoint
              : undefined,
        });

        let status = 'imported';
        const embedded = embeddedByExcelRow.get(excelRow);
        if (embedded) {
          try {
            await this.uploadItemImage(saved.id, embedded);
            status = 'imported+image';
          } catch (imgErr) {
            status = `imported (image failed: ${exceptionMessage(imgErr)})`;
          }
        } else if (imageUrlRaw) {
          try {
            await this.attachImageFromUrl(saved.id, imageUrlRaw);
            status = 'imported+image';
          } catch (imgErr) {
            status = `imported (image failed: ${exceptionMessage(imgErr)})`;
          }
        }

        results.push({ row: excelRow, status, id: saved.id });
      } catch (e) {
        results.push({
          row: excelRow,
          status: `error: ${exceptionMessage(e)}`,
        });
      }
    }

    return {
      imported: results.filter((r) => r.status.startsWith('imported')).length,
      results,
    };
  }

  /**
   * Map floating pictures in the first sheet to Excel row numbers (1-based).
   * Header is row 1; first data row is 2. Only .xlsx is supported.
   * Handles both standard pictures (xdr:pic) and shape image fills (xdr:sp + blipFill),
   * which Excel often writes when pasting photos into cells.
   */
  private async loadEmbeddedImagesByExcelRow(
    buffer: Buffer,
  ): Promise<Map<number, UploadedImageFile>> {
    const byRow = new Map<number, UploadedImageFile>();
    try {
      const zip = await JSZip.loadAsync(buffer);
      const sheetPath = await resolveFirstWorksheetPath(zip);
      if (!sheetPath) return byRow;

      const sheetRelsPath = worksheetRelsPath(sheetPath);
      const sheetRelsXml = await zip.file(sheetRelsPath)?.async('string');
      if (!sheetRelsXml) return byRow;

      const drawingRel = [...sheetRelsXml.matchAll(REL_HREF_RE)].find((m) =>
        m[2].includes('/relationships/drawing'),
      );
      if (!drawingRel) return byRow;

      const drawingPath = resolveZipPath(sheetPath, drawingRel[3]);
      const drawingXml = await zip.file(drawingPath)?.async('string');
      const drawingRelsXml = await zip
        .file(relsPathFor(drawingPath))
        ?.async('string');
      if (!drawingXml || !drawingRelsXml) return byRow;

      const rIdToMedia = new Map<string, string>();
      for (const m of drawingRelsXml.matchAll(REL_HREF_RE)) {
        if (!m[2].includes('/relationships/image')) continue;
        rIdToMedia.set(m[1], resolveZipPath(drawingPath, m[3]));
      }

      for (const anchor of drawingXml.matchAll(DRAWING_ANCHOR_RE)) {
        const block = anchor[0];
        const rowMatch = block.match(/<xdr:row>(\d+)<\/xdr:row>/);
        const embedMatch = block.match(/r:embed="([^"]+)"/);
        if (!rowMatch || !embedMatch) continue;

        const excelRow = Number(rowMatch[1]) + 1;
        if (!Number.isFinite(excelRow) || excelRow < 2 || byRow.has(excelRow)) {
          continue;
        }

        const mediaPath = rIdToMedia.get(embedMatch[1]);
        if (!mediaPath) continue;

        const ext = mediaPath.split('.').pop()?.toLowerCase() ?? '';
        const mimetype = ITEM_IMAGE_EXT_MIME[ext];
        if (!mimetype) continue;

        const imageBuffer = Buffer.from(
          await zip.file(mediaPath)!.async('nodebuffer'),
        );
        if (imageBuffer.byteLength > ITEM_IMAGE_MAX_BYTES) continue;

        byRow.set(excelRow, {
          buffer: imageBuffer,
          mimetype,
          size: imageBuffer.byteLength,
        });
      }
    } catch {
      // .xls / .csv / malformed zip — ignore embedded images
    }
    return byRow;
  }

  /** Download a public image URL and attach it to the stock row's catalog item. */
  private async attachImageFromUrl(stockId: string, imageUrl: string) {
    let parsed: URL;
    try {
      parsed = new URL(imageUrl);
    } catch {
      throw new BadRequestException('Invalid image URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('imageUrl must be http or https');
    }
    const hosts = (process.env.IMAGE_FETCH_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    if (
      parsed.protocol !== 'https:' ||
      !hosts.includes(parsed.hostname.toLowerCase()) ||
      isBlockedImageHost(parsed.hostname)
    ) {
      throw new BadRequestException('imageUrl host is not allowed');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response: Response;
    try {
      response = await fetch(parsed.toString(), {
        signal: controller.signal,
        redirect: 'error',
        headers: { Accept: 'image/*' },
      });
    } catch {
      throw new BadRequestException('Failed to download image');
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new BadRequestException(
        `Image download failed (${response.status})`,
      );
    }

    const contentType = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!ITEM_IMAGE_MIME[contentType]) {
      throw new BadRequestException(
        'Remote file must be JPEG, PNG, WebP, or GIF',
      );
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > ITEM_IMAGE_MAX_BYTES) {
      throw new BadRequestException('Image must be 5 MB or smaller');
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > ITEM_IMAGE_MAX_BYTES) {
      throw new BadRequestException('Image must be 5 MB or smaller');
    }

    await this.uploadItemImage(stockId, {
      buffer: Buffer.from(arrayBuffer),
      mimetype: contentType,
      size: arrayBuffer.byteLength,
    });
  }

  private async ensureLocation(locationId: string) {
    const loc = await this.locationRepo.findOne({ where: { id: locationId } });
    if (!loc) throw new BadRequestException('Location not found');
  }
}

function exceptionMessage(err: unknown): string {
  if (err instanceof BadRequestException) {
    const res = err.getResponse();
    if (typeof res === 'string') return res;
    if (typeof res === 'object' && res && 'message' in res) {
      const message = (res as { message: string | string[] }).message;
      return Array.isArray(message) ? message.join(', ') : String(message);
    }
  }
  if (err instanceof Error) return err.message;
  return 'unknown';
}

function isBlockedImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host === 'metadata.google.internal' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }

  if (host.includes(':')) {
    // IPv6: block loopback / link-local / ULA
    return (
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80')
    );
  }

  const parts = host.split('.').map((p) => Number(p));
  if (
    parts.length === 4 &&
    parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }

  return false;
}

const REL_HREF_RE =
  /<Relationship[^>]*\bId="([^"]+)"[^>]*\bType="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/>/g;
const DRAWING_ANCHOR_RE =
  /<xdr:(?:twoCellAnchor|oneCellAnchor)[^>]*>[\s\S]*?<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g;

async function resolveFirstWorksheetPath(
  zip: JSZip,
): Promise<string | undefined> {
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
  const workbookRels = await zip
    .file('xl/_rels/workbook.xml.rels')
    ?.async('string');
  if (!workbookXml || !workbookRels) {
    return zip.file('xl/worksheets/sheet1.xml')
      ? 'xl/worksheets/sheet1.xml'
      : undefined;
  }

  const firstSheet = workbookXml.match(/<sheet[^>]*\br:id="([^"]+)"[^>]*\/?>/);
  if (!firstSheet) {
    return zip.file('xl/worksheets/sheet1.xml')
      ? 'xl/worksheets/sheet1.xml'
      : undefined;
  }

  for (const m of workbookRels.matchAll(REL_HREF_RE)) {
    if (m[1] === firstSheet[1]) {
      return resolveZipPath('xl/workbook.xml', m[3]);
    }
  }
  return undefined;
}

function worksheetRelsPath(sheetPath: string): string {
  return relsPathFor(sheetPath);
}

function relsPathFor(partPath: string): string {
  const parts = partPath.split('/');
  const file = parts.pop()!;
  return `${parts.join('/')}/_rels/${file}.rels`;
}

function resolveZipPath(fromPath: string, target: string): string {
  if (target.startsWith('/')) return target.replace(/^\//, '');
  const baseParts = fromPath.split('/');
  baseParts.pop();
  for (const part of target.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') baseParts.pop();
    else baseParts.push(part);
  }
  return baseParts.join('/');
}
