import { money, moneyAdd, moneyMultiply, moneySubtract } from './money.util';
describe('posted currency amounts', () => {
  it('rounds decimal half values consistently', () => {
    expect(money(1.005)).toBe('1.01');
    expect(money(-1.005)).toBe('-1.01');
  });
  it('adds and subtracts decimal balances exactly', () => {
    expect(moneyAdd('0.10', '0.20')).toBe('0.30');
    expect(moneySubtract('100.00', '99.99')).toBe('0.01');
  });
  it('rounds quantity times price at the line boundary', () => {
    expect(moneyMultiply('1.005', '1.00')).toBe('1.01');
    expect(
      moneyAdd(moneyMultiply('1.005', '1.00'), moneyMultiply('1.005', '1.00')),
    ).toBe('2.02');
  });
});
