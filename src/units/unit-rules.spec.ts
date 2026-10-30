import { conversionIssue, groupIssues, standardFactor } from './unit-rules';
import { conversionOptions, normalizeLine } from './conversion';
import { UnitOfMeasure } from '../database/entities/unit-of-measure.entity';
import { Item } from '../database/entities/item.entity';
import { EntityManager } from 'typeorm';
const u = (code: string, category: UnitOfMeasure['category']) =>
  Object.assign(new UnitOfMeasure(), {
    id: code,
    code,
    name: code,
    symbol: code,
    category,
    isActive: true,
    requiresReview: false,
    decimalPlaces: 3,
  });
const m = u('M', 'LENGTH'),
  cm = u('CM', 'LENGTH'),
  kg = u('KG', 'MASS'),
  roll = u('ROLL', 'COUNT'),
  custom = u('STRIP', 'LENGTH');
describe('measurement category boundaries', () => {
  it('never permits mass and length to mix, including packaging profiles', () => {
    for (const kind of ['CATEGORY', 'PACKAGING'])
      expect(conversionIssue(m, kg, '2', kind)).toContain('Cannot convert');
    expect(conversionIssue(m, roll, '50')).toContain('packaging profile');
    expect(conversionIssue(m, roll, '50', 'PACKAGING')).toBeNull();
  });
  it('fixes standard relationships and validates reference categories', () => {
    expect(standardFactor(cm, m)).toBe('0.01');
    expect(conversionIssue(m, cm, '0.02')).toContain('fixed');
    expect(
      groupIssues({ category: 'MASS', baseUnitId: m.id, conversions: [] }, [
        m,
        kg,
      ]),
    ).toHaveLength(1);
  });
  it('keeps standards consistent even when the reference is a custom unit', () => {
    const group = {
      category: 'LENGTH',
      baseUnitId: custom.id,
      conversions: [
        { unitId: m.id, factor: '2' },
        { unitId: cm.id, factor: '0.04' },
      ],
    };
    expect(groupIssues(group, [m, cm, custom]).join()).toContain(
      'fixed relationship',
    );
    group.conversions[1].factor = '0.02';
    expect(groupIssues(group, [m, cm, custom])).toEqual([]);
  });
  it('flags old mixed configurations and exposes only their unchanged stock unit', () => {
    const item = Object.assign(new Item(), {
      unitId: m.id,
      stockUnit: m,
      unitGroup: {
        category: 'LENGTH',
        baseUnitId: m.id,
        kind: 'CATEGORY',
        conversions: [{ unitId: kg.id, factor: '2' }],
      },
    });
    expect(groupIssues(item.unitGroup, [m, kg]).length).toBeGreaterThan(0);
    expect(conversionOptions(item, [m, kg]).map((o) => o.unit.id)).toEqual([
      m.id,
    ]);
  });
  it('preserves historical snapshots for record edits without allowing invalid new handoffs', async () => {
    const item = Object.assign(new Item(), {
      unitId: m.id,
      stockUnit: m,
      unitConversions: [],
    });
    const manager = {
      getRepository: (entity: unknown) =>
        entity === Item
          ? { findOne: async () => item, findOneByOrFail: async () => item }
          : { find: async () => [m, kg] },
    } as unknown as EntityManager;
    const snapshot = {
      unitId: kg.id,
      code: 'KG',
      symbol: 'kg',
      category: 'MASS' as const,
      factor: '2',
      quantity: '3',
    };
    await expect(
      normalizeLine(manager, 'item', { quantity: 3, unitId: kg.id }, snapshot),
    ).rejects.toThrow('Cannot convert');
    const existing = await normalizeLine(
      manager,
      'item',
      { quantity: 3, unitId: kg.id },
      snapshot,
      true,
    );
    expect(existing.quantity).toBe(6);
    expect(existing.unitSnapshot.factor).toBe('2');
  });
});
