// Booking lifecycle (Section 7.1) with the anti-leakage controls of
// Section 9 built into each step. The database triggers in
// 001_init.sql enforce the same invariants a second time.

import { config } from '../config.js';
import { decrypt, decryptJson, encrypt, encryptJson, randomDigits, timingSafeEqualStr } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { distanceMeters } from '../lib/geo.js';
import { applyBps, splitCommission } from '../lib/money.js';
import { applyStrike, raiseFlag } from './fraud.js';
import { notify } from './notify.js';
import { payments } from './payments.js';
import { createRefundRequest } from './refunds.js';

export async function transition(db, booking, to, { actorId = null, actorRole, meta = {}, set = {} }) {
  const cols = Object.keys(set);
  const assignments = ['status = $2', ...cols.map((c, i) => `${c} = $${i + 3}`)].join(', ');
  const { rows } = await db.query(
    `UPDATE bookings SET ${assignments} WHERE id = $1 AND status = $${cols.length + 3} RETURNING *`,
    [booking.id, to, ...cols.map((c) => set[c]), booking.status],
  );
  if (!rows[0]) throw conflict('Booking changed in the meantime; refresh and try again');
  await db.query(
    `INSERT INTO booking_events (booking_id, from_status, to_status, actor_id, actor_role, meta)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [booking.id, booking.status, to, actorId, actorRole, JSON.stringify(meta)],
  );
  return rows[0];
}

export async function lockBooking(db, id) {
  const { rows } = await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Booking not found');
  return rows[0];
}

// ------------------------------------------------------------ pricing
const IST_OFFSET_MS = 5.5 * 3600_000;

export function istHour(date) {
  return new Date(date.getTime() + IST_OFFSET_MS).getUTCHours();
}

export function quote(service, scheduledTime, now = new Date()) {
  const lead = scheduledTime.getTime() - now.getTime();
  const isUrgent = lead < config.booking.urgentWithinHours * 3600_000;
  const premium = isUrgent ? applyBps(service.fixed_price_paise, service.urgent_premium_bps) : 0;
  return { isUrgent, basePrice: service.fixed_price_paise, urgentPremium: premium, total: service.fixed_price_paise + premium };
}

export function validateSlot(scheduledTime, now = new Date()) {
  if (Number.isNaN(scheduledTime.getTime())) throw badRequest('Invalid time');
  if (scheduledTime.getTime() < now.getTime() + config.booking.minLeadMinutes * 60_000) {
    throw badRequest(`Bookings need at least ${config.booking.minLeadMinutes} minutes notice`);
  }
  if (scheduledTime.getTime() > now.getTime() + 60 * 86400_000) throw badRequest('Bookings can be made up to 60 days ahead');
  const h = istHour(scheduledTime);
  if (h < 7 || h > 20) throw badRequest('Service hours are 7:00–21:00 IST');
}

// ------------------------------------------------------------ create
export async function createBooking(db, { customerId, serviceId, addressId, scheduledTime }) {
  const { rows: s } = await db.query('SELECT * FROM services WHERE id = $1 AND active', [serviceId]);
  if (!s[0]) throw notFound('Service not available');
  const { rows: a } = await db.query(
    'SELECT * FROM addresses WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [addressId, customerId],
  );
  if (!a[0]) throw notFound('Address not found');
  validateSlot(scheduledTime);
  // Section 9.1: price is fixed server-side from the catalogue, never
  // supplied by the client and never negotiated on site.
  const q = quote(s[0], scheduledTime);
  const addr = a[0];
  const { rows } = await db.query(
    `INSERT INTO bookings (customer_id, service_id, address_id, address_enc, pincode, lat, lng,
                           scheduled_time, is_urgent, amount, completion_otp_enc)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [customerId, serviceId, addressId,
      encryptJson({ ...decryptJson(addr.details_enc), city: addr.city, pincode: addr.pincode, label: addr.label }),
      addr.pincode, addr.lat, addr.lng, scheduledTime, q.isUrgent, q.total,
      // Section 9.3: 4-digit completion OTP, shown only to the customer.
      encrypt(randomDigits(4))],
  );
  const booking = rows[0];
  await db.query(
    `INSERT INTO booking_events (booking_id, to_status, actor_id, actor_role, meta) VALUES ($1, 'pending_payment', $2, 'customer', $3)`,
    [booking.id, customerId, JSON.stringify(q)],
  );
  const order = await payments.createOrder({
    amount: booking.amount, receipt: `bk_${booking.id.slice(0, 30)}`, notes: { booking_id: booking.id },
  });
  await db.query(
    `INSERT INTO payments (booking_id, amount, gateway, gateway_order_id) VALUES ($1, $2, $3, $4)`,
    [booking.id, booking.amount, payments.name, order.orderId],
  );
  return { booking, quote: q, order: { orderId: order.orderId, amount: booking.amount, currency: 'INR', keyId: payments.publicKey(), provider: payments.name } };
}

