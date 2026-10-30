import { UnitsService } from './units.service';
import { Item } from '../database/entities/item.entity';
import { UnitOfMeasure } from '../database/entities/unit-of-measure.entity';
import { DataSource, EntityManager, Repository } from 'typeorm';

describe('custom item conversions', () => {
  function setup(baseCode = 'M') {
    const base = {
      id: 'base',
      code: baseCode,
      category: 'LENGTH',
      isActive: true,
      decimalPlaces: 3,
    };
    const cm = {
      id: 'cm',
      code: 'CM',
      category: 'LENGTH',
      isActive: true,
      decimalPlaces: 3,
      isActive: true,
    };
    const pack = {
      id: 'pack',
      code: 'PACK',
      category: 'COUNT',
      decimalPlaces: 0,
      isActive: true,
    };
    const item = {
      id: 'item',
      unitId: 'base',
      stockUnit: base,
      unitConversions: [],
    };
    const save = jest.fn().mockResolvedValue(item);
    const manager = {
      query: jest.fn().mockResolvedValue([]),
      getRepository: (entity: unknown) =>
        entity === Item
          ? { findOneBy: jest.fn().mockResolvedValue(item), save }
          : { find: jest.fn().mockResolvedValue([base, cm, pack]) },
    };
    const db = {
      transaction: async (fn: (m: EntityManager) => Promise<void>) =>
        fn(manager as unknown as EntityManager),
    };
    const service = new UnitsService(
      {} as Repository<UnitOfMeasure>,
      db as DataSource,
    );
    jest.spyOn(service, 'itemOptions').mockResolvedValue({} as never);
    return { service, save, item };
  }
  it('rejects redefining standard centimetres', async () => {
    const { service, save } = setup();
    await expect(
      service.configureItem('item', {
        conversions: [{ unitId: 'cm', stockQuantity: 1, unitQuantity: 50 }],
      }),
    ).rejects.toThrow('standard conversion is fixed');
    expect(save).not.toHaveBeenCalled();
  });
  it('requires an explicit shared packaging profile for cross-category packages', async () => {
    const { service, save } = setup();
    await expect(
      service.configureItem('item', {
        conversions: [{ unitId: 'pack', factor: 10 }],
      }),
    ).rejects.toThrow('packaging profile');
    expect(save).not.toHaveBeenCalled();
  });
  it('accepts the standard centimetre ratio', async () => {
    const { service, save } = setup();
    await service.configureItem('item', {
      conversions: [{ unitId: 'cm', factor: 0.01 }],
    });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        unitConversions: [expect.objectContaining({ factor: '0.01' })],
      }),
    );
  });
  it('rejects redefining the base unit itself', async () => {
    const { service, save, item } = setup();
    Object.assign(item.stockUnit, { isActive: true });
    await expect(
      service.configureItem('item', {
        conversions: [{ unitId: 'base', factor: 2 }],
      }),
    ).rejects.toThrow('1:1');
    expect(save).not.toHaveBeenCalled();
  });
});
