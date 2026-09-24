// Customer app API (Section 3.1).

import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { decrypt, decryptJson, encryptJson } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import {
  cancellationTerms, confirmBooking, createBooking, customerCancel, customerView, lockBooking, markPaymentCaptured,
  quote, transition, validateSlot,
} from '../services/bookings.js';
import { holdPayoutItem, raiseFlag } from '../services/fraud.js';
import { payments } from '../services/payments.js';
import { processApprovedRefund } from '../services/refunds.js';
import { revokeAllForUser } from '../services/sessions.js';
import { FREQUENCY_MONTHS } from '../services/subscriptions.js';

export const customerRouter = Router();
const uuid = z.uuid();

// ---------------------------------------------------------------- public
customerRouter.get('/services', async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.name, s.category, s.fixed_price_paise, s.duration_minutes, s.description, s.urgent_premium_bps,
            COALESCE(round(avg(r.rating)::numeric, 1), 0) AS rating, count(r.id)::int AS reviews
       FROM services s
       LEFT JOIN bookings b ON b.service_id = s.id
       LEFT JOIN reviews r ON r.booking_id = b.id
      WHERE s.active
      GROUP BY s.id ORDER BY s.category, s.name`,
  );
  res.json({ services: rows });
});

customerRouter.get('/services/:id', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { rows } = await query('SELECT * FROM services WHERE id = $1 AND active', [id]);
  if (!rows[0]) throw notFound();
  const { rows: reviews } = await query(
    `SELECT r.rating, r.comment, r.created_at, split_part(u.name, ' ', 1) AS customer
       FROM reviews r JOIN bookings b ON b.id = r.booking_id JOIN users u ON u.id = r.customer_id
      WHERE b.service_id = $1 AND r.comment IS NOT NULL ORDER BY r.created_at DESC LIMIT 20`,
    [id],
  );
  res.json({ service: rows[0], reviews });
});

// ------------------------------------------------------ authenticated
const app = Router();
customerRouter.use(app);
app.use(authenticate());

app.get('/me', async (req, res) => {
  const { rows } = await query('SELECT id, role, name, email, phone_last4, created_at FROM users WHERE id = $1', [req.auth.userId]);
  res.json({ user: rows[0], worker: req.auth.worker });
});

app.patch('/me', async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(2).max(80).optional(),
    email: z.email().max(200).optional().or(z.literal('')),
  }).strict(), req.body);
  if (req.auth.role === 'worker' && body.name && req.auth.worker?.kycStatus === 'approved') {
    throw forbidden('Your verified name cannot be changed. Contact support.');
  }
  const { rows } = await query(
    `UPDATE users SET name = COALESCE($2, name), email = COALESCE(NULLIF($3, ''), email), updated_at = now()
      WHERE id = $1 RETURNING id, name, email`,
    [req.auth.userId, body.name ?? null, body.email ?? null],
  );
  res.json({ user: rows[0] });
});

app.post('/devices', async (req, res) => {
  const body = parse(z.object({ token: z.string().min(10).max(4096), platform: z.enum(['android', 'ios', 'web']) }).strict(), req.body);
  await query('INSERT INTO device_tokens (user_id, token, platform) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [req.auth.userId, body.token, body.platform]);
  res.json({ ok: true });
});

app.get('/notifications', async (req, res) => {
  const { rows } = await query(
    'SELECT id, kind, title, body, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 50',
    [req.auth.userId],
  );
  res.json({ notifications: rows });
});

app.post('/notifications/read', async (req, res) => {
  await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.auth.userId]);
  res.json({ ok: true });
});

// ------------------------------------------------------ DPDP rights
app.get('/me/export', async (req, res) => {
  const uid = req.auth.userId;
  const [u, addrs, bookings, reviews, consents] = await Promise.all([
    query('SELECT id, role, name, email, phone_enc, created_at FROM users WHERE id = $1', [uid]),
    query('SELECT id, label, details_enc, city, pincode, created_at FROM addresses WHERE user_id = $1 AND deleted_at IS NULL', [uid]),
    query('SELECT id, service_id, status, amount, scheduled_time, created_at FROM bookings WHERE customer_id = $1', [uid]),
    query('SELECT booking_id, rating, comment, created_at FROM reviews WHERE customer_id = $1', [uid]),
    query('SELECT purpose, policy_version, granted_at, withdrawn_at FROM consents WHERE user_id = $1', [uid]),
  ]);
  await query(`INSERT INTO data_requests (user_id, kind, status, completed_at) VALUES ($1, 'export', 'completed', now())`, [uid]);
  const user = u.rows[0];
  res.set('Content-Disposition', 'attachment; filename="my-data.json"');
  res.json({
    exportedAt: new Date().toISOString(),
    profile: { id: user.id, role: user.role, name: user.name, email: user.email, phone: decrypt(user.phone_enc), createdAt: user.created_at },
    addresses: addrs.rows.map((a) => ({ id: a.id, label: a.label, ...decryptJson(a.details_enc), city: a.city, pincode: a.pincode })),
    bookings: bookings.rows,
    reviews: reviews.rows,
    consents: consents.rows,
  });
});

app.post('/me/delete', async (req, res) => {
  const uid = req.auth.userId;
  await tx(async (db) => {
    const { rows: active } = await db.query(
      `SELECT 1 FROM bookings WHERE (customer_id = $1 OR worker_id = (SELECT id FROM workers WHERE user_id = $1))
          AND status IN ('pending_payment', 'paid', 'assigned', 'in_progress', 'completed', 'disputed') LIMIT 1`,
      [uid],
    );
    if (active[0]) throw conflict('Finish or cancel your active bookings before deleting your account');
    if (req.auth.role === 'worker') {
      const { rows: owed } = await db.query(
        `SELECT 1 FROM payout_items pi JOIN workers w ON w.id = pi.worker_id
          WHERE w.user_id = $1 AND pi.status IN ('pending', 'held', 'batched') LIMIT 1`, [uid]);
      if (owed[0]) throw conflict('You have pending earnings. Deletion is possible after your final payout.');
      await db.query(
        `UPDATE workers SET id_number_enc = NULL, id_last4 = NULL, payout_ref_token = NULL, payout_masked = NULL
          WHERE user_id = $1`, [uid]);
      await db.query('DELETE FROM kyc_documents WHERE worker_id = (SELECT id FROM workers WHERE user_id = $1)', [uid]);
    }
    // Financial records are retained as required by tax law; identity is erased.
    // phone_hash is replaced by random bytes: unlinkable to the number,
    // and the number can sign up afresh later.
    await db.query(
      `UPDATE users SET status = 'deleted', name = NULL, email = NULL, phone_enc = NULL, phone_hash = $2,
              phone_last4 = NULL, updated_at = now() WHERE id = $1`, [uid, crypto.randomBytes(32)]);
    await db.query(`UPDATE addresses SET deleted_at = now(), details_enc = $2 WHERE user_id = $1`, [uid, encryptJson({ line1: '[deleted]' })]);
    await db.query('UPDATE consents SET withdrawn_at = now() WHERE user_id = $1 AND withdrawn_at IS NULL', [uid]);
    await db.query('DELETE FROM device_tokens WHERE user_id = $1', [uid]);
    await db.query(`INSERT INTO data_requests (user_id, kind, status, completed_at) VALUES ($1, 'deletion', 'completed', now())`, [uid]);
    await revokeAllForUser(db, uid, 'account_deleted');
    await audit(db, { actorId: uid, actorRole: req.auth.role, action: 'user.self_deleted', targetTable: 'users', targetId: uid, ip: req.ip });
  });
  res.json({ ok: true });
});

// ------------------------------------------------------ addresses
const cust = Router();
app.use(cust);
cust.use(requireRole('customer'));

const addressSchema = z.object({
  label: z.string().trim().min(1).max(30).default('Home'),
  line1: z.string().trim().min(3).max(200),
  line2: z.string().trim().max(200).optional().default(''),
  landmark: z.string().trim().max(120).optional().default(''),
  city: z.string().trim().min(2).max(60),
  pincode: z.string().regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code'),
  lat: z.number().min(6).max(38),   // India bounding box
  lng: z.number().min(68).max(98),
}).strict();

cust.get('/addresses', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM addresses WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at', [req.auth.userId],
  );
  res.json({
    addresses: rows.map((a) => ({
      id: a.id, label: a.label, ...decryptJson(a.details_enc), city: a.city, pincode: a.pincode, lat: a.lat, lng: a.lng,
    })),
  });
});

cust.post('/addresses', async (req, res) => {
  const b = parse(addressSchema, req.body);
  const { rows: count } = await query('SELECT count(*)::int AS n FROM addresses WHERE user_id = $1 AND deleted_at IS NULL', [req.auth.userId]);
  if (count[0].n >= 10) throw badRequest('You can save up to 10 addresses');
  const { rows } = await query(
    `INSERT INTO addresses (user_id, label, details_enc, city, pincode, lat, lng)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [req.auth.userId, b.label, encryptJson({ line1: b.line1, line2: b.line2, landmark: b.landmark }), b.city, b.pincode, b.lat, b.lng],
  );
  res.status(201).json({ id: rows[0].id });
});

