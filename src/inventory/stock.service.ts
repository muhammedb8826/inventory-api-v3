import Decimal from 'decimal.js';
import { assertUnitQuantity } from '../units/unit-quantity';
import { randomUUID } from 'crypto';
import { applyLocationScope } from '../common/location-scope';
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { StockMovementType } from '../common/enums';
import { Item } from '../database/entities/item.entity';
import { StockLevel } from '../database/entities/stock-level.entity';
import { StockLot } from '../database/entities/stock-lot.entity';
import { StockMovement } from '../database/entities/stock-movement.entity';

export interface StockMovementMeta {
  type: StockMovementType;
  refType?: string | null;
  refId?: string | null;
  createdById?: string | null;
  notes?: string | null;
  lotId?: string | null;
  lotNumber?: string | null;
}

export interface StockAdjustment {
  locationId: string;
  itemId: string;
  quantityDelta: number;
  purchasePrice?: number;
  /** Optional lot/batch for receipts & issues. */
  lotNumber?: string;
  expiryDate?: string | null;
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
    @InjectRepository(StockLot)
    private readonly lotRepo: Repository<StockLot>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async assertQuantity(
    itemId: string,
    quantity: number | string,
    manager?: EntityManager,
  ) {
    const catalogItem = await this.repos(manager).item.findOne({
      where: { id: itemId },
    });
    if (!catalogItem) throw new BadRequestException('Item not found');
    assertUnitQuantity(catalogItem.stockUnit, quantity);
    return catalogItem;
  }

