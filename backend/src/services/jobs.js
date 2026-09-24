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

// Nightly jobs are due once per IST day, at or after RECONCILIATION_HOUR_IST.
// "Already done today" is read from job_runs, not memory, so a restart or a
// host that slept through the hour (free tiers) catches up on the next tick
// instead of silently skipping a night.
export async function nightlyDue(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  if (ist.getUTCHours() < config.jobs.reconciliationHourIst) return false;
  const { rows } = await query(
    `SELECT 1 FROM job_runs
      WHERE job = 'reconciliation' AND status = 'succeeded'
        AND (started_at AT TIME ZONE 'Asia/Kolkata')::date = ($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
      LIMIT 1`,
    [now],
  );
  return !rows[0];
}

export async function schedulerTick() {
  for (const j of ['expire_payments', 'auto_confirm', 'subscriptions']) await runJob(j);
  if (await nightlyDue()) {
    await runJob('reconciliation');
    await runJob('anomalies');
  }
}

// Frequent jobs every 10 minutes; the reconciliation engine and anomaly
// rules nightly (Section 9.4: "every night").
export function startScheduler() {
  const tick = () => { schedulerTick().catch((e) => console.error('scheduler tick failed', e)); };
  const timer = setInterval(tick, 10 * 60_000);
  timer.unref();
  setTimeout(tick, 5_000).unref();
  return timer;
}