cust.delete('/addresses/:id', async (req, res) => {
  const id = parse(uuid, req.params.id);
  await query('UPDATE addresses SET deleted_at = now() WHERE id = $1 AND user_id = $2', [id, req.auth.userId]);
  res.json({ ok: true });
});

// ------------------------------------------------------ bookings
cust.post('/bookings/quote', async (req, res) => {
  const b = parse(z.object({ serviceId: uuid, scheduledTime: z.iso.datetime({ offset: true }) }).strict(), req.body);
  const { rows } = await query('SELECT * FROM services WHERE id = $1 AND active', [b.serviceId]);
  if (!rows[0]) throw notFound('Service not available');
  const when = new Date(b.scheduledTime);
  validateSlot(when);
  res.json({
    quote: quote(rows[0], when),
    cancellationPolicy: {
      freeUntilHoursBefore: config.booking.freeCancelHoursBefore,
      lateFeePercent: config.booking.lateCancelFeeBps / 100,
      text: `Free cancellation up to ${config.booking.freeCancelHoursBefore} hours before your slot. After that, ${config.booking.lateCancelFeeBps / 100}% of the booking amount is retained. Refunds go back to your original payment method.`,
    },
  });
});

cust.post('/bookings', async (req, res) => {
  const b = parse(z.object({
    serviceId: uuid,
    addressId: uuid,
    scheduledTime: z.iso.datetime({ offset: true }),
    acceptCancellationPolicy: z.literal(true),
  }).strict(), req.body);
  const out = await tx((db) => createBooking(db, {
    customerId: req.auth.userId, serviceId: b.serviceId, addressId: b.addressId, scheduledTime: new Date(b.scheduledTime),
  }));
  res.status(201).json({ booking: customerView(out.booking), quote: out.quote, order: out.order });
});

