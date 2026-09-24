// Section 9.4 — the nightly reconciliation engine, and Section 9.5 —
// automated anomaly rules. Every rule only raises flags (and, where the
// plan says so, payout holds); humans decide in the admin fraud queue.

import { config } from '../config.js';
import { query, tx } from '../db.js';
import { holdPayoutItem, holdWorkerPayouts, raiseFlag } from './fraud.js';
import { notify } from './notify.js';

// Three independent signals must agree: (1) gateway payment, (2) GPS
// check-in/out, (3) customer OTP. Returns the list of problems.
export function evaluateBooking(b) {
  const problems = [];
  const paymentOk = b.payment_captured && (b.payment_amount_ok);
  if (!paymentOk) problems.push('no_payment');
  if (!b.checkin_ok) problems.push(b.has_checkin ? 'gps_far' : 'no_checkin');
  if (b.checkout_distance_m !== null && b.checkout_distance_m > config.booking.gpsFlagDistanceM) problems.push('checkout_far');
  if (!b.otp_verified_at) problems.push('no_otp');
  return problems;
}

export async function reconcileBookings() {
  const { rows } = await query(
    `SELECT b.id, b.worker_id, b.customer_id, b.amount, b.otp_verified_at, b.checkout_distance_m,
            EXISTS (SELECT 1 FROM payments p
                     WHERE (p.booking_id = b.id OR (b.subscription_id IS NOT NULL AND p.subscription_id = b.subscription_id))
                       AND p.payment_status IN ('captured', 'partially_refunded') AND p.gateway_txn_id IS NOT NULL
                       AND p.paid_at IS NOT NULL) AS payment_captured,
            COALESCE((SELECT p.amount = b.amount FROM payments p WHERE p.booking_id = b.id LIMIT 1),
                     (SELECT s.per_visit_paise = b.amount FROM subscriptions s WHERE s.id = b.subscription_id), false)
              AS payment_amount_ok,
            EXISTS (SELECT 1 FROM gps_pings g WHERE g.booking_id = b.id AND g.kind = 'checkin') AS has_checkin,
            EXISTS (SELECT 1 FROM gps_pings g WHERE g.booking_id = b.id AND g.kind = 'checkin'
                       AND g.worker_id = b.worker_id AND g.distance_m <= $1 AND NOT g.is_mock) AS checkin_ok
       FROM bookings b
      WHERE b.status IN ('completed', 'confirmed') AND b.reconciliation_status = 'pending'
      ORDER BY b.completed_at
      LIMIT 5000`,
    [config.booking.checkinRadiusM],
  );

  const summary = { checked: rows.length, clean: 0, mismatch: 0 };
  for (const b of rows) {
    const problems = evaluateBooking(b);
    await tx(async (db) => {
      if (problems.length === 0) {
        summary.clean += 1;
        await db.query(`UPDATE bookings SET reconciliation_status = 'clean', reconciled_at = now() WHERE id = $1`, [b.id]);
        return;
      }
      summary.mismatch += 1;
      await db.query(`UPDATE bookings SET reconciliation_status = 'mismatch', reconciled_at = now() WHERE id = $1`, [b.id]);
      // Anything not clean is held for human review before the next payout.
      await holdPayoutItem(db, b.id, `Reconciliation mismatch: ${problems.join(', ')}`);
      if (problems.includes('no_payment')) {
        await raiseFlag(db, { workerId: b.worker_id, bookingId: b.id, type: 'completed_without_payment',
          severity: 'critical', details: { problems } });
      }
      if (problems.includes('gps_far') || problems.includes('no_checkin') || problems.includes('checkout_far')) {
        await raiseFlag(db, { workerId: b.worker_id, bookingId: b.id, type: 'gps_mismatch',
          severity: 'high', details: { problems } });
      }
      if (problems.includes('no_otp')) {
        await raiseFlag(db, { workerId: b.worker_id, bookingId: b.id, type: 'missing_customer_otp',
          severity: 'high', details: { problems } });
      }
    });
  }
  return summary;
}

