import { BadRequestException, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { EntityManager } from 'typeorm';
import { Item } from '../database/entities/item.entity';
import { UnitOfMeasure } from '../database/entities/unit-of-measure.entity';
import { assertUnitQuantity } from './unit-quantity';
const ConversionDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

export interface ItemConversion {
  unitId: string;
  factor: string;
  stockQuantity?: string;
  unitQuantity?: string;
  purchaseDefault?: boolean;
  salesDefault?: boolean;
}
export interface UnitSnapshot {
  unitId: string;
  category?: UnitOfMeasure['category'];
  squareMetreFactor?: string;
  code: string;
  symbol: string;
  decimalPlaces?: number;
  dimensions?: { widthMetres: number; lengthMetres: number; count: number };
  factor: string;
  quantity: string;
  unitPrice?: string;
}
// Reference quantities in kg, metres, litres, square/cubic metres and hours.
const STANDARD: Record<string, [string, string]> = {
  KG: ['MASS', '1'],
  G: ['MASS', '0.001'],
  MG: ['MASS', '0.000001'],
  M: ['LENGTH', '1'],
  CM: ['LENGTH', '0.01'],
  MM: ['LENGTH', '0.001'],
  M2: ['AREA', '1'],
  CM2: ['AREA', '0.0001'],
  M3: ['VOLUME', '1000'],
  L: ['VOLUME', '1'],
  ML: ['VOLUME', '0.001'],
  H: ['TIME', '1'],
  MIN: ['TIME', '0.016666666666666667'],
};
export function standardFactor(
  from: UnitOfMeasure,
  to: UnitOfMeasure,
): string | null {
  const a = STANDARD[from.code],
    b = STANDARD[to.code];
  if (
    !a ||
    !b ||
    a[0] !== from.category ||
    b[0] !== to.category ||
    a[0] !== b[0]
  )
    return null;
  return new ConversionDecimal(a[1]).div(b[1]).toString();
}
export function itemConversionFactor(entry: {
  factor?: number;
  stockQuantity?: number;
  unitQuantity?: number;
}) {
  const hasRatio = entry.stockQuantity != null || entry.unitQuantity != null;
  if (hasRatio) {
    if (entry.factor != null)
      throw new BadRequestException(
        'Use either a conversion factor or a quantity ratio',
      );
    if (
      !Number.isFinite(entry.stockQuantity) ||
      !Number.isFinite(entry.unitQuantity) ||
      !(entry.stockQuantity! > 0) ||
      !(entry.unitQuantity! > 0)
    )
      throw new BadRequestException(
        'Enter both quantities in the conversion ratio',
      );
    return new ConversionDecimal(entry.stockQuantity!)
      .div(entry.unitQuantity!)
      .toString();
  }
  if (
    !(
      typeof entry.factor === 'number' &&
      Number.isFinite(entry.factor) &&
      entry.factor > 0
    )
  )
    throw new BadRequestException(
      'Enter a positive conversion factor or quantity ratio',
    );
  return String(entry.factor);
}
export function conversionOptions(item: Item, units: UnitOfMeasure[]) {
  return units
    .filter((u) => (u.isActive && !u.requiresReview) || u.id === item.unitId)
    .flatMap((unit) => {
      const configured = (
        item.unitGroup
          ? item.unitGroup.conversions
          : (item.unitConversions ?? [])
      ).find((c) => c.unitId === unit.id);
      if (item.unitGroup && unit.id !== item.unitId && !configured) return [];
      const standard = standardFactor(unit, item.stockUnit);
      const factor =
        unit.id === item.unitId ? '1' : (configured?.factor ?? standard);
      return factor
        ? [
            {
              unit,
              factor,
              isStandard:
                unit.id === item.unitId || (!configured && standard !== null),
              purchaseDefault: configured?.purchaseDefault === true,
              salesDefault: configured?.salesDefault === true,
            },
          ]
        : [];
    });
}
export function convertQuantity(
  quantity: number,
  factor: string,
  source: UnitOfMeasure,
  base: UnitOfMeasure,
) {
  assertUnitQuantity(source, quantity, 'Entered quantity');
  const result = new ConversionDecimal(quantity).mul(factor);
  if (!result.isFinite() || result.lte(0) || result.gte('100000000000'))
    throw new BadRequestException(
      'Converted quantity is outside the supported range',
    );
  assertUnitQuantity(base, result.toString(), 'Converted stock quantity');
  return result.toDecimalPlaces(base.decimalPlaces).toNumber();
}
export async function normalizeLine<
  T extends {
    quantity: number;
    unitId?: string;
    unitPrice?: number;
    dimensions?: { widthMetres: number; lengthMetres: number; count: number };
  },
>(
  manager: EntityManager,
  itemId: string,
  line: T,
  original?: UnitSnapshot | null,
): Promise<T & { unitSnapshot: UnitSnapshot }> {
  const item = await manager
    .getRepository(Item)
    .findOne({ where: { id: itemId } });
  if (!item) throw new NotFoundException('Item not found');
  // Lock the item configuration against simultaneous edits for transactional callers.
  if (manager.queryRunner?.isTransactionActive)
    await manager.query('SELECT id FROM items WHERE id=$1 FOR SHARE', [itemId]);
  if (manager.queryRunner?.isTransactionActive)
    await manager.query(
      'SELECT g.id FROM unit_groups g JOIN items i ON i.unit_group_id=g.id WHERE i.id=$1 FOR SHARE OF g',
      [itemId],
    );
  const fresh = await manager
    .getRepository(Item)
    .findOneByOrFail({ id: itemId });
  const units = await manager.getRepository(UnitOfMeasure).find();
  let option = conversionOptions(fresh, units).find(
    (o) => o.unit.id === (line.unitId || fresh.unitId),
  );
  const frozen =
    original?.unitId === (line.unitId || fresh.unitId) ? original : undefined;
  if (frozen) {
    const unit = units.find(
      (u) =>
        u.id === frozen.unitId &&
        (u.id === fresh.unitId || (u.isActive && !u.requiresReview)),
    );
    if (!unit)
      throw new BadRequestException(
        'The original inquiry unit is no longer active',
      );
    option = {
      unit: Object.assign(new UnitOfMeasure(), unit, {
        code: frozen.code,
        symbol: frozen.symbol,
        decimalPlaces: frozen.decimalPlaces ?? unit.decimalPlaces,
        category: frozen.category ?? unit.category,
      }),
      factor: frozen.factor,
      isStandard: false,
      purchaseDefault: false,
      salesDefault: false,
    };
  }
  let squareMetreFactor: string | undefined;
  if (!option)
    throw new BadRequestException(
      'This unit is not available for the selected item',
    );
  if (line.dimensions) {
    const squareMetre = conversionOptions(fresh, units).find(
      (o) => o.unit.code === 'M2' && o.unit.category === 'AREA',
    );
    squareMetreFactor = frozen?.squareMetreFactor ?? squareMetre?.factor;
    if (!squareMetreFactor || option.unit.category !== 'AREA')
      throw new BadRequestException(
        'Width and length entry requires an area unit and a square metre conversion in the group',
      );
    const area = new ConversionDecimal(line.dimensions.widthMetres)
      .mul(line.dimensions.lengthMetres)
      .mul(line.dimensions.count);
    const enteredArea = area.mul(squareMetreFactor).div(option.factor);
    if (enteredArea.minus(line.quantity).abs().gt('0.000000001'))
      throw new BadRequestException(
        'Quantity must match width x length x count',
      );
  }
  const quantity = convertQuantity(
    line.quantity,
    option.factor,
    option.unit,
    fresh.stockUnit,
  );
  const rate =
    line.unitPrice === undefined
      ? undefined
      : new ConversionDecimal(line.unitPrice).div(option.factor);
  if (
    rate &&
    (!rate.isFinite() ||
      rate.lt(0) ||
      rate.gte('100000000000') ||
      (rate.gt(0) && rate.toDecimalPlaces(10).eq(0)))
  )
    throw new BadRequestException(
      'Converted price is outside the supported range',
    );
  if (
    line.unitPrice !== undefined &&
    new ConversionDecimal(line.quantity)
      .mul(line.unitPrice)
      .gte('1000000000000')
  )
    throw new BadRequestException('Line amount is outside the supported range');
  return {
    ...line,
    quantity,
    ...(rate ? { unitPrice: rate.toNumber() } : {}),
    unitSnapshot: {
      unitId: option.unit.id,
      category: option.unit.category,
      ...(squareMetreFactor ? { squareMetreFactor } : {}),
      code: option.unit.code,
      symbol: option.unit.symbol,
      decimalPlaces: option.unit.decimalPlaces,
      factor: option.factor,
      quantity: String(line.quantity),
      ...(line.dimensions ? { dimensions: { ...line.dimensions } } : {}),
      ...(line.unitPrice === undefined
        ? {}
        : { unitPrice: String(line.unitPrice) }),
    },
  };
}
export function commercialTotal(line: {
  quantity: number;
  unitPrice: number;
  unitSnapshot?: UnitSnapshot | null;
}) {
  return new ConversionDecimal(line.unitSnapshot?.quantity ?? line.quantity)
    .mul(line.unitSnapshot?.unitPrice ?? line.unitPrice)
    .toDecimalPlaces(2)
    .toNumber();
}
