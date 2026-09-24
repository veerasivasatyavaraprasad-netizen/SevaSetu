// Background jobs, recorded in job_runs. The in-process scheduler takes a
// Postgres advisory lock per job, so running several API instances never
// runs a job twice concurrently.

import { config } from '../config.js';
import { pool, query, tx } from '../db.js';
import { autoConfirmDue } from './bookings.js';
import { expireStalePayments, reconcileBookings, runAnomalyRules } from './reconciliation.js';
import { generateDueVisits } from './subscriptions.js';

export const JOBS = {
  auto_confirm: async () => ({ confirmed: await tx((db) => autoConfirmDue(db)) }),
  expire_payments: async () => ({ expired: await expireStalePayments() }),
  subscriptions: async () => ({ visitsCreated: await generateDueVisits() }),
  reconciliation: reconcileBookings,
  anomalies: runAnomalyRules,
};

export async function runJob(name) {
  const client = await pool.connect();
  try {
    const { rows: lock } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [`job:${name}`]);
    if (!lock[0].ok) return { skipped: true, reason: 'already running' };
    const { rows } = await query(`INSERT INTO job_runs (job) VALUES ($1) RETURNING id`, [name]);
    try {
      const summary = await JOBS[name]();
      await query(`UPDATE job_runs SET status = 'succeeded', finished_at = now(), summary = $2 WHERE id = $1`, [rows[0].id, JSON.stringify(summary)]);
      return { job: name, status: 'succeeded', summary };
    } catch (err) {
      await query(`UPDATE job_runs SET status = 'failed', finished_at = now(), summary = $2 WHERE id = $1`,
        [rows[0].id, JSON.stringify({ error: err.message })]);
      console.error(`job ${name} failed:`, err);
      return { job: name, status: 'failed', error: err.message };
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`job:${name}`]);
    }
  } finally {
    client.release();
  }
}

function istNow() {
  return new Date(Date.now() + 5.5 * 3600_000);
}

// Frequent jobs every 10 minutes; the reconciliation engine and anomaly
// rules nightly at RECONCILIATION_HOUR_IST (Section 9.4: "every night").
export function startScheduler() {
  let lastNightly = null;
  const tick = async () => {
    for (const j of ['expire_payments', 'auto_confirm', 'subscriptions']) await runJob(j);
    const now = istNow();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === config.jobs.reconciliationHourIst && lastNightly !== day) {
      lastNightly = day;
      await runJob('reconciliation');
      await runJob('anomalies');
    }
  };
  const timer = setInterval(() => { tick().catch((e) => console.error('scheduler tick failed', e)); }, 10 * 60_000);
  timer.unref();
  setTimeout(() => { tick().catch((e) => console.error('scheduler tick failed', e)); }, 5_000).unref();
  return timer;
}
