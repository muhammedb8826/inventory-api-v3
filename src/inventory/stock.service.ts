import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { StockMovementType } from '../common/enums';
import { Item } from '../database/entities/item.entity';
import { StockLevel } from '../database/entities/stock-level.entity';
import { StockMovement } from '../database/entities/stock-movement.entity';

export interface StockMovementMeta {
  type: StockMovementType;
  refType?: string | null;
  refId?: string | null;
  createdById?: string | null;
  notes?: string | null;
}

export interface StockAdjustment {
  locationId: string;
  itemId: string;
  quantityDelta: number;
  purchasePrice?: number;
  /** Ledger metadata — defaults to ADJUSTMENT when omitted. */
  movement?: StockMovementMeta;
}

@Injectable()
export class StockService {
  constructor(
    @InjectRepository(StockLevel)
    private readonly stockRepo: Repository<StockLevel>,
    @InjectRepository(Item)
    private readonly itemRepo: Repository<Item>,
    @InjectRepository(StockMovement)
    private readonly movementRepo: Repository<StockMovement>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  private repos(manager?: EntityManager) {
    return {
      stock: manager ? manager.getRepository(StockLevel) : this.stockRepo,
      item: manager ? manager.getRepository(Item) : this.itemRepo,
      movement: manager
        ? manager.getRepository(StockMovement)
        : this.movementRepo,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof QueryFailedError &&
      typeof (err as QueryFailedError & { code?: string }).code === 'string' &&
      (err as QueryFailedError & { code?: string }).code === '23505'
    );
  }

  /**
   * Load stock row. When `forUpdate` and a transaction manager are set,
   * takes a Postgres row lock (`FOR UPDATE`) to serialize concurrent qty changes.
   */
  async getStock(
    locationId: string,
    itemId: string,
    manager?: EntityManager,
    options?: { forUpdate?: boolean },
  ): Promise<StockLevel | null> {
    const { stock } = this.repos(manager);
    const forUpdate = Boolean(options?.forUpdate && manager);

    if (forUpdate) {
      return stock
        .createQueryBuilder('s')
        .where('s.location_id = :locationId', { locationId })
        .andWhere('s.item_id = :itemId', { itemId })
        .setLock('pessimistic_write')
        .getOne();
    }

    return stock.findOne({ where: { locationId, itemId } });
  }

  async getQuantity(
    locationId: string,
    itemId: string,
    manager?: EntityManager,
    options?: { forUpdate?: boolean },
  ): Promise<number> {
    const row = await this.getStock(locationId, itemId, manager, options);
    return row ? parseFloat(row.quantity) : 0;
  }

  /**
   * Ensure a locked stock_levels row exists (qty 0) for location+item.
   * Handles concurrent first-insert races via unique constraint retry.
   */
  private async getOrCreateLocked(
    locationId: string,
    itemId: string,
    manager: EntityManager,
    initialPurchasePrice = 0,
  ): Promise<StockLevel> {
    const { stock } = this.repos(manager);
    let row = await this.getStock(locationId, itemId, manager, {
      forUpdate: true,
    });
    if (row) return row;

    try {
      await stock.save(
        stock.create({
          locationId,
          itemId,
          quantity: '0',
          purchasePrice: String(initialPurchasePrice),
        }),
      );
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
    }

    row = await this.getStock(locationId, itemId, manager, {
      forUpdate: true,
    });
    if (!row) {
      throw new BadRequestException(
        'Failed to lock stock level after concurrent create',
      );
    }
    return row;
  }

  async adjust(
    adj: StockAdjustment,
    manager?: EntityManager,
  ): Promise<StockLevel> {
    if (!manager) {
      return this.dataSource.transaction((tx) => this.adjust(adj, tx));
    }

    const { stock, item, movement } = this.repos(manager);
    const catalogItem = await item.findOne({ where: { id: adj.itemId } });
    if (!catalogItem) throw new BadRequestException('Item not found');

    const row = await this.getOrCreateLocked(
      adj.locationId,
      adj.itemId,
      manager,
      adj.purchasePrice ?? 0,
    );

    const currentQty = parseFloat(row.quantity);
    const newQty = currentQty + adj.quantityDelta;
    let unitCostForLedger: string | null = null;

    if (adj.purchasePrice !== undefined && adj.quantityDelta > 0) {
      const currentPrice = parseFloat(row.purchasePrice);
      const incoming = adj.quantityDelta;
      const weighted =
        currentQty <= 0
          ? adj.purchasePrice
          : (currentQty * currentPrice + incoming * adj.purchasePrice) /
            (currentQty + incoming);
      row.purchasePrice = weighted.toFixed(2);
      unitCostForLedger = adj.purchasePrice.toFixed(2);
    } else if (adj.quantityDelta !== 0) {
      unitCostForLedger = parseFloat(row.purchasePrice).toFixed(2);
    }

    row.quantity = newQty.toFixed(3);
    const saved = await stock.save(row);

    const meta = adj.movement ?? {
      type: StockMovementType.ADJUSTMENT,
    };

    await movement.save(
      movement.create({
        locationId: adj.locationId,
        itemId: adj.itemId,
        type: meta.type,
        quantityDelta: adj.quantityDelta.toFixed(3),
        quantityBefore: currentQty.toFixed(3),
        quantityAfter: newQty.toFixed(3),
        unitCost: unitCostForLedger,
        refType: meta.refType ?? null,
        refId: meta.refId ?? null,
        notes: meta.notes ?? null,
        createdById: meta.createdById ?? null,
      }),
    );

    return saved;
  }

  async transfer(
    fromLocationId: string,
    toLocationId: string,
    itemId: string,
    quantity: number,
    manager?: EntityManager,
    meta?: {
      refType?: string | null;
      refId?: string | null;
      createdById?: string | null;
      notes?: string | null;
    },
  ): Promise<void> {
    if (!manager) {
      return this.dataSource.transaction((tx) =>
        this.transfer(fromLocationId, toLocationId, itemId, quantity, tx, meta),
      );
    }

    if (quantity <= 0) {
      throw new BadRequestException('Quantity must be positive');
    }

    // Lock source then destination in stable id order to reduce deadlock risk.
    const [firstId, secondId] =
      fromLocationId < toLocationId
        ? [fromLocationId, toLocationId]
        : [toLocationId, fromLocationId];
    await this.getOrCreateLocked(firstId, itemId, manager);
    if (secondId !== firstId) {
      await this.getOrCreateLocked(secondId, itemId, manager);
    }

    const fromStock = await this.getStock(fromLocationId, itemId, manager, {
      forUpdate: true,
    });
    const available = fromStock ? parseFloat(fromStock.quantity) : 0;
    if (available < quantity) {
      throw new BadRequestException(
        `Insufficient stock. Available: ${available}, requested: ${quantity}`,
      );
    }

    const purchasePrice = fromStock ? parseFloat(fromStock.purchasePrice) : 0;
    const movementBase = {
      refType: meta?.refType ?? 'stock_transfer',
      refId: meta?.refId ?? null,
      createdById: meta?.createdById ?? null,
      notes: meta?.notes ?? null,
    };

    await this.adjust(
      {
        locationId: fromLocationId,
        itemId,
        quantityDelta: -quantity,
        movement: {
          type: StockMovementType.TRANSFER_OUT,
          ...movementBase,
        },
      },
      manager,
    );
    await this.adjust(
      {
        locationId: toLocationId,
        itemId,
        quantityDelta: quantity,
        purchasePrice,
        movement: {
          type: StockMovementType.TRANSFER_IN,
          ...movementBase,
        },
      },
      manager,
    );
  }

  async checkAvailability(
    locationId: string,
    lines: { itemId: string; quantity: number }[],
    allowNegative: boolean,
    manager?: EntityManager,
  ): Promise<string[]> {
    const { item } = this.repos(manager);
    const warnings: string[] = [];
    // Stable item order reduces deadlock chance when locking multiple SKUs.
    const ordered = [...lines].sort((a, b) =>
      a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0,
    );
    for (const line of ordered) {
      const available = await this.getQuantity(
        locationId,
        line.itemId,
        manager,
        manager ? { forUpdate: true } : undefined,
      );
      if (available < line.quantity) {
        const catalogItem = await item.findOne({ where: { id: line.itemId } });
        const msg = `${catalogItem?.description ?? line.itemId}: requested ${line.quantity}, available ${available}`;
        if (!allowNegative) {
          throw new BadRequestException(`Stock unavailable: ${msg}`);
        }
        warnings.push(msg);
      }
    }
    return warnings;
  }
}