// Payment housekeeping: expire abandoned orders.
export async function expireStalePayments() {
  return tx(async (db) => {
    const { rows } = await db.query(
      `UPDATE payments SET payment_status = 'failed'
        WHERE payment_status = 'created' AND created_at < now() - interval '2 hours'
        RETURNING booking_id, subscription_id`,
    );
    for (const r of rows) {
      if (r.booking_id) {
        const { rows: b } = await db.query(
          `UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by_role = 'system',
                  cancel_reason = 'Payment not completed'
            WHERE id = $1 AND status = 'pending_payment' RETURNING id`,
          [r.booking_id],
        );
        if (b[0]) {
          await db.query(
            `INSERT INTO booking_events (booking_id, from_status, to_status, actor_role, meta)
             VALUES ($1, 'pending_payment', 'cancelled', 'system', '{"reason":"payment_timeout"}')`,
            [r.booking_id],
          );
        }
      } else if (r.subscription_id) {
        await db.query(`UPDATE subscriptions SET status = 'cancelled' WHERE id = $1 AND status = 'pending_payment'`, [r.subscription_id]);
      }
    }
    return rows.length;
  });
}

// --------------------------------------------------- Section 9.4/9.5 rules
async function ruleHighCancellation(db) {
  // Customers cancelling after this worker was assigned (the "no-show"
  // pattern). Worker moved to review and payouts held temporarily.
  const { rows } = await db.query(`
    WITH assigned AS (
      SELECT (meta->>'workerId')::uuid AS worker_id, count(*)::int AS n
        FROM booking_events
       WHERE to_status = 'assigned' AND created_at > now() - interval '30 days' AND meta ? 'workerId'
       GROUP BY 1
    ), cancelled AS (
      SELECT (meta->>'workerId')::uuid AS worker_id, count(*)::int AS n
        FROM booking_events
       WHERE to_status = 'cancelled' AND actor_role = 'customer' AND created_at > now() - interval '30 days'
         AND meta->>'workerId' IS NOT NULL
       GROUP BY 1
    )
    SELECT a.worker_id, a.n AS assigned, c.n AS cancelled
      FROM assigned a JOIN cancelled c ON c.worker_id = a.worker_id
     WHERE a.n >= 5 AND c.n * 100 >= 30 * a.n`);
  for (const r of rows) {
    const id = await raiseFlag(db, { workerId: r.worker_id, type: 'high_customer_cancellation_rate', severity: 'high',
      details: { assigned: r.assigned, cancelled: r.cancelled, windowDays: 30 } });
    if (id) await holdWorkerPayouts(db, r.worker_id, 'Temporary hold: high customer cancellation rate under review');
  }
  return rows.length;
}

async function ruleHeavyMaskedCalls(db) {
  // Customer keeps calling the worker's masked number but has stopped
  // booking in-app: an off-app relationship forming.
  const { rows } = await db.query(`
    SELECT mc.customer_id, mc.worker_id, count(*)::int AS calls
      FROM masked_calls mc
     WHERE mc.created_at > now() - interval '30 days' AND mc.initiated_by_role = 'customer'
     GROUP BY mc.customer_id, mc.worker_id
    HAVING count(*) >= 5
       AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = mc.customer_id
                        AND b.created_at > now() - interval '14 days')`);
  for (const r of rows) {
    const id = await raiseFlag(db, { workerId: r.worker_id, customerId: r.customer_id, type: 'off_app_relationship_signal',
      severity: 'low', details: { calls30d: r.calls } });
    if (id) {
      await notify(db, r.customer_id, 'reminder', 'Always book in-app for protection',
        'Jobs booked and paid in the app carry our service guarantee and refund protection. Cash payments outside the app are not covered.');
    }
  }
  return rows.length;
}

async function ruleValueDrop(db) {
  // Completed-job count rising but average booking value falling sharply.
  const { rows } = await db.query(`
    SELECT worker_id,
           count(*) FILTER (WHERE completed_at > now() - interval '30 days')::int AS recent_n,
           count(*) FILTER (WHERE completed_at <= now() - interval '30 days')::int AS prev_n,
           avg(amount) FILTER (WHERE completed_at > now() - interval '30 days') AS recent_avg,
           avg(amount) FILTER (WHERE completed_at <= now() - interval '30 days') AS prev_avg
      FROM bookings
     WHERE worker_id IS NOT NULL AND status IN ('completed', 'confirmed')
       AND completed_at > now() - interval '60 days'
     GROUP BY worker_id
    HAVING count(*) FILTER (WHERE completed_at <= now() - interval '30 days') >= 5
       AND count(*) FILTER (WHERE completed_at > now() - interval '30 days')
           > count(*) FILTER (WHERE completed_at <= now() - interval '30 days')
       AND avg(amount) FILTER (WHERE completed_at > now() - interval '30 days')
           < 0.6 * avg(amount) FILTER (WHERE completed_at <= now() - interval '30 days')`);
  for (const r of rows) {
    await raiseFlag(db, { workerId: r.worker_id, type: 'job_value_drop', severity: 'medium',
      details: { recentJobs: r.recent_n, previousJobs: r.prev_n, recentAvg: Math.round(r.recent_avg), previousAvg: Math.round(r.prev_avg) } });
  }
  return rows.length;
}

