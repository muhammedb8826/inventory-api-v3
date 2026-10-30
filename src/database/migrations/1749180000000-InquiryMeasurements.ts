import { MigrationInterface, QueryRunner } from 'typeorm';
export class InquiryMeasurements1749180000000 implements MigrationInterface {
  async up(q: QueryRunner) {
    await q.query(
      'ALTER TABLE customer_inquiry_lines ADD COLUMN IF NOT EXISTS unit_snapshot jsonb',
    );
    await q.query(
      'ALTER TABLE customer_inquiries ADD COLUMN IF NOT EXISTS requested_delivery_date date',
    );
    await q.query(`CREATE TABLE IF NOT EXISTS inquiry_attachments (
      id uuid PRIMARY KEY, inquiry_id uuid NOT NULL REFERENCES customer_inquiries(id) ON DELETE CASCADE,
      name varchar(150) NOT NULL, mime varchar(80) NOT NULL, size integer NOT NULL,
      hash varchar(64) NOT NULL, data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(inquiry_id,hash))`);
  }
  async down(q: QueryRunner) {
    await q.query('DROP TABLE inquiry_attachments');
    await q.query(
      'ALTER TABLE customer_inquiries DROP COLUMN requested_delivery_date',
    );
    await q.query(
      'ALTER TABLE customer_inquiry_lines DROP COLUMN unit_snapshot',
    );
  }
}
