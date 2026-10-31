import { BadRequestException } from '@nestjs/common';
import type { FamilyAttribute } from '../database/entities/product-family.entity';

export function cleanValues(values: string[]) {
  const cleaned = values.map((v) => v.trim());
  if (
    cleaned.some((v) => !v) ||
    new Set(cleaned.map((v) => v.toLowerCase())).size !== cleaned.length
  )
    throw new BadRequestException(
      'Attribute values must be non-empty and unique',
    );
  return cleaned;
}

/** Canonical, order-independent identity. Names never identify a variant. */
export function variantKey(
  attributes: FamilyAttribute[],
  values: { attributeId: string; value: string }[],
) {
  if (
    values.length !== attributes.length ||
    new Set(values.map((v) => v.attributeId)).size !== values.length
  )
    throw new BadRequestException(
      'Choose exactly one value for every family attribute',
    );
  for (const selected of values) {
    const attribute = attributes.find(
      (a) => a.attributeId === selected.attributeId,
    );
    if (!attribute?.values.includes(selected.value))
      throw new BadRequestException(
        'Variant contains a value outside the configured family attributes',
      );
  }
  return JSON.stringify(
    values
      .map((v) => [v.attributeId, v.value])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}
