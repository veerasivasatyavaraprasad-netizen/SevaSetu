import { migrate } from '../lib/migrate.js';
import { pool } from '../db.js';

try {
  await migrate();
  console.log('migrations up to date');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
