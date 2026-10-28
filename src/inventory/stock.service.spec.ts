import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { StockMovementType } from '../common/enums';
import { Item } from '../database/entities/item.entity';
import { StockLevel } from '../database/entities/stock-level.entity';
import { StockLot } from '../database/entities/stock-lot.entity';
import { StockMovement } from '../database/entities/stock-movement.entity';
import { StockService } from './stock.service';

describe('StockService', () => {
  let service: StockService;
  let stockRepo: Record<string, jest.Mock>;
  let itemRepo: Record<string, jest.Mock>;
  let movementRepo: Record<string, jest.Mock>;
  let lotRepo: Record<string, jest.Mock>;
  let manager: EntityManager;
  let stockLevels: Map<string, StockLevel>;
  let movements: StockMovement[];

  const key = (locationId: string, itemId: string) => `${locationId}:${itemId}`;

  beforeEach(() => {
    stockLevels = new Map();
    movements = [];

    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => null as StockLevel | null),
    };

    stockRepo = {
      findOne: jest.fn(
        async ({
          where,
        }: {
          where: { locationId: string; itemId: string };
        }) => {
          return stockLevels.get(key(where.locationId, where.itemId)) ?? null;
        },
      ),
      create: jest.fn(
        (data: Partial<StockLevel>) => ({ ...data }) as StockLevel,
      ),
      save: jest.fn(async (row: StockLevel) => {
        if (!row.id) row.id = `stock-${stockLevels.size + 1}`;
        stockLevels.set(key(row.locationId, row.itemId), row);
        return row;
      }),
      createQueryBuilder: jest.fn(() => {
        qb.getOne.mockImplementation(async () => {
          // last where args are not tracked simply; resolve via map scan for tests
          return null;
        });
        return qb;
      }),
    };

    itemRepo = {
      findOne: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === 'missing') return null;
        return {
          id: where.id,
          description: 'Widget',
          sku: 'W1',
        } as Item;
      }),
    };

    movementRepo = {
      create: jest.fn(
        (data: Partial<StockMovement>) => ({ ...data }) as StockMovement,
      ),
      save: jest.fn(async (row: StockMovement) => {
        if (!row.id) row.id = `mv-${movements.length + 1}`;
        movements.push(row);
        return row;
      }),
    };

    lotRepo = {
      findOne: jest.fn(async () => null),
      create: jest.fn((data: Partial<StockLot>) => ({ ...data }) as StockLot),
      save: jest.fn(async (row: StockLot) => row),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn(async () => []),
      })),
    };

    const getRepository = (entity: unknown) => {
      if (entity === StockLevel) return stockRepo;
      if (entity === Item) return itemRepo;
      if (entity === StockMovement) return movementRepo;
      if (entity === StockLot) return lotRepo;
      throw new Error('unknown repo');
    };

    manager = {
      getRepository,
      query: jest.fn(async () => []),
    } as unknown as EntityManager;

    // Override locked getOne to read from map using closure patched per call
    stockRepo.createQueryBuilder.mockImplementation(() => {
      let loc = '';
      let item = '';
      let inserted: Partial<StockLevel> = {};
      const lockedQb = {
        where: jest.fn((sql: string, params: { locationId: string }) => {
          loc = params.locationId;
          return lockedQb;
        }),
        andWhere: jest.fn((sql: string, params: { itemId: string }) => {
          item = params.itemId;
          return lockedQb;
        }),
        insert: jest.fn().mockReturnThis(),
        values: jest.fn((value: Partial<StockLevel>) => {
          inserted = value;
          return lockedQb;
        }),
        orIgnore: jest.fn().mockReturnThis(),
        execute: jest.fn(async () => stockRepo.save(inserted)),
        setLock: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () => stockLevels.get(key(loc, item)) ?? null),
      };
      return lockedQb;
    });

    const dataSource = {
      transaction: jest.fn(async (fn: (m: EntityManager) => Promise<unknown>) =>
        fn(manager),
      ),
    } as unknown as DataSource;

    service = new StockService(
      stockRepo as Repository<StockLevel>,
      itemRepo as Repository<Item>,
      movementRepo as Repository<StockMovement>,
      lotRepo as Repository<StockLot>,
      dataSource,
    );
  });

  it('computes weighted average cost on inbound and writes a ledger row', async () => {
    stockLevels.set(key('loc-1', 'item-1'), {
      id: 's1',
      locationId: 'loc-1',
      itemId: 'item-1',
      quantity: '10.000',
      reserved: '0',
      purchasePrice: '10.00',
    } as StockLevel);

    const row = await service.adjust(
      {
        locationId: 'loc-1',
        itemId: 'item-1',
        quantityDelta: 10,
        purchasePrice: 20,
        movement: {
          type: StockMovementType.PURCHASE,
          refType: 'purchase',
          refId: 'p1',
        },
      },
      manager,
    );

    expect(row.quantity).toBe('20.000');
    expect(row.purchasePrice).toBe('15.00');
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: StockMovementType.PURCHASE,
      quantityBefore: '10.000',
      quantityAfter: '20.000',
      quantityDelta: '10.000',
      refType: 'purchase',
      refId: 'p1',
    });
  });

  it('rejects unknown items', async () => {
    await expect(
      service.adjust(
        {
          locationId: 'loc-1',
          itemId: 'missing',
          quantityDelta: 1,
        },
        manager,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates a zero row then applies opening qty with ledger', async () => {
    const row = await service.adjust(
      {
        locationId: 'loc-1',
        itemId: 'item-1',
        quantityDelta: 5,
        purchasePrice: 12,
        movement: { type: StockMovementType.OPENING },
      },
      manager,
    );

    expect(row.quantity).toBe('5.000');
    expect(movements[0].type).toBe(StockMovementType.OPENING);
    expect(movements[0].quantityBefore).toBe('0.000');
    expect(movements[0].quantityAfter).toBe('5.000');
  });

  it('transfer writes TRANSFER_OUT and TRANSFER_IN movements', async () => {
    stockLevels.set(key('from', 'item-1'), {
      id: 's-from',
      locationId: 'from',
      itemId: 'item-1',
      quantity: '8.000',
      reserved: '0',
      purchasePrice: '4.00',
    } as StockLevel);

    await service.transfer('from', 'to', 'item-1', 3, manager, {
      refType: 'stock_transfer',
      refId: 't1',
    });

    expect(stockLevels.get(key('from', 'item-1'))!.quantity).toBe('5.000');
    expect(stockLevels.get(key('to', 'item-1'))!.quantity).toBe('3.000');
    expect(movements.map((m) => m.type)).toEqual([
      StockMovementType.TRANSFER_OUT,
      StockMovementType.TRANSFER_IN,
    ]);
  });

  it('checkAvailability throws when stock is insufficient', async () => {
    stockLevels.set(key('loc-1', 'item-1'), {
      id: 's1',
      locationId: 'loc-1',
      itemId: 'item-1',
      quantity: '1.000',
      reserved: '0',
      purchasePrice: '1.00',
    } as StockLevel);

    await expect(
      service.checkAvailability(
        'loc-1',
        [{ itemId: 'item-1', quantity: 5 }],
        false,
        manager,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('checkAvailability warns but allows when negative stock is permitted', async () => {
    stockLevels.set(key('loc-1', 'item-1'), {
      id: 's1',
      locationId: 'loc-1',
      itemId: 'item-1',
      quantity: '1.000',
      reserved: '0',
      purchasePrice: '1.00',
    } as StockLevel);

    const warnings = await service.checkAvailability(
      'loc-1',
      [{ itemId: 'item-1', quantity: 5 }],
      true,
      manager,
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('available 1');
  });

  it('allows balance to go negative via adjust (caller enforces policy)', async () => {
    stockLevels.set(key('loc-1', 'item-1'), {
      id: 's1',
      locationId: 'loc-1',
      itemId: 'item-1',
      quantity: '2.000',
      reserved: '0',
      purchasePrice: '5.00',
    } as StockLevel);

    const row = await service.adjust(
      {
        locationId: 'loc-1',
        itemId: 'item-1',
        quantityDelta: -5,
        movement: {
          type: StockMovementType.SALE,
          refType: 'sale',
          refId: 's1',
        },
      },
      manager,
    );

    expect(row.quantity).toBe('-3.000');
    expect(movements[0]).toMatchObject({
      type: StockMovementType.SALE,
      quantityBefore: '2.000',
      quantityAfter: '-3.000',
      quantityDelta: '-5.000',
    });
  });

  it('sale void style reverse restores qty with SALE_VOID ledger', async () => {
    stockLevels.set(key('loc-1', 'item-1'), {
      id: 's1',
      locationId: 'loc-1',
      itemId: 'item-1',
      quantity: '7.000',
      reserved: '0',
      purchasePrice: '3.00',
    } as StockLevel);

    await service.adjust(
      {
        locationId: 'loc-1',
        itemId: 'item-1',
        quantityDelta: -2,
        movement: {
          type: StockMovementType.SALE,
          refType: 'sale',
          refId: 'sale-1',
        },
      },
      manager,
    );
    await service.adjust(
      {
        locationId: 'loc-1',
        itemId: 'item-1',
        quantityDelta: 2,
        movement: {
          type: StockMovementType.SALE_VOID,
          refType: 'sale',
          refId: 'sale-1',
          notes: 'Sale voided',
        },
      },
      manager,
    );

    expect(stockLevels.get(key('loc-1', 'item-1'))!.quantity).toBe('7.000');
    expect(movements.map((m) => m.type)).toEqual([
      StockMovementType.SALE,
      StockMovementType.SALE_VOID,
    ]);
    expect(movements[1].quantityBefore).toBe('5.000');
    expect(movements[1].quantityAfter).toBe('7.000');
  });

  it('transfer rejects insufficient source stock', async () => {
    stockLevels.set(key('from', 'item-1'), {
      id: 's-from',
      locationId: 'from',
      itemId: 'item-1',
      quantity: '1.000',
      reserved: '0',
      purchasePrice: '4.00',
    } as StockLevel);

    await expect(
      service.transfer('from', 'to', 'item-1', 3, manager),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(movements).toHaveLength(0);
  });

  it('reserve reduces available without changing on-hand qty', async () => {
    stockLevels.set(key('loc-1', 'item-1'), {
      id: 's1',
      locationId: 'loc-1',
      itemId: 'item-1',
      quantity: '10.000',
      reserved: '0',
      purchasePrice: '1.00',
    } as StockLevel);

    await service.reserve('loc-1', 'item-1', 4, manager);
    expect(stockLevels.get(key('loc-1', 'item-1'))!.reserved).toBe('4.000');
    expect(await service.getAvailable('loc-1', 'item-1', manager)).toBe(6);

    await expect(
      service.checkAvailability(
        'loc-1',
        [{ itemId: 'item-1', quantity: 7 }],
        false,
        manager,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses setLock pessimistic_write when forUpdate', async () => {
    const setLock = jest.fn();
    stockRepo.createQueryBuilder.mockImplementationOnce(() => {
      let loc = '';
      let item = '';
      const lockedQb = {
        where: jest.fn((_: string, params: { locationId: string }) => {
          loc = params.locationId;
          return lockedQb;
        }),
        andWhere: jest.fn((__: string, p: { itemId: string }) => {
          item = p.itemId;
          return lockedQb;
        }),
        setLock: setLock.mockImplementation(() => lockedQb),
        getOne: jest.fn(async () => stockLevels.get(key(loc, item)) ?? null),
      };
      return lockedQb;
    });

    stockLevels.set(key('loc-1', 'item-1'), {
      id: 's1',
      locationId: 'loc-1',
      itemId: 'item-1',
      quantity: '1.000',
      reserved: '0',
      purchasePrice: '1.00',
    } as StockLevel);

    await service.getStock('loc-1', 'item-1', manager, { forUpdate: true });
    expect(setLock).toHaveBeenCalledWith('pessimistic_write');
  });
});
