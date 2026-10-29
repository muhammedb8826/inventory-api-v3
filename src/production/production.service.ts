import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  InquiryAssignmentStatus,
  InquiryStatus,
  ProductionOrderStatus,
  StockMovementType,
} from '../common/enums';
import {
  applyDateRangeToQb,
  applyIlikeSearch,
  paginatedQueryBuilder,
} from '../common/utils/query.util';
import { BomsService } from '../boms/boms.service';
import { Bom } from '../database/entities/bom.entity';
import { CustomerInquiry } from '../database/entities/customer-inquiry.entity';
import { Item } from '../database/entities/item.entity';
import { Location } from '../database/entities/location.entity';
import { ProductionOrderLine } from '../database/entities/production-order-line.entity';
import { ProductionOrder } from '../database/entities/production-order.entity';
import { Sale } from '../database/entities/sale.entity';
import { StockService } from '../inventory/stock.service';
import { LowStockService } from '../notifications/low-stock.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CompleteProductionDto,
  CreateProductionOrderDto,
  IssueProductionDto,
  ProductionOrderListQueryDto,
  ScrapProductionDto,
  StartProductionFromInquiryDto,
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
    @InjectRepository(CustomerInquiry)
    private readonly inquiryRepo: Repository<CustomerInquiry>,
    @InjectRepository(Sale)
    private readonly saleRepo: Repository<Sale>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly stockService: StockService,
    private readonly lowStockService: LowStockService,
    private readonly bomsService: BomsService,
    private readonly notifications: NotificationsService,
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
      .leftJoinAndSelect('po.inquiry', 'inquiry')
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
    if (query.inquiryId) {
      qb.andWhere('po.inquiry_id = :inquiryId', {
        inquiryId: query.inquiryId,
      });
    }
    if (query.saleId) {
      qb.andWhere('po.sale_id = :saleId', { saleId: query.saleId });
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
        inquiry: true,
        sale: true,
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

    const inquiryId = dto.inquiryId
      ? await this.assertInquiryForProduction(dto.inquiryId)
      : null;
    const saleId = dto.saleId ? await this.assertSaleLink(dto.saleId) : null;

    // Industry: explode phantom components only; stocked SEMIs issued as-is.
    // explodeBom=true forces full flatten to leaf RAW (ignore phantom flags).
    const lineSpecs = await this.bomsService.explodeForProduction(
      bom.id,
      dto.quantityPlanned,
      dto.explodeBom === true,
    );

    if (!lineSpecs.length) {
      throw new BadRequestException('BOM has no component requirements');
    }

    const orderNumber = await this.nextOrderNumber();
    const notes =
      dto.notes?.trim() ||
      (inquiryId ? `MTO from inquiry ${inquiryId.slice(0, 8)}` : null);

    const order = await this.orderRepo.save(
      this.orderRepo.create({
        orderNumber,
        bomId: bom.id,
        finishedItemId: bom.finishedItemId,
        inquiryId,
        saleId,
        locationId: dto.locationId,
        finishedLocationId,
        quantityPlanned: dto.quantityPlanned.toFixed(3),
        quantityCompleted: '0.000',
        quantityScrapped: '0.000',
        materialsReserved: false,
        status: ProductionOrderStatus.DRAFT,
        notes,
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

    if (inquiryId) {
      await this.inquiryRepo.update(
        { id: inquiryId },
        {
          status: InquiryStatus.IN_PROGRESS,
          readyForSaleAt: null,
        },
      );
    }

    return this.findOne(order.id);
  }

  /**
   * Start production from a firm-demand inquiry (QUOTED / IN_PROGRESS):
   * resolve item + default BOM → DRAFT work order.
   */
  async createFromInquiry(dto: StartProductionFromInquiryDto, userId?: string) {
    const inquiry = await this.inquiryRepo.findOne({
      where: { id: dto.inquiryId },
      relations: { lines: { item: true } },
    });
    if (!inquiry) throw new NotFoundException('Inquiry not found');
    if (
      inquiry.status === InquiryStatus.CANCELLED ||
      inquiry.status === InquiryStatus.CLOSED ||
      inquiry.status === InquiryStatus.CONVERTED
    ) {
      throw new BadRequestException(
        `Cannot start production for inquiry in status ${inquiry.status}`,
      );
    }
    // Industry: plan production against firm demand (QUOTED). IN_PROGRESS is
    // allowed so a second work order can be opened while the first runs.
    if (
      inquiry.status !== InquiryStatus.QUOTED &&
      inquiry.status !== InquiryStatus.IN_PROGRESS
    ) {
      throw new BadRequestException(
        'Confirm the inquiry quote (firm demand) before starting production',
      );
    }
    if (
      inquiry.assignmentStatus !== InquiryAssignmentStatus.ACCEPTED &&
      inquiry.assignmentStatus !== InquiryAssignmentStatus.UNASSIGNED
    ) {
      // Allow ACCEPTED (normal) or UNASSIGNED for small shops; block PENDING/DECLINED.
      if (inquiry.assignmentStatus === InquiryAssignmentStatus.PENDING) {
        throw new BadRequestException(
          'Accept the inquiry assignment before starting production',
        );
      }
    }

    const lines = inquiry.lines ?? [];
    if (!lines.length && !dto.itemId && !dto.bomId) {
      throw new BadRequestException(
        'Inquiry has no item lines — pass bomId (and item via BOM) explicitly',
      );
    }

    let bomId = dto.bomId;
    let quantity =
      dto.quantityPlanned ??
      (lines[0]?.quantity ? parseFloat(lines[0].quantity) : 1);
    if (!Number.isFinite(quantity) || quantity <= 0) quantity = 1;

    if (!bomId) {
      const itemId = dto.itemId ?? lines.find((l) => l.itemId)?.itemId ?? null;
      if (!itemId) {
        throw new BadRequestException(
          'Pass itemId or bomId — inquiry has no item lines',
        );
      }
      const defaultBom = await this.bomsService.findDefaultBom(itemId);
      if (!defaultBom) {
        throw new BadRequestException(
          'No active default BOM for the inquiry item — create a BOM or pass bomId',
        );
      }
      bomId = defaultBom.id;
      const line = lines.find((l) => l.itemId === itemId);
      if (!dto.quantityPlanned && line?.quantity) {
        const q = parseFloat(line.quantity);
        if (Number.isFinite(q) && q > 0) quantity = q;
      }
    }

    return this.create(
      {
        bomId,
        locationId: dto.locationId,
        finishedLocationId: dto.finishedLocationId,
        quantityPlanned: quantity,
        explodeBom: dto.explodeBom,
        inquiryId: inquiry.id,
        notes: dto.notes,
      },
      userId,
    );
  }

  /**
   * BOM material list for the job: required vs on-hand / available / shortage.
   * Used by planners before Release and by warehouse before Issue.
   */
  async materialRequirements(id: string) {
    const order = await this.orderRepo.findOne({
      where: { id },
      relations: { lines: { componentItem: true }, location: true },
    });
    if (!order) throw new NotFoundException('Production order not found');

    const lines = [];
    for (const line of order.lines ?? []) {
      const required = parseFloat(line.quantityRequired);
      const issued = parseFloat(line.quantityIssued ?? '0');
      const remaining = Math.max(0, required - issued);
      const onHand = await this.stockService.getQuantity(
        order.locationId,
        line.componentItemId,
      );
      const available = await this.stockService.getAvailable(
        order.locationId,
        line.componentItemId,
      );
      const reservedForOrder =
        order.materialsReserved && remaining > 0 ? remaining : 0;
      const shortage =
        order.status === ProductionOrderStatus.DRAFT
          ? Math.max(0, required - available)
          : Math.max(0, remaining - available - reservedForOrder);

      lines.push({
        componentItemId: line.componentItemId,
        sku: line.componentItem?.sku ?? null,
        description: line.componentItem?.description ?? null,
        quantityRequired: required.toFixed(3),
        quantityIssued: issued.toFixed(3),
        quantityRemaining: remaining.toFixed(3),
        onHand: onHand.toFixed(3),
        available: available.toFixed(3),
        reservedForOrder: reservedForOrder.toFixed(3),
        shortage: shortage.toFixed(3),
      });
    }

    const hasShortages = lines.some((l) => parseFloat(l.shortage) > 0);
    return {
      productionOrderId: order.id,
      orderNumber: order.orderNumber,
      locationId: order.locationId,
      locationName: order.location?.name ?? null,
      status: order.status,
      materialsReserved: order.materialsReserved,
      hasShortages,
      lines,
    };
  }

  async release(id: string, actorUserId?: string) {
    let shortageLabels: string[] = [];
    let shortageDetails: {
      componentItemId: string;
      sku?: string | null;
      description?: string | null;
      shortageQty: string;
    }[] = [];
    let shortageLocationId: string | null = null;

    await this.dataSource
      .transaction(async (manager) => {
        const orderRepo = manager.getRepository(ProductionOrder);
        await orderRepo
          .createQueryBuilder('document')
          .where('document.id = :id', { id })
          .setLock('pessimistic_write')
          .getOne();
        const order = await orderRepo.findOne({
          where: { id },
          relations: { lines: { componentItem: true } },
        });/
        if (!order) throw new NotFoundException('Production order not found');
        if (order.status !== ProductionOrderStatus.DRAFT) {
          throw new BadRequestException('Only DRAFT orders can be released');
        }

        const shortages: string[] = [];
        const details: typeof shortageDetails = [];
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
            const shortQty = required - available;
            shortages.push(
              `${this.formatItemLabel(line.componentItem)}: need ${this.fmtQty(required)}, available ${this.fmtQty(available)}`,
            );
            details.push({
              componentItemId: line.componentItemId,
              sku: line.componentItem?.sku ?? null,
              description: line.componentItem?.description ?? null,
              shortageQty: shortQty.toFixed(3),
            });
          }
        }
        if (shortages.length) {
          shortageLabels = shortages;
          shortageDetails = details;
          shortageLocationId = order.locationId;
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
      })
      .catch(async (err) => {
        if (shortageLabels.length) {
          const draft = await this.findOne(id).catch(() => null);
          await this.notifications.onProductionMaterialShortage({
            productionOrderId: id,
            orderNumber: draft?.orderNumber ?? null,
            shortages: shortageLabels,
            shortagesDetailed: shortageDetails,
            locationId: shortageLocationId ?? draft?.locationId ?? null,
            actorUserId: actorUserId ?? null,
            inquiryId: draft?.inquiryId ?? null,
          });
        }
        throw err;
      });

    const released = await this.findOne(id);
    await this.notifications.onProductionReleased({
      productionOrderId: released.id,
      orderNumber: released.orderNumber,
      finishedItemLabel:
        released.finishedItem?.description ?? released.finishedItemId,
      quantityPlanned: released.quantityPlanned,
      actorUserId: actorUserId ?? null,
      inquiryId: released.inquiryId,
    });
    return released;
  }

  async issue(id: string, dto: IssueProductionDto) {
    const stockChanges: {
      locationId: string;
      itemId: string;
      previous: number;
    }[] = [];

    await this.dataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(ProductionOrder);
      await orderRepo
        .createQueryBuilder('document')
        .where('document.id = :id', { id })
        .setLock('pessimistic_write')
        .getOne();
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

  async complete(id: string, dto: CompleteProductionDto, actorUserId?: string) {
    const autoIssue = dto.autoIssue !== false;
    const stockChanges: {
      locationId: string;
      itemId: string;
      previous: number;
    }[] = [];
    let becameFullyDone = false;

    await this.dataSource.transaction(async (manager) => {
      const orderRepo = manager.getRepository(ProductionOrder);
      await orderRepo
        .createQueryBuilder('document')
        .where('document.id = :id', { id })
        .setLock('pessimistic_write')
        .getOne();
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
      if (fullyDone) {
        order.completedAt = new Date();
        becameFullyDone = true;
        if (order.inquiryId) {
          await manager
            .getRepository(CustomerInquiry)
            .update({ id: order.inquiryId }, { readyForSaleAt: new Date() });
        }
      }
      await orderRepo.save(order);
    });

    for (const change of stockChanges) {
      await this.lowStockService.evaluate(
        change.locationId,
        change.itemId,
        change.previous,
      );
    }

    const completed = await this.findOne(id);
    if (becameFullyDone) {
      let assigneeUserId: string | null = null;
      if (completed.inquiryId) {
        const inquiry = await this.inquiryRepo.findOne({
          where: { id: completed.inquiryId },
        });
        assigneeUserId = inquiry?.assignedToUserId ?? null;
      }
      await this.notifications.onProductionReadyForSale({
        productionOrderId: completed.id,
        orderNumber: completed.orderNumber,
        finishedItemLabel:
          completed.finishedItem?.description ?? completed.finishedItemId,
        quantityCompleted: completed.quantityCompleted,
        actorUserId: actorUserId ?? null,
        inquiryId: completed.inquiryId,
        assigneeUserId,
      });
    }
    return completed;
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
      await orderRepo
        .createQueryBuilder('document')
        .where('document.id = :id', { id })
        .setLock('pessimistic_write')
        .getOne();
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
      await orderRepo
        .createQueryBuilder('document')
        .where('document.id = :id', { id })
        .setLock('pessimistic_write')
        .getOne();
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
      await orderRepo
        .createQueryBuilder('document')
        .where('document.id = :id', { id })
        .setLock('pessimistic_write')
        .getOne();
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

  private async assertInquiryForProduction(inquiryId: string): Promise<string> {
    const inquiry = await this.inquiryRepo.findOne({
      where: { id: inquiryId },
    });
    if (!inquiry) throw new BadRequestException('Inquiry not found');
    if (
      inquiry.status === InquiryStatus.CANCELLED ||
      inquiry.status === InquiryStatus.CLOSED ||
      inquiry.status === InquiryStatus.CONVERTED
    ) {
      throw new BadRequestException(
        `Cannot link production to inquiry in status ${inquiry.status}`,
      );
    }
    if (inquiry.assignmentStatus === InquiryAssignmentStatus.PENDING) {
      throw new BadRequestException(
        'Accept the inquiry assignment before linking production',
      );
    }
    return inquiry.id;
  }

  private async assertSaleLink(saleId: string): Promise<string> {
    const sale = await this.saleRepo.findOne({ where: { id: saleId } });
    if (!sale) throw new BadRequestException('Sale not found');
    return sale.id;
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
