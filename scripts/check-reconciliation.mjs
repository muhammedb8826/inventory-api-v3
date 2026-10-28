import 'dotenv/config';
import pg from 'pg';
const client = new pg.Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD ?? '', database: process.env.DB_DATABASE });
await client.connect();
try {
  const checks = {
    bankBalances: `SELECT a.id, a.balance, COALESCE(SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END),0)::numeric(14,2) AS ledger_balance
      FROM bank_accounts a LEFT JOIN bank_transactions t ON t.bank_account_id=a.id GROUP BY a.id
      HAVING a.balance <> COALESCE(SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END),0)`,
    stockBalances: `SELECT s.id, s.quantity, SUM(m.quantity_delta) AS ledger_quantity FROM stock_levels s
      JOIN stock_movements m ON m.location_id=s.location_id AND m.item_id=s.item_id GROUP BY s.id
      HAVING s.quantity <> SUM(m.quantity_delta)`,
    customerCredits: `SELECT id FROM customer_credits WHERE balance <> amount-paid_amount OR balance < 0 OR paid_amount < 0`,
    supplierCredits: `SELECT id FROM supplier_credits WHERE balance <> amount-paid_amount OR balance < 0 OR paid_amount < 0`,
    reservations: `SELECT id FROM stock_levels WHERE reserved < 0 OR (quantity >= 0 AND reserved > quantity)`,
  };
  let failed = false;
  for (const [name, sql] of Object.entries(checks)) {
    const result = await client.query(sql); console.log(`${name}: ${result.rowCount} mismatches`);
    if (result.rowCount) { failed = true; console.log(JSON.stringify(result.rows)); }
  }
  if (failed) process.exitCode = 1;
} finally { await client.end(); }