  private repos(manager?: EntityManager) {
    return {
      stock: manager ? manager.getRepository(StockLevel) : this.stockRepo,
      item: manager ? manager.getRepository(Item) : this.itemRepo,
      movement: manager
        ? manager.getRepository(StockMovement)
        : this.movementRepo,
      lot: manager ? manager.getRepository(StockLot) : this.lotRepo,
    };
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
      // Match the item-before-stock lock order used by unit corrections and
      // inventory creation; the precision trigger also locks this item.
      await manager!.query('SELECT id FROM items WHERE id=$1 FOR SHARE', [
        itemId,
      ]);
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

  /** On-hand qty minus reserved (sellable / transferable). */
  async getAvailable(
    locationId: string,
    itemId: string,
    manager?: EntityManager,
    options?: { forUpdate?: boolean },
  ): Promise<number> {
    const row = await this.getStock(locationId, itemId, manager, options);
    if (!row) return 0;
    return parseFloat(row.quantity) - parseFloat(row.reserved ?? '0');
  }

  /**
   * Commit qty for a hold / pending transfer. Fails if available &lt; quantity.
   */
  async reserve(
    locationId: string,
    itemId: string,
    quantity: number,
    manager?: EntityManager,
  ): Promise<StockLevel> {
    if (!manager) {
      return this.dataSource.transaction((tx) =>
        this.reserve(locationId, itemId, quantity, tx),
      );
    }
    if (quantity <= 0) {
      throw new BadRequestException('Reserve quantity must be positive');
    }
    await this.assertQuantity(itemId, quantity, manager);
    const { stock } = this.repos(manager);
    const row = await this.getOrCreateLocked(locationId, itemId, manager);
    const available =
      parseFloat(row.quantity) - parseFloat(row.reserved ?? '0');
    if (available < quantity) {
      throw new BadRequestException(
        `Insufficient available stock to reserve. Available: ${available}, requested: ${quantity}`,
      );
    }
    row.reserved = (parseFloat(row.reserved ?? '0') + quantity).toFixed(3);
    return stock.save(row);
  }

  /** Release a previous reservation (cancel hold / pending transfer). */
  async releaseReservation(
    locationId: string,
    itemId: string,
    quantity: number,
    manager?: EntityManager,
  ): Promise<StockLevel> {
    if (!manager) {
      return this.dataSource.transaction((tx) =>
        this.releaseReservation(locationId, itemId, quantity, tx),
      );
    }
    if (quantity <= 0) {
      throw new BadRequestException('Release quantity must be positive');
    }
    await this.assertQuantity(itemId, quantity, manager);
    const { stock } = this.repos(manager);
    const row = await this.getOrCreateLocked(locationId, itemId, manager);
    const reserved = parseFloat(row.reserved ?? '0');
    if (reserved < quantity) {
      throw new BadRequestException(
        `Cannot release more than reserved. Reserved: ${reserved}, requested: ${quantity}`,
      );
    }
    row.reserved = (reserved - quantity).toFixed(3);
    return stock.save(row);
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

    await stock
      .createQueryBuilder()
      .insert()
      .values({
        id: randomUUID(),
        locationId,
        itemId,
        quantity: '0',
        reserved: '0',
        purchasePrice: String(initialPurchasePrice),
      })
      .orIgnore()
      .execute();

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
    assertUnitQuantity(catalogItem.stockUnit, adj.quantityDelta);

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
          : new Decimal(currentQty)
              .mul(currentPrice)
              .plus(new Decimal(incoming).mul(adj.purchasePrice))
              .div(new Decimal(currentQty).plus(incoming))
              .toNumber();
      row.purchasePrice = weighted.toFixed(10);
      unitCostForLedger = adj.purchasePrice.toFixed(10);
    } else if (adj.quantityDelta !== 0) {
      unitCostForLedger = parseFloat(row.purchasePrice).toFixed(10);
    }

    row.quantity = newQty.toFixed(3);
    const saved = await stock.save(row);

    const lotMeta = await this.applyLotDelta(adj, manager);

    const meta = adj.movement ?? {
      type: StockMovementType.ADJUSTMENT,
    };

    const ledger = await movement.save(
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
        lotId: lotMeta.lotId ?? meta.lotId ?? null,
        lotNumber: lotMeta.lotNumber ?? meta.lotNumber ?? null,
      }),
    );

    for (const allocation of lotMeta.allocations ?? []) {
      await manager.query(
        'INSERT INTO stock_movement_lots (movement_id, lot_id, quantity) VALUES ($1, $2, $3)',
        [ledger.id, allocation.lotId, allocation.quantity],
      );
    }
    return saved;
  }

  /**
   * Maintain stock_lots on receipt (+) / issue (−).
   * Issues without lotNumber use FEFO across lots when lots exist.
   */
  private async applyLotDelta(
    adj: StockAdjustment,
    manager: EntityManager,
  ): Promise<{
    lotId: string | null;
    lotNumber: string | null;
    allocations?: { lotId: string; quantity: string }[];
  }> {
    const { lot } = this.repos(manager);
    const qty = adj.quantityDelta;
    if (qty === 0) return { lotId: null, lotNumber: null };

    if (qty > 0) {
      if (!adj.lotNumber?.trim()) {
        return { lotId: null, lotNumber: null };
      }
      const lotNumber = adj.lotNumber.trim();
      let row = await lot.findOne({
        where: {
          locationId: adj.locationId,
          itemId: adj.itemId,
          lotNumber,
        },
      });
      if (!row) {
        row = lot.create({
          locationId: adj.locationId,
          itemId: adj.itemId,
          lotNumber,
          expiryDate: adj.expiryDate ?? null,
          quantity: '0',
        });
      }
      row.quantity = (parseFloat(row.quantity) + qty).toFixed(3);
      if (adj.expiryDate !== undefined) {
        row.expiryDate = adj.expiryDate;
      }
      const saved = await lot.save(row);
      return {
        lotId: saved.id,
        lotNumber: saved.lotNumber,
        allocations: [{ lotId: saved.id, quantity: qty.toFixed(3) }],
      };
    }

    // Issue: explicit lot or FEFO across existing lots
    const need = Math.abs(qty);
    if (adj.lotNumber?.trim()) {
      const lotNumber = adj.lotNumber.trim();
      const row = await lot.findOne({
        where: {
          locationId: adj.locationId,
          itemId: adj.itemId,
          lotNumber,
        },
      });
      if (!row || parseFloat(row.quantity) < need) {
        throw new BadRequestException(
          `Insufficient qty in lot ${lotNumber}. Available: ${row ? row.quantity : 0}, requested: ${need}`,
        );
      }
      row.quantity = (parseFloat(row.quantity) - need).toFixed(3);
      await lot.save(row);
      return {
        lotId: row.id,
        lotNumber: row.lotNumber,
        allocations: [{ lotId: row.id, quantity: need.toFixed(3) }],
      };
    }

    const lots = await lot
      .createQueryBuilder('l')
      .where('l.location_id = :locationId', { locationId: adj.locationId })
      .andWhere('l.item_id = :itemId', { itemId: adj.itemId })
      .andWhere('l.quantity::numeric > 0')
      .orderBy('l.expiry_date', 'ASC', 'NULLS LAST')
      .addOrderBy('l.created_at', 'ASC')
      .getMany();

    if (lots.length === 0) {
      return { lotId: null, lotNumber: null };
    }

    const allocations: { lotId: string; quantity: string }[] = [];
    let remaining = need;
    let firstLotId: string | null = null;
    let firstLotNumber: string | null = null;
    for (const row of lots) {
      if (remaining <= 0) break;
      const available = parseFloat(row.quantity);
      const take = Math.min(available, remaining);
      row.quantity = (available - take).toFixed(3);
      await lot.save(row);
      if (!firstLotId) {
        firstLotId = row.id;
        firstLotNumber = row.lotNumber;
      }
      allocations.push({ lotId: row.id, quantity: take.toFixed(3) });
      remaining -= take;
    }
    if (remaining > 1e-9) {
      throw new BadRequestException(
        `Insufficient lot qty for item. Short by ${remaining.toFixed(3)}`,
      );
    }
    return { lotId: firstLotId, lotNumber: firstLotNumber, allocations };
  }

  async listLots(filters: {
    locationId?: string;
    itemId?: string;
    expiringBefore?: string;
  }) {
    const qb = this.lotRepo
      .createQueryBuilder('lot')
      .leftJoinAndSelect('lot.item', 'item')
      .leftJoinAndSelect('lot.location', 'location')
      .where('lot.quantity::numeric > 0')
      .orderBy('lot.expiry_date', 'ASC', 'NULLS LAST');
    if (filters.locationId) {
      qb.andWhere('lot.location_id = :locationId', {
        locationId: filters.locationId,
      });
    }
    if (filters.itemId) {
      qb.andWhere('lot.item_id = :itemId', { itemId: filters.itemId });
    }
    if (filters.expiringBefore) {
      qb.andWhere('lot.expiry_date IS NOT NULL').andWhere(
        'lot.expiry_date <= :expiringBefore',
        {
          expiringBefore: filters.expiringBefore,
        },
      );
    }
    return applyLocationScope(qb).getMany();
  }

  /**
   * Soft-reserve fulfill: release hold then decrement on-hand (sale / issue).
   * Call after `reserve` so concurrent ops cannot take the same available qty.
   */
  async consumeReserved(
    locationId: string,
    itemId: string,
    quantity: number,
    manager?: EntityManager,
    meta?: StockMovementMeta,
    lot?: { lotNumber?: string; expiryDate?: string | null },
  ): Promise<StockLevel> {
    if (!manager) {
      return this.dataSource.transaction((tx) =>
        this.consumeReserved(locationId, itemId, quantity, tx, meta, lot),
      );
    }
    if (quantity <= 0) {
      throw new BadRequestException('Quantity must be positive');
    }
    await this.releaseReservation(locationId, itemId, quantity, manager);
    return this.adjust(
      {
        locationId,
        itemId,
        quantityDelta: -quantity,
        lotNumber: lot?.lotNumber,
        expiryDate: lot?.expiryDate,
        movement: meta ?? { type: StockMovementType.SALE },
      },
      manager,
    );
  }

  /**
   * Ship previously reserved stock out of source (PENDING → IN_TRANSIT).
   * Releases reservation then decrements on-hand with TRANSFER_OUT.
   */
  async shipOutbound(
    locationId: string,
    itemId: string,
    quantity: number,
    manager?: EntityManager,
    meta?: {
      refType?: string | null;
      refId?: string | null;
      createdById?: string | null;
      notes?: string | null;
    },
  ): Promise<number> {
    if (!manager) {
      return this.dataSource.transaction((tx) =>
        this.shipOutbound(locationId, itemId, quantity, tx, meta),
      );
    }
    if (quantity <= 0) {
      throw new BadRequestException('Quantity must be positive');
    }
    const row = await this.getOrCreateLocked(locationId, itemId, manager);
    const purchasePrice = parseFloat(row.purchasePrice);
    await this.releaseReservation(locationId, itemId, quantity, manager);
    await this.adjust(
      {
        locationId,
        itemId,
        quantityDelta: -quantity,
        movement: {
          type: StockMovementType.TRANSFER_OUT,
          refType: meta?.refType ?? 'stock_transfer',
          refId: meta?.refId ?? null,
          createdById: meta?.createdById ?? null,
          notes: meta?.notes ?? null,
        },
      },
      manager,
    );
    return purchasePrice;
  }

  /** Receive stock at destination (IN_TRANSIT → COMPLETED). */
  async receiveInbound(
    locationId: string,
    itemId: string,
    quantity: number,
    purchasePrice: number,
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
        this.receiveInbound(
          locationId,
          itemId,
          quantity,
          purchasePrice,
          tx,
          meta,
        ),
      );
    }
    const allocations: {
      lot_number: string;
      expiry_date: string | null;
      quantity: string;
    }[] = meta?.refId
      ? await manager.query(
          `SELECT l.lot_number, l.expiry_date, a.quantity FROM stock_movement_lots a
          JOIN stock_movements m ON m.id = a.movement_id JOIN stock_lots l ON l.id = a.lot_id
          WHERE m.ref_id = $1 AND m.item_id = $2 AND m.type = 'TRANSFER_OUT'
          AND m.ref_type = $3 ORDER BY m.created_at, a.id`,
          [meta.refId, itemId, meta.refType ?? 'stock_transfer'],
        )
      : [];
    const received = allocations.length
      ? allocations
      : [
          {
            lot_number: undefined,
            expiry_date: undefined,
            quantity: String(quantity),
          },
        ];
    for (const allocation of received) {
      await this.adjust(
        {
          locationId,
          itemId,
          quantityDelta: Number(allocation.quantity),
          purchasePrice,
          lotNumber: allocation.lot_number,
          expiryDate: allocation.expiry_date,
          movement: {
            type: StockMovementType.TRANSFER_IN,
            refType: meta?.refType ?? 'stock_transfer',
            refId: meta?.refId ?? null,
            createdById: meta?.createdById ?? null,
            notes: meta?.notes ?? null,
          },
        },
        manager,
      );
    }
  }

  /** One-shot transfer (ship + receive). Prefer multi-step for warehouse workflows. */
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

    meta = { ...meta, refId: meta?.refId ?? randomUUID() };
    if (quantity <= 0) {
      throw new BadRequestException('Quantity must be positive');
    }

    const [firstId, secondId] =
      fromLocationId < toLocationId
        ? [fromLocationId, toLocationId]
        : [toLocationId, fromLocationId];
    await this.getOrCreateLocked(firstId, itemId, manager);
    if (secondId !== firstId) {
      await this.getOrCreateLocked(secondId, itemId, manager);
    }

    const available = await this.getAvailable(fromLocationId, itemId, manager, {
      forUpdate: true,
    });
    if (available < quantity) {
      throw new BadRequestException(
        `Insufficient stock. Available: ${available}, requested: ${quantity}`,
      );
    }

    await this.reserve(fromLocationId, itemId, quantity, manager);
    const purchasePrice = await this.shipOutbound(
      fromLocationId,
      itemId,
      quantity,
      manager,
      meta,
    );
    await this.receiveInbound(
      toLocationId,
      itemId,
      quantity,
      purchasePrice,
      manager,
      meta,
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
      await this.assertQuantity(line.itemId, line.quantity, manager);
      const available = await this.getAvailable(
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
