// Admin panel API (Section 3.3). Every mutating action is permission-gated
// and written to the audit log (Section 9.8).

import argon2 from 'argon2';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { decryptBuffer, lookupHash } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { PERMISSIONS, validatePermissionSet } from '../lib/permissions.js';
import { normalizeIndianMobile } from '../lib/phone.js';
import { splitCommission } from '../lib/money.js';
import { parse } from '../lib/validate.js';
import { authenticate, requirePermission, requireRole } from '../middleware/auth.js';
import { audit, verifyAuditChain } from '../services/audit.js';
import { customerView, lockBooking, notifyEligibleWorkers, transition } from '../services/bookings.js';
import { applyStrike, holdWorkerPayouts } from '../services/fraud.js';
import { runJob, JOBS } from '../services/jobs.js';
import { notify } from '../services/notify.js';
import { approveBatch, cancelBatch, prepareBatch, releaseBatch } from '../services/payouts.js';
import {
  createRefundRequest, processApprovedRefund, REFUND_PENDING, refundableForBooking,
} from '../services/refunds.js';
import { revokeAllForUser } from '../services/sessions.js';
import { ARGON_OPTS, validatePasswordStrength } from './adminAuth.js';

export const adminRouter = Router();
adminRouter.use(authenticate(), requireRole('admin'));

const uuid = z.uuid();
const actor = (req) => ({ id: req.auth.userId, role: 'admin', ip: req.ip });
const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });

adminRouter.get('/me', async (req, res) => {
  const { rows } = await query('SELECT id, name, email FROM users WHERE id = $1', [req.auth.userId]);
  res.json({ admin: rows[0], permissions: req.auth.permissions, allPermissions: PERMISSIONS });
});

// ---------------------------------------------------------- dashboard
adminRouter.get('/dashboard', requirePermission('reports.view'), async (_req, res) => {
  const { rows } = await query(`
    SELECT
      (SELECT count(*) FROM bookings WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS bookings_today,
      (SELECT COALESCE(sum(amount), 0) FROM bookings WHERE status = 'confirmed' AND (confirmed_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::bigint AS gmv_today,
      (SELECT COALESCE(sum(commission_amount), 0) FROM bookings WHERE status = 'confirmed' AND (confirmed_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::bigint AS commission_today,
      (SELECT COALESCE(sum(commission_amount), 0) FROM bookings WHERE status = 'confirmed' AND confirmed_at > now() - interval '7 days')::bigint AS commission_7d,
      (SELECT count(*) FROM workers WHERE kyc_status = 'approved' AND status = 'active')::int AS active_workers,
      (SELECT count(*) FROM workers WHERE kyc_status = 'under_review')::int AS pending_kyc,
      (SELECT count(*) FROM disputes WHERE status = 'open')::int AS open_disputes,
      (SELECT count(*) FROM bookings WHERE status IN ('paid') AND worker_id IS NULL)::int AS unassigned_paid,
      (SELECT count(*) FROM change_requests WHERE status = 'pending')::int AS pending_changes,
      (SELECT count(*) FROM refund_requests WHERE status = 'requested')::int AS pending_refunds,
      (SELECT count(*) FROM payout_batches WHERE status IN ('draft', 'approved'))::int AS open_payout_batches,
      (SELECT COALESCE(sum(amount), 0) FROM payout_items WHERE status = 'held')::bigint AS held_payouts`);
  const { rows: flags } = await query(
    `SELECT severity, count(*)::int AS n FROM fraud_flags WHERE status = 'open' GROUP BY severity`,
  );
  const { rows: lastRuns } = await query(
    `SELECT DISTINCT ON (job) job, status, started_at, finished_at, summary FROM job_runs ORDER BY job, id DESC`,
  );
  res.json({ ...rows[0], openFlags: Object.fromEntries(flags.map((f) => [f.severity, f.n])), lastRuns });
});

// ---------------------------------------------------------- bookings
adminRouter.get('/bookings', requirePermission('bookings.manage'), async (req, res) => {
  const q = parse(pageSchema.extend({ status: z.string().max(30).optional(), reconciliation: z.enum(['pending', 'clean', 'mismatch']).optional() }), req.query);
  const { rows } = await query(
    `SELECT b.id, b.status, b.amount, b.commission_amount, b.worker_payout, b.scheduled_time, b.pincode, b.is_urgent,
            b.reconciliation_status, b.created_at, s.name AS service_name, cu.name AS customer_name, cu.phone_last4 AS customer_phone_last4,
            wu.name AS worker_name, b.worker_id
       FROM bookings b JOIN services s ON s.id = b.service_id JOIN users cu ON cu.id = b.customer_id
       LEFT JOIN workers w ON w.id = b.worker_id LEFT JOIN users wu ON wu.id = w.user_id
      WHERE ($1::text IS NULL OR b.status = $1) AND ($2::text IS NULL OR b.reconciliation_status = $2)
      ORDER BY b.created_at DESC LIMIT $3 OFFSET $4`,
    [q.status || null, q.reconciliation || null, q.limit, q.offset],
  );
  res.json({ bookings: rows });
});

adminRouter.get('/bookings/:id', requirePermission('bookings.manage'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { rows } = await query(
    `SELECT b.*, s.name AS service_name, cu.name AS customer_name, cu.phone_last4 AS customer_phone_last4, wu.name AS worker_name
       FROM bookings b JOIN services s ON s.id = b.service_id JOIN users cu ON cu.id = b.customer_id
       LEFT JOIN workers w ON w.id = b.worker_id LEFT JOIN users wu ON wu.id = w.user_id WHERE b.id = $1`, [id]);
  if (!rows[0]) throw notFound();
  const b = rows[0];
  const [events, pings, pays, flags, refunds, disputes, msgs] = await Promise.all([
    query('SELECT from_status, to_status, actor_role, meta, created_at FROM booking_events WHERE booking_id = $1 ORDER BY id', [id]),
    query('SELECT kind, distance_m, accuracy_m, is_mock, created_at FROM gps_pings WHERE booking_id = $1 ORDER BY id', [id]),
    query(`SELECT id, amount, gateway, gateway_order_id, gateway_txn_id, payment_status, refunded_amount, paid_at FROM payments
            WHERE booking_id = $1 OR ($2::uuid IS NOT NULL AND subscription_id = $2)`, [id, b.subscription_id]),
    query('SELECT id, flag_type, severity, status, created_at FROM fraud_flags WHERE booking_id = $1', [id]),
    query('SELECT id, amount, reason, status, created_at FROM refund_requests WHERE booking_id = $1', [id]),
    query('SELECT id, reason, description, status, resolution, created_at FROM disputes WHERE booking_id = $1', [id]),
    query('SELECT sender_role, body, redacted, created_at FROM messages WHERE booking_id = $1 ORDER BY id', [id]),
  ]);
  const view = customerView(b);
  delete view.completionOtp; // admins never see the customer's code
  res.json({
    booking: {
      ...view,
      serviceName: b.service_name,
      customer: { id: b.customer_id, name: b.customer_name, phoneLast4: b.customer_phone_last4 },
      worker: b.worker_id ? { id: b.worker_id, name: b.worker_name } : null,
      commissionAmount: b.commission_amount,
      workerPayout: b.worker_payout,
      commissionRateBps: b.commission_rate_bps,
      reconciliationStatus: b.reconciliation_status,
      otpAttempts: b.completion_otp_attempts,
      checkinDistanceM: b.checkin_distance_m,
      checkoutDistanceM: b.checkout_distance_m,
    },
    events: events.rows, gps: pings.rows, payments: pays.rows, flags: flags.rows, refunds: refunds.rows,
    disputes: disputes.rows, messages: msgs.rows,
  });
});