// ------------------------------------------------------------ payment
// Shared by the checkout callback and the gateway webhook; idempotent.
export async function markPaymentCaptured(db, { orderId, paymentId, amount }) {
  const { rows } = await db.query('SELECT * FROM payments WHERE gateway_order_id = $1 FOR UPDATE', [orderId]);
  const pay = rows[0];
  if (!pay) throw notFound('Unknown order');
  if (pay.payment_status !== 'created') {
    if (pay.gateway_txn_id && pay.gateway_txn_id !== paymentId) {
      await raiseFlag(db, { bookingId: pay.booking_id, type: 'duplicate_payment', severity: 'medium',
        details: { orderId, existing: pay.gateway_txn_id, second: paymentId } });
    }
    return { payment: pay, alreadyCaptured: true };
  }
  if (amount !== pay.amount) {
    // Not thrown: the flag must survive (callers decide how to respond).
    await raiseFlag(db, { bookingId: pay.booking_id, type: 'payment_amount_mismatch', severity: 'critical',
      details: { orderId, expected: pay.amount, received: amount } });
    return { payment: pay, amountMismatch: true };
  }
  const { rows: updated } = await db.query(
    `UPDATE payments SET payment_status = 'captured', gateway_txn_id = $2, paid_at = now() WHERE id = $1 RETURNING *`,
    [pay.id, paymentId],
  );

  if (pay.booking_id) {
    const booking = await lockBooking(db, pay.booking_id);
    if (booking.status === 'pending_payment') {
      const paid = await transition(db, booking, 'paid', { actorRole: 'system', meta: { paymentId }, set: { paid_at: new Date() } });
      await notify(db, booking.customer_id, 'booking', 'Payment received',
        'Your booking is confirmed. We are finding a verified professional near you.');
      await notifyEligibleWorkers(db, paid);
    } else if (booking.status === 'cancelled') {
      // Paid after cancelling: refund automatically.
      const r = await createRefundRequest(db, { bookingId: booking.id, amount: booking.amount,
        reason: 'Payment received for a cancelled booking', autoApprove: true });
      db.afterCommit?.(() => import('./refunds.js').then((m) => m.processApprovedRefund(r.id)));
    }
  } else if (pay.subscription_id) {
    const { rows: sub } = await db.query(
      `UPDATE subscriptions SET status = 'active' WHERE id = $1 AND status = 'pending_payment' RETURNING *`,
      [pay.subscription_id],
    );
    if (sub[0]) {
      await notify(db, sub[0].customer_id, 'subscription', 'Subscription active',
        'Your visits will be scheduled automatically. Each visit is completed with an OTP, just like a regular booking.');
    }
  }
  return { payment: updated[0], alreadyCaptured: false };
}

export async function notifyEligibleWorkers(db, booking) {
  const { rows } = await db.query(
    `SELECT w.user_id FROM workers w JOIN services s ON s.id = $2
      WHERE w.kyc_status = 'approved' AND w.status = 'active' AND w.service_area_pincode = $1
        AND w.skill_category = s.category AND w.policy_ack_version = $3
      LIMIT 50`,
    [booking.pincode, booking.service_id, config.policyVersion],
  );
  for (const r of rows) {
    await notify(db, r.user_id, 'job_request', 'New job near you', 'A paid job is available in your area. Open the app to accept.');
  }
}

