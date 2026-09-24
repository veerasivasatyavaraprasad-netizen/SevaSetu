import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { verifyAuditChain } from '../src/services/audit.js';
import { runJob } from '../src/services/jobs.js';
import { istWeekStart, addDays } from '../src/services/payouts.js';
import {
  AT_ADDRESS, adminLogin, api, auth, createAdmin, customer, onboardedWorker, paidBooking, resetDb,
} from './helpers.js';

let preparer;
let approverA;
let approverB;
let risk;
let ops;
let finance2;

beforeAll(async () => {
  await resetDb();
  await createAdmin('prep@example.com', ['payouts.prepare', 'reports.view']);
  await createAdmin('appr1@example.com', ['payouts.approve']);
  await createAdmin('appr2@example.com', ['payouts.approve']);
  await createAdmin('risk@example.com', ['fraud.review', 'workers.enforce', 'commission.request', 'audit.view']);
  await createAdmin('ops@example.com', ['changes.approve', 'disputes.manage', 'bookings.manage', 'workers.kyc']);
  await createAdmin('fin2@example.com', ['refunds.approve']);
  preparer = await adminLogin('prep@example.com');
  approverA = await adminLogin('appr1@example.com');
  approverB = await adminLogin('appr2@example.com');
  risk = await adminLogin('risk@example.com');
  ops = await adminLogin('ops@example.com');
  finance2 = await adminLogin('fin2@example.com');
});

let slotDay = 3;
async function completedJob({ c, w, confirm = true, gps = AT_ADDRESS }) {
  slotDay += 1;
  const id = await paidBooking(c, { daysAhead: slotDay });
  await api().post(`/api/worker/jobs/${id}/accept`).set(auth(w.token)).expect(200);
  await query(`UPDATE bookings SET scheduled_time = now() + interval '30 minutes' WHERE id = $1`, [id]);
  await api().post(`/api/worker/jobs/${id}/checkin`).set(auth(w.token)).send(gps).expect(200);
  const v = await api().get(`/api/bookings/${id}`).set(auth(c.token)).expect(200);
  await api().post(`/api/worker/jobs/${id}/complete`).set(auth(w.token)).send({ otp: v.body.booking.completionOtp, ...AT_ADDRESS }).expect(200);
  if (confirm) await api().post(`/api/bookings/${id}/confirm`).set(auth(c.token)).expect(200);
  return id;
}