// Manual reassignment (Section 3.3).
adminRouter.post('/bookings/:id/assign', requirePermission('bookings.manage'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ workerId: uuid.nullable(), reason: z.string().trim().min(3).max(300) }).strict(), req.body);
  await tx(async (db) => {
    let b = await lockBooking(db, id);
    if (!['paid', 'assigned', 'in_progress'].includes(b.status)) throw conflict('Booking cannot be reassigned in its current state');
    const previous = b.worker_id;
    if (b.status !== 'paid') {
      b = await transition(db, b, 'paid', {
        actorId: req.auth.userId, actorRole: 'admin', meta: { unassigned: previous, reason: body.reason },
        set: { worker_id: null, accepted_at: null, checkin_at: null, checkin_distance_m: null, commission_rate_bps: null,
          commission_amount: null, worker_payout: null },
      });
    }
    if (body.workerId) {
      const { rows: w } = await db.query(
        `SELECT w.*, s.category FROM workers w, services s WHERE w.id = $1 AND s.id = $2`, [body.workerId, b.service_id]);
      const worker = w[0];
      if (!worker || worker.kyc_status !== 'approved' || worker.status !== 'active') throw badRequest('Worker is not active and approved');
      if (worker.category !== worker.skill_category) throw badRequest('Worker does not offer this service');
      if (!worker.payout_verified_at || worker.policy_ack_version !== config.policyVersion) throw badRequest('Worker onboarding is incomplete');
      const split = splitCommission(b.amount, worker.commission_rate_bps);
      await transition(db, b, 'assigned', {
        actorId: req.auth.userId, actorRole: 'admin', meta: { workerId: worker.id, reason: body.reason },
        set: { worker_id: worker.id, accepted_at: new Date(), commission_rate_bps: worker.commission_rate_bps,
          commission_amount: split.commission, worker_payout: split.workerPayout },
      });
      await notify(db, worker.user_id, 'job_assigned', 'New job assigned', 'Support assigned a job to you. Open the app for details.');
    } else {
      await notifyEligibleWorkers(db, b);
    }
    await audit(db, { ...actorAudit(req), action: 'booking.reassigned', targetTable: 'bookings', targetId: id,
      oldValue: { workerId: previous }, newValue: { workerId: body.workerId, reason: body.reason } });
  });
  res.json({ ok: true });
});

function actorAudit(req) {
  return { actorId: req.auth.userId, actorRole: 'admin', ip: req.ip };
}

// Admin cancellation always refunds in full via a maker-checker refund.
adminRouter.post('/bookings/:id/cancel', requirePermission('bookings.manage'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ reason: z.string().trim().min(3).max(300) }).strict(), req.body);
  const out = await tx(async (db) => {
    const b = await lockBooking(db, id);
    if (!['pending_payment', 'paid', 'assigned'].includes(b.status)) throw conflict('Only unstarted bookings can be cancelled');
    await transition(db, b, 'cancelled', { actorId: req.auth.userId, actorRole: 'admin', meta: { reason: body.reason },
      set: { cancelled_at: new Date(), cancelled_by_role: 'admin', cancel_reason: body.reason } });
    let refund = null;
    if (b.status !== 'pending_payment') {
      refund = await createRefundRequest(db, { bookingId: id, amount: b.amount, reason: `Admin cancellation: ${body.reason}`, requestedBy: req.auth.userId });
    }
    await audit(db, { ...actorAudit(req), action: 'booking.cancelled', targetTable: 'bookings', targetId: id, newValue: { reason: body.reason, refundRequestId: refund?.id || null } });
    await notify(db, b.customer_id, 'booking', 'Booking cancelled', 'Your booking was cancelled by support. A full refund has been initiated.');
    return refund;
  });
  res.json({ ok: true, refundRequestId: out?.id || null });
});

// ---------------------------------------------------------- workers
adminRouter.get('/workers', requirePermission('workers.kyc'), async (req, res) => {
  const q = parse(pageSchema.extend({
    kyc: z.enum(['not_submitted', 'under_review', 'approved', 'rejected']).optional(),
    status: z.enum(['active', 'suspended', 'deactivated']).optional(),
  }), req.query);
  const { rows } = await query(
    `SELECT w.id, u.name, u.phone_last4, w.skill_category, w.service_area_pincode, w.kyc_status, w.status, w.strikes,
            w.rating_avg, w.rating_count, w.total_jobs, w.commission_rate_bps, w.payout_hold, w.payout_masked,
            w.monitoring_until, w.created_at,
            (SELECT count(*) FROM fraud_flags f WHERE f.worker_id = w.id AND f.status = 'open')::int AS open_flags
       FROM workers w JOIN users u ON u.id = w.user_id
      WHERE ($1::text IS NULL OR w.kyc_status = $1) AND ($2::text IS NULL OR w.status = $2)
      ORDER BY w.created_at DESC LIMIT $3 OFFSET $4`,
    [q.kyc || null, q.status || null, q.limit, q.offset],
  );
  res.json({ workers: rows });
});