// ------------------------------------------------------------ worker
export async function acceptJob(db, { bookingId, worker }) {
  const booking = await lockBooking(db, bookingId);
  if (booking.status !== 'paid' || booking.worker_id) throw conflict('This job is no longer available');
  const { rows: w } = await db.query('SELECT * FROM workers WHERE id = $1 FOR UPDATE', [worker.id]);
  const { rows: s } = await db.query('SELECT * FROM services WHERE id = $1', [booking.service_id]);
  if (w[0].service_area_pincode !== booking.pincode || w[0].skill_category !== s[0].category) {
    throw forbidden('This job is outside your service area or skill');
  }
  if (!w[0].payout_verified_at) throw forbidden('Verify your payout account before accepting jobs');
  // A worker can't take a job booked from their own phone number.
  const { rows: same } = await db.query(
    `SELECT 1 FROM users c, users wu WHERE c.id = $1 AND wu.id = $2 AND c.phone_hash = wu.phone_hash`,
    [booking.customer_id, w[0].user_id],
  );
  if (same[0]) {
    await raiseFlag(db, { workerId: worker.id, bookingId: booking.id, type: 'self_booking_attempt', severity: 'medium', details: {} });
    throw forbidden('You cannot accept a job booked from your own number');
  }
  // No double-booking: reject overlapping active jobs.
  const { rows: clash } = await db.query(
    `SELECT 1 FROM bookings b JOIN services s ON s.id = b.service_id
      WHERE b.worker_id = $1 AND b.status IN ('assigned', 'in_progress')
        AND tstzrange(b.scheduled_time, b.scheduled_time + (s.duration_minutes || ' minutes')::interval + interval '30 minutes')
         && tstzrange($2::timestamptz, $2::timestamptz + ($3 || ' minutes')::interval + interval '30 minutes')
      LIMIT 1`,
    [worker.id, booking.scheduled_time, String(s[0].duration_minutes)],
  );
  if (clash[0]) throw conflict('You already have a job at that time');
  // Section 7.2: commission snapshotted from the worker's own rate.
  const split = splitCommission(booking.amount, w[0].commission_rate_bps);
  const updated = await transition(db, booking, 'assigned', {
    actorId: worker.userId, actorRole: 'worker', meta: { workerId: worker.id },
    set: {
      worker_id: worker.id, accepted_at: new Date(), commission_rate_bps: w[0].commission_rate_bps,
      commission_amount: split.commission, worker_payout: split.workerPayout,
    },
  });
  await notify(db, booking.customer_id, 'booking', 'Professional assigned',
    'A verified professional accepted your booking. Chat and calls stay inside the app.');
  return updated;
}

