import { MigrationInterface, QueryRunner } from 'typeorm';
export class StructuredUnits1749130000000 implements MigrationInterface {
  name = 'StructuredUnits1749130000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS units_of_measure (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code varchar(40) NOT NULL UNIQUE,
      name varchar(100) NOT NULL, symbol varchar(40) NOT NULL, category varchar(20) NOT NULL,
      unece_code varchar(3), decimal_places smallint NOT NULL DEFAULT 3,
      is_active boolean NOT NULL DEFAULT true, requires_review boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT unit_precision CHECK(decimal_places BETWEEN 0 AND 3),
      CONSTRAINT unit_category CHECK(category IN ('COUNT','LENGTH','AREA','VOLUME','MASS','TIME','OTHER'))
    )`);
    await q.query(`INSERT INTO units_of_measure(id,code,name,symbol,category,unece_code,decimal_places) VALUES ('10000000-0000-4000-8000-000000000001', 'PCS', 'Piece', 'pcs', 'COUNT', 'H87', 0),
('10000000-0000-4000-8000-000000000002', 'KG', 'Kilogram', 'kg', 'MASS', 'KGM', 3),
('10000000-0000-4000-8000-000000000003', 'G', 'Gram', 'g', 'MASS', 'GRM', 3),
('10000000-0000-4000-8000-000000000004', 'M', 'Metre', 'm', 'LENGTH', 'MTR', 3),
('10000000-0000-4000-8000-000000000005', 'CM', 'Centimetre', 'cm', 'LENGTH', 'CMT', 3),
('10000000-0000-4000-8000-000000000006', 'M2', 'Square metre', 'm2', 'AREA', 'MTK', 3),
('10000000-0000-4000-8000-000000000007', 'M3', 'Cubic metre', 'm3', 'VOLUME', 'MTQ', 3),
('10000000-0000-4000-8000-000000000008', 'L', 'Litre', 'L', 'VOLUME', 'LTR', 3),
('10000000-0000-4000-8000-000000000009', 'ML', 'Millilitre', 'ml', 'VOLUME', 'MLT', 3),
('10000000-0000-4000-8000-000000000010', 'H', 'Hour', 'h', 'TIME', 'HUR', 3) ON CONFLICT(code) DO NOTHING`);
    await q.query('ALTER TABLE items ADD COLUMN IF NOT EXISTS unit_id uuid');
    await q.query(`UPDATE items i SET unit_id=u.id FROM units_of_measure u WHERE u.code=(CASE LOWER(TRIM(COALESCE(i.unit, '')))
WHEN 'pcs' THEN 'PCS'
WHEN 'pc' THEN 'PCS'
WHEN 'piece' THEN 'PCS'
WHEN 'pieces' THEN 'PCS'
WHEN 'ea' THEN 'PCS'
WHEN 'each' THEN 'PCS'
WHEN 'unit' THEN 'PCS'
WHEN 'units' THEN 'PCS'
WHEN 'nos' THEN 'PCS'
WHEN 'number' THEN 'PCS'
WHEN 'numbers' THEN 'PCS'
WHEN 'kg' THEN 'KG'
WHEN 'kgs' THEN 'KG'
WHEN 'kilogram' THEN 'KG'
WHEN 'kilograms' THEN 'KG'
WHEN 'g' THEN 'G'
WHEN 'gram' THEN 'G'
WHEN 'grams' THEN 'G'
WHEN 'm' THEN 'M'
WHEN 'meter' THEN 'M'
WHEN 'meters' THEN 'M'
WHEN 'metre' THEN 'M'
WHEN 'metres' THEN 'M'
WHEN 'cm' THEN 'CM'
WHEN 'centimeter' THEN 'CM'
WHEN 'centimeters' THEN 'CM'
WHEN 'centimetre' THEN 'CM'
WHEN 'centimetres' THEN 'CM'
WHEN 'm2' THEN 'M2'
WHEN 'sqm' THEN 'M2'
WHEN 'sq m' THEN 'M2'
WHEN 'square meter' THEN 'M2'
WHEN 'square metre' THEN 'M2'
WHEN 'm3' THEN 'M3'
WHEN 'cbm' THEN 'M3'
WHEN 'cubic meter' THEN 'M3'
WHEN 'cubic metre' THEN 'M3'
WHEN 'l' THEN 'L'
WHEN 'lt' THEN 'L'
WHEN 'ltr' THEN 'L'
WHEN 'liter' THEN 'L'
WHEN 'liters' THEN 'L'
WHEN 'litre' THEN 'L'
WHEN 'litres' THEN 'L'
WHEN 'ml' THEN 'ML'
WHEN 'milliliter' THEN 'ML'
WHEN 'millilitre' THEN 'ML'
WHEN 'h' THEN 'H'
WHEN 'hr' THEN 'H'
WHEN 'hour' THEN 'H'
WHEN 'hours' THEN 'H'
ELSE NULL END)`);
    // Do not silently classify fractional historical counts as whole pieces.
    await q.query(`UPDATE items i SET unit_id=NULL WHERE i.unit_id=(SELECT id FROM units_of_measure WHERE code='PCS') AND (
      EXISTS(SELECT 1 FROM stock_levels s WHERE s.item_id=i.id AND (s.quantity<>trunc(s.quantity) OR s.reserved<>trunc(s.reserved) OR s.reorder_point<>trunc(s.reorder_point)))
      OR EXISTS(SELECT 1 FROM stock_movements s WHERE s.item_id=i.id AND s.quantity_delta<>trunc(s.quantity_delta))
      OR EXISTS(SELECT 1 FROM bom_lines s WHERE s.component_item_id=i.id AND s.quantity<>trunc(s.quantity))
      OR EXISTS(SELECT 1 FROM sale_lines s WHERE s.item_id=i.id AND s.quantity<>trunc(s.quantity))
      OR EXISTS(SELECT 1 FROM purchase_lines s WHERE s.item_id=i.id AND s.quantity<>trunc(s.quantity))
      OR EXISTS(SELECT 1 FROM customer_inquiry_lines s WHERE s.item_id=i.id AND s.quantity<>trunc(s.quantity)))`);
    // Preserve unknown/blank labels. They are explicit review records, never guessed conversions.
    await q.query(`INSERT INTO units_of_measure(id,code,name,symbol,category,decimal_places,requires_review)
      SELECT gen_random_uuid(), labels.* FROM (SELECT DISTINCT 'LEGACY_'||substr(md5(COALESCE(i.unit,'')),1,24),
      LEFT(COALESCE(NULLIF(TRIM(i.unit),''),'Unspecified legacy unit'),100),
      LEFT(COALESCE(NULLIF(TRIM(i.unit),''),'?'),40),'OTHER',3,true FROM items i WHERE i.unit_id IS NULL) labels`);
    await q.query(
      `UPDATE items i SET unit_id=u.id FROM units_of_measure u WHERE i.unit_id IS NULL AND u.code='LEGACY_'||substr(md5(COALESCE(i.unit,'')),1,24)`,
    );
    await q.query(
      `UPDATE items i SET unit=u.symbol FROM units_of_measure u WHERE i.unit_id=u.id AND NOT u.requires_review`,
    );
    await q.query('ALTER TABLE items ALTER COLUMN unit_id SET NOT NULL');
    await q.query(
      'ALTER TABLE items ADD CONSTRAINT items_stock_unit_fk FOREIGN KEY(unit_id) REFERENCES units_of_measure(id)',
    );
    await q.query('CREATE INDEX items_unit_id_idx ON items(unit_id)');
    await q.query(`CREATE FUNCTION protect_item_stock_unit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.unit_id IS DISTINCT FROM OLD.unit_id AND (
        EXISTS(SELECT 1 FROM stock_movements WHERE item_id=OLD.id)
        OR EXISTS(SELECT 1 FROM stock_levels WHERE item_id=OLD.id AND (quantity<>0 OR reserved<>0))
        OR EXISTS(SELECT 1 FROM sale_lines WHERE item_id=OLD.id)
        OR EXISTS(SELECT 1 FROM purchase_lines WHERE item_id=OLD.id)
        OR EXISTS(SELECT 1 FROM bom_lines WHERE component_item_id=OLD.id)
        OR EXISTS(SELECT 1 FROM boms WHERE finished_item_id=OLD.id)
        OR EXISTS(SELECT 1 FROM customer_inquiry_lines WHERE item_id=OLD.id)
        OR EXISTS(SELECT 1 FROM stocktake_lines WHERE item_id=OLD.id)
        OR EXISTS(SELECT 1 FROM stock_transfer_lines WHERE item_id=OLD.id)
        OR EXISTS(SELECT 1 FROM production_order_lines WHERE component_item_id=OLD.id)
        OR EXISTS(SELECT 1 FROM production_orders WHERE finished_item_id=OLD.id)
      ) THEN RAISE EXCEPTION 'Stock unit is locked by inventory history or documents' USING ERRCODE='23514', CONSTRAINT='item_stock_unit_locked'; END IF;
      IF NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.unit IS DISTINCT FROM OLD.unit THEN
        SELECT symbol INTO NEW.unit FROM units_of_measure WHERE id=NEW.unit_id;
      END IF; RETURN NEW;
    END $$`);
    await q.query(
      'CREATE TRIGGER item_stock_unit_locked BEFORE UPDATE OF unit_id,unit ON items FOR EACH ROW EXECUTE FUNCTION protect_item_stock_unit()',
    );
    // Guard direct SQL writes and serialize precision changes with stock updates.
    await q.query(`CREATE FUNCTION validate_stock_unit_precision() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE places integer; BEGIN
      SELECT u.decimal_places INTO places FROM items i JOIN units_of_measure u ON u.id=i.unit_id
        WHERE i.id=NEW.item_id FOR SHARE OF i,u;
      IF NEW.quantity<>round(NEW.quantity,places) OR NEW.reserved<>round(NEW.reserved,places)
        OR NEW.reorder_point<>round(NEW.reorder_point,places) THEN
        RAISE EXCEPTION 'Stock quantity precision does not match its unit' USING ERRCODE='23514', CONSTRAINT='stock_unit_precision';
      END IF; RETURN NEW; END $$`);
    await q.query(
      'CREATE TRIGGER stock_unit_precision BEFORE INSERT OR UPDATE OF quantity,reserved,reorder_point ON stock_levels FOR EACH ROW EXECUTE FUNCTION validate_stock_unit_precision()',
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(
      'DROP TRIGGER IF EXISTS stock_unit_precision ON stock_levels',
    );
    await q.query('DROP FUNCTION IF EXISTS validate_stock_unit_precision()');
    await q.query('DROP TRIGGER item_stock_unit_locked ON items');
    await q.query('DROP FUNCTION protect_item_stock_unit()');
    await q.query('ALTER TABLE items DROP COLUMN unit_id');
    await q.query('DROP TABLE units_of_measure');
  }
}
