import { EntityManager } from 'typeorm';
import {
  normalizeLine,
  convertQuantity,
  commercialTotal,
  standardFactor,
  conversionOptions,
  itemConversionFactor,
} from './conversion';
import { UnitOfMeasure } from '../database/entities/unit-of-measure.entity';
import { Item } from '../database/entities/item.entity';
const unit = (
  id: string,
  code: string,
  category: UnitOfMeasure['category'],
  decimalPlaces = 3,
) =>
  Object.assign(new UnitOfMeasure(), {
    id,
    code,
    category,
    decimalPlaces,
    symbol: code,
    isActive: true,
    requiresReview: false,
  });
const pcs = unit('pcs', 'PCS', 'COUNT', 0),
  kg = unit('kg', 'KG', 'MASS'),
  g = unit('g', 'G', 'MASS'),
  box = unit('box', 'BOX', 'COUNT', 0);
describe('unit conversions', () => {
  it('converts mass in either direction without binary rounding', () => {
    expect(standardFactor(g, kg)).toBe('0.001');
    expect(convertQuantity(1250, '0.001', g, kg)).toBe(1.25);
    expect(convertQuantity(1.25, '1000', kg, g)).toBe(1250);
  });
  it('rejects quantities that cannot be represented in the stock unit', () => {
    expect(() => convertQuantity(0.1, '0.001', g, kg)).toThrow(
      'Converted stock quantity',
    );
    expect(() => convertQuantity(1.5, '12', box, pcs)).toThrow('whole number');
  });
  it('does not invent a length-to-area conversion', () =>
    expect(
      standardFactor(unit('m', 'M', 'LENGTH'), unit('m2', 'M2', 'AREA')),
    ).toBeNull());
  it('keeps packaging factors item specific and hides inactive units', () => {
    const item = Object.assign(new Item(), {
      unitId: pcs.id,
      stockUnit: pcs,
      unitConversions: [{ unitId: box.id, factor: '12' }],
    });
    expect(
      conversionOptions(item, [pcs, box]).find((o) => o.unit.id === box.id)
        ?.factor,
    ).toBe('12');
    expect(
      conversionOptions({ ...item, unitConversions: [] } as Item, [pcs, box]),
    ).toHaveLength(1);
    expect(
      conversionOptions(item, [
        pcs,
        { ...box, isActive: false } as UnitOfMeasure,
      ]),
    ).toHaveLength(1);
  });
  it('flags and hides nonstandard overrides rather than redefining centimetres', () => {
    const m = unit('m', 'M', 'LENGTH'),
      cm = unit('cm', 'CM', 'LENGTH');
    const item = Object.assign(new Item(), {
      unitId: m.id,
      stockUnit: m,
      unitConversions: [{ unitId: cm.id, factor: '0.02' }],
    });
    expect(conversionOptions(item, [m, cm]).map((o) => o.unit.id)).toEqual([
      m.id,
    ]);
    item.unitConversions = [];
    expect(
      conversionOptions(item, [m, cm]).find((o) => o.unit.id === cm.id)?.factor,
    ).toBe('0.01');
  });
  it('converts a custom pack to stock pieces', () => {
    expect(
      convertQuantity(3, '10', unit('pack', 'PACK', 'COUNT', 0), pcs),
    ).toBe(30);
  });
  it('reuses group ratios across items and excludes unrelated units', () => {
    const group = {
      category: 'COUNT',
      baseUnitId: pcs.id,
      kind: 'CATEGORY',
      conversions: [{ unitId: box.id, factor: '10', purchaseDefault: true }],
    };
    for (const id of ['first', 'second']) {
      const item = Object.assign(new Item(), {
        id,
        unitId: pcs.id,
        stockUnit: pcs,
        unitGroup: group,
        unitConversions: [{ unitId: box.id, factor: '99' }],
      });
      const options = conversionOptions(item, [pcs, box, kg]);
      expect(options).toHaveLength(2);
      expect(options.find((o) => o.unit.id === box.id)?.factor).toBe('10');
      expect(options.find((o) => o.unit.id === box.id)?.purchaseDefault).toBe(
        true,
      );
      expect(convertQuantity(3, options[1].factor, box, pcs)).toBe(30);
    }
  });
  it('normalizes width and length into a preferred square-centimetre stock unit', async () => {
    const cm2 = unit('cm2', 'CM2', 'AREA');
    const m2 = unit('m2', 'M2', 'AREA');
    const item = Object.assign(new Item(), {
      id: 'cloth',
      unitId: cm2.id,
      stockUnit: cm2,
      unitGroup: {
        category: 'AREA',
        baseUnitId: cm2.id,
        conversions: [{ unitId: m2.id, factor: '10000' }],
      },
    });
    const manager = {
      getRepository: (entity: unknown) =>
        entity === Item
          ? { findOne: async () => item, findOneByOrFail: async () => item }
          : { find: async () => [cm2, m2] },
    } as unknown as EntityManager;
    const line = await normalizeLine(manager, 'cloth', {
      quantity: 30000,
      unitId: cm2.id,
      dimensions: { widthMetres: 1.5, lengthMetres: 2, count: 1 },
    });
    expect(line.quantity).toBe(30000);
    expect(line.unitSnapshot.dimensions?.widthMetres).toBe(1.5);
  });
  it('uses the commercial price for totals, avoiding recurring base-rate rounding', () => {
    expect(
      commercialTotal({
        quantity: 3,
        unitPrice: 1 / 3,
        unitSnapshot: {
          unitId: 'box',
          code: 'BOX',
          symbol: 'box',
          factor: '3',
          quantity: '1',
          unitPrice: '1',
        },
      }),
    ).toBe(1);
  });
  it('preserves exact custom count ratios without entering a rounded reciprocal', () => {
    const factor = itemConversionFactor({ stockQuantity: 1, unitQuantity: 3 });
    const area = unit('third', 'THIRD', 'COUNT');
    expect(convertQuantity(6, factor, area, pcs)).toBe(2);
    expect(convertQuantity(30000000000, factor, area, pcs)).toBe(10000000000);
    expect(() => convertQuantity(1, factor, area, pcs)).toThrow('whole number');
  });
  it('rejects missing, incomplete and conflicting conversion definitions', () => {
    expect(() => itemConversionFactor({})).toThrow();
    expect(() => itemConversionFactor({ stockQuantity: 1 })).toThrow();
    expect(() =>
      itemConversionFactor({
        stockQuantity: 1,
        unitQuantity: 3,
        factor: 0.3333333333,
      }),
    ).toThrow();
  });
});