export async function declineJob(db, { bookingId, workerId }) {
  await db.query('INSERT INTO booking_declines (booking_id, worker_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [bookingId, workerId]);
}

// Worker withdraws before starting: the job goes back to the open pool.
export async function workerWithdraw(db, { bookingId, worker, reason }) {
  const booking = await lockBooking(db, bookingId);
  if (booking.worker_id !== worker.id || booking.status !== 'assigned') throw conflict('You can only withdraw from an assigned job you have not started');
  await declineJob(db, { bookingId, workerId: worker.id });
  const updated = await transition(db, booking, 'paid', {
    actorId: worker.userId, actorRole: 'worker', meta: { withdrawn: true, reason },
    set: { worker_id: null, accepted_at: null, commission_rate_bps: null, commission_amount: null, worker_payout: null },
  });
  await notifyEligibleWorkers(db, updated);
  await notify(db, booking.customer_id, 'booking', 'Finding another professional',
    'Your assigned professional is unavailable. We are assigning someone else at no extra cost.');
  return updated;
}

// Section 9.2: GPS check-in within radius of the booked address.
export async function checkIn(db, { bookingId, worker, lat, lng, accuracyM, isMock }) {
  const booking = await lockBooking(db, bookingId);
  if (booking.worker_id !== worker.id) throw forbidden();
  if (booking.status !== 'assigned') throw conflict('Job is not awaiting check-in');
  const now = Date.now();
  const sched = new Date(booking.scheduled_time).getTime();
  if (now < sched - 2 * 3600_000) throw badRequest('Check-in opens 2 hours before the scheduled time');
  if (now > sched + 12 * 3600_000) throw badRequest('The check-in window for this job has passed. Contact support.');

  const distance = distanceMeters(lat, lng, booking.lat, booking.lng);

  if (isMock) {
    // Section 9.6: mock-location tampering is an immediate security suspension.
    await db.query(
      `INSERT INTO gps_pings (booking_id, worker_id, kind, lat, lng, accuracy_m, distance_m, is_mock)
       VALUES ($1, $2, 'checkin_rejected', $3, $4, $5, $6, true)`,
      [booking.id, worker.id, lat, lng, accuracyM, distance],
    );
    const flagId = await raiseFlag(db, { workerId: worker.id, bookingId: booking.id, type: 'gps_tampering',
      severity: 'critical', details: { distance } });
    await applyStrike(db, { workerId: worker.id, violation: 'gps_tampering', flagId, actor: { id: null, role: 'system' } });
    return { ok: false, suspended: true };
  }
  if (accuracyM > config.booking.maxGpsAccuracyM) {
    throw badRequest(`GPS signal too weak (±${accuracyM} m). Move to an open area and try again.`);
  }
  if (distance > config.booking.checkinRadiusM) {
    await db.query(
      `INSERT INTO gps_pings (booking_id, worker_id, kind, lat, lng, accuracy_m, distance_m)
       VALUES ($1, $2, 'checkin_rejected', $3, $4, $5, $6)`,
      [booking.id, worker.id, lat, lng, accuracyM, distance],
    );
    if (distance > config.booking.gpsFlagDistanceM) {
      await raiseFlag(db, { workerId: worker.id, bookingId: booking.id, type: 'checkin_far_from_address',
        severity: 'medium', details: { distanceM: distance } });
    }
    return { ok: false, distanceM: distance, radiusM: config.booking.checkinRadiusM };
  }

  await db.query(
    `INSERT INTO gps_pings (booking_id, worker_id, kind, lat, lng, accuracy_m, distance_m)
     VALUES ($1, $2, 'checkin', $3, $4, $5, $6)`,
    [booking.id, worker.id, lat, lng, accuracyM, distance],
  );
  const updated = await transition(db, booking, 'in_progress', {
    actorId: worker.userId, actorRole: 'worker', meta: { distanceM: distance },
    set: { checkin_at: new Date(), checkin_distance_m: distance },
  });
  await notify(db, booking.customer_id, 'booking', 'Your professional has arrived',
    'Share the completion code only when you are satisfied the job is done. Never pay in cash.');
  return { ok: true, booking: updated, distanceM: distance };
}

// Section 9.3: completion requires the customer's OTP.
export async function completeJob(db, { bookingId, worker, otp, lat, lng, accuracyM, isMock }) {
  const booking = await lockBooking(db, bookingId);
  if (booking.worker_id !== worker.id) throw forbidden();
  if (booking.status !== 'in_progress') throw conflict('Job is not in progress');
  if (booking.completion_otp_attempts >= config.booking.completionOtpMaxAttempts) {
    throw forbidden('Too many incorrect codes. Support has been notified.');
  }
  if (isMock) {
    const flagId = await raiseFlag(db, { workerId: worker.id, bookingId: booking.id, type: 'gps_tampering', severity: 'critical', details: { stage: 'checkout' } });
    await applyStrike(db, { workerId: worker.id, violation: 'gps_tampering', flagId, actor: { id: null, role: 'system' } });
    return { ok: false, suspended: true };
  }
  if (!timingSafeEqualStr(decrypt(booking.completion_otp_enc), otp)) {
    const { rows } = await db.query(
      'UPDATE bookings SET completion_otp_attempts = completion_otp_attempts + 1 WHERE id = $1 RETURNING completion_otp_attempts',
      [booking.id],
    );
    const attempts = rows[0].completion_otp_attempts;
    if (attempts >= config.booking.completionOtpMaxAttempts) {
      await raiseFlag(db, { workerId: worker.id, bookingId: booking.id, type: 'completion_otp_bruteforce',
        severity: 'high', details: { attempts } });
    }
    return { ok: false, attemptsLeft: Math.max(0, config.booking.completionOtpMaxAttempts - attempts) };
  }

  const distance = distanceMeters(lat, lng, booking.lat, booking.lng);
  await db.query(
    `INSERT INTO gps_pings (booking_id, worker_id, kind, lat, lng, accuracy_m, distance_m)
     VALUES ($1, $2, 'checkout', $3, $4, $5, $6)`,
    [booking.id, worker.id, lat, lng, accuracyM, distance],
  );
  if (distance > config.booking.gpsFlagDistanceM) {
    await raiseFlag(db, { workerId: worker.id, bookingId: booking.id, type: 'checkout_far_from_address',
      severity: 'medium', details: { distanceM: distance } });
  }
  const now = new Date();
  const updated = await transition(db, booking, 'completed', {
    actorId: worker.userId, actorRole: 'worker', meta: { checkoutDistanceM: distance },
    set: { otp_verified_at: now, completed_at: now, checkout_at: now, checkout_distance_m: distance },
  });
  await notify(db, booking.customer_id, 'booking', 'Job completed',
    'Please confirm and rate the service. It will be auto-confirmed in 24 hours if you do nothing.');
  return { ok: true, booking: updated };
}

// Section 7.1 step 5/6: confirmation moves the worker share into the payout queue.
export async function confirmBooking(db, booking, { actorId = null, actorRole, auto = false }) {
  const updated = await transition(db, booking, 'confirmed', {
    actorId, actorRole, meta: { auto }, set: { confirmed_at: new Date(), auto_confirmed: auto },
  });
  await db.query(
    `INSERT INTO payout_items (booking_id, worker_id, amount) VALUES ($1, $2, $3) ON CONFLICT (booking_id) DO NOTHING`,
    [booking.id, booking.worker_id, booking.worker_payout],
  );
  await db.query('UPDATE workers SET total_jobs = total_jobs + 1 WHERE id = $1', [booking.worker_id]);
  return updated;
}

export async function autoConfirmDue(db) {
  const { rows } = await db.query(
    `SELECT * FROM bookings WHERE status = 'completed'
        AND completed_at < now() - ($1 || ' hours')::interval
      ORDER BY completed_at LIMIT 500 FOR UPDATE SKIP LOCKED`,
    [String(config.booking.autoConfirmHours)],
  );
  for (const b of rows) await confirmBooking(db, b, { actorRole: 'system', auto: true });
  return rows.length;
}

// ------------------------------------------------------- cancellation
// Consumer-protection policy shown before booking: free cancellation up
// to 2 hours before the slot; later than that, a 10% fee is retained.
export function cancellationTerms(booking, now = new Date()) {
  if (booking.status === 'pending_payment') return { refund: 0, fee: 0 };
  const hoursBefore = (new Date(booking.scheduled_time).getTime() - now.getTime()) / 3600_000;
  const fee = hoursBefore >= config.booking.freeCancelHoursBefore ? 0 : applyBps(booking.amount, config.booking.lateCancelFeeBps);
  return { refund: booking.amount - fee, fee };
}

export async function customerCancel(db, { bookingId, customerId, reason }) {
  const booking = await lockBooking(db, bookingId);
  if (booking.customer_id !== customerId) throw notFound('Booking not found');
  if (!['pending_payment', 'paid', 'assigned'].includes(booking.status)) {
    throw conflict('This booking can no longer be cancelled. Raise an issue instead.');
  }
  const terms = cancellationTerms(booking);
  const updated = await transition(db, booking, 'cancelled', {
    actorId: customerId, actorRole: 'customer', meta: { ...terms, hadWorker: !!booking.worker_id, workerId: booking.worker_id },
    set: { cancelled_at: new Date(), cancelled_by_role: 'customer', cancel_reason: reason || null },
  });
  let refundId = null;
  if (terms.refund > 0) {
    const r = await createRefundRequest(db, { bookingId, amount: terms.refund, reason: 'Customer cancellation (policy)', autoApprove: true });
    refundId = r.id;
  }
  if (booking.worker_id) {
    const { rows } = await db.query('SELECT user_id FROM workers WHERE id = $1', [booking.worker_id]);
    await notify(db, rows[0].user_id, 'booking', 'Job cancelled', 'The customer cancelled this booking.');
  }
  return { booking: updated, terms, refundId };
}

// ------------------------------------------------------------ views
export function customerView(b, extra = {}) {
  const showOtp = ['assigned', 'in_progress'].includes(b.status);
  return {
    id: b.id,
    status: b.status,
    serviceId: b.service_id,
    scheduledTime: b.scheduled_time,
    isUrgent: b.is_urgent,
    amount: b.amount,
    address: decryptJson(b.address_enc),
    workerAssigned: !!b.worker_id,
    // Section 9.3: OTP shown only to the customer.
    completionOtp: showOtp ? decrypt(b.completion_otp_enc) : null,
    paidAt: b.paid_at,
    checkinAt: b.checkin_at,
    completedAt: b.completed_at,
    confirmedAt: b.confirmed_at,
    cancelledAt: b.cancelled_at,
    createdAt: b.created_at,
    subscriptionId: b.subscription_id,
    ...extra,
  };
}

// Section 9.1: job details and address only after payment and acceptance;
// the worker never sees payout internals of others or customer phone.
export function workerView(b, { assignedToMe, commissionRateBps = null }) {
  const base = {
    id: b.id,
    status: b.status,
    serviceId: b.service_id,
    scheduledTime: b.scheduled_time,
    isUrgent: b.is_urgent,
    pincode: b.pincode,
    yourEarning: assignedToMe
      ? b.worker_payout
      : (commissionRateBps === null ? null : splitCommission(b.amount, commissionRateBps).workerPayout),
  };
  if (!assignedToMe) return base;
  const addr = decryptJson(b.address_enc);
  return {
    ...base,
    address: addr,
    location: { lat: b.lat, lng: b.lng },
    checkinAt: b.checkin_at,
    completedAt: b.completed_at,
    confirmedAt: b.confirmed_at,
    otpAttemptsLeft: Math.max(0, config.booking.completionOtpMaxAttempts - b.completion_otp_attempts),
  };
}
