import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ProductionOrderStatus, StockMovementType } from '../common/enums';
import {
  applyDateRangeToQb,
  applyIlikeSearch,
  paginatedQueryBuilder,
} from '../common/utils/query.util';
import { BomsService } from '../boms/boms.service';
import { Bom } from '../database/entities/bom.entity';
import { Item } from '../database/entities/item.entity';
import { Location } from '../database/entities/location.entity';
import { ProductionOrderLine } from '../database/entities/production-order-line.entity';
import { ProductionOrder } from '../database/entities/production-order.entity';
import { StockService } from '../inventory/stock.service';
import { LowStockService } from '../notifications/low-stock.service';
import {
  CompleteProductionDto,
  CreateProductionOrderDto,
  IssueProductionDto,
  ProductionOrderListQueryDto,
  ScrapProductionDto,
  UnbuildProductionDto,
} from './dto/production-order.dto';

@Injectable()
export class ProductionService {
  constructor(
    @InjectRepository(ProductionOrder)
    private readonly orderRepo: Repository<ProductionOrder>,
    @InjectRepository(Bom)
    private readonly bomRepo: Repository<Bom>,
    @InjectRepository(Location)
    private readonly locationRepo: Repository<Location>,
    @InjectRepository(Item)
    private readonly itemRepo: Repository<Item>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly stockService: StockService,
    private readonly lowStockService: LowStockService,
    private readonly bomsService: BomsService,
  ) {}

  findAll(query: ProductionOrderListQueryDto) {
    const qb = this.orderRepo
      .createQueryBuilder('po')
      .leftJoinAndSelect('po.finishedItem', 'finishedItem')
      .leftJoinAndSelect('po.location', 'location')
      .leftJoinAndSelect('po.finishedLocation', 'finishedLocation')
      .leftJoinAndSelect('po.bom', 'bom')
      .leftJoinAndSelect('po.lines', 'lines')
      .leftJoinAndSelect('lines.componentItem', 'componentItem')
      .leftJoinAndSelect('po.createdBy', 'createdBy')
      .orderBy('po.created_at', 'DESC');

    if (query.locationId) {
      qb.andWhere(
        '(po.location_id = :locationId OR po.finished_location_id = :locationId)',
        { locationId: query.locationId },
      );
    }
    if (query.finishedItemId) {
      qb.andWhere('po.finished_item_id = :finishedItemId', {
        finishedItemId: query.finishedItemId,
      });
    }
    if (query.bomId) {
      qb.andWhere('po.bom_id = :bomId', { bomId: query.bomId });
    }
    if (query.status) {
      qb.andWhere('po.status = :status', { status: query.status });
    }
    applyIlikeSearch(qb, query.search, [
      'po.notes',
      'po.order_number',
      'finishedItem.description',
      'finishedItem.sku',
      'bom.name',
    ]);
    applyDateRangeToQb(qb, 'po.created_at', query.from, query.to);

    return paginatedQueryBuilder(qb, query.page, query.limit);
  }

  async findOne(id: string) {
    const order = await this.orderRepo.findOne({
      where: { id },
      relations: {
        finishedItem: true,
        location: true,
        finishedLocation: true,
        bom: true,
        createdBy: true,
        lines: { componentItem: true },
      },
    });
    if (!order) throw new NotFoundException('Production order not found');
    return order;
  }

