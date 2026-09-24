// Weekly batched payouts (Section 8) with maker-checker controls
// (Section 9.8): the preparer can't approve, batches above the threshold
// need two distinct approvers, and only reconciled-clean bookings of
// workers without a payout hold are paid.

import { config } from '../config.js';
import { tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { audit } from './audit.js';
import { notify } from './notify.js';
import { payments } from './payments.js';

// Monday 00:00 IST of the week containing `date`, as YYYY-MM-DD.
export function istWeekStart(date) {
  const ist = new Date(date.getTime() + 5.5 * 3600_000);
  const day = (ist.getUTCDay() + 6) % 7; // Monday = 0
  ist.setUTCDate(ist.getUTCDate() - day);
  return ist.toISOString().slice(0, 10);
}

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function prepareBatch(db, { adminId, weekStart, ip }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || istWeekStart(new Date(`${weekStart}T12:00:00+05:30`)) !== weekStart) {
    throw badRequest('weekStart must be a Monday (YYYY-MM-DD)');
  }
  const weekEnd = addDays(weekStart, 6);
  if (new Date(`${addDays(weekStart, 7)}T00:00:00+05:30`) > new Date()) {
    throw badRequest('That week has not ended yet');
  }
  const { rows: existing } = await db.query(
    `SELECT id FROM payout_batches WHERE week_start = $1 AND status <> 'cancelled'`, [weekStart],
  );
  if (existing[0]) throw conflict('A batch for this week already exists');

  // Eligible: confirmed on or before week end, reconciled clean, no open
  // dispute, worker has a verified payout account and no hold.
  const { rows: items } = await db.query(
    `SELECT pi.id, pi.worker_id, pi.amount FROM payout_items pi
       JOIN bookings b ON b.id = pi.booking_id
       JOIN workers w ON w.id = pi.worker_id
      WHERE pi.status = 'pending' AND pi.amount > 0
        AND b.status = 'confirmed' AND b.reconciliation_status = 'clean'
        AND b.confirmed_at < ($1::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'
        AND w.payout_hold = false AND w.status <> 'deactivated' AND w.payout_verified_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.booking_id = b.id AND d.status = 'open')
      FOR UPDATE OF pi`,
    [weekEnd],
  );
  if (items.length === 0) throw badRequest('No eligible earnings to pay out for that week');

  const byWorker = new Map();
  for (const it of items) {
    const w = byWorker.get(it.worker_id) || { total: 0, ids: [] };
    w.total += it.amount;
    w.ids.push(it.id);
    byWorker.set(it.worker_id, w);
  }
  const total = items.reduce((s, i) => s + i.amount, 0);
  const required = total > config.payoutTwoPersonThresholdPaise ? 2 : 1;
  const { rows: batch } = await db.query(
    `INSERT INTO payout_batches (week_start, week_end, total_amount, required_approvals, prepared_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [weekStart, weekEnd, total, required, adminId],
  );
  for (const [workerId, w] of byWorker) {
    const { rows: p } = await db.query(
      `INSERT INTO payouts (batch_id, worker_id, week_start, week_end, total_amount) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [batch[0].id, workerId, weekStart, weekEnd, w.total],
    );
    await db.query(`UPDATE payout_items SET status = 'batched', payout_id = $2 WHERE id = ANY($1)`, [w.ids, p[0].id]);
  }
  await audit(db, { actorId: adminId, actorRole: 'admin', action: 'payout.batch_prepared', targetTable: 'payout_batches',
    targetId: batch[0].id, newValue: { weekStart, total, workers: byWorker.size, requiredApprovals: required }, ip });
  return batch[0];
}

export async function approveBatch(db, { batchId, adminId, ip }) {
  const { rows } = await db.query('SELECT * FROM payout_batches WHERE id = $1 FOR UPDATE', [batchId]);
  const batch = rows[0];
  if (!batch) throw notFound();
  if (batch.status !== 'draft') throw conflict('Batch is not awaiting approval');
  if (batch.prepared_by === adminId) throw forbidden('You prepared this batch; a different admin must approve it');
  const { rowCount } = await db.query(
    'INSERT INTO payout_batch_approvals (batch_id, admin_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [batchId, adminId],
  );
  if (!rowCount) throw conflict('You have already approved this batch');
  const { rows: c } = await db.query('SELECT count(*)::int AS n FROM payout_batch_approvals WHERE batch_id = $1', [batchId]);
  let status = batch.status;
  if (c[0].n >= batch.required_approvals) {
    status = 'approved';
    await db.query(`UPDATE payout_batches SET status = 'approved' WHERE id = $1`, [batchId]);
  }
  await audit(db, { actorId: adminId, actorRole: 'admin', action: 'payout.batch_approved', targetTable: 'payout_batches',
    targetId: batchId, newValue: { approvals: c[0].n, required: batch.required_approvals, status }, ip });
  return { approvals: c[0].n, required: batch.required_approvals, status };
}

