import { cleanValues, variantKey } from './variant-rules';
describe('Variant identities', () => {
  const attributes = [
    { attributeId: 'a', values: ['Oak', 'Walnut'] },
    { attributeId: 'b', values: ['Black', 'Natural'] },
  ];
  it('uses the same identity regardless of attribute order', () => {
    const values = [
      { attributeId: 'a', value: 'Oak' },
      { attributeId: 'b', value: 'Black' },
    ];
    expect(variantKey(attributes, values)).toBe(
      variantKey(attributes, [...values].reverse()),
    );
  });
  it('rejects missing, repeated, foreign and unconfigured selections', () => {
    expect(() =>
      variantKey(attributes, [{ attributeId: 'a', value: 'Oak' }]),
    ).toThrow();
    expect(() =>
      variantKey(attributes, [
        { attributeId: 'a', value: 'Oak' },
        { attributeId: 'a', value: 'Walnut' },
      ]),
    ).toThrow();
    expect(() =>
      variantKey(attributes, [
        { attributeId: 'a', value: 'Steel' },
        { attributeId: 'b', value: 'Black' },
      ]),
    ).toThrow();
    expect(() => cleanValues(['Black', ' black '])).toThrow();
  });
});
