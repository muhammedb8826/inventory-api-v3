import { MigrationInterface, QueryRunner } from 'typeorm';
export class ItemUnitCorrections1749150000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    // A correction waiting on a stock write must see that write after it commits.
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
    $$`);
    await q.query(`CREATE OR REPLACE FUNCTION protect_item_stock_unit() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE places integer; BEGIN
      IF NEW.unit_id IS DISTINCT FROM OLD.unit_id THEN
        IF item_stock_unit_in_use(OLD.id) THEN RAISE EXCEPTION 'Stock unit is locked by inventory history or documents' USING ERRCODE='23514', CONSTRAINT='item_stock_unit_locked'; END IF;
        IF jsonb_array_length(OLD.unit_conversions)>0 THEN RAISE EXCEPTION 'Remove alternative units before correcting the stock unit' USING ERRCODE='23514', CONSTRAINT='item_unit_conversions_exist'; END IF;
        SELECT decimal_places INTO places FROM units_of_measure WHERE id=NEW.unit_id;
        IF EXISTS(SELECT 1 FROM stock_levels WHERE item_id=OLD.id AND reorder_point<>round(reorder_point,places)) THEN RAISE EXCEPTION 'Clear incompatible reorder points before correcting the unit' USING ERRCODE='23514', CONSTRAINT='stock_unit_precision'; END IF;
      END IF;
      IF NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.unit IS DISTINCT FROM OLD.unit THEN
        SELECT symbol INTO NEW.unit FROM units_of_measure WHERE id=NEW.unit_id;
      END IF; RETURN NEW;
    END $$`);
  }
  async down(q: QueryRunner) {
    // Restore the stricter history policy, including zero opening records.
    await q.query(`CREATE OR REPLACE FUNCTION protect_item_stock_unit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.unit_id IS DISTINCT FROM OLD.unit_id AND (item_stock_unit_in_use(OLD.id) OR EXISTS(SELECT 1 FROM stock_movements WHERE item_id=OLD.id)) THEN RAISE EXCEPTION 'Stock unit is locked by inventory history or documents' USING ERRCODE='23514', CONSTRAINT='item_stock_unit_locked'; END IF;
      IF NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.unit IS DISTINCT FROM OLD.unit THEN SELECT symbol INTO NEW.unit FROM units_of_measure WHERE id=NEW.unit_id; END IF; RETURN NEW;
    END $$`);
    // Keep the function while the rollback trigger uses it; it is safe to retain.
  }
}