adminRouter.get('/workers/:id', requirePermission('workers.kyc'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { rows } = await query(
    `SELECT w.*, u.name, u.phone_last4, u.status AS user_status FROM workers w JOIN users u ON u.id = w.user_id WHERE w.id = $1`, [id]);
  if (!rows[0]) throw notFound();
  const w = rows[0];
  const [docs, strikes, flags, earnings, acks] = await Promise.all([
    query('SELECT id, doc_type, mime_type, size_bytes, sha256, uploaded_at FROM kyc_documents WHERE worker_id = $1', [id]),
    query('SELECT violation, action_taken, issued_by, created_at FROM strikes WHERE worker_id = $1 ORDER BY created_at DESC', [id]),
    query('SELECT id, flag_type, severity, status, booking_id, created_at FROM fraud_flags WHERE worker_id = $1 ORDER BY created_at DESC LIMIT 50', [id]),
    query(`SELECT status, COALESCE(sum(amount), 0)::bigint AS total FROM payout_items WHERE worker_id = $1 GROUP BY status`, [id]),
    query('SELECT policy_version, acknowledged_at FROM policy_acknowledgements WHERE worker_id = $1 ORDER BY id DESC LIMIT 10', [id]),
  ]);
  delete w.id_number_enc;
  delete w.payout_ref_token;
  res.json({ worker: w, documents: docs.rows, strikes: strikes.rows, flags: flags.rows, earnings: earnings.rows, policyAcks: acks.rows });
});

// Viewing KYC documents is PII access: each view is audited.
adminRouter.get('/workers/:id/documents/:docId', requirePermission('workers.kyc'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const docId = parse(uuid, req.params.docId);
  const { rows } = await query('SELECT * FROM kyc_documents WHERE id = $1 AND worker_id = $2', [docId, id]);
  if (!rows[0]) throw notFound();
  await audit({ query }, { ...actorAudit(req), action: 'kyc.document_viewed', targetTable: 'kyc_documents', targetId: docId, newValue: { workerId: id, docType: rows[0].doc_type } });
  res.set('Content-Type', rows[0].mime_type);
  res.set('Content-Disposition', 'inline');
  res.set('Cache-Control', 'no-store');
  res.send(decryptBuffer(rows[0].content_enc));
});

adminRouter.post('/workers/:id/kyc', requirePermission('workers.kyc'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(300).optional() }).strict(), req.body);
  if (body.decision === 'reject' && !body.reason) throw badRequest('A reason is required when rejecting');
  await tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM workers WHERE id = $1 FOR UPDATE', [id]);
    const w = rows[0];
    if (!w) throw notFound();
    if (w.kyc_status !== 'under_review') throw conflict('KYC is not awaiting review');
    const status = body.decision === 'approve' ? 'approved' : 'rejected';
    await db.query('UPDATE workers SET kyc_status = $2, kyc_rejection_reason = $3, updated_at = now() WHERE id = $1',
      [id, status, body.decision === 'reject' ? body.reason : null]);
    await audit(db, { ...actorAudit(req), action: `worker.kyc_${status}`, targetTable: 'workers', targetId: id,
      oldValue: { kyc_status: w.kyc_status }, newValue: { kyc_status: status, reason: body.reason || null } });
    await notify(db, w.user_id, 'kyc', status === 'approved' ? 'You are approved!' : 'KYC needs attention',
      status === 'approved' ? 'Your account is verified. You can start accepting jobs.' : `Reason: ${body.reason}. Please update and resubmit.`);
  });
  res.json({ ok: true });
});

adminRouter.post('/workers/:id/suspend', requirePermission('workers.enforce'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ days: z.number().int().min(1).max(365).nullable(), reason: z.string().trim().min(3).max(300) }).strict(), req.body);
  await tx(async (db) => {
    const { rows } = await db.query('SELECT status, suspended_until, user_id FROM workers WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw notFound();
    if (rows[0].status === 'deactivated') throw conflict('Worker is deactivated');
    await db.query(
      `UPDATE workers SET status = 'suspended',
              suspended_until = CASE WHEN $2::int IS NULL THEN NULL ELSE now() + ($2::int || ' days')::interval END
        WHERE id = $1`, [id, body.days]);
    await audit(db, { ...actorAudit(req), action: 'worker.suspended', targetTable: 'workers', targetId: id,
      oldValue: { status: rows[0].status }, newValue: { status: 'suspended', days: body.days, reason: body.reason } });
    await notify(db, rows[0].user_id, 'account', 'Account suspended', body.days ? `Your account is suspended for ${body.days} days.` : 'Your account is suspended pending review.');
  });
  res.json({ ok: true });
});

adminRouter.post('/workers/:id/payout-hold', requirePermission('workers.enforce'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ reason: z.string().trim().min(3).max(300) }).strict(), req.body);
  await tx((db) => holdWorkerPayouts(db, id, body.reason, actor(req)));
  res.json({ ok: true });
});

adminRouter.post('/workers/:id/strike', requirePermission('workers.enforce'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({
    violation: z.enum(['cash_demand', 'off_app_diversion', 'minor_mismatch', 'gps_tampering']),
    flagId: uuid.optional(),
  }).strict(), req.body);
  const action = await tx(async (db) => {
    const { rows } = await db.query('SELECT 1 FROM workers WHERE id = $1', [id]);
    if (!rows[0]) throw notFound();
    return applyStrike(db, { workerId: id, violation: body.violation, flagId: body.flagId || null, actor: actor(req) });
  });
  res.json({ ok: true, action });
});

// --------------------------------------------- maker-checker changes
const changeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('commission_rate'), commissionRatePercent: z.number().min(0).max(50).multipleOf(0.01), reason: z.string().trim().min(5).max(500) }).strict(),
  z.object({ kind: z.literal('worker_reactivation'), reason: z.string().trim().min(5).max(500) }).strict(),
  z.object({ kind: z.literal('payout_hold_release'), reason: z.string().trim().min(5).max(500) }).strict(),
]);