async function ruleRepeatCashReports(db) {
  // Multiple "asked for cash" reports (button or 1-star review tag).
  const { rows } = await db.query(`
    SELECT worker_id, count(*)::int AS reports FROM (
      SELECT worker_id, booking_id FROM cash_reports WHERE created_at > now() - interval '90 days'
      UNION
      SELECT worker_id, booking_id FROM reviews WHERE asked_for_cash AND created_at > now() - interval '90 days'
    ) x GROUP BY worker_id HAVING count(*) >= 2`);
  for (const r of rows) {
    await raiseFlag(db, { workerId: r.worker_id, type: 'repeated_cash_demand_reports', severity: 'critical',
      details: { reports90d: r.reports } });
  }
  return rows.length;
}

async function ruleShortDurationMultiWorker(db) {
  // Same address booking many different workers with unusually short
  // in-app durations.
  const { rows } = await db.query(`
    SELECT b.customer_id, b.address_id, count(DISTINCT b.worker_id)::int AS workers,
           count(*) FILTER (WHERE EXTRACT(EPOCH FROM (b.completed_at - b.checkin_at)) < s.duration_minutes * 60 * 0.25)::int AS short_jobs,
           count(*)::int AS jobs
      FROM bookings b JOIN services s ON s.id = b.service_id
     WHERE b.status IN ('completed', 'confirmed') AND b.completed_at > now() - interval '30 days'
     GROUP BY b.customer_id, b.address_id
    HAVING count(DISTINCT b.worker_id) >= 3
       AND count(*) FILTER (WHERE EXTRACT(EPOCH FROM (b.completed_at - b.checkin_at)) < s.duration_minutes * 60 * 0.25) * 2 > count(*)`);
  for (const r of rows) {
    await raiseFlag(db, { customerId: r.customer_id, type: 'short_duration_multi_worker', severity: 'medium',
      details: { addressId: r.address_id, workers: r.workers, shortJobs: r.short_jobs, jobs: r.jobs } });
  }
  return rows.length;
}

async function ruleCancelWithoutRebook(db) {
  // Spike in "cancelled after this worker was assigned, and the customer
  // never re-booked the service in-app" — the job likely happened off-app.
  const { rows } = await db.query(`
    SELECT (c.meta->>'workerId')::uuid AS worker_id, count(*)::int AS n
      FROM booking_events c
      JOIN bookings b ON b.id = c.booking_id
     WHERE c.to_status = 'cancelled' AND c.actor_role = 'customer' AND c.meta->>'workerId' IS NOT NULL
       AND c.created_at > now() - interval '30 days' AND c.created_at < now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM bookings nb WHERE nb.customer_id = b.customer_id AND nb.service_id = b.service_id
                        AND nb.created_at > c.created_at AND nb.status NOT IN ('cancelled', 'pending_payment'))
     GROUP BY 1 HAVING count(*) >= 3`);
  for (const r of rows) {
    await raiseFlag(db, { workerId: r.worker_id, type: 'cancel_then_no_rebook_pattern', severity: 'high',
      details: { occurrences30d: r.n } });
  }
  return rows.length;
}

async function ruleMonitoredWorkerMismatch(db) {
  // Workers under 30-day monitoring: any new mismatch escalates.
  const { rows } = await db.query(`
    SELECT DISTINCT b.worker_id FROM bookings b JOIN workers w ON w.id = b.worker_id
     WHERE w.monitoring_until > now() AND b.reconciliation_status = 'mismatch'
       AND b.reconciled_at > now() - interval '1 day'`);
  for (const r of rows) {
    await raiseFlag(db, { workerId: r.worker_id, type: 'mismatch_during_monitoring', severity: 'high', details: {} });
  }
  return rows.length;
}

export const RULES = {
  high_customer_cancellation_rate: ruleHighCancellation,
  off_app_relationship_signal: ruleHeavyMaskedCalls,
  job_value_drop: ruleValueDrop,
  repeated_cash_demand_reports: ruleRepeatCashReports,
  short_duration_multi_worker: ruleShortDurationMultiWorker,
  cancel_then_no_rebook_pattern: ruleCancelWithoutRebook,
  mismatch_during_monitoring: ruleMonitoredWorkerMismatch,
};

export async function runAnomalyRules() {
  const out = {};
  for (const [name, fn] of Object.entries(RULES)) {
    out[name] = await tx((db) => fn(db));
  }
  return out;
}
