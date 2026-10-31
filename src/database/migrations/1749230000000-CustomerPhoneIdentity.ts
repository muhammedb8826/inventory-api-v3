import { MigrationInterface, QueryRunner } from 'typeorm';

export class CustomerPhoneIdentity1749230000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE OR REPLACE FUNCTION customer_phone_key(value text) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT nullif(regexp_replace(regexp_replace(coalesce(value,''),'[^0-9]','','g'),'^00',''),'') $$`);
    await q.query(
      'ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_normalized varchar(15)',
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS customer_phone_lookup ON customers(customer_phone_key(phone))`,
    );
    // Preserve existing phone strings, customers and history. Only unambiguous
    // legacy numbers enter the unique index; the trigger also checks legacy duplicates.
    await q.query(`UPDATE customers c SET phone_normalized=customer_phone_key(c.phone)
      WHERE length(customer_phone_key(c.phone)) BETWEEN 7 AND 15
      AND (SELECT count(*) FROM customers other WHERE customer_phone_key(other.phone)=customer_phone_key(c.phone))=1`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS customer_phone_normalized_unique ON customers(phone_normalized) WHERE phone_normalized IS NOT NULL`,
    );
    await q.query(`CREATE OR REPLACE FUNCTION check_customer_phone_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE key text;
      BEGIN
        IF TG_OP='UPDATE' THEN
          IF NEW.phone IS NOT DISTINCT FROM OLD.phone THEN RETURN NEW; END IF;
        END IF;
        key := customer_phone_key(NEW.phone);
        IF key IS NULL OR length(key) NOT BETWEEN 7 AND 15
          OR trim(NEW.phone) !~ '^[+]?[0-9().[:space:]-]+$' THEN
          RAISE EXCEPTION 'A valid customer phone number is required' USING ERRCODE='23514',CONSTRAINT='customer_phone_required';
        END IF;
        IF EXISTS(SELECT 1 FROM customers c WHERE c.id<>NEW.id AND customer_phone_key(c.phone)=key) THEN
          RAISE EXCEPTION 'Customer phone already exists' USING ERRCODE='23505',CONSTRAINT='customer_phone_normalized_unique';
        END IF;
        NEW.phone_normalized := key;
        RETURN NEW;
      END $$`);
    await q.query(
      'DROP TRIGGER IF EXISTS customer_phone_identity ON customers',
    );
    await q.query(
      `CREATE TRIGGER customer_phone_identity BEFORE INSERT OR UPDATE OF phone ON customers FOR EACH ROW EXECUTE FUNCTION check_customer_phone_identity()`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(
      'DROP TRIGGER IF EXISTS customer_phone_identity ON customers',
    );
    await q.query('DROP FUNCTION IF EXISTS check_customer_phone_identity()');
    await q.query('DROP INDEX IF EXISTS customer_phone_lookup');
    await q.query('DROP INDEX IF EXISTS customer_phone_normalized_unique');
    await q.query('ALTER TABLE customers DROP COLUMN phone_normalized');
    await q.query('DROP FUNCTION customer_phone_key(text)');
  }
}