adminRouter.post('/workers/:id/change-requests', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(changeSchema, req.body);
  const needed = body.kind === 'commission_rate' ? 'commission.request' : 'workers.enforce';
  if (!req.auth.permissions.includes(needed)) throw forbidden(`Requires permission: ${needed}`);
  const cr = await tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM workers WHERE id = $1', [id]);
    const w = rows[0];
    if (!w) throw notFound();
    let oldValue;
    let newValue;
    if (body.kind === 'commission_rate') {
      oldValue = { commission_rate_bps: w.commission_rate_bps };
      newValue = { commission_rate_bps: Math.round(body.commissionRatePercent * 100) };
    } else if (body.kind === 'worker_reactivation') {
      if (w.status === 'active') throw conflict('Worker is already active');
      oldValue = { status: w.status };
      newValue = { status: 'active' };
    } else {
      if (!w.payout_hold) throw conflict('Worker has no payout hold');
      oldValue = { payout_hold: true, reason: w.payout_hold_reason };
      newValue = { payout_hold: false };
    }
    const { rows: pending } = await db.query(
      `SELECT 1 FROM change_requests WHERE target_id = $1 AND kind = $2 AND status = 'pending'`, [id, body.kind]);
    if (pending[0]) throw conflict('A request of this kind is already pending for this worker');
    const { rows: ins } = await db.query(
      `INSERT INTO change_requests (kind, target_id, old_value, new_value, reason, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [body.kind, id, JSON.stringify(oldValue), JSON.stringify(newValue), body.reason, req.auth.userId]);
    await audit(db, { ...actorAudit(req), action: `change.requested.${body.kind}`, targetTable: 'workers', targetId: id, oldValue, newValue });
    return ins[0];
  });
  res.status(201).json({ changeRequest: cr });
});

adminRouter.get('/change-requests', async (req, res) => {
  if (!req.auth.permissions.some((p) => ['changes.approve', 'commission.request', 'workers.enforce'].includes(p))) throw forbidden();
  const q = parse(z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }), req.query);
  const { rows } = await query(
    `SELECT cr.*, ru.name AS requested_by_name, wu.name AS worker_name
       FROM change_requests cr JOIN users ru ON ru.id = cr.requested_by
       LEFT JOIN workers w ON w.id = cr.target_id LEFT JOIN users wu ON wu.id = w.user_id
      WHERE cr.status = $1 ORDER BY cr.created_at DESC LIMIT 100`, [q.status]);
  res.json({ changeRequests: rows });
});

adminRouter.post('/change-requests/:id/decision', requirePermission('changes.approve'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ approve: z.boolean() }).strict(), req.body);
  await tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM change_requests WHERE id = $1 FOR UPDATE', [id]);
    const cr = rows[0];
    if (!cr) throw notFound();
    if (cr.status !== 'pending') throw conflict('Already decided');
    if (cr.requested_by === req.auth.userId) throw forbidden('You cannot approve your own request');
    await db.query('UPDATE change_requests SET status = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1',
      [id, body.approve ? 'approved' : 'rejected', req.auth.userId]);
    if (body.approve) {
      if (cr.kind === 'commission_rate') {
        await db.query('UPDATE workers SET commission_rate_bps = $2, updated_at = now() WHERE id = $1', [cr.target_id, cr.new_value.commission_rate_bps]);
      } else if (cr.kind === 'worker_reactivation') {
        const { rows: w } = await db.query(
          `UPDATE workers SET status = 'active', suspended_until = NULL WHERE id = $1 RETURNING user_id`, [cr.target_id]);
        await db.query(`UPDATE users SET status = 'active' WHERE id = $1 AND status IN ('deactivated', 'suspended')`, [w[0].user_id]);
        await notify(db, w[0].user_id, 'account', 'Account reactivated', 'Please re-read and accept the platform policy before taking jobs.');
        await db.query('UPDATE workers SET policy_ack_version = NULL WHERE id = $1', [cr.target_id]);
      } else if (cr.kind === 'payout_hold_release') {
        await db.query(`UPDATE workers SET payout_hold = false, payout_hold_reason = NULL WHERE id = $1`, [cr.target_id]);
      }
    }
    await audit(db, { ...actorAudit(req), action: `change.${body.approve ? 'approved' : 'rejected'}.${cr.kind}`,
      targetTable: 'workers', targetId: cr.target_id, oldValue: cr.old_value, newValue: body.approve ? cr.new_value : null });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------- customers
adminRouter.get('/customers', requirePermission('customers.view'), async (req, res) => {
  const q = parse(pageSchema.extend({ phone: z.string().max(20).optional() }), req.query);
  const phoneHash = q.phone ? lookupHash(normalizeIndianMobile(q.phone)) : null;
  const { rows } = await query(
    `SELECT u.id, u.name, u.phone_last4, u.status, u.created_at,
            (SELECT count(*) FROM bookings b WHERE b.customer_id = u.id)::int AS bookings,
            (SELECT count(*) FROM disputes d JOIN bookings b ON b.id = d.booking_id WHERE b.customer_id = u.id)::int AS disputes
       FROM users u WHERE u.role = 'customer' AND ($1::bytea IS NULL OR u.phone_hash = $1)
      ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`,
    [phoneHash, q.limit, q.offset]);
  res.json({ customers: rows });
});

adminRouter.get('/customers/:id', requirePermission('customers.view'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { rows } = await query(`SELECT id, name, email, phone_last4, status, created_at FROM users WHERE id = $1 AND role = 'customer'`, [id]);
  if (!rows[0]) throw notFound();
  const { rows: bookings } = await query(
    `SELECT b.id, b.status, b.amount, b.scheduled_time, s.name AS service_name FROM bookings b JOIN services s ON s.id = b.service_id
      WHERE b.customer_id = $1 ORDER BY b.created_at DESC LIMIT 100`, [id]);
  res.json({ customer: rows[0], bookings });
});

adminRouter.post('/customers/:id/status', requirePermission('customers.view'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().min(3).max(300) }).strict(), req.body);
  await tx(async (db) => {
    const { rows } = await db.query(`SELECT status FROM users WHERE id = $1 AND role = 'customer' FOR UPDATE`, [id]);
    if (!rows[0] || rows[0].status === 'deleted') throw notFound();
    await db.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [id, body.status]);
    if (body.status === 'suspended') await revokeAllForUser(db, id, 'suspended');
    await audit(db, { ...actorAudit(req), action: 'customer.status_changed', targetTable: 'users', targetId: id,
      oldValue: { status: rows[0].status }, newValue: body });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------- payouts
adminRouter.get('/payout-batches', async (req, res) => {
  if (!req.auth.permissions.some((p) => ['payouts.prepare', 'payouts.approve'].includes(p))) throw forbidden();
  const { rows } = await query(
    `SELECT pb.*, pu.name AS prepared_by_name,
            (SELECT json_agg(json_build_object('adminId', a.admin_id, 'name', u.name, 'at', a.created_at))
               FROM payout_batch_approvals a JOIN users u ON u.id = a.admin_id WHERE a.batch_id = pb.id) AS approvals,
            (SELECT count(*) FROM payouts p WHERE p.batch_id = pb.id)::int AS payouts
       FROM payout_batches pb JOIN users pu ON pu.id = pb.prepared_by ORDER BY pb.week_start DESC LIMIT 52`);
  const { rows: queue } = await query(
    `SELECT status, COALESCE(sum(amount), 0)::bigint AS total, count(*)::int AS n FROM payout_items GROUP BY status`);
  res.json({ batches: rows, queue, twoPersonThreshold: config.payoutTwoPersonThresholdPaise });
});

adminRouter.get('/payout-batches/:id', async (req, res) => {
  if (!req.auth.permissions.some((p) => ['payouts.prepare', 'payouts.approve'].includes(p))) throw forbidden();
  const id = parse(uuid, req.params.id);
  const { rows } = await query(
    `SELECT p.*, u.name AS worker_name, w.payout_masked,
            (SELECT count(*) FROM payout_items pi WHERE pi.payout_id = p.id)::int AS jobs
       FROM payouts p JOIN workers w ON w.id = p.worker_id JOIN users u ON u.id = w.user_id
      WHERE p.batch_id = $1 ORDER BY p.total_amount DESC`, [id]);
  if (req.query.format === 'csv') {
    await audit({ query }, { ...actorAudit(req), action: 'payout.batch_exported', targetTable: 'payout_batches', targetId: id });
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
    const lines = [['payout_id', 'worker', 'account', 'jobs', 'amount_inr', 'status', 'utr'].join(',')];
    for (const r of rows) {
      lines.push([r.id, r.worker_name, r.payout_masked, r.jobs, (r.total_amount / 100).toFixed(2), r.status, r.utr_number].map(esc).join(','));
    }
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="payout-batch-${id}.csv"`);
    res.send(lines.join('\n'));
    return;
  }
  res.json({ payouts: rows });
});

