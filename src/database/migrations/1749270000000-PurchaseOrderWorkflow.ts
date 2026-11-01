import { MigrationInterface, QueryRunner } from 'typeorm';
export class PurchaseOrderWorkflow1749270000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(
      `CREATE TABLE IF NOT EXISTS purchase_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),state varchar NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','CONFIRMED','RECEIVED','CANCELLED')),location_id uuid NOT NULL REFERENCES locations(id),payload jsonb NOT NULL,normalized_lines jsonb NOT NULL DEFAULT '[]',total numeric(14,2) NOT NULL DEFAULT 0,purchase_id uuid UNIQUE REFERENCES purchases(id),created_by_id uuid REFERENCES users(id),history jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS purchase_orders_location_state ON purchase_orders(location_id,state)`,
    );
    await q.query(
      `CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION inventory_audit_change()`,
    );
    await q.query(
      `INSERT INTO permissions(id,code,name,module) VALUES(gen_random_uuid(),'purchase.receive','Receive confirmed purchase orders','purchase') ON CONFLICT(code) DO NOTHING`,
    );
    await q.query(
      `INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE (r.name='Admin' AND p.code='purchase.receive') OR (r.name IN ('Stock Keeper','Warehouse Operator') AND p.code IN ('purchase.receive','purchase.read')) ON CONFLICT DO NOTHING`,
    );
    await q.query(
      `ALTER TABLE items ALTER COLUMN sales_price TYPE numeric(24,10)`,
    );
    const [{ body }]: { body: string }[] = await q.query(
      "SELECT prosrc AS body FROM pg_proc WHERE oid='item_stock_unit_in_use(uuid)'::regprocedure",
    );
    await q.query(
      `CREATE OR REPLACE FUNCTION item_stock_unit_in_use(item uuid) RETURNS boolean LANGUAGE sql VOLATILE AS $guard$ ${body.trim().replace(/;$/, '')} OR EXISTS(SELECT 1 FROM purchase_orders o CROSS JOIN LATERAL jsonb_array_elements(o.normalized_lines) l WHERE l->>'itemId'=item::text AND o.state<>'CANCELLED') $guard$`,
    );
  }
  async down() {
    /* Preserve receipts and approvals. */
  }
}
