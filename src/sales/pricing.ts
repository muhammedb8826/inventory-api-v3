import { CommissionBasis, DEFAULT_COMMISSION_PERCENT } from '../common/enums';
import Decimal from 'decimal.js';
import { EntityManager } from 'typeorm';
import { Item } from '../database/entities/item.entity';
import { BadRequestException } from '@nestjs/common';
import { effectiveSalesPrice } from '../products/family-pricing';
export async function priceExceptions(
  manager: EntityManager,
  lines: { itemId: string; unitPrice: number }[],
) {
  const issues: string[] = [];
  for (const line of lines) {
    const item = await manager.getRepository(Item).findOne({
      where: { id: line.itemId },
      relations: { productFamily: true },
    });
    if (!item || !item.isActive)
      throw new BadRequestException('Select an active item');
    const label = item.sku || item.description;
    const price = effectiveSalesPrice(item);
    if (price === null)
      issues.push(`${label}: no standard sales price configured`);
    else if (
      !new Decimal(line.unitPrice).toDecimalPlaces(10).eq(new Decimal(price))
    )
      issues.push(
        `${label}: requested price differs from standard ${price} per ${item.stockUnit.symbol}`,
      );
  }
  return issues;
}
export async function assertStandardPrices(
  manager: EntityManager,
  lines: { itemId: string; unitPrice: number }[],
) {
  const issues = await priceExceptions(manager, lines);
  if (issues.length)
    throw new BadRequestException(
      `Price approval required. Create a quotation and submit it for approval. ${issues.join('; ')}`,
    );
}

export async function assertOrderItemsActive(
  manager: EntityManager,
  lines: { itemId: string }[],
) {
  const ids = [...new Set(lines.map((l) => l.itemId))].sort();
  for (const id of ids) {
    const rows: { is_active: boolean }[] = await manager.query(
      'SELECT is_active FROM items WHERE id=$1 FOR SHARE',
      [id],
    );
    if (!rows[0]?.is_active)
      throw new BadRequestException(
        'An order item is archived or missing. Activate it before processing this order.',
      );
  }
}

export function commissionExceptions(dto: {
  commissionPercent?: number;
  commissionBasis?: CommissionBasis;
}) {
  return (dto.commissionPercent !== undefined &&
    dto.commissionPercent !== DEFAULT_COMMISSION_PERCENT) ||
    (dto.commissionBasis !== undefined &&
      dto.commissionBasis !== CommissionBasis.PROFIT)
    ? ['Commission differs from the standard rate or basis and needs approval']
    : [];
}