cust.get('/bookings', async (req, res) => {
  const { rows } = await query(
    `SELECT b.*, s.name AS service_name FROM bookings b JOIN services s ON s.id = b.service_id
      WHERE b.customer_id = $1 ORDER BY b.scheduled_time DESC LIMIT 100`,
    [req.auth.userId],
  );
  res.json({ bookings: rows.map((b) => customerView(b, { serviceName: b.service_name })) });
});

async function loadCustomerBooking(id, customerId) {
  const { rows } = await query(
    `SELECT b.*, s.name AS service_name, s.duration_minutes,
            u.name AS worker_name, w.rating_avg, w.rating_count,
            (SELECT row_to_json(r) FROM (SELECT rating, comment FROM reviews WHERE booking_id = b.id) r) AS review,
            (SELECT gateway_order_id FROM payments WHERE booking_id = b.id AND payment_status = 'created' LIMIT 1) AS open_order_id,
            EXISTS (SELECT 1 FROM cash_reports WHERE booking_id = b.id) AS cash_reported,
            (SELECT status FROM disputes WHERE booking_id = b.id ORDER BY created_at DESC LIMIT 1) AS dispute_status
       FROM bookings b JOIN services s ON s.id = b.service_id
       LEFT JOIN workers w ON w.id = b.worker_id LEFT JOIN users u ON u.id = w.user_id
      WHERE b.id = $1 AND b.customer_id = $2`,
    [id, customerId],
  );
  if (!rows[0]) throw notFound('Booking not found');
  return rows[0];
}