  async create(dto: CreateProductionOrderDto, userId?: string) {
    const bom = await this.bomRepo.findOne({
      where: { id: dto.bomId },
      relations: { lines: true, finishedItem: true },
    });
    if (!bom) throw new BadRequestException('BOM not found');
    if (!bom.isActive) throw new BadRequestException('BOM is inactive');
    if (!bom.lines?.length) {
      throw new BadRequestException('BOM has no component lines');
    }
    this.assertBomEffective(bom);

    const location = await this.locationRepo.findOne({
      where: { id: dto.locationId },
    });
    if (!location) throw new BadRequestException('Location not found');

    const finishedLocationId = dto.finishedLocationId ?? dto.locationId;
    if (finishedLocationId !== dto.locationId) {
      const finLoc = await this.locationRepo.findOne({
        where: { id: finishedLocationId },
      });
      if (!finLoc) {
        throw new BadRequestException('Finished location not found');
      }
    }

    // Default: use BOM lines as written (stocked SEMIs like Seat/Back).
    // explodeBom=true flattens through SEMI BOMs to RAW (phantom / MRP style).
    const explode = dto.explodeBom === true;
    let lineSpecs: { componentItemId: string; quantityRequired: number }[];
    if (explode) {
      lineSpecs = await this.bomsService.explodeForProduction(
        bom.id,
        dto.quantityPlanned,
      );
    } else {
      const yieldPct = parseFloat(bom.yieldPercent) || 100;
      const materialMultiplier = yieldPct > 0 ? 100 / yieldPct : 1;
      lineSpecs = bom.lines.map((line) => {
        const scrap = parseFloat(line.scrapPercent) || 0;
        const perUnit = parseFloat(line.quantity) * (1 + scrap / 100);
        return {
          componentItemId: line.componentItemId,
          quantityRequired: perUnit * dto.quantityPlanned * materialMultiplier,
        };
      });
    }

    if (!lineSpecs.length) {
      throw new BadRequestException('BOM has no component requirements');
    }

    const orderNumber = await this.nextOrderNumber();

    const order = await this.orderRepo.save(
      this.orderRepo.create({
        orderNumber,
        bomId: bom.id,
        finishedItemId: bom.finishedItemId,
        locationId: dto.locationId,
        finishedLocationId,
        quantityPlanned: dto.quantityPlanned.toFixed(3),
        quantityCompleted: '0.000',
        quantityScrapped: '0.000',
        materialsReserved: false,
        status: ProductionOrderStatus.DRAFT,
        notes: dto.notes?.trim() || null,
        createdById: userId ?? null,
        lines: lineSpecs.map((spec) =>
          Object.assign(new ProductionOrderLine(), {
            componentItemId: spec.componentItemId,
            quantityRequired: spec.quantityRequired.toFixed(3),
            quantityIssued: '0.000',
            issuedValue: '0.00',
          }),
        ),
      }),
    );

    return this.findOne(order.id);
  }

