import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SME ERP style: base stock unit may be corrected when on-hand is zero and the
 * item is not used on commercial/operational documents. Past stock movements
 * alone no longer lock the unit forever (so a mistaken opening PCS can be
 * fixed after reducing qty to zero).
 */
export class StockUnitCorrectionWhenZero1749290000000
  implements MigrationInterface
{
  async up(q: QueryRunner) {
    await q.query(`CREATE OR REPLACE FUNCTION item_stock_unit_in_use(item uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
      SELECT EXISTS(SELECT 1 FROM stock_levels WHERE item_id=item AND (quantity<>0 OR reserved<>0))
      OR EXISTS(SELECT 1 FROM stock_lots WHERE item_id=item AND quantity<>0)
      OR EXISTS(SELECT 1 FROM sale_lines WHERE item_id=item)
      OR EXISTS(SELECT 1 FROM purchase_lines WHERE item_id=item)
      OR EXISTS(SELECT 1 FROM bom_lines WHERE component_item_id=item)
      OR EXISTS(SELECT 1 FROM boms WHERE finished_item_id=item)
      OR EXISTS(SELECT 1 FROM customer_inquiry_lines WHERE item_id=item)
      OR EXISTS(SELECT 1 FROM stocktake_lines WHERE item_id=item)
      OR EXISTS(SELECT 1 FROM stock_transfer_lines WHERE item_id=item)
      OR EXISTS(SELECT 1 FROM production_order_lines WHERE component_item_id=item)
      OR EXISTS(SELECT 1 FROM production_orders WHERE finished_item_id=item)
      OR EXISTS(SELECT 1 FROM sales_orders o CROSS JOIN LATERAL jsonb_array_elements(o.normalized_lines) l WHERE l->>'itemId'=item::text AND o.state<>'CANCELLED')
      OR EXISTS(SELECT 1 FROM purchase_orders o CROSS JOIN LATERAL jsonb_array_elements(o.normalized_lines) l WHERE l->>'itemId'=item::text AND o.state<>'CANCELLED')
    $$`);
  }

  async down(q: QueryRunner) {
    await q.query(`CREATE OR REPLACE FUNCTION item_stock_unit_in_use(item uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $$
      SELECT EXISTS(SELECT 1 FROM stock_movements WHERE item_id=item AND NOT(type='OPENING' AND quantity_delta=0 AND quantity_before=0 AND quantity_after=0))
      OR EXISTS(SELECT 1 FROM stock_levels WHERE item_id=item AND (quantity<>0 OR reserved<>0))
      OR EXISTS(SELECT 1 FROM stock_lots WHERE item_id=item AND quantity<>0)
      OR EXISTS(SELECT 1 FROM sale_lines WHERE item_id=item)
      OR EXISTS(SELECT 1 FROM purchase_lines WHERE item_id=item)
      OR EXISTS(SELECT 1 FROM bom_lines WHERE component_item_id=item)
      OR EXISTS(SELECT 1 FROM boms WHERE finished_item_id=item)
      OR EXISTS(SELECT 1 FROM customer_inquiry_lines WHERE item_id=item)
      OR EXISTS(SELECT 1 FROM stocktake_lines WHERE item_id=item)
      OR EXISTS(SELECT 1 FROM stock_transfer_lines WHERE item_id=item)
      OR EXISTS(SELECT 1 FROM production_order_lines WHERE component_item_id=item)
      OR EXISTS(SELECT 1 FROM production_orders WHERE finished_item_id=item)
      OR EXISTS(SELECT 1 FROM sales_orders o CROSS JOIN LATERAL jsonb_array_elements(o.normalized_lines) l WHERE l->>'itemId'=item::text AND o.state<>'CANCELLED')
      OR EXISTS(SELECT 1 FROM purchase_orders o CROSS JOIN LATERAL jsonb_array_elements(o.normalized_lines) l WHERE l->>'itemId'=item::text AND o.state<>'CANCELLED')
    $$`);
  }
}
