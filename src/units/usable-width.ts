import { UnitOfMeasure } from '../database/entities/unit-of-measure.entity';

/** Usable/default width applies only to length-based stock (rolls, reels, film, etc.). */
export function supportsUsableWidth(
  category: UnitOfMeasure['category'] | string | null | undefined,
) {
  return category === 'LENGTH';
}

export function normalizeUsableWidthMetres(
  category: UnitOfMeasure['category'] | string | null | undefined,
  value: number | string | null | undefined,
): string | null {
  if (!supportsUsableWidth(category)) return null;
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0.001) return null;
  return n.toFixed(3);
}