adminRouter.post('/payout-batches', requirePermission('payouts.prepare'), async (req, res) => {
  const body = parse(z.object({ weekStart: z.iso.date() }).strict(), req.body);
  const batch = await tx((db) => prepareBatch(db, { adminId: req.auth.userId, weekStart: body.weekStart, ip: req.ip }));
  res.status(201).json({ batch });
});

adminRouter.post('/payout-batches/:id/approve', requirePermission('payouts.approve'), async (req, res) => {
  const out = await tx((db) => approveBatch(db, { batchId: parse(uuid, req.params.id), adminId: req.auth.userId, ip: req.ip }));
  res.json(out);
});

adminRouter.post('/payout-batches/:id/release', requirePermission('payouts.approve'), async (req, res) => {
  const results = await releaseBatch({ batchId: parse(uuid, req.params.id), adminId: req.auth.userId, ip: req.ip });
  res.json({ results });
});

adminRouter.post('/payout-batches/:id/cancel', async (req, res) => {
  if (!req.auth.permissions.some((p) => ['payouts.prepare', 'payouts.approve'].includes(p))) throw forbidden();
  await tx((db) => cancelBatch(db, { batchId: parse(uuid, req.params.id), adminId: req.auth.userId, ip: req.ip }));
  res.json({ ok: true });
});

// ---------------------------------------------------------- disputes
adminRouter.get('/disputes', requirePermission('disputes.manage'), async (req, res) => {
  const q = parse(z.object({ status: z.enum(['open', 'resolved', 'rejected']).default('open') }), req.query);
  const { rows } = await query(
    `SELECT d.*, b.amount, b.status AS booking_status, s.name AS service_name, cu.name AS customer_name, wu.name AS worker_name
       FROM disputes d JOIN bookings b ON b.id = d.booking_id JOIN services s ON s.id = b.service_id
       JOIN users cu ON cu.id = b.customer_id LEFT JOIN workers w ON w.id = b.worker_id LEFT JOIN users wu ON wu.id = w.user_id
      WHERE d.status = $1 ORDER BY d.created_at LIMIT 200`, [q.status]);
  res.json({ disputes: rows });
});

adminRouter.post('/disputes/:id/resolve', requirePermission('disputes.manage'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({
    outcome: z.enum(['worker_favour', 'refund_full', 'refund_partial']),
    amountPaise: z.number().int().positive().optional(),
    resolution: z.string().trim().min(5).max(1000),
  }).strict(), req.body);
  const out = await tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM disputes WHERE id = $1 FOR UPDATE', [id]);
    const d = rows[0];
    if (!d) throw notFound();
    if (d.status !== 'open') throw conflict('Dispute already resolved');
    const b = await lockBooking(db, d.booking_id);
    let refund = null;
    // A refund-in-full keeps the booking disputed until the (separately
    // approved) refund is processed; other outcomes restore it.
    const restoreTo = d.previous_booking_status === 'in_progress' ? 'completed' : d.previous_booking_status;
    if (body.outcome === 'worker_favour') {
      await transition(db, b, restoreTo === 'confirmed' ? 'confirmed' : 'completed', { actorId: req.auth.userId, actorRole: 'admin', meta: { disputeId: id } });
      await db.query(`UPDATE payout_items SET status = 'pending', hold_reason = NULL WHERE booking_id = $1 AND status = 'held' AND hold_reason = 'Open dispute'`, [b.id]);
    } else {
      const amount = body.outcome === 'refund_full' ? await refundableForBooking(db, b.id) : body.amountPaise;
      if (!amount) throw badRequest('amountPaise is required for a partial refund');
      if (body.outcome === 'refund_partial' && amount >= b.amount) throw badRequest('Use refund_full for the whole amount');
      refund = await createRefundRequest(db, { bookingId: b.id, amount, reason: `Dispute: ${body.resolution}`, disputeId: id, requestedBy: req.auth.userId });
      if (body.outcome === 'refund_partial') {
        await transition(db, b, restoreTo === 'confirmed' ? 'confirmed' : 'completed', { actorId: req.auth.userId, actorRole: 'admin', meta: { disputeId: id, partialRefund: amount } });
        await db.query(`UPDATE payout_items SET hold_reason = $2 WHERE booking_id = $1 AND status = 'held'`, [b.id, REFUND_PENDING]);
      }
    }
    await db.query(`UPDATE disputes SET status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now() WHERE id = $1`,
      [id, `${body.outcome}: ${body.resolution}`, req.auth.userId]);
    await audit(db, { ...actorAudit(req), action: 'dispute.resolved', targetTable: 'disputes', targetId: id,
      newValue: { outcome: body.outcome, refundRequestId: refund?.id || null } });
    await notify(db, b.customer_id, 'dispute', 'Your issue has been resolved', body.resolution.slice(0, 200));
    return refund;
  });
  res.json({ ok: true, refundRequestId: out?.id || null });
});

