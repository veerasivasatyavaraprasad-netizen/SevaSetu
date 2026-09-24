// Run a background job once, e.g. from an external cron:
//   npm run run-job -- reconciliation
import { pool } from '../db.js';
import { JOBS, runJob } from '../services/jobs.js';

const name = process.argv[2];
try {
  if (!JOBS[name]) throw new Error(`usage: npm run run-job -- <${Object.keys(JOBS).join('|')}>`);
  console.log(JSON.stringify(await runJob(name), null, 2));
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