cust.get('/bookings/:id', async (req, res) => {
  const b = await loadCustomerBooking(parse(uuid, req.params.id), req.auth.userId);
  const { rows: events } = await query(
    'SELECT to_status, created_at FROM booking_events WHERE booking_id = $1 ORDER BY id', [b.id],
  );
  res.json({
    booking: customerView(b, {
      serviceName: b.service_name,
      durationMinutes: b.duration_minutes,
      // Only the worker's first name and rating: never their phone number.
      worker: b.worker_id ? { firstName: (b.worker_name || 'Professional').split(' ')[0], rating: Number(b.rating_avg), ratingCount: b.rating_count } : null,
      review: b.review,
      cashReported: b.cash_reported,
      disputeStatus: b.dispute_status,
      pendingOrder: b.open_order_id ? { orderId: b.open_order_id, amount: b.amount, currency: 'INR', keyId: payments.publicKey(), provider: payments.name } : null,
      cancellation: ['pending_payment', 'paid', 'assigned'].includes(b.status) ? cancellationTerms(b) : null,
      events,
    }),
  });
});

cust.post('/bookings/:id/cancel', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ reason: z.string().trim().max(300).optional() }).strict(), req.body);
  const out = await tx((db) => customerCancel(db, { bookingId: id, customerId: req.auth.userId, reason: body.reason }));
  if (out.refundId) await processApprovedRefund(out.refundId);
  res.json({ status: out.booking.status, refund: out.terms.refund, fee: out.terms.fee });
});

cust.post('/bookings/:id/confirm', async (req, res) => {
  const id = parse(uuid, req.params.id);
  await tx(async (db) => {
    const b = await lockBooking(db, id);
    if (b.customer_id !== req.auth.userId) throw notFound();
    if (b.status !== 'completed') throw conflict('Only completed jobs can be confirmed');
    await confirmBooking(db, b, { actorId: req.auth.userId, actorRole: 'customer' });
  });
  res.json({ ok: true });
});

cust.post('/bookings/:id/review', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().max(1000).optional(),
    askedForCash: z.boolean().default(false),
  }).strict(), req.body);
  await tx(async (db) => {
    const b = await lockBooking(db, id);
    if (b.customer_id !== req.auth.userId) throw notFound();
    // Section 2: no rating is recorded unless the job happened in-app.
    if (!['completed', 'confirmed'].includes(b.status)) throw conflict('You can rate once the job is completed');
    const { rowCount } = await db.query(
      `INSERT INTO reviews (booking_id, customer_id, worker_id, rating, comment, asked_for_cash)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (booking_id) DO NOTHING`,
      [id, req.auth.userId, b.worker_id, body.rating, body.comment || null, body.askedForCash],
    );
    if (!rowCount) throw conflict('You have already reviewed this booking');
    await db.query(
      `UPDATE workers SET rating_count = rating_count + 1,
              rating_avg = round(((rating_avg * rating_count) + $2) / (rating_count + 1), 2)
        WHERE id = $1`,
      [b.worker_id, body.rating],
    );
    if (b.status === 'completed') await confirmBooking(db, b, { actorId: req.auth.userId, actorRole: 'customer' });
    if (body.askedForCash) {
      await raiseFlag(db, { workerId: b.worker_id, bookingId: b.id, customerId: req.auth.userId, type: 'cash_demand_report',
        severity: 'high', details: { source: 'review', rating: body.rating } });
    }
  });
  res.status(201).json({ ok: true });
});