// ---------------------------------------------------------- refunds
adminRouter.get('/refund-requests', async (req, res) => {
  if (!req.auth.permissions.some((p) => ['refunds.approve', 'disputes.manage'].includes(p))) throw forbidden();
  const q = parse(z.object({ status: z.enum(['requested', 'approved', 'rejected', 'processed', 'failed']).default('requested') }), req.query);
  const { rows } = await query(
    `SELECT r.*, u.name AS requested_by_name, b.amount AS booking_amount FROM refund_requests r
       LEFT JOIN users u ON u.id = r.requested_by JOIN bookings b ON b.id = r.booking_id
      WHERE r.status = $1 ORDER BY r.created_at LIMIT 200`, [q.status]);
  res.json({ refundRequests: rows });
});

adminRouter.post('/refund-requests/:id/decision', requirePermission('refunds.approve'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ approve: z.boolean() }).strict(), req.body);
  await tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM refund_requests WHERE id = $1 FOR UPDATE', [id]);
    const r = rows[0];
    if (!r) throw notFound();
    if (r.status !== 'requested') throw conflict('Already decided');
    if (r.requested_by === req.auth.userId) throw forbidden('You cannot approve a refund you requested');
    await db.query('UPDATE refund_requests SET status = $2, approved_by = $3 WHERE id = $1',
      [id, body.approve ? 'approved' : 'rejected', req.auth.userId]);
    if (!body.approve) {
      await db.query(
        `UPDATE payout_items SET status = 'pending', hold_reason = NULL WHERE booking_id = $1 AND status = 'held' AND hold_reason = $2`,
        [r.booking_id, REFUND_PENDING]);
      // A rejected full refund on a disputed booking restores it.
      const b = await lockBooking(db, r.booking_id);
      if (b.status === 'disputed') {
        const { rows: d } = await db.query('SELECT previous_booking_status FROM disputes WHERE id = $1', [r.dispute_id]);
        const restoreTo = d[0]?.previous_booking_status === 'confirmed' ? 'confirmed' : 'completed';
        await transition(db, b, restoreTo, { actorId: req.auth.userId, actorRole: 'admin', meta: { refundRejected: id } });
        await db.query(`UPDATE payout_items SET status = 'pending', hold_reason = NULL WHERE booking_id = $1 AND status = 'held' AND hold_reason = 'Open dispute'`, [b.id]);
      }
    }
    await audit(db, { ...actorAudit(req), action: `refund.${body.approve ? 'approved' : 'rejected'}`, targetTable: 'refund_requests',
      targetId: id, newValue: { amount: r.amount, bookingId: r.booking_id } });
  });
  const result = body.approve ? await processApprovedRefund(id) : null;
  res.json({ ok: true, result });
});

// ---------------------------------------------------------- fraud queue
const SEVERITY_ORDER = `CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

adminRouter.get('/fraud-flags', requirePermission('fraud.review'), async (req, res) => {
  const q = parse(pageSchema.extend({ status: z.enum(['open', 'confirmed', 'dismissed']).default('open') }), req.query);
  const { rows } = await query(
    `SELECT f.*, wu.name AS worker_name, cu.name AS customer_name
       FROM fraud_flags f LEFT JOIN workers w ON w.id = f.worker_id LEFT JOIN users wu ON wu.id = w.user_id
       LEFT JOIN users cu ON cu.id = f.customer_id
      WHERE f.status = $1 ORDER BY ${SEVERITY_ORDER}, f.created_at LIMIT $2 OFFSET $3`,
    [q.status, q.limit, q.offset]);
  res.json({ flags: rows });
});

adminRouter.post('/fraud-flags/:id/review', requirePermission('fraud.review'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({
    decision: z.enum(['confirm', 'dismiss']),
    violation: z.enum(['cash_demand', 'off_app_diversion', 'minor_mismatch', 'gps_tampering']).optional(),
    releaseBookingPayout: z.boolean().default(false),
    note: z.string().trim().min(3).max(1000),
  }).strict(), req.body);
  const out = await tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM fraud_flags WHERE id = $1 FOR UPDATE', [id]);
    const f = rows[0];
    if (!f) throw notFound();
    if (f.status !== 'open') throw conflict('Flag already reviewed');
    await db.query(`UPDATE fraud_flags SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1`,
      [id, body.decision === 'confirm' ? 'confirmed' : 'dismissed', req.auth.userId, body.note]);
    let action = null;
    if (body.decision === 'confirm' && body.violation) {
      if (!f.worker_id) throw badRequest('This flag is not tied to a worker');
      action = await applyStrike(db, { workerId: f.worker_id, violation: body.violation, flagId: id, actor: actor(req) });
    }
    // A dismissed mismatch can release that booking's held payout (and
    // marks the booking reconciled, as a human has now verified it).
    if (body.decision === 'dismiss' && body.releaseBookingPayout && f.booking_id) {
      const { rows: other } = await db.query(
        `SELECT 1 FROM fraud_flags WHERE booking_id = $1 AND status = 'open' AND id <> $2 LIMIT 1`, [f.booking_id, id]);
      if (other[0]) throw conflict('Other open flags exist on this booking; review them first');
      await db.query(`UPDATE payout_items SET status = 'pending', hold_reason = NULL WHERE booking_id = $1 AND status = 'held' AND hold_reason LIKE 'Reconciliation mismatch%'`, [f.booking_id]);
      await db.query(`UPDATE bookings SET reconciliation_status = 'clean', reconciled_at = now() WHERE id = $1 AND reconciliation_status = 'mismatch'`, [f.booking_id]);
    }
    await audit(db, { ...actorAudit(req), action: `fraud.flag_${body.decision}ed`, targetTable: 'fraud_flags', targetId: id,
      newValue: { violation: body.violation || null, action, note: body.note, releasedPayout: body.releaseBookingPayout } });
    return action;
  });
  res.json({ ok: true, action: out });
});

// ---------------------------------------------------------- catalogue
const serviceSchema = z.object({
  name: z.string().trim().min(3).max(100),
  category: z.enum(['cleaning', 'repairs', 'ac_service', 'pest_control', 'tutoring', 'plumbing', 'electrical', 'appliance_repair']),
  fixedPricePaise: z.number().int().min(100).max(10_000_000),
  durationMinutes: z.number().int().min(15).max(600),
  description: z.string().trim().max(2000).default(''),
  urgentPremiumPercent: z.number().min(0).max(100).default(25),
  active: z.boolean().default(true),
}).strict();

adminRouter.get('/services', requirePermission('catalog.manage'), async (_req, res) => {
  const { rows } = await query('SELECT * FROM services ORDER BY category, name');
  res.json({ services: rows });
});

adminRouter.post('/services', requirePermission('catalog.manage'), async (req, res) => {
  const b = parse(serviceSchema, req.body);
  const out = await tx(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO services (name, category, fixed_price_paise, duration_minutes, description, urgent_premium_bps, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [b.name, b.category, b.fixedPricePaise, b.durationMinutes, b.description, Math.round(b.urgentPremiumPercent * 100), b.active]);
    await audit(db, { ...actorAudit(req), action: 'service.created', targetTable: 'services', targetId: rows[0].id, newValue: rows[0] });
    return rows[0];
  });
  res.status(201).json({ service: out });
});

adminRouter.patch('/services/:id', requirePermission('catalog.manage'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const b = parse(serviceSchema.partial(), req.body);
  const out = await tx(async (db) => {
    const { rows: before } = await db.query('SELECT * FROM services WHERE id = $1 FOR UPDATE', [id]);
    if (!before[0]) throw notFound();
    const { rows } = await db.query(
      `UPDATE services SET name = COALESCE($2, name), category = COALESCE($3, category),
              fixed_price_paise = COALESCE($4, fixed_price_paise), duration_minutes = COALESCE($5, duration_minutes),
              description = COALESCE($6, description), urgent_premium_bps = COALESCE($7, urgent_premium_bps),
              active = COALESCE($8, active), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, b.name ?? null, b.category ?? null, b.fixedPricePaise ?? null, b.durationMinutes ?? null, b.description ?? null,
        b.urgentPremiumPercent === undefined ? null : Math.round(b.urgentPremiumPercent * 100), b.active ?? null]);
    await audit(db, { ...actorAudit(req), action: 'service.updated', targetTable: 'services', targetId: id, oldValue: before[0], newValue: rows[0] });
    return rows[0];
  });
  res.json({ service: out });
});

