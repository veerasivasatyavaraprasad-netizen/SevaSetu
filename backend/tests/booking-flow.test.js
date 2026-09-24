import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { runJob } from '../src/services/jobs.js';
import {
  AT_ADDRESS, api, auth, customer, onboardedWorker, paidBooking, resetDb,
} from './helpers.js';

beforeAll(resetDb);

async function makeCheckinable(bookingId) {
  await query(`UPDATE bookings SET scheduled_time = now() + interval '30 minutes' WHERE id = $1`, [bookingId]);
}

describe('end-to-end booking → payment → GPS → OTP → payout queue', () => {
  let c;
  let w;
  let bookingId;

  it('creates a booking with server-side fixed pricing and pays in-app', async () => {
    c = await customer();
    w = await onboardedWorker();
    bookingId = await paidBooking(c);
    const res = await api().get(`/api/bookings/${bookingId}`).set(auth(c.token)).expect(200);
    expect(res.body.booking.status).toBe('paid');
    expect(res.body.booking.amount).toBe(59900);
    expect(res.body.booking.completionOtp).toBeNull(); // hidden until a worker is assigned
  });

  it('rejects a client-supplied price', async () => {
    const { rows } = await query(`SELECT id FROM services LIMIT 1`);
    const res = await api().post('/api/bookings').set(auth(c.token)).send({
      serviceId: rows[0].id, addressId: c.addressId, scheduledTime: new Date(Date.now() + 86400_000).toISOString(),
      acceptCancellationPolicy: true, amount: 1,
    });
    expect(res.status).toBe(400);
  });

  it('shows open jobs to workers without the address, then reveals it after acceptance', async () => {
    const open = await api().get('/api/worker/jobs/open').set(auth(w.token)).expect(200);
    const job = open.body.jobs.find((j) => j.id === bookingId);
    expect(job).toBeTruthy();
    expect(job.address).toBeUndefined();
    expect(job.yourEarning).toBe(59900 - 11980); // 20% default commission

    await api().post(`/api/worker/jobs/${bookingId}/accept`).set(auth(w.token)).expect(200);
    const detail = await api().get(`/api/worker/jobs/${bookingId}`).set(auth(w.token)).expect(200);
    expect(detail.body.job.address.line1).toContain('MG Road');
    expect(JSON.stringify(detail.body)).not.toContain(c.phone.slice(-10));
    expect(detail.body.job.completionOtp).toBeUndefined();
  });

  it('refuses check-in far from the address and flags large deviations', async () => {
    await makeCheckinable(bookingId);
    const res = await api().post(`/api/worker/jobs/${bookingId}/checkin`).set(auth(w.token))
      .send({ lat: 12.99, lng: 77.62, accuracyM: 10 });
    expect(res.status).toBe(400);
    const { rows } = await query(`SELECT flag_type FROM fraud_flags WHERE booking_id = $1`, [bookingId]);
    expect(rows.map((r) => r.flag_type)).toContain('checkin_far_from_address');
  });

  it('cannot complete before check-in (DB guard) and checks in within radius', async () => {
    await expect(query(`UPDATE bookings SET status = 'in_progress' WHERE id = $1`, [bookingId]))
      .rejects.toThrow(/GPS check-in/);
    await api().post(`/api/worker/jobs/${bookingId}/checkin`).set(auth(w.token)).send(AT_ADDRESS).expect(200);
  });

  it('requires the customer OTP to complete, with limited attempts', async () => {
    const view = await api().get(`/api/bookings/${bookingId}`).set(auth(c.token)).expect(200);
    const otp = view.body.booking.completionOtp;
    expect(otp).toMatch(/^\d{4}$/);
    const wrong = otp === '0000' ? '1111' : '0000';
    const bad = await api().post(`/api/worker/jobs/${bookingId}/complete`).set(auth(w.token)).send({ otp: wrong, ...AT_ADDRESS });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/4 attempt/);
    await api().post(`/api/worker/jobs/${bookingId}/complete`).set(auth(w.token)).send({ otp, ...AT_ADDRESS }).expect(200);
  });

  it('customer rating confirms the job and queues the worker payout', async () => {
    await api().post(`/api/bookings/${bookingId}/review`).set(auth(c.token)).send({ rating: 5, comment: 'Great work' }).expect(201);
    const { rows } = await query('SELECT status, amount FROM payout_items WHERE booking_id = $1', [bookingId]);
    expect(rows[0]).toEqual({ status: 'pending', amount: 47920 });
    const b = await query('SELECT status, commission_amount, worker_payout FROM bookings WHERE id = $1', [bookingId]);
    expect(b.rows[0]).toEqual({ status: 'confirmed', commission_amount: 11980, worker_payout: 47920 });
  });

  it('nightly reconciliation marks a fully verified booking clean', async () => {
    const out = await runJob('reconciliation');
    expect(out.status).toBe('succeeded');
    const { rows } = await query('SELECT reconciliation_status FROM bookings WHERE id = $1', [bookingId]);
    expect(rows[0].reconciliation_status).toBe('clean');
  });
});