// Section 9.7: one-tap "Worker asked for cash".
cust.post('/bookings/:id/report-cash', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ note: z.string().trim().max(500).optional() }).strict(), req.body);
  await tx(async (db) => {
    const b = await lockBooking(db, id);
    if (b.customer_id !== req.auth.userId) throw notFound();
    if (!b.worker_id) throw conflict('No professional is assigned to this booking');
    const { rowCount } = await db.query(
      `INSERT INTO cash_reports (booking_id, customer_id, worker_id, note) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [id, req.auth.userId, b.worker_id, body.note || null],
    );
    if (!rowCount) return;
    await raiseFlag(db, { workerId: b.worker_id, bookingId: b.id, customerId: req.auth.userId, type: 'cash_demand_report',
      severity: 'high', details: { source: 'report_button', note: body.note || null } });
    const { rows } = await db.query(
      `SELECT count(DISTINCT booking_id)::int AS n FROM cash_reports WHERE worker_id = $1 AND created_at > now() - interval '90 days'`,
      [b.worker_id],
    );
    if (rows[0].n >= 2) {
      await raiseFlag(db, { workerId: b.worker_id, type: 'repeated_cash_demand_reports', severity: 'critical',
        details: { reports90d: rows[0].n } });
    }
  });
  res.status(201).json({
    ok: true,
    message: 'Thank you. Do not pay in cash — your in-app payment is protected. Our team will review this report.',
  });
});

cust.post('/bookings/:id/dispute', async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({
    reason: z.enum(['not_completed', 'poor_quality', 'damage', 'overcharged', 'asked_for_cash', 'other']),
    description: z.string().trim().min(10).max(2000),
  }).strict(), req.body);
  const out = await tx(async (db) => {
    const b = await lockBooking(db, id);
    if (b.customer_id !== req.auth.userId) throw notFound();
    if (!['in_progress', 'completed', 'confirmed'].includes(b.status)) throw conflict('Disputes can be raised on started or completed jobs');
    if (b.status === 'confirmed' && new Date(b.confirmed_at).getTime() < Date.now() - 7 * 86400_000) {
      throw conflict('Disputes must be raised within 7 days of completion');
    }
    const { rows } = await db.query(
      `INSERT INTO disputes (booking_id, raised_by, reason, description, previous_booking_status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [id, req.auth.userId, body.reason, body.description, b.status],
    );
    await transition(db, b, 'disputed', { actorId: req.auth.userId, actorRole: 'customer', meta: { disputeId: rows[0].id } });
    await holdPayoutItem(db, id, 'Open dispute');
    if (body.reason === 'asked_for_cash' && b.worker_id) {
      await raiseFlag(db, { workerId: b.worker_id, bookingId: id, customerId: req.auth.userId, type: 'cash_demand_report',
        severity: 'high', details: { source: 'dispute' } });
    }
    return rows[0].id;
  });
  res.status(201).json({ disputeId: out });
});

// ------------------------------------------------------ payments
cust.post('/payments/confirm', async (req, res) => {
  const body = parse(z.object({
    orderId: z.string().min(5).max(100),
    paymentId: z.string().min(5).max(100),
    signature: z.string().min(10).max(200),
  }).strict(), req.body);

  const { rows } = await query(
    `SELECT p.*, COALESCE(b.customer_id, s.customer_id) AS owner
       FROM payments p LEFT JOIN bookings b ON b.id = p.booking_id LEFT JOIN subscriptions s ON s.id = p.subscription_id
      WHERE p.gateway_order_id = $1`,
    [body.orderId],
  );
  const pay = rows[0];
  if (!pay || pay.owner !== req.auth.userId) throw notFound('Order not found');
  if (!payments.verifyCheckoutSignature(body)) throw badRequest('Payment signature verification failed');
  // Verify with the gateway itself; the browser's word is not enough.
  const gw = await payments.fetchAndCapture(body.paymentId, pay.amount);
  if (gw.orderId !== body.orderId) throw badRequest('Payment does not belong to this order');
  if (gw.status !== 'captured') throw conflict(`Payment is ${gw.status}`);
  const out = await tx((db) => markPaymentCaptured(db, { orderId: body.orderId, paymentId: body.paymentId, amount: gw.amount }));
  if (out.amountMismatch) throw badRequest('Payment amount does not match the order. Support has been notified.');
  res.json({ ok: true, alreadyCaptured: out.alreadyCaptured });
});

