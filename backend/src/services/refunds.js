// Refunds. Admin-initiated refunds are maker-checker (Section 9.8: "approving
// fake refunds" is an insider risk): one admin requests, a different admin
// with refunds.approve approves. Refunds that follow automatically from
// the published cancellation policy are requested by the system and
// processed without a human in the loop.

import { tx } from '../db.js';
import { audit } from './audit.js';
import { payments } from './payments.js';
import { notify } from './notify.js';

export const REFUND_PENDING = 'Refund pending';

export async function findCapturedPayment(db, bookingId) {
  const { rows } = await db.query(
    `SELECT p.* FROM payments p JOIN bookings b ON b.id = $1
      WHERE (p.booking_id = b.id OR (b.subscription_id IS NOT NULL AND p.subscription_id = b.subscription_id))
        AND p.payment_status IN ('captured', 'partially_refunded')
      ORDER BY p.created_at LIMIT 1`,
    [bookingId],
  );
  return rows[0] || null;
}

// Refundable amount for this booking: its own price, minus what has
// already been refunded against it.
export async function refundableForBooking(db, bookingId) {
  const { rows } = await db.query(
    `SELECT b.amount - COALESCE((SELECT sum(amount) FROM refund_requests
                                  WHERE booking_id = b.id AND status IN ('requested', 'approved', 'processed')), 0) AS left
       FROM bookings b WHERE b.id = $1`,
    [bookingId],
  );
  return rows[0]?.left ?? 0;
}

export async function createRefundRequest(db, { bookingId, amount, reason, disputeId = null, requestedBy = null,
  autoApprove = false }) {
  const payment = await findCapturedPayment(db, bookingId);
  if (!payment) throw new Error('No captured payment to refund');
  const left = await refundableForBooking(db, bookingId);
  if (amount > left) throw new Error(`Refund exceeds refundable amount (${left} paise)`);
  const { rows } = await db.query(
    `INSERT INTO refund_requests (booking_id, payment_id, dispute_id, amount, reason, status, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [bookingId, payment.id, disputeId, amount, reason, autoApprove ? 'approved' : 'requested', requestedBy],
  );
  await audit(db, {
    actorId: requestedBy, actorRole: requestedBy ? 'admin' : 'system', action: 'refund.requested',
    targetTable: 'refund_requests', targetId: rows[0].id, newValue: { bookingId, amount, reason, autoApprove },
  });
  return rows[0];
}

// Calls the gateway outside any transaction, then records the result.
export async function processApprovedRefund(refundId) {
  const claimed = await tx(async (db) => {
    const { rows } = await db.query(
      `SELECT r.*, p.gateway_txn_id FROM refund_requests r JOIN payments p ON p.id = r.payment_id
        WHERE r.id = $1 AND r.status = 'approved' AND r.gateway_refund_id IS NULL FOR UPDATE OF r`,
      [refundId],
    );
    return rows[0] || null;
  });
  if (!claimed) return null;

  let result;
  try {
    result = await payments.refund(claimed.gateway_txn_id, claimed.amount, claimed.id);
  } catch (err) {
    await tx(async (db) => {
      await db.query(`UPDATE refund_requests SET status = 'failed', failure_reason = $2 WHERE id = $1`,
        [refundId, err.message.slice(0, 500)]);
      await audit(db, { actorRole: 'system', action: 'refund.failed', targetTable: 'refund_requests',
        targetId: refundId, newValue: { error: err.message.slice(0, 500) } });
    });
    return { status: 'failed' };
  }

  return tx(async (db) => {
    await db.query(
      `UPDATE refund_requests SET status = 'processed', gateway_refund_id = $2, processed_at = now() WHERE id = $1`,
      [refundId, result.refundId],
    );
    const { rows: pay } = await db.query(
      `UPDATE payments SET refunded_amount = refunded_amount + $2,
              payment_status = CASE WHEN refunded_amount + $2 >= amount THEN 'refunded' ELSE 'partially_refunded' END
        WHERE id = $1 RETURNING *`,
      [claimed.payment_id, claimed.amount],
    );
    const { rows: b } = await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [claimed.booking_id]);
    const booking = b[0];
    const fullyRefunded = (await refundableForBooking(db, booking.id)) <= 0;

    if (fullyRefunded && ['cancelled', 'disputed'].includes(booking.status)) {
      await db.query(`UPDATE bookings SET status = 'refunded' WHERE id = $1`, [booking.id]);
      await db.query(
        `INSERT INTO booking_events (booking_id, from_status, to_status, actor_role, meta)
         VALUES ($1, $2, 'refunded', 'system', $3)`,
        [booking.id, booking.status, JSON.stringify({ refundId })],
      );
      await db.query(
        `UPDATE payout_items SET status = 'cancelled', hold_reason = 'Booking refunded'
          WHERE booking_id = $1 AND status IN ('pending', 'held')`,
        [booking.id],
      );
    } else if (booking.worker_payout !== null) {
      // Partial refund: the worker's share shrinks in proportion.
      const cut = Math.round((claimed.amount * booking.worker_payout) / booking.amount);
      await db.query(
        `UPDATE payout_items SET amount = GREATEST(amount - $2, 0),
                status = CASE WHEN hold_reason = $3 THEN 'pending' ELSE status END,
                hold_reason = CASE WHEN hold_reason = $3 THEN NULL ELSE hold_reason END
          WHERE booking_id = $1 AND status IN ('pending', 'held')`,
        [booking.id, cut, REFUND_PENDING],
      );
    }
    await audit(db, { actorRole: 'system', action: 'refund.processed', targetTable: 'refund_requests',
      targetId: refundId, newValue: { amount: claimed.amount, gatewayRefundId: result.refundId,
        paymentStatus: pay[0].payment_status } });
    await notify(db, booking.customer_id, 'refund', 'Refund processed',
      `₹${(claimed.amount / 100).toFixed(2)} has been refunded to your original payment method.`);
    return { status: 'processed' };
  });
}