describe('Section 9.1 structural controls', () => {
  it('a booking cannot be moved to paid/completed without a captured payment (DB trigger)', async () => {
    const c = await customer();
    const { rows: s } = await query(`SELECT id FROM services LIMIT 1`);
    const res = await api().post('/api/bookings').set(auth(c.token)).send({
      serviceId: s[0].id, addressId: c.addressId, scheduledTime: new Date(Date.now() + 86400_000).toISOString(), acceptCancellationPolicy: true,
    }).expect(201);
    await expect(query(`UPDATE bookings SET status = 'paid' WHERE id = $1`, [res.body.booking.id]))
      .rejects.toThrow(/no captured in-app payment/);
    await expect(query(`UPDATE bookings SET amount = 1 WHERE id = $1`, [res.body.booking.id]))
      .rejects.toThrow(/price is fixed/);
  });

  it('rejects a forged checkout signature', async () => {
    const c = await customer();
    const { rows: s } = await query(`SELECT id FROM services LIMIT 1`);
    const res = await api().post('/api/bookings').set(auth(c.token)).send({
      serviceId: s[0].id, addressId: c.addressId, scheduledTime: new Date(Date.now() + 86400_000).toISOString(), acceptCancellationPolicy: true,
    }).expect(201);
    const forged = await api().post('/api/payments/confirm').set(auth(c.token)).send({
      orderId: res.body.order.orderId, paymentId: 'pay_fake123456', signature: 'a'.repeat(64),
    });
    expect(forged.status).toBe(400);
  });

  it('another customer cannot see or pay for someone else\'s booking', async () => {
    const a = await customer();
    const b = await customer();
    const id = await paidBooking(a);
    await api().get(`/api/bookings/${id}`).set(auth(b.token)).expect(404);
    await api().post(`/api/bookings/${id}/cancel`).set(auth(b.token)).send({}).expect(404);
  });

  it('chat redacts phone numbers and UPI IDs, and flags workers who mention cash', async () => {
    const c = await customer();
    const w = await onboardedWorker();
    const id = await paidBooking(c);
    await api().post(`/api/worker/jobs/${id}/accept`).set(auth(w.token)).expect(200);
    const m = await api().post(`/api/bookings/${id}/messages`).set(auth(w.token))
      .send({ body: 'Pay cash or to ravi@okaxis, call 98765 43210' }).expect(201);
    expect(m.body.message.body).not.toMatch(/okaxis|98765/);
    expect(m.body.message.redacted).toBe(true);
    const { rows } = await query(`SELECT flag_type FROM fraud_flags WHERE booking_id = $1`, [id]);
    expect(rows.map((r) => r.flag_type)).toContain('chat_off_app_attempt');
  });

  it('mock location on check-in suspends the worker immediately', async () => {
    const c = await customer();
    const w = await onboardedWorker();
    const id = await paidBooking(c);
    await api().post(`/api/worker/jobs/${id}/accept`).set(auth(w.token)).expect(200);
    await makeCheckinable(id);
    const res = await api().post(`/api/worker/jobs/${id}/checkin`).set(auth(w.token)).send({ ...AT_ADDRESS, isMock: true });
    expect(res.status).toBe(403);
    const { rows } = await query('SELECT status, payout_hold FROM workers WHERE id = $1', [w.workerId]);
    expect(rows[0]).toEqual({ status: 'suspended', payout_hold: true });
    await api().get('/api/worker/jobs/open').set(auth(w.token)).expect(403);
  });

  it('a worker cannot accept a job booked from their own number', async () => {
    const w = await onboardedWorker();
    const { otpLogin } = await import('./helpers.js');
    const selfCustomer = await otpLogin(w.phone, 'customer');
    const token = selfCustomer.body.accessToken;
    const addr = await api().post('/api/addresses').set(auth(token)).send({
      label: 'Home', line1: '5 Brigade Road', city: 'Bengaluru', pincode: '560001', lat: 12.97, lng: 77.6,
    }).expect(201);
    const id = await paidBooking({ token, addressId: addr.body.id }, { hour: 16 });
    const res = await api().post(`/api/worker/jobs/${id}/accept`).set(auth(w.token));
    expect(res.status).toBe(403);
  });

  it('a suspended customer cannot sign back in', async () => {
    const c = await customer();
    await query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [c.userId]);
    await api().get('/api/me').set(auth(c.token)).expect(401);
    const { otpLogin } = await import('./helpers.js');
    const res = await otpLogin(c.phone, 'customer');
    expect(res.status).toBe(403);
  });

  it('worker must be KYC-approved to see jobs', async () => {
    const w = await onboardedWorker({ approve: false });
    const res = await api().get('/api/worker/jobs/open').set(auth(w.token));
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/under review/);
  });
});

describe('cancellation and refunds', () => {
  it('free cancellation refunds in full through the gateway', async () => {
    const c = await customer();
    const id = await paidBooking(c, { daysAhead: 2 });
    const res = await api().post(`/api/bookings/${id}/cancel`).set(auth(c.token)).send({ reason: 'plans changed' }).expect(200);
    expect(res.body).toMatchObject({ refund: 59900, fee: 0 });
    const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [id]);
    expect(rows[0].status).toBe('refunded');
    const p = await query('SELECT payment_status, refunded_amount FROM payments WHERE booking_id = $1', [id]);
    expect(p.rows[0]).toEqual({ payment_status: 'refunded', refunded_amount: 59900 });
  });

  it('late cancellation retains the published 10% fee', async () => {
    const c = await customer();
    const id = await paidBooking(c, { daysAhead: 1 });
    await query(`UPDATE bookings SET scheduled_time = now() + interval '90 minutes' WHERE id = $1`, [id]);
    const res = await api().post(`/api/bookings/${id}/cancel`).set(auth(c.token)).send({}).expect(200);
    expect(res.body).toMatchObject({ refund: 53910, fee: 5990 });
  });
});