if (!config.isProduction) {
  // Development checkout that stands in for the Razorpay widget.
  cust.post('/payments/mock/checkout', async (req, res) => {
    if (payments.name !== 'mock') throw notFound();
    const body = parse(z.object({ orderId: z.string() }).strict(), req.body);
    const out = payments.simulateCheckout(body.orderId);
    if (!out) throw notFound('Order not found');
    res.json({ orderId: body.orderId, ...out });
  });
}

// ------------------------------------------------------ subscriptions
cust.post('/subscriptions', async (req, res) => {
  const b = parse(z.object({
    serviceId: uuid,
    addressId: uuid,
    frequency: z.enum(['monthly', 'quarterly', 'half_yearly']),
    visits: z.number().int().min(2).max(12),
    preferredHour: z.number().int().min(7).max(20),
    startDate: z.iso.date(),
    acceptTerms: z.literal(true),
  }).strict(), req.body);
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  if (b.startDate <= today) throw badRequest('Start date must be in the future');
  if (b.frequency === 'half_yearly' && b.visits > 4) throw badRequest('Half-yearly plans cover at most 4 visits');
  const out = await tx(async (db) => {
    const { rows: s } = await db.query('SELECT * FROM services WHERE id = $1 AND active', [b.serviceId]);
    if (!s[0]) throw notFound('Service not available');
    const { rows: a } = await db.query('SELECT id FROM addresses WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [b.addressId, req.auth.userId]);
    if (!a[0]) throw notFound('Address not found');
    const perVisit = s[0].fixed_price_paise;
    const { rows } = await db.query(
      `INSERT INTO subscriptions (customer_id, service_id, address_id, frequency, visits_total, preferred_hour,
                                  next_due_date, per_visit_paise, amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.auth.userId, b.serviceId, b.addressId, b.frequency, b.visits, b.preferredHour, b.startDate, perVisit, perVisit * b.visits],
    );
    const order = await payments.createOrder({ amount: rows[0].amount, receipt: `sub_${rows[0].id.slice(0, 30)}`, notes: { subscription_id: rows[0].id } });
    await db.query(`INSERT INTO payments (subscription_id, amount, gateway, gateway_order_id) VALUES ($1, $2, $3, $4)`,
      [rows[0].id, rows[0].amount, payments.name, order.orderId]);
    return { sub: rows[0], order: { orderId: order.orderId, amount: rows[0].amount, currency: 'INR', keyId: payments.publicKey(), provider: payments.name } };
  });
  res.status(201).json({ subscription: out.sub, order: out.order, monthsBetweenVisits: FREQUENCY_MONTHS[b.frequency] });
});

cust.get('/subscriptions', async (req, res) => {
  const { rows } = await query(
    `SELECT sb.*, s.name AS service_name FROM subscriptions sb JOIN services s ON s.id = sb.service_id
      WHERE sb.customer_id = $1 AND sb.status <> 'cancelled' ORDER BY sb.created_at DESC`,
    [req.auth.userId],
  );
  res.json({ subscriptions: rows });
});

// Shared by both parties on a booking: in-app chat and masked calling.
export async function loadBookingParty(bookingId, auth) {
  const { rows } = await query(
    `SELECT b.*, w.user_id AS worker_user_id FROM bookings b LEFT JOIN workers w ON w.id = b.worker_id WHERE b.id = $1`,
    [bookingId],
  );
  const b = rows[0];
  if (!b) throw notFound();
  const isCustomer = auth.role === 'customer' && b.customer_id === auth.userId;
  const isWorker = auth.role === 'worker' && b.worker_user_id === auth.userId;
  if (!isCustomer && !isWorker) throw notFound();
  return { booking: b, side: isCustomer ? 'customer' : 'worker' };
}