export async function cancelBatch(db, { batchId, adminId, ip }) {
  const { rows } = await db.query('SELECT * FROM payout_batches WHERE id = $1 FOR UPDATE', [batchId]);
  if (!rows[0]) throw notFound();
  if (!['draft', 'approved'].includes(rows[0].status)) throw conflict('Only unreleased batches can be cancelled');
  await db.query(`UPDATE payout_batches SET status = 'cancelled' WHERE id = $1`, [batchId]);
  await db.query(`UPDATE payouts SET status = 'cancelled' WHERE batch_id = $1`, [batchId]);
  await db.query(
    `UPDATE payout_items SET status = 'pending', payout_id = NULL
      WHERE payout_id IN (SELECT id FROM payouts WHERE batch_id = $1) AND status = 'batched'`,
    [batchId],
  );
  await audit(db, { actorId: adminId, actorRole: 'admin', action: 'payout.batch_cancelled', targetTable: 'payout_batches', targetId: batchId, ip });
}

// Release: marks the batch released, then sends each payout through the
// gateway with an idempotency key so a retry can never double-pay.
export async function releaseBatch({ batchId, adminId, ip }) {
  const payoutsToSend = await tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM payout_batches WHERE id = $1 FOR UPDATE', [batchId]);
    const batch = rows[0];
    if (!batch) throw notFound();
    if (batch.status !== 'approved') throw conflict('Batch must be fully approved before release');
    if (batch.prepared_by === adminId) throw forbidden('The preparer cannot release a batch');
    await db.query(`UPDATE payout_batches SET status = 'released', released_by = $2, released_at = now() WHERE id = $1`,
      [batchId, adminId]);
    // A hold placed after approval still wins.
    const { rows: held } = await db.query(
      `UPDATE payouts p SET status = 'cancelled', failure_reason = 'Worker payout hold at release time'
        FROM workers w WHERE w.id = p.worker_id AND p.batch_id = $1 AND p.status = 'pending'
          AND (w.payout_hold OR w.status = 'deactivated')
        RETURNING p.id`,
      [batchId],
    );
    if (held.length) {
      await db.query(`UPDATE payout_items SET status = 'pending', payout_id = NULL WHERE payout_id = ANY($1)`,
        [held.map((h) => h.id)]);
    }
    const { rows: ps } = await db.query(
      `UPDATE payouts p SET status = 'processing' FROM workers w
        WHERE w.id = p.worker_id AND p.batch_id = $1 AND p.status = 'pending'
        RETURNING p.*, w.payout_ref_token, w.payout_method, w.user_id`,
      [batchId],
    );
    await audit(db, { actorId: adminId, actorRole: 'admin', action: 'payout.batch_released', targetTable: 'payout_batches',
      targetId: batchId, newValue: { payouts: ps.length, heldBack: held.length }, ip });
    return ps;
  });

  const results = [];
  for (const p of payoutsToSend) {
    try {
      const r = await payments.createPayout({
        fundAccountId: p.payout_ref_token,
        amount: p.total_amount,
        referenceId: p.id,
        idempotencyKey: p.id,
        mode: p.payout_method === 'vpa' ? 'UPI' : 'IMPS',
      });
      await tx((db) => recordPayoutResult(db, { payoutId: p.id, gatewayPayoutId: r.payoutId, status: r.status, utr: r.utr }));
      results.push({ payoutId: p.id, status: r.status });
    } catch (err) {
      await tx((db) => recordPayoutResult(db, { payoutId: p.id, status: 'failed', failureReason: err.message }));
      results.push({ payoutId: p.id, status: 'failed' });
    }
  }
  return results;
}

// Also used by the RazorpayX payout.* webhooks.
export async function recordPayoutResult(db, { payoutId, gatewayPayoutId, status, utr, failureReason }) {
  const { rows } = await db.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [payoutId]);
  const p = rows[0];
  if (!p || p.status === 'paid') return;
  if (status === 'processed') {
    await db.query(
      `UPDATE payouts SET status = 'paid', gateway_payout_id = COALESCE($2, gateway_payout_id), utr_number = $3, paid_at = now()
        WHERE id = $1`,
      [payoutId, gatewayPayoutId || null, utr || null],
    );
    await db.query(`UPDATE payout_items SET status = 'paid' WHERE payout_id = $1`, [payoutId]);
    const { rows: w } = await db.query('SELECT user_id FROM workers WHERE id = $1', [p.worker_id]);
    await notify(db, w[0].user_id, 'payout', 'Weekly payout sent',
      `₹${(p.total_amount / 100).toFixed(2)} has been sent to your verified account${utr ? ` (UTR ${utr})` : ''}.`);
  } else if (['failed', 'rejected', 'reversed', 'cancelled'].includes(status)) {
    await db.query(
      `UPDATE payouts SET status = 'failed', failure_reason = $2, gateway_payout_id = COALESCE($3, gateway_payout_id) WHERE id = $1`,
      [payoutId, (failureReason || status).slice(0, 500), gatewayPayoutId || null],
    );
    // Earnings go back into the queue for the next batch.
    await db.query(`UPDATE payout_items SET status = 'pending', payout_id = NULL WHERE payout_id = $1`, [payoutId]);
  } else {
    await db.query('UPDATE payouts SET gateway_payout_id = COALESCE($2, gateway_payout_id) WHERE id = $1',
      [payoutId, gatewayPayoutId || null]);
  }
  await audit(db, { actorRole: 'system', action: `payout.${status}`, targetTable: 'payouts', targetId: payoutId,
    newValue: { gatewayPayoutId, utr, failureReason } });
}