  async release(id: string) {
    await this.dataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(ProductionOrder);
      const order = await orderRepo.findOne({
        where: { id },
        relations: { lines: { componentItem: true } },
      });
      if (!order) throw new NotFoundException('Production order not found');
      if (order.status !== ProductionOrderStatus.DRAFT) {
        throw new BadRequestException('Only DRAFT orders can be released');
      }

      const shortages: string[] = [];
      for (const line of order.lines) {
        const required = parseFloat(line.quantityRequired);
        if (required <= 0) continue;
        const available = await this.stockService.getAvailable(
          order.locationId,
          line.componentItemId,
          manager,
          { forUpdate: true },
        );
        if (available < required) {
          shortages.push(
            `${this.formatItemLabel(line.componentItem)}: need ${this.fmtQty(required)}, available ${this.fmtQty(available)}`,
          );
        }
      }
      if (shortages.length) {
        throw new BadRequestException(
          shortages.length === 1
            ? `Insufficient available stock to reserve: ${shortages[0]}`
            : ['Insufficient available stock to reserve:', ...shortages],
        );
      }

      for (const line of order.lines) {
        const required = parseFloat(line.quantityRequired);
        if (required <= 0) continue;
        await this.stockService.reserve(
          order.locationId,
          line.componentItemId,
          required,
          manager,
        );
      }

      order.status = ProductionOrderStatus.RELEASED;
      order.releasedAt = new Date();
      order.materialsReserved = true;
      await orderRepo.save(order);
    });

    return this.findOne(id);
  }

  async issue(id: string, dto: IssueProductionDto) {
    const stockChanges: {
      locationId: string;
      itemId: string;
      previous: number;
    }[] = [];

    await this.dataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(ProductionOrder);
      const order = await orderRepo.findOne({
        where: { id },
        relations: { lines: { componentItem: true } },
      });
      if (!order) throw new NotFoundException('Production order not found');
      if (
        order.status !== ProductionOrderStatus.RELEASED &&
        order.status !== ProductionOrderStatus.IN_PROGRESS
      ) {
        throw new BadRequestException(
          'Only RELEASED or IN_PROGRESS orders can issue materials',
        );
      }

      const issues = dto.lines?.length
        ? dto.lines
        : order.lines
            .map((line) => {
              const remaining =
                parseFloat(line.quantityRequired) -
                parseFloat(line.quantityIssued);
              return remaining > 0
                ? {
                    componentItemId: line.componentItemId,
                    quantity: remaining,
                  }
                : null;
            })
            .filter((x): x is { componentItemId: string; quantity: number } =>
              Boolean(x),
            );

      if (!issues.length) {
        throw new BadRequestException('Nothing left to issue');
      }

      for (const issue of issues) {
        const line = order.lines.find(
          (l) => l.componentItemId === issue.componentItemId,
        );
        if (!line) {
          const label = await this.itemLabel(issue.componentItemId, manager);
          throw new BadRequestException(
            `${label} is not a component on this production order`,
          );
        }
        const label = this.formatItemLabel(line.componentItem);
        const remaining =
          parseFloat(line.quantityRequired) - parseFloat(line.quantityIssued);
        if (issue.quantity > remaining + 1e-9) {
          throw new BadRequestException(
            `Cannot issue ${this.fmtQty(issue.quantity)} of ${label}; only ${this.fmtQty(remaining)} remaining on this order`,
          );
        }

        const previous = await this.stockService.getQuantity(
          order.locationId,
          issue.componentItemId,
          manager,
        );
        const stock = await this.stockService.getStock(
          order.locationId,
          issue.componentItemId,
          manager,
        );
        const unitCost = stock ? parseFloat(stock.purchasePrice) : 0;

        if (order.materialsReserved) {
          await this.stockService.consumeReserved(
            order.locationId,
            line.componentItemId,
            issue.quantity,
            manager,
            {
              type: StockMovementType.PRODUCTION_ISSUE,
              refType: 'production_order',
              refId: order.id,
            },
          );
        } else {
          if (previous < issue.quantity) {
            throw new BadRequestException(
              `Insufficient stock for ${label}. Available: ${this.fmtQty(previous)}, requested: ${this.fmtQty(issue.quantity)}`,
            );
          }
          await this.stockService.adjust(
            {
              locationId: order.locationId,
              itemId: line.componentItemId,
              quantityDelta: -issue.quantity,
              movement: {
                type: StockMovementType.PRODUCTION_ISSUE,
                refType: 'production_order',
                refId: order.id,
              },
            },
            manager,
          );
        }

        line.quantityIssued = (
          parseFloat(line.quantityIssued) + issue.quantity
        ).toFixed(3);
        line.issuedValue = (
          parseFloat(line.issuedValue ?? '0') +
          issue.quantity * unitCost
        ).toFixed(2);
        stockChanges.push({
          locationId: order.locationId,
          itemId: line.componentItemId,
          previous,
        });
      }

      order.status = ProductionOrderStatus.IN_PROGRESS;
      await orderRepo.save(order);
    });

    for (const change of stockChanges) {
      await this.lowStockService.evaluate(
        change.locationId,
        change.itemId,
        change.previous,
      );
    }

    return this.findOne(id);
  }

  async complete(id: string, dto: CompleteProductionDto) {
    const autoIssue = dto.autoIssue !== false;
    const stockChanges: {
      locationId: string;
      itemId: string;
      previous: number;
    }[] = [];

    await this.dataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(ProductionOrder);
      const order = await orderRepo.findOne({
        where: { id },
        relations: { lines: { componentItem: true } },
      });
      if (!order) throw new NotFoundException('Production order not found');
      if (
        order.status !== ProductionOrderStatus.RELEASED &&
        order.status !== ProductionOrderStatus.IN_PROGRESS
      ) {
        throw new BadRequestException(
          'Only RELEASED or IN_PROGRESS orders can be completed',
        );
      }

      const planned = parseFloat(order.quantityPlanned);
      const alreadyDone = parseFloat(order.quantityCompleted);
      const remainingFg = planned - alreadyDone;
      if (dto.quantity > remainingFg + 1e-9) {
        throw new BadRequestException(
          `Completion quantity exceeds what is left to produce. Remaining: ${this.fmtQty(remainingFg)}`,
        );
      }

      const ratio = dto.quantity / planned;
      const receiptLocationId = order.finishedLocationId ?? order.locationId;

      for (const line of order.lines) {
        const label = this.formatItemLabel(line.componentItem);
        const neededForThis = parseFloat(line.quantityRequired) * ratio;
        const issued = parseFloat(line.quantityIssued);
        const shortfall = neededForThis - issued;

        if (shortfall > 1e-9) {
          if (!autoIssue) {
            throw new BadRequestException(
              `Not enough ${label} has been issued. Need ${this.fmtQty(neededForThis)}, already issued ${this.fmtQty(issued)}. Issue materials first or set autoIssue to true`,
            );
          }
          const stock = await this.stockService.getStock(
            order.locationId,
            line.componentItemId,
            manager,
          );
          const unitCost = stock ? parseFloat(stock.purchasePrice) : 0;
          const previous = await this.stockService.getQuantity(
            order.locationId,
            line.componentItemId,
            manager,
          );

          if (order.materialsReserved) {
            await this.stockService.consumeReserved(
              order.locationId,
              line.componentItemId,
              shortfall,
              manager,
              {
                type: StockMovementType.PRODUCTION_ISSUE,
                refType: 'production_order',
                refId: order.id,
                notes: 'Auto-issue on complete',
              },
            );
          } else {
            if (previous < shortfall) {
              throw new BadRequestException(
                `Insufficient stock for ${label}. Available: ${this.fmtQty(previous)}, needed: ${this.fmtQty(shortfall)}`,
              );
            }
            await this.stockService.adjust(
              {
                locationId: order.locationId,
                itemId: line.componentItemId,
                quantityDelta: -shortfall,
                movement: {
                  type: StockMovementType.PRODUCTION_ISSUE,
                  refType: 'production_order',
                  refId: order.id,
                  notes: 'Auto-issue on complete',
                },
              },
              manager,
            );
          }
          line.quantityIssued = (issued + shortfall).toFixed(3);
          line.issuedValue = (
            parseFloat(line.issuedValue ?? '0') +
            shortfall * unitCost
          ).toFixed(2);
          stockChanges.push({
            locationId: order.locationId,
            itemId: line.componentItemId,
            previous,
          });
        }
      }

      // Actual costing: allocate issued value proportional to this completion
      let materialCost = 0;
      for (const line of order.lines) {
        const issuedQty = parseFloat(line.quantityIssued);
        const issuedVal = parseFloat(line.issuedValue ?? '0');
        const neededForThis = parseFloat(line.quantityRequired) * ratio;
        if (issuedQty > 1e-9) {
          materialCost += issuedVal * (neededForThis / issuedQty);
        }
      }
      const fgUnitCost = dto.quantity > 0 ? materialCost / dto.quantity : 0;

      const fgPrevious = await this.stockService.getQuantity(
        receiptLocationId,
        order.finishedItemId,
        manager,
      );
      await this.stockService.adjust(
        {
          locationId: receiptLocationId,
          itemId: order.finishedItemId,
          quantityDelta: dto.quantity,
          purchasePrice: fgUnitCost,
          movement: {
            type: StockMovementType.PRODUCTION_RECEIPT,
            refType: 'production_order',
            refId: order.id,
            notes: `Actual material cost ${materialCost.toFixed(2)}`,
          },
        },
        manager,
      );
      stockChanges.push({
        locationId: receiptLocationId,
        itemId: order.finishedItemId,
        previous: fgPrevious,
      });

      // Release leftover reservation for unused portion when fully complete
      const newCompleted = alreadyDone + dto.quantity;
      const fullyDone = newCompleted >= planned - 1e-9;

      if (fullyDone && order.materialsReserved) {
        for (const line of order.lines) {
          const reservedLeft =
            parseFloat(line.quantityRequired) - parseFloat(line.quantityIssued);
          if (reservedLeft > 1e-9) {
            await this.stockService.releaseReservation(
              order.locationId,
              line.componentItemId,
              reservedLeft,
              manager,
            );
          }
        }
        order.materialsReserved = false;
      }

      order.quantityCompleted = newCompleted.toFixed(3);
      order.status = fullyDone
        ? ProductionOrderStatus.COMPLETED
        : ProductionOrderStatus.IN_PROGRESS;
      if (fullyDone) order.completedAt = new Date();
      await orderRepo.save(order);
    });

    for (const change of stockChanges) {
      await this.lowStockService.evaluate(
        change.locationId,
        change.itemId,
        change.previous,
      );
    }

    return this.findOne(id);
  }

  /** Reverse completed FG and return proportional issued materials. */
  async unbuild(id: string, dto: UnbuildProductionDto) {
    const stockChanges: {
      locationId: string;
      itemId: string;
      previous: number;
    }[] = [];

    await this.dataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(ProductionOrder);
      const order = await orderRepo.findOne({
        where: { id },
        relations: { lines: { componentItem: true } },
      });
      if (!order) throw new NotFoundException('Production order not found');
      if (
        order.status !== ProductionOrderStatus.COMPLETED &&
        order.status !== ProductionOrderStatus.IN_PROGRESS
      ) {
        throw new BadRequestException(
          'Only COMPLETED or IN_PROGRESS orders with finished goods can be unbuilt',
        );
      }

      const completed = parseFloat(order.quantityCompleted);
      if (dto.quantity > completed + 1e-9) {
        throw new BadRequestException(
          `Cannot unbuild more than completed. Completed: ${this.fmtQty(completed)}`,
        );
      }

      const planned = parseFloat(order.quantityPlanned);
      const ratio = dto.quantity / planned;
      const receiptLocationId = order.finishedLocationId ?? order.locationId;

      const fgPrevious = await this.stockService.getQuantity(
        receiptLocationId,
        order.finishedItemId,
        manager,
      );
      if (fgPrevious < dto.quantity) {
        throw new BadRequestException(
          `Insufficient finished goods to unbuild. Available: ${this.fmtQty(fgPrevious)}`,
        );
      }
      await this.stockService.adjust(
        {
          locationId: receiptLocationId,
          itemId: order.finishedItemId,
          quantityDelta: -dto.quantity,
          movement: {
            type: StockMovementType.PRODUCTION_REVERSE,
            refType: 'production_order',
            refId: order.id,
            notes: dto.notes ?? 'Unbuild finished goods',
          },
        },
        manager,
      );
      stockChanges.push({
        locationId: receiptLocationId,
        itemId: order.finishedItemId,
        previous: fgPrevious,
      });

      for (const line of order.lines) {
        const returnQty = parseFloat(line.quantityRequired) * ratio;
        if (returnQty <= 1e-9) continue;
        const issued = parseFloat(line.quantityIssued);
        const take = Math.min(returnQty, issued);
        if (take <= 1e-9) continue;

        const avgCost =
          issued > 0 ? parseFloat(line.issuedValue ?? '0') / issued : 0;
        const previous = await this.stockService.getQuantity(
          order.locationId,
          line.componentItemId,
          manager,
        );
        await this.stockService.adjust(
          {
            locationId: order.locationId,
            itemId: line.componentItemId,
            quantityDelta: take,
            purchasePrice: avgCost || undefined,
            movement: {
              type: StockMovementType.PRODUCTION_REVERSE,
              refType: 'production_order',
              refId: order.id,
              notes: dto.notes ?? 'Unbuild — return materials',
            },
          },
          manager,
        );
        line.quantityIssued = (issued - take).toFixed(3);
        line.issuedValue = Math.max(
          0,
          parseFloat(line.issuedValue ?? '0') - take * avgCost,
        ).toFixed(2);
        stockChanges.push({
          locationId: order.locationId,
          itemId: line.componentItemId,
          previous,
        });
      }

      order.quantityCompleted = (completed - dto.quantity).toFixed(3);
      order.status = ProductionOrderStatus.IN_PROGRESS;
      order.completedAt = null;
      await orderRepo.save(order);
    });

    for (const change of stockChanges) {
      await this.lowStockService.evaluate(
        change.locationId,
        change.itemId,
        change.previous,
      );
    }

    return this.findOne(id);
  }

  /** Scrap finished goods already produced (components stay consumed). */
  async scrap(id: string, dto: ScrapProductionDto) {
    const stockChanges: {
      locationId: string;
      itemId: string;
      previous: number;
    }[] = [];

    await this.dataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(ProductionOrder);
      const order = await orderRepo.findOne({ where: { id } });
      if (!order) throw new NotFoundException('Production order not found');

      const completed = parseFloat(order.quantityCompleted);
      if (dto.quantity > completed + 1e-9) {
        throw new BadRequestException(
          `Cannot scrap more than completed. Completed: ${this.fmtQty(completed)}`,
        );
      }

      const receiptLocationId = order.finishedLocationId ?? order.locationId;
      const previous = await this.stockService.getQuantity(
        receiptLocationId,
        order.finishedItemId,
        manager,
      );
      if (previous < dto.quantity) {
        throw new BadRequestException(
          `Insufficient finished goods to scrap. Available: ${this.fmtQty(previous)}`,
        );
      }

      await this.stockService.adjust(
        {
          locationId: receiptLocationId,
          itemId: order.finishedItemId,
          quantityDelta: -dto.quantity,
          movement: {
            type: StockMovementType.ADJUSTMENT,
            refType: 'production_order',
            refId: order.id,
            notes: dto.notes ?? 'Production scrap',
          },
        },
        manager,
      );

      order.quantityCompleted = (completed - dto.quantity).toFixed(3);
      order.quantityScrapped = (
        parseFloat(order.quantityScrapped ?? '0') + dto.quantity
      ).toFixed(3);
      if (
        parseFloat(order.quantityCompleted) < 1e-9 &&
        order.status === ProductionOrderStatus.COMPLETED
      ) {
        order.status = ProductionOrderStatus.IN_PROGRESS;
        order.completedAt = null;
      }
      await orderRepo.save(order);
      stockChanges.push({
        locationId: receiptLocationId,
        itemId: order.finishedItemId,
        previous,
      });
    });

    for (const change of stockChanges) {
      await this.lowStockService.evaluate(
        change.locationId,
        change.itemId,
        change.previous,
      );
    }

    return this.findOne(id);
  }

  async cancel(id: string) {
    const stockChanges: {
      locationId: string;
      itemId: string;
      previous: number;
    }[] = [];

    await this.dataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(ProductionOrder);
      const order = await orderRepo.findOne({
        where: { id },
        relations: { lines: true },
      });
      if (!order) throw new NotFoundException('Production order not found');
      if (
        order.status === ProductionOrderStatus.COMPLETED ||
        order.status === ProductionOrderStatus.CANCELLED
      ) {
        throw new BadRequestException(
          'Completed or cancelled orders cannot be cancelled — use unbuild for finished goods',
        );
      }
      if (parseFloat(order.quantityCompleted) > 0) {
        throw new BadRequestException(
          'Cannot cancel an order with completed finished goods; use unbuild first',
        );
      }

      for (const line of order.lines) {
        const issued = parseFloat(line.quantityIssued);
        const required = parseFloat(line.quantityRequired);
        const reservedLeft = order.materialsReserved ? required - issued : 0;

        if (reservedLeft > 1e-9) {
          await this.stockService.releaseReservation(
            order.locationId,
            line.componentItemId,
            reservedLeft,
            manager,
          );
        }

        if (issued > 0) {
          const previous = await this.stockService.getQuantity(
            order.locationId,
            line.componentItemId,
            manager,
          );
          await this.stockService.adjust(
            {
              locationId: order.locationId,
              itemId: line.componentItemId,
              quantityDelta: issued,
              movement: {
                type: StockMovementType.PRODUCTION_REVERSE,
                refType: 'production_order',
                refId: order.id,
                notes: 'Production order cancelled — return issued materials',
              },
            },
            manager,
          );
          line.quantityIssued = '0.000';
          line.issuedValue = '0.00';
          stockChanges.push({
            locationId: order.locationId,
            itemId: line.componentItemId,
            previous,
          });
        }
      }

      order.materialsReserved = false;
      order.status = ProductionOrderStatus.CANCELLED;
      await orderRepo.save(order);
    });

    for (const change of stockChanges) {
      await this.lowStockService.evaluate(
        change.locationId,
        change.itemId,
        change.previous,
      );
    }

    return this.findOne(id);
  }

  private assertBomEffective(bom: Bom) {
    const today = new Date().toISOString().slice(0, 10);
    if (bom.effectiveFrom && bom.effectiveFrom > today) {
      throw new BadRequestException(
        `BOM is not yet effective (from ${bom.effectiveFrom})`,
      );
    }
    if (bom.effectiveTo && bom.effectiveTo < today) {
      throw new BadRequestException(
        `BOM is no longer effective (to ${bom.effectiveTo})`,
      );
    }
  }

  private async nextOrderNumber(): Promise<string> {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = `PO-${day}-`;
    const latest = await this.orderRepo
      .createQueryBuilder('po')
      .where('po.order_number LIKE :prefix', { prefix: `${prefix}%` })
      .orderBy('po.order_number', 'DESC')
      .getOne();
    let seq = 1;
    if (latest?.orderNumber) {
      const tail = latest.orderNumber.slice(prefix.length);
      const n = parseInt(tail, 10);
      if (Number.isFinite(n)) seq = n + 1;
    }
    return `${prefix}${String(seq).padStart(4, '0')}`;
  }

  private formatItemLabel(
    item?: Pick<Item, 'description' | 'sku'> | null,
  ): string {
    if (!item) return 'Unknown item';
    const name = item.description?.trim() || 'Unnamed item';
    const sku = item.sku?.trim();
    return sku ? `${name} (${sku})` : name;
  }

  private async itemLabel(
    itemId: string,
    manager?: EntityManager,
  ): Promise<string> {
    const repo = manager ? manager.getRepository(Item) : this.itemRepo;
    const item = await repo.findOne({ where: { id: itemId } });
    return item ? this.formatItemLabel(item) : `Unknown item (${itemId})`;
  }

  private fmtQty(n: number): string {
    if (Number.isInteger(n)) return String(n);
    return parseFloat(n.toFixed(3)).toString();
  }
}
