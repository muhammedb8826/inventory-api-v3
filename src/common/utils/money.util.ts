import Decimal from 'decimal.js';
// Sufficient precision for numeric(14,2) amounts and numeric(14,3) quantities.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export function money(value: string | number): string {
  return new Decimal(value).toFixed(2);
}
export function moneyAdd(...values: (string | number)[]): string {
  return values
    .reduce<Decimal>((sum, value) => sum.plus(value), new Decimal(0))
    .toFixed(2);
}
export function moneySubtract(a: string | number, b: string | number): string {
  return new Decimal(a).minus(b).toFixed(2);
}
export function moneyMultiply(a: string | number, b: string | number): string {
  return new Decimal(a).times(b).toFixed(2);
}