describe('separation of duties (Section 9.8)', () => {
  it('rejects conflicting permission sets', async () => {
    await createAdmin('boss@example.com', ['admins.manage']);
    const boss = await adminLogin('boss@example.com');
    const res = await api().post('/api/admin/admins').set(auth(boss)).send({
      name: 'Bad', email: 'bad@example.com', temporaryPassword: 'An0ther!Strong#1', permissions: ['payouts.approve', 'commission.request'],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Separation of duties/);
    await api().patch(`/api/admin/admins/${(await query(`SELECT id FROM users WHERE email='boss@example.com'`)).rows[0].id}`)
      .set(auth(boss)).send({ permissions: ['admins.manage', 'audit.view'] }).expect(403);
  });

  it('new admin access needs approval from a second admin', async () => {
    const boss = await adminLogin('boss@example.com');
    const created = await api().post('/api/admin/admins').set(auth(boss)).send({
      name: 'Sock Puppet', email: 'puppet@example.com', temporaryPassword: 'An0ther!Strong#1', permissions: ['payouts.approve'],
    }).expect(201);
    expect(created.body.pendingApproval).toBe(true);
    const { rows } = await query('SELECT permissions FROM admin_accounts WHERE user_id = $1', [created.body.id]);
    expect(rows[0].permissions).toEqual([]);
    // The requester can't approve their own grant.
    await api().post(`/api/admin/admins/${created.body.id}/approve-access`).set(auth(boss)).send({ approve: true }).expect(403);
    await createAdmin('boss2@example.com', ['changes.approve']);
    const boss2 = await adminLogin('boss2@example.com');
    await api().post(`/api/admin/admins/${created.body.id}/approve-access`).set(auth(boss2)).send({ approve: true }).expect(200);
    const after = await query('SELECT permissions FROM admin_accounts WHERE user_id = $1', [created.body.id]);
    expect(after.rows[0].permissions).toEqual(['payouts.approve']);
  });

  it('commission changes need a second admin (maker-checker)', async () => {
    const w = await onboardedWorker();
    const cr = await api().post(`/api/admin/workers/${w.workerId}/change-requests`).set(auth(risk))
      .send({ kind: 'commission_rate', commissionRatePercent: 15, reason: 'Top performer retention' }).expect(201);
    // Requester cannot approve (even if they had the permission)...
    await api().post(`/api/admin/change-requests/${cr.body.changeRequest.id}/decision`).set(auth(risk)).send({ approve: true }).expect(403);
    // ...a different admin with changes.approve can.
    await api().post(`/api/admin/change-requests/${cr.body.changeRequest.id}/decision`).set(auth(ops)).send({ approve: true }).expect(200);
    const { rows } = await query('SELECT commission_rate_bps FROM workers WHERE id = $1', [w.workerId]);
    expect(rows[0].commission_rate_bps).toBe(1500);
  });
});

describe('weekly payouts with reconciliation gate and two-person approval', () => {
  it('pays only reconciled-clean jobs; mismatches are held for review', async () => {
    const c = await customer();
    const w = await onboardedWorker();
    const clean = await completedJob({ c, w });
    const dirty = await completedJob({ c, w });
    // Simulate a job whose GPS check-in record is missing.
    await query(`DELETE FROM gps_pings WHERE booking_id = $1 AND kind = 'checkin'`, [dirty]);

    await runJob('reconciliation');
    const { rows } = await query(
      `SELECT booking_id, status FROM payout_items WHERE booking_id = ANY($1)`, [[clean, dirty]]);
    const byId = Object.fromEntries(rows.map((r) => [r.booking_id, r.status]));
    expect(byId[clean]).toBe('pending');
    expect(byId[dirty]).toBe('held');
    const flags = await query(`SELECT flag_type FROM fraud_flags WHERE booking_id = $1`, [dirty]);
    expect(flags.rows.map((f) => f.flag_type)).toContain('gps_mismatch');

    // Put the confirmations in last week so the batch can include them.
    const lastMonday = addDays(istWeekStart(new Date()), -7);
    await query(`UPDATE bookings SET confirmed_at = ($1::date + 2)::timestamp AT TIME ZONE 'Asia/Kolkata' WHERE id = ANY($2)`, [lastMonday, [clean, dirty]]);
    // Make it large enough to need two approvers.
    await query(`UPDATE payout_items SET amount = 6000000 WHERE booking_id = $1`, [clean]);

    const batch = await api().post('/api/admin/payout-batches').set(auth(preparer)).send({ weekStart: lastMonday }).expect(201);
    expect(batch.body.batch.total_amount).toBe(6000000);
    expect(batch.body.batch.required_approvals).toBe(2);
    const bid = batch.body.batch.id;

    // Preparer lacks payouts.approve entirely; the DB would also block them.
    await api().post(`/api/admin/payout-batches/${bid}/approve`).set(auth(preparer)).expect(403);
    const a1 = await api().post(`/api/admin/payout-batches/${bid}/approve`).set(auth(approverA)).expect(200);
    expect(a1.body.status).toBe('draft');
    await api().post(`/api/admin/payout-batches/${bid}/approve`).set(auth(approverA)).expect(409);
    await api().post(`/api/admin/payout-batches/${bid}/release`).set(auth(approverA)).expect(409);
    const a2 = await api().post(`/api/admin/payout-batches/${bid}/approve`).set(auth(approverB)).expect(200);
    expect(a2.body.status).toBe('approved');
    const rel = await api().post(`/api/admin/payout-batches/${bid}/release`).set(auth(approverB)).expect(200);
    expect(rel.body.results[0].status).toBe('processed');
    const paid = await query(`SELECT status, utr_number FROM payouts WHERE batch_id = $1`, [bid]);
    expect(paid.rows[0].status).toBe('paid');
    expect(paid.rows[0].utr_number).toMatch(/^MOCKUTR/);
    const item = await query(`SELECT status FROM payout_items WHERE booking_id = $1`, [dirty]);
    expect(item.rows[0].status).toBe('held');
  });

  it('the database itself blocks a preparer approving their own batch', async () => {
    const { rows } = await query(`SELECT id, prepared_by FROM payout_batches LIMIT 1`);
    await expect(query('INSERT INTO payout_batch_approvals (batch_id, admin_id) VALUES ($1, $2)', [rows[0].id, rows[0].prepared_by]))
      .rejects.toThrow(/cannot approve/);
  });
});

describe('fraud queue and strikes (Sections 9.5–9.7)', () => {
  it('cash reports escalate; confirmed strikes follow warning → 7-day suspension → deactivation', async () => {
    const w = await onboardedWorker();
    for (let i = 0; i < 2; i += 1) {
      const c = await customer();
      const id = await paidBooking(c, { hour: 10 + i * 3 });
      await api().post(`/api/worker/jobs/${id}/accept`).set(auth(w.token)).expect(200);
      await api().post(`/api/bookings/${id}/report-cash`).set(auth(c.token)).send({ note: 'asked for cash' }).expect(201);
    }
    const flags = await api().get('/api/admin/fraud-flags').set(auth(risk)).expect(200);
    const mine = flags.body.flags.filter((f) => f.worker_id === w.workerId);
    expect(mine[0].flag_type).toBe('repeated_cash_demand_reports'); // critical sorts first
    expect(mine[0].severity).toBe('critical');

    const cashFlags = mine.filter((f) => f.flag_type === 'cash_demand_report');
    const r1 = await api().post(`/api/admin/fraud-flags/${cashFlags[0].id}/review`).set(auth(risk))
      .send({ decision: 'confirm', violation: 'cash_demand', note: 'customer evidence' }).expect(200);
    expect(r1.body.action).toBe('formal_warning_and_retraining');
    // Must re-accept policy before working again.
    await api().get('/api/worker/jobs/open').set(auth(w.token)).expect(403);

    const r2 = await api().post(`/api/admin/fraud-flags/${cashFlags[1].id}/review`).set(auth(risk))
      .send({ decision: 'confirm', violation: 'cash_demand', note: 'second report' }).expect(200);
    expect(r2.body.action).toBe('suspended_7_days');

    const r3 = await api().post(`/api/admin/workers/${w.workerId}/strike`).set(auth(risk)).send({ violation: 'cash_demand' }).expect(200);
    expect(r3.body.action).toBe('deactivated');
    await api().get('/api/worker/me').set(auth(w.token)).expect(401);
  });

  it('reactivation requires maker-checker', async () => {
    const { rows } = await query(`SELECT id FROM workers WHERE status = 'deactivated' LIMIT 1`);
    const cr = await api().post(`/api/admin/workers/${rows[0].id}/change-requests`).set(auth(risk))
      .send({ kind: 'worker_reactivation', reason: 'Appeal accepted after review' }).expect(201);
    await api().post(`/api/admin/change-requests/${cr.body.changeRequest.id}/decision`).set(auth(ops)).send({ approve: true }).expect(200);
    const w = await query('SELECT status, policy_ack_version FROM workers WHERE id = $1', [rows[0].id]);
    expect(w.rows[0]).toEqual({ status: 'active', policy_ack_version: null });
  });
});

describe('disputes and maker-checker refunds', () => {
  it('holds the payout during a dispute and needs a second admin to approve the refund', async () => {
    const c = await customer();
    const w = await onboardedWorker();
    const id = await completedJob({ c, w });
    await api().post(`/api/bookings/${id}/dispute`).set(auth(c.token))
      .send({ reason: 'poor_quality', description: 'AC still not cooling after service' }).expect(201);
    let item = await query('SELECT status FROM payout_items WHERE booking_id = $1', [id]);
    expect(item.rows[0].status).toBe('held');

    const d = await api().get('/api/admin/disputes').set(auth(ops)).expect(200);
    const dispute = d.body.disputes.find((x) => x.booking_id === id);
    const r = await api().post(`/api/admin/disputes/${dispute.id}/resolve`).set(auth(ops))
      .send({ outcome: 'refund_partial', amountPaise: 20000, resolution: 'Partial refund for incomplete service' }).expect(200);
    // ops has disputes.manage but not refunds.approve.
    await api().post(`/api/admin/refund-requests/${r.body.refundRequestId}/decision`).set(auth(ops)).send({ approve: true }).expect(403);
    await api().post(`/api/admin/refund-requests/${r.body.refundRequestId}/decision`).set(auth(finance2)).send({ approve: true }).expect(200);

    item = await query('SELECT status, amount FROM payout_items WHERE booking_id = $1', [id]);
    // 47920 worker share − (20000 × 47920/59900 = 16000) = 31920
    expect(item.rows[0]).toEqual({ status: 'pending', amount: 31920 });
    const pay = await query('SELECT payment_status, refunded_amount FROM payments WHERE booking_id = $1', [id]);
    expect(pay.rows[0]).toEqual({ payment_status: 'partially_refunded', refunded_amount: 20000 });
  });
});

describe('audit log (Section 9.8)', () => {
  it('is append-only and its hash chain verifies', async () => {
    await expect(query('UPDATE audit_logs SET action = $1 WHERE id = 1', ['tampered'])).rejects.toThrow(/append-only/);
    await expect(query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
    const res = await api().get('/api/admin/audit-logs/verify').set(auth(risk)).expect(200);
    expect(res.body.brokenAt).toBeNull();
    expect(res.body.checked).toBeGreaterThan(5);
  });

  it('detects tampering if a superuser bypasses the trigger', async () => {
    await query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update');
    await query(`UPDATE audit_logs SET new_value = '{"forged":true}' WHERE id = 2`);
    await query('ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update');
    const out = await verifyAuditChain({ query });
    expect(out.brokenAt).toBe(2);
  });
});

describe('anomaly rules', () => {
  it('high customer cancellation rate flags the worker and holds payouts', async () => {
    const w = await onboardedWorker({ skill: 'cleaning' });
    for (let i = 0; i < 5; i += 1) {
      const c = await customer();
      const id = await paidBooking(c, { serviceName: 'Deep clean', daysAhead: 2 + i });
      await api().post(`/api/worker/jobs/${id}/accept`).set(auth(w.token)).expect(200);
      if (i < 2) await api().post(`/api/bookings/${id}/cancel`).set(auth(c.token)).send({}).expect(200);
    }
    const out = await runJob('anomalies');
    expect(out.summary.high_customer_cancellation_rate).toBeGreaterThanOrEqual(1);
    const { rows } = await query('SELECT payout_hold FROM workers WHERE id = $1', [w.workerId]);
    expect(rows[0].payout_hold).toBe(true);
  });
});
