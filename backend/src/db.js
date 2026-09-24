import pg from 'pg';
import { config } from './config.js';

// BIGINT (int8) -> JS number. All money values are paise and stay far
// below Number.MAX_SAFE_INTEGER (~9e15 paise = ₹90 trillion).
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
// DATE -> 'YYYY-MM-DD' string, so calendar dates never shift with the
// server's timezone.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  // TLS when PGSSL=true or the URL says sslmode=require (external/managed
  // connections). Private-network URLs (e.g. Render internal) don't use it.
  ssl: config.pgSsl
    ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' }
    : undefined,
});

export function query(text, params) {
  return pool.query(text, params);
}

// Run fn inside a transaction. Rolls back on any thrown error. Side
// effects registered with client.afterCommit(fn) (push notifications,
// SMS) run only once the transaction has committed.
export async function tx(fn) {
  const client = await pool.connect();
  const after = [];
  client.afterCommit = (f) => after.push(f);
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    for (const f of after) {
      Promise.resolve().then(f).catch((err) => console.error('after-commit hook failed:', err.message));
    }
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    delete client.afterCommit;
    client.release();
  }
}
