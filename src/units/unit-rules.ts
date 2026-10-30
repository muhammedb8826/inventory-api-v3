import Decimal from 'decimal.js';
import { BadRequestException } from '@nestjs/common';
import type { UnitOfMeasure } from '../database/entities/unit-of-measure.entity';
import type { ItemConversion } from './conversion';
const D = Decimal.clone({ precision: 40 });
export const STANDARD_UNITS: Record<string, [string, string]> = {
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
  PCS: ['COUNT', '1'],
  DOZEN: ['COUNT', '12'],
};
export function standardFactor(
  from: UnitOfMeasure,
  to: UnitOfMeasure,
): string | null {
  const a = STANDARD_UNITS[from.code],
    b = STANDARD_UNITS[to.code];
  if (
    !a ||
    !b ||
    a[0] !== from.category ||
    b[0] !== to.category ||
    a[0] !== b[0]
  )
    return null;
  return new D(a[1]).div(b[1]).toString();
}
export function unitDefinitionIssue(
  unit: Pick<UnitOfMeasure, 'code' | 'category'>,
): string | null {
  const category = STANDARD_UNITS[unit.code]?.[0];
  return category && category !== unit.category
    ? `${unit.code} is a standard ${category.toLowerCase()} unit and cannot belong to ${unit.category.toLowerCase()}.`
    : null;
}
export function conversionIssue(
  base: UnitOfMeasure,
  unit: UnitOfMeasure,
  factor: string,
  kind = 'CATEGORY',
): string | null {
  const definition = unitDefinitionIssue(base) ?? unitDefinitionIssue(unit);
  if (definition) return definition;
  if (
    unit.category !== base.category &&
    !(
      kind === 'PACKAGING' &&
      unit.category === 'COUNT' &&
      base.category !== 'OTHER'
    )
  )
    return `Cannot convert ${unit.name ?? unit.code} (${unit.category}) to ${base.name ?? base.code} (${base.category}). Use the same measurement category; count-based packaging requires a packaging profile.`;
  const expected = standardFactor(unit, base);
  try {
    const value = new D(factor);
    if (!value.isFinite() || value.lte(0))
      return 'Conversion factors must be positive finite numbers.';
    if (
      expected &&
      value
        .minus(expected)
        .abs()
        .gt(new D(expected).abs().mul('0.000000000001'))
    )
      return `The standard conversion is fixed: 1 ${unit.symbol ?? unit.code} = ${expected} ${base.symbol ?? base.code}. Create a distinct custom unit instead of redefining a standard unit.`;
  } catch {
    return 'Conversion factors must be positive finite numbers.';
  }
  return null;
}
export function groupIssues(
  group: {
    category: string;
    baseUnitId: string;
    kind?: string;
    conversions: ItemConversion[];
  },
  units: UnitOfMeasure[],
): string[] {
  const base = units.find((u) => u.id === group.baseUnitId);
  if (!base) return ['The reference unit no longer exists.'];
  const issues: string[] = [];
  if (base.category !== group.category)
    issues.push(
      'The reference unit must belong to the selected measurement category.',
    );
  if (!base.isActive || base.requiresReview)
    issues.push('The reference unit must be active and reviewed.');
  const definition = unitDefinitionIssue(base);
  if (definition) issues.push(definition);
  for (const c of group.conversions) {
    const unit = units.find((u) => u.id === c.unitId);
    if (!unit) {
      issues.push('An alternative unit no longer exists.');
      continue;
    }
    const issue = conversionIssue(base, unit, c.factor, group.kind);
    if (issue) issues.push(issue);
  }
  const anchors = new Map<string, { unit: UnitOfMeasure; factor: string }>();
  for (const c of [{ unitId: base.id, factor: '1' }, ...group.conversions]) {
    const unit = units.find((u) => u.id === c.unitId);
    if (!unit || !STANDARD_UNITS[unit.code] || unitDefinitionIssue(unit))
      continue;
    const anchor = anchors.get(unit.category);
    if (!anchor) {
      anchors.set(unit.category, { unit, factor: c.factor });
      continue;
    }
    if (standardFactor(unit, base) !== null) continue;
    try {
      const expected = new D(standardFactor(unit, anchor.unit)!).mul(
        anchor.factor,
      );
      if (
        new D(c.factor)
          .minus(expected)
          .abs()
          .gt(expected.abs().mul('0.000000000001'))
      )
        issues.push(
          `Standard units must retain their fixed relationship: ${unit.code} and ${anchor.unit.code} have inconsistent ratios.`,
        );
    } catch {
      issues.push('Invalid conversion ratio.');
    }
  }
  return [...new Set(issues)];
}
export function assertConversion(
  base: UnitOfMeasure,
  unit: UnitOfMeasure,
  factor: string,
  kind = 'CATEGORY',
) {
  const issue = conversionIssue(base, unit, factor, kind);
  if (issue) throw new BadRequestException(issue);
}
