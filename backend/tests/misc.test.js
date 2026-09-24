import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { payments } from '../src/services/payments.js';
import { runJob } from '../src/services/jobs.js';
import { api, auth, customer, istSlot, resetDb } from './helpers.js';

beforeAll(resetDb);

describe('subscriptions (Section 7.3)', () => {
  it('charges upfront and generates visits as prepaid bookings', async () => {
    const c = await customer();
    const { rows: s } = await query(`SELECT id FROM services WHERE name = 'AC service'`);
    const start = new Date(Date.now() + 2 * 86400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);
    const res = await api().post('/api/subscriptions').set(auth(c.token)).send({
      serviceId: s[0].id, addressId: c.addressId, frequency: 'quarterly', visits: 4, preferredHour: 10, startDate: start, acceptTerms: true,
    }).expect(201);
    expect(res.body.order.amount).toBe(59900 * 4);
    const pay = await api().post('/api/payments/mock/checkout').set(auth(c.token)).send({ orderId: res.body.order.orderId }).expect(200);
    await api().post('/api/payments/confirm').set(auth(c.token)).send({ orderId: res.body.order.orderId, ...pay.body }).expect(200);

    const out = await runJob('subscriptions');
    expect(out.summary.visitsCreated).toBe(1);
    const { rows } = await query('SELECT status, amount FROM bookings WHERE subscription_id = $1', [res.body.subscription.id]);
    expect(rows).toEqual([{ status: 'paid', amount: 59900 }]);
    const sub = await query('SELECT visits_generated, next_due_date FROM subscriptions WHERE id = $1', [res.body.subscription.id]);
    expect(sub.rows[0].visits_generated).toBe(1);
    expect(sub.rows[0].next_due_date).not.toBe(start);
  });
});

describe('gateway webhook', () => {
  it('rejects bad signatures and captures payments idempotently', async () => {
    const c = await customer();
    const { rows: s } = await query(`SELECT id FROM services WHERE name = 'AC service'`);
    const b = await api().post('/api/bookings').set(auth(c.token)).send({
      serviceId: s[0].id, addressId: c.addressId, scheduledTime: istSlot(1, 12), acceptCancellationPolicy: true,
    }).expect(201);
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_webhook1', order_id: b.body.order.orderId, amount: 59900 } } } });
    await api().post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('X-Razorpay-Signature', 'bad').send(body).expect(400);
    const sig = payments.signWebhook(body);
    await api().post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('X-Razorpay-Signature', sig).set('X-Razorpay-Event-Id', 'evt_1').send(body).expect(200);
    const dup = await api().post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('X-Razorpay-Signature', sig).set('X-Razorpay-Event-Id', 'evt_1').send(body).expect(200);
    expect(dup.body.duplicate).toBe(true);
    const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [b.body.booking.id]);
    expect(rows[0].status).toBe('paid');
  });
});

describe('DPDP rights (Section 10)', () => {
  it('exports and then erases personal data', async () => {
    const c = await customer('Delete Me');
    const exp = await api().get('/api/me/export').set(auth(c.token)).expect(200);
    expect(exp.body.profile.phone).toBe(`+91${c.phone}`);
    expect(exp.body.addresses[0].line1).toContain('MG Road');
    await api().post('/api/me/delete').set(auth(c.token)).expect(200);
    await api().get('/api/me').set(auth(c.token)).expect(401);
    const { rows } = await query('SELECT name, phone_enc, status FROM users WHERE id = $1', [c.userId]);
    expect(rows[0]).toEqual({ name: null, phone_enc: null, status: 'deleted' });
  });
});

describe('scheduler', () => {
  it('runs the nightly checks once per IST day, catching up after a missed hour', async () => {
    const { nightlyDue, schedulerTick } = await import('../src/services/jobs.js');
    const { query: q } = await import('../src/db.js');
    await q(`DELETE FROM job_runs WHERE job = 'reconciliation'`);
    // 23:30 IST — after the 02:00 slot with no run today: due.
    const lateNight = new Date('2026-09-24T18:00:00Z');
    expect(await nightlyDue(lateNight)).toBe(true);
    // 01:00 IST — before the slot: not due yet.
    expect(await nightlyDue(new Date('2026-09-24T19:30:00Z'))).toBe(false);
    // After a tick, tonight's run is either done or not yet due.
    await schedulerTick();
    expect(await nightlyDue()).toBe(false);
  });
});