// ---------------------------------------------------------- reports
adminRouter.get('/reports', requirePermission('reports.view'), async (req, res) => {
  const q = parse(z.object({ from: z.iso.date(), to: z.iso.date() }), req.query);
  const range = [q.from, q.to];
  const where = `confirmed_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata' AND confirmed_at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`;
  const [totals, byService, byStatus, cash, top, bottom, flags] = await Promise.all([
    query(`SELECT count(*)::int AS jobs, COALESCE(sum(amount), 0)::bigint AS gmv, COALESCE(sum(commission_amount), 0)::bigint AS commission,
                  COALESCE(sum(worker_payout), 0)::bigint AS worker_earnings FROM bookings WHERE status = 'confirmed' AND ${where}`, range),
    query(`SELECT s.name, count(*)::int AS jobs, sum(b.amount)::bigint AS gmv, sum(b.commission_amount)::bigint AS commission
             FROM bookings b JOIN services s ON s.id = b.service_id WHERE b.status = 'confirmed' AND ${where.replaceAll('confirmed_at', 'b.confirmed_at')}
            GROUP BY s.name ORDER BY gmv DESC`, range),
    query(`SELECT status, count(*)::int AS n FROM bookings WHERE created_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
             AND created_at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata' GROUP BY status`, range),
    query(`SELECT
             (SELECT count(DISTINCT booking_id) FROM cash_reports WHERE created_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
                AND created_at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')::int AS cash_reports,
             (SELECT count(*) FROM bookings WHERE status IN ('completed', 'confirmed') AND completed_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
                AND completed_at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')::int AS completed_jobs`, range),
    query(`SELECT w.id, u.name, w.rating_avg, w.rating_count, w.total_jobs FROM workers w JOIN users u ON u.id = w.user_id
            WHERE w.kyc_status = 'approved' AND w.rating_count >= 3 ORDER BY w.rating_avg DESC, w.total_jobs DESC LIMIT 10`),
    query(`SELECT w.id, u.name, w.rating_avg, w.rating_count, w.total_jobs, w.strikes FROM workers w JOIN users u ON u.id = w.user_id
            WHERE w.kyc_status = 'approved' AND w.rating_count >= 3 ORDER BY w.rating_avg ASC, w.strikes DESC LIMIT 10`),
    query(`SELECT flag_type, count(*)::int AS n FROM fraud_flags WHERE created_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata'
             AND created_at < ($2::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata' GROUP BY flag_type ORDER BY n DESC`, range),
  ]);
  const c = cash.rows[0];
  res.json({
    totals: totals.rows[0],
    byService: byService.rows,
    bookingsByStatus: byStatus.rows,
    cashComplaintRatePercent: c.completed_jobs ? Math.round((c.cash_reports / c.completed_jobs) * 10000) / 100 : 0,
    cashReports: c.cash_reports,
    completedJobs: c.completed_jobs,
    topWorkers: top.rows,
    bottomWorkers: bottom.rows,
    flagsByType: flags.rows,
  });
});

// ---------------------------------------------------------- audit
adminRouter.get('/audit-logs', requirePermission('audit.view'), async (req, res) => {
  const q = parse(pageSchema.extend({ targetId: z.string().max(64).optional(), actorId: uuid.optional(), action: z.string().max(80).optional() }), req.query);
  const { rows } = await query(
    `SELECT a.*, u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
      WHERE ($1::text IS NULL OR a.target_id = $1) AND ($2::uuid IS NULL OR a.actor_id = $2)
        AND ($3::text IS NULL OR a.action LIKE $3 || '%')
      ORDER BY a.id DESC LIMIT $4 OFFSET $5`,
    [q.targetId || null, q.actorId || null, q.action || null, q.limit, q.offset]);
  res.json({ logs: rows });
});

adminRouter.get('/audit-logs/verify', requirePermission('audit.view'), async (_req, res) => {
  res.json(await verifyAuditChain({ query }));
});

adminRouter.get('/login-attempts', requirePermission('audit.view'), async (_req, res) => {
  const { rows } = await query('SELECT * FROM admin_login_attempts ORDER BY id DESC LIMIT 200');
  res.json({ attempts: rows });
});

