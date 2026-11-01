import Decimal from 'decimal.js';
import type { Item } from '../database/entities/item.entity';
export interface FamilyPrices {
  basePrice: string | null;
  extras: { attributeId: string; value: string; extra: string }[];
}
export function effectiveSalesPrice(item: Item): string | null {
  if (item.salesPrice != null) return item.salesPrice;
  const rules = item.productFamily?.priceRules;
  if (rules?.basePrice == null) return null;
  return rules.extras
    .filter((e) =>
      item.variantValues.some(
        (v) => v.attributeId === e.attributeId && v.value === e.value,
      ),
    )
    .reduce((p, e) => p.plus(e.extra), new Decimal(rules.basePrice))
    .toFixed(10);
}
