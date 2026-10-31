import { MigrationInterface, QueryRunner } from 'typeorm';
import { CustomerPhoneIdentity1749230000000 } from './1749230000000-CustomerPhoneIdentity';

/** Forward repair for servers that already applied the optional phone feature. */
export class RemoveCustomerPhoneValidation1749240000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      'DROP TRIGGER IF EXISTS customer_phone_identity ON customers',
    );
    await q.query('DROP FUNCTION IF EXISTS check_customer_phone_identity()');
    await q.query('DROP INDEX IF EXISTS customer_phone_lookup');
    await q.query('DROP INDEX IF EXISTS customer_phone_normalized_unique');
    await q.query(
      'ALTER TABLE customers DROP COLUMN IF EXISTS phone_normalized',
    );
    await q.query('DROP FUNCTION IF EXISTS customer_phone_key(text)');
  }
  async down(q: QueryRunner): Promise<void> {
    await new CustomerPhoneIdentity1749230000000().up(q);
  }
}
