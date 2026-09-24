// Razorpay / RazorpayX webhooks. Signature verified over the raw body;
// events de-duplicated by id. The webhook is the backstop that captures
// payments even if the customer closes the browser before the checkout
// callback reaches us.

import express, { Router } from 'express';
import { tx } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { markPaymentCaptured } from '../services/bookings.js';
import { payments } from '../services/payments.js';
import { recordPayoutResult } from '../services/payouts.js';

export const webhookRouter = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

webhookRouter.post('/razorpay', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  const raw = req.body instanceof Buffer ? req.body.toString('utf8') : '';
  if (!payments.verifyWebhook(raw, req.get('x-razorpay-signature'))) {
    res.status(400).json({ error: 'invalid signature' });
    return;
  }
  let evt;
  try {
    evt = JSON.parse(raw);
  } catch {
    throw badRequest('invalid json');
  }
  const eventId = req.get('x-razorpay-event-id') || `${evt.event}:${evt.payload?.payment?.entity?.id || evt.payload?.payout?.entity?.id || evt.created_at}`;
  // Recording the event and acting on it commit together, so a failed
  // run is retried by the gateway instead of being skipped as a duplicate.
  const duplicate = await tx(async (db) => {
    const { rowCount } = await db.query(
      'INSERT INTO webhook_events (id, provider, event) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [eventId, 'razorpay', evt.event],
    );
    if (!rowCount) return true;
    if (evt.event === 'payment.captured' || evt.event === 'order.paid') {
      const p = evt.payload.payment.entity;
      const { rows } = await db.query('SELECT 1 FROM payments WHERE gateway_order_id = $1', [p.order_id]);
      // Orders from other integrations on the same account are ignored.
      if (rows[0]) await markPaymentCaptured(db, { orderId: p.order_id, paymentId: p.id, amount: p.amount });
    } else if (evt.event?.startsWith('payout.')) {
      const po = evt.payload.payout.entity;
      if (UUID_RE.test(po.reference_id || '')) {
        await recordPayoutResult(db, {
          payoutId: po.reference_id, gatewayPayoutId: po.id, status: evt.event.split('.')[1], utr: po.utr,
          failureReason: po.status_details?.description,
        });
      }
    }
    return false;
  });
  if (duplicate) {
    res.json({ ok: true, duplicate: true });
    return;
  }
  res.json({ ok: true });
});
