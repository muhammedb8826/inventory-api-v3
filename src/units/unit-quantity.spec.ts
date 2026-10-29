import { assertUnitQuantity } from './unit-quantity';
describe('stock unit quantity rules', () => {
  const pieces = { symbol: 'pcs', decimalPlaces: 0 };
  const kilograms = { symbol: 'kg', decimalPlaces: 3 };
  it('accepts whole counts, zero, and reversal quantities', () => {
    for (const q of [0, 1, 12, -12])
      expect(() => assertUnitQuantity(pieces, q)).not.toThrow();
  });
  it('rejects fractional pieces', () =>
    expect(() => assertUnitQuantity(pieces, 1.5)).toThrow('whole number'));
  it('accepts decimal units to their configured precision', () =>
    expect(() => assertUnitQuantity(kilograms, '1.125')).not.toThrow());
  it('rejects meaningful precision loss instead of silently rounding', () =>
    expect(() => assertUnitQuantity(kilograms, '1.1234')).toThrow(
      '3 decimal places',
    ));
  it('rejects missing units and non-finite quantities', () => {
    expect(() => assertUnitQuantity(undefined, 1)).toThrow('missing');
    for (const q of [NaN, Infinity, 'bad'])
      expect(() => assertUnitQuantity(kilograms, q)).toThrow('finite');
  });
  it('allows only negligible binary arithmetic noise', () =>
    expect(() =>
      assertUnitQuantity({ symbol: 'm', decimalPlaces: 1 }, 0.1 + 0.2),
    ).not.toThrow());
});
