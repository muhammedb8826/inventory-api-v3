import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductionHardening1749110000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS request_hash varchar(64)`,
    );
    await q.query(`ALTER TABLE sale_returns ADD COLUMN IF NOT EXISTS refund_amount numeric(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS credit_amount numeric(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES bank_accounts(id)`);
    await q.query(`CREATE TABLE audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid, method varchar(10) NOT NULL,
      route text NOT NULL, resource_id varchar(128), request_id varchar(128), status_code int NOT NULL,
      changes jsonb, created_at timestamptz NOT NULL DEFAULT now())`);
    await q.query(`CREATE FUNCTION inventory_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO audit_events(method, route, resource_id, status_code, changes)
        VALUES (TG_OP, TG_TABLE_NAME, COALESCE(NEW.id, OLD.id)::text, 200,
          jsonb_build_object('before', CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) - ARRAY['password_hash','token_hash'] ELSE NULL END,
                             'after', CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) - ARRAY['password_hash','token_hash'] ELSE NULL END));
        RETURN COALESCE(NEW, OLD);
      END $$`);
    for (const table of [
      'users',
      'roles',
      'sales',
      'purchases',
      'customer_credits',
      'supplier_credits',
      'bank_accounts',
      'bank_transactions',
      'stock_adjustments',
      'sale_returns',
    ]) {
      await q.query(
        `CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION inventory_audit_change()`,
      );
    }
    await q.query(
      `CREATE FUNCTION inventory_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit records are append only'; END $$`,
    );
    await q.query(
      `CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION inventory_audit_immutable()`,
    );
    await q.query(
      `CREATE INDEX audit_events_created_idx ON audit_events(created_at)`,
    );
    await q.query(
      `CREATE INDEX audit_events_actor_idx ON audit_events(actor_id, created_at)`,
    );
    await q.query(`CREATE TABLE stock_movement_lots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), movement_id uuid NOT NULL REFERENCES stock_movements(id),
      lot_id uuid NOT NULL REFERENCES stock_lots(id), quantity numeric(14,3) NOT NULL CHECK(quantity > 0))`);
    await q.query(
      `CREATE INDEX stock_movement_lots_movement_idx ON stock_movement_lots(movement_id)`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE stock_movement_lots`);
    for (const table of [
      'users',
      'roles',
      'sales',
      'purchases',
      'customer_credits',
      'supplier_credits',
      'bank_accounts',
      'bank_transactions',
      'stock_adjustments',
      'sale_returns',
    ]) {
      await q.query(`DROP TRIGGER audit_change ON "${table}"`);
    }
    await q.query(`DROP FUNCTION inventory_audit_change()`);
    await q.query(`DROP TABLE audit_events`);
    await q.query(`DROP FUNCTION inventory_audit_immutable()`);
    await q.query(
      `ALTER TABLE sale_returns DROP COLUMN bank_account_id, DROP COLUMN credit_amount, DROP COLUMN refund_amount`,
    );
    await q.query(`ALTER TABLE idempotency_keys DROP COLUMN request_hash`);
  }
}
