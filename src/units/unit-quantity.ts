import { BadRequestException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { UnitOfMeasure } from '../database/entities/unit-of-measure.entity';
export function assertUnitQuantity(
  unit: Pick<UnitOfMeasure, 'decimalPlaces' | 'symbol'> | null | undefined,
  quantity: number | string,
  field = 'Quantity',
) {
  if (!unit)
    throw new BadRequestException(
      'Item stock unit is missing; resolve the item unit before transacting',
    );
  let value: Decimal;
  try {
    value = new Decimal(quantity);
  } catch {
    throw new BadRequestException(`${field} must be a finite number`);
  }
  if (!value.isFinite())
    throw new BadRequestException(`${field} must be a finite number`);
  // Ignore only binary arithmetic noise, never a meaningful extra decimal place.
  const rounded = value.toDecimalPlaces(unit.decimalPlaces);
  if (value.minus(rounded).abs().greaterThan('0.000000001')) {
    throw new BadRequestException(
      unit.decimalPlaces === 0
        ? `${field} must be a whole number in ${unit.symbol}`
        : `${field} allows at most ${unit.decimalPlaces} decimal places in ${unit.symbol}`,
    );
  }
}
