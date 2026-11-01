import { MigrationInterface, QueryRunner } from 'typeorm';
export class CommercialWorkflow1749250000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(
      `ALTER TABLE items ADD COLUMN IF NOT EXISTS sales_price numeric(14,2) CHECK(sales_price>=0)`,
    );
    await q.query(
      `ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS workflow_history jsonb NOT NULL DEFAULT '[]', ADD COLUMN IF NOT EXISTS materials_requested_at timestamptz, ADD COLUMN IF NOT EXISTS materials_requested_by_id uuid REFERENCES users(id), ADD COLUMN IF NOT EXISTS handed_over_at timestamptz, ADD COLUMN IF NOT EXISTS handed_over_by_id uuid REFERENCES users(id), ADD COLUMN IF NOT EXISTS started_at timestamptz, ADD COLUMN IF NOT EXISTS started_by_id uuid REFERENCES users(id)`,
    );
    await q.query(`CREATE TABLE IF NOT EXISTS sales_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), state varchar NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','PENDING_APPROVAL','APPROVED','CONFIRMED','DELIVERED','CANCELLED')),
      location_id uuid NOT NULL REFERENCES locations(id), payload jsonb NOT NULL,
      normalized_lines jsonb NOT NULL DEFAULT '[]', price_exceptions jsonb NOT NULL DEFAULT '[]', total numeric(14,2) NOT NULL DEFAULT 0,
      sale_id uuid UNIQUE REFERENCES sales(id), created_by_id uuid REFERENCES users(id), approved_by_id uuid REFERENCES users(id), approved_at timestamptz,
      approval_note text, history jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS sales_orders_location_state ON sales_orders(location_id,state)`,
    );
    await q.query(
      `CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON sales_orders FOR EACH ROW EXECUTE FUNCTION inventory_audit_change()`,
    );
    for (const [code, name] of [
      ['pricing.write', 'Configure item sales prices'],
      ['sales.approve', 'Approve sales price exceptions'],
      ['sales.deliver', 'Deliver confirmed sales orders'],
    ]) {
      await q.query(
        `INSERT INTO permissions(id,code,name,module) VALUES(gen_random_uuid(),$1,$2,'sales') ON CONFLICT(code) DO NOTHING`,
        [code, name],
      );
      await q.query(
        `INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.name='Admin' AND p.code=$1 ON CONFLICT DO NOTHING`,
        [code],
      );
    }
    await q.query(
      `INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.name IN ('Stock Keeper','Warehouse Operator') AND p.code IN ('sales.deliver','sales.read') ON CONFLICT DO NOTHING`,
    );
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
    $$`);
    // Production requests and warehouse handovers are distinct responsibilities.
    await q.query(
      `DELETE FROM role_permissions rp USING roles r, permissions p WHERE rp.role_id=r.id AND rp.permission_id=p.id AND ((r.name='Production Manager' AND p.code='production.issue') OR (r.name='Stock Keeper' AND p.code='production.write'))`,
    );
  }
  async down() {
    /* Preserve operational records and approval evidence. */
  }
}