// ---------------------------------------------------------- admins
adminRouter.get('/admins', async (req, res) => {
  if (!req.auth.permissions.some((p) => ['admins.manage', 'changes.approve'].includes(p))) throw forbidden();
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.status, a.permissions, a.pending_permissions, a.pending_requested_by,
            a.totp_enabled, a.last_login_at, a.access_reviewed_at, a.locked_until
       FROM users u JOIN admin_accounts a ON a.user_id = u.id ORDER BY u.created_at`);
  res.json({ admins: rows, accessReviewDueDays: 90 });
});

adminRouter.post('/admins', requirePermission('admins.manage'), async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2).max(80),
    email: z.email().max(200),
    temporaryPassword: z.string().max(200),
    permissions: z.array(z.string()).min(1).max(20),
  }).strict(), req.body);
  const weak = validatePasswordStrength(b.temporaryPassword);
  if (weak) throw badRequest(weak);
  const permErr = validatePermissionSet(b.permissions);
  if (permErr) throw badRequest(permErr);
  const out = await tx(async (db) => {
    const { rows: exists } = await db.query(`SELECT 1 FROM users WHERE role = 'admin' AND lower(email) = lower($1)`, [b.email]);
    if (exists[0]) throw conflict('An admin with that email exists');
    const { rows } = await db.query(`INSERT INTO users (role, name, email) VALUES ('admin', $1, lower($2)) RETURNING id`, [b.name, b.email]);
    // The account starts with no access; a second admin must approve the grant.
    await db.query(
      `INSERT INTO admin_accounts (user_id, password_hash, permissions, pending_permissions, pending_requested_by, created_by)
       VALUES ($1, $2, '{}', $3, $4, $4)`,
      [rows[0].id, await argon2.hash(b.temporaryPassword, ARGON_OPTS), b.permissions, req.auth.userId]);
    await audit(db, { ...actorAudit(req), action: 'admin.created', targetTable: 'users', targetId: rows[0].id, newValue: { email: b.email, requestedPermissions: b.permissions } });
    return rows[0].id;
  });
  res.status(201).json({ id: out, pendingApproval: true });
});

adminRouter.patch('/admins/:id', requirePermission('admins.manage'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  if (id === req.auth.userId) throw forbidden('You cannot change your own access');
  const b = parse(z.object({ permissions: z.array(z.string()).max(20).optional(), status: z.enum(['active', 'deactivated']).optional() }).strict(), req.body);
  if (b.permissions) {
    const permErr = validatePermissionSet(b.permissions);
    if (permErr) throw badRequest(permErr);
  }
  const out = await tx(async (db) => {
    const { rows } = await db.query(
      `SELECT u.status, a.permissions FROM users u JOIN admin_accounts a ON a.user_id = u.id WHERE u.id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) throw notFound();
    let pending = false;
    if (b.permissions) {
      // Removing access applies immediately; any new grant needs a second admin.
      const adds = b.permissions.filter((p) => !rows[0].permissions.includes(p));
      if (adds.length === 0) {
        await db.query('UPDATE admin_accounts SET permissions = $2, pending_permissions = NULL, pending_requested_by = NULL WHERE user_id = $1', [id, b.permissions]);
      } else {
        pending = true;
        await db.query('UPDATE admin_accounts SET pending_permissions = $2, pending_requested_by = $3 WHERE user_id = $1', [id, b.permissions, req.auth.userId]);
      }
      await revokeAllForUser(db, id, 'permissions_changed');
    }
    if (b.status) {
      if (b.status === 'active' && rows[0].status !== 'active') {
        // Reactivating restores access: route it through approval too.
        await db.query(
          `UPDATE admin_accounts SET pending_permissions = permissions, pending_requested_by = $2, permissions = '{}' WHERE user_id = $1`,
          [id, req.auth.userId]);
        pending = true;
      }
      await db.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [id, b.status]);
      if (b.status === 'deactivated') await revokeAllForUser(db, id, 'admin_deactivated');
    }
    await audit(db, { ...actorAudit(req), action: pending ? 'admin.access_change_requested' : 'admin.access_changed', targetTable: 'users', targetId: id, oldValue: rows[0], newValue: b });
    return pending;
  });
  res.json({ ok: true, pendingApproval: out });
});

adminRouter.post('/admins/:id/approve-access', requirePermission('changes.approve'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ approve: z.boolean() }).strict(), req.body);
  if (id === req.auth.userId) throw forbidden('You cannot approve your own access');
  await tx(async (db) => {
    const { rows } = await db.query('SELECT permissions, pending_permissions, pending_requested_by FROM admin_accounts WHERE user_id = $1 FOR UPDATE', [id]);
    const a = rows[0];
    if (!a || !a.pending_permissions) throw conflict('No access change is pending');
    if (a.pending_requested_by === req.auth.userId) throw forbidden('A different admin must approve this access change');
    const permErr = validatePermissionSet(a.pending_permissions);
    if (permErr) throw badRequest(permErr);
    if (body.approve) {
      await db.query('UPDATE admin_accounts SET permissions = pending_permissions, pending_permissions = NULL, pending_requested_by = NULL WHERE user_id = $1', [id]);
    } else {
      await db.query('UPDATE admin_accounts SET pending_permissions = NULL, pending_requested_by = NULL WHERE user_id = $1', [id]);
    }
    await audit(db, { ...actorAudit(req), action: `admin.access_${body.approve ? 'approved' : 'rejected'}`, targetTable: 'users', targetId: id,
      oldValue: { permissions: a.permissions }, newValue: { permissions: body.approve ? a.pending_permissions : a.permissions, requestedBy: a.pending_requested_by } });
  });
  res.json({ ok: true });
});

adminRouter.post('/admins/:id/reset-2fa', requirePermission('admins.manage'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  if (id === req.auth.userId) throw forbidden('You cannot reset your own 2FA');
  await tx(async (db) => {
    await db.query('UPDATE admin_accounts SET totp_enabled = false, totp_secret_enc = NULL, last_totp_step = NULL WHERE user_id = $1', [id]);
    await revokeAllForUser(db, id, '2fa_reset');
    await audit(db, { ...actorAudit(req), action: 'admin.2fa_reset', targetTable: 'users', targetId: id });
  });
  res.json({ ok: true });
});

// Section 9.8: quarterly access review.
adminRouter.post('/admins/:id/access-reviewed', requirePermission('admins.manage'), async (req, res) => {
  const id = parse(uuid, req.params.id);
  await tx(async (db) => {
    await db.query('UPDATE admin_accounts SET access_reviewed_at = now() WHERE user_id = $1', [id]);
    await audit(db, { ...actorAudit(req), action: 'admin.access_reviewed', targetTable: 'users', targetId: id });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------- jobs
adminRouter.get('/jobs', requirePermission('fraud.review'), async (_req, res) => {
  const { rows } = await query('SELECT * FROM job_runs ORDER BY id DESC LIMIT 50');
  res.json({ runs: rows, jobs: Object.keys(JOBS) });
});

adminRouter.post('/jobs/:name/run', requirePermission('fraud.review'), async (req, res) => {
  const name = parse(z.enum(Object.keys(JOBS)), req.params.name);
  await audit({ query }, { ...actorAudit(req), action: 'job.manual_run', targetTable: 'job_runs', targetId: name });
  res.json(await runJob(name));
});

