// In-app chat and masked calling between a booking's customer and worker
// (Section 9.1). Neither side ever receives the other's phone number.

import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { decrypt } from '../lib/crypto.js';
import { conflict } from '../lib/errors.js';
import { redactMessage } from '../lib/redact.js';
import { parse } from '../lib/validate.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { calls } from '../services/comms.js';
import { raiseFlag } from '../services/fraud.js';
import { notify } from '../services/notify.js';
import { loadBookingParty } from './customer.js';

export const commsRouter = Router();
// Scoped to booking paths: this router is mounted at /api alongside public routes.
commsRouter.use('/bookings/:id', authenticate(), requireRole('customer', 'worker'));

const OPEN_STATUSES = ['assigned', 'in_progress', 'completed', 'confirmed', 'disputed'];

function assertChannelOpen(b) {
  if (!b.worker_id || !OPEN_STATUSES.includes(b.status)) throw conflict('Chat opens once a professional is assigned');
  const closedAt = b.confirmed_at || b.completed_at;
  if (closedAt && Date.now() - new Date(closedAt).getTime() > 7 * 86400_000) {
    throw conflict('This conversation is closed. Book again in the app to reach this professional.');
  }
}

commsRouter.get('/bookings/:id/messages', async (req, res) => {
  const { booking } = await loadBookingParty(parse(z.uuid(), req.params.id), req.auth);
  const { rows } = await query(
    'SELECT id, sender_role, body, redacted, created_at FROM messages WHERE booking_id = $1 ORDER BY id LIMIT 500',
    [booking.id],
  );
  res.json({ messages: rows });
});

const msgLimiter = rateLimit({ windowMs: 60_000, limit: config.isTest ? 1000 : 20, standardHeaders: 'draft-8', legacyHeaders: false });

commsRouter.post('/bookings/:id/messages', msgLimiter, async (req, res) => {
  const body = parse(z.object({ body: z.string().trim().min(1).max(1000) }).strict(), req.body);
  const { booking, side } = await loadBookingParty(parse(z.uuid(), req.params.id), req.auth);
  assertChannelOpen(booking);
  const clean = redactMessage(body.body);
  const msg = await tx(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO messages (booking_id, sender_id, sender_role, body, redacted) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, sender_role, body, redacted, created_at`,
      [booking.id, req.auth.userId, side, clean.text, clean.redacted],
    );
    if (side === 'worker' && (clean.mentionsOffAppPayment || clean.redacted)) {
      await raiseFlag(db, { workerId: booking.worker_id, bookingId: booking.id, type: 'chat_off_app_attempt', severity: 'medium',
        details: { redacted: clean.redacted, paymentWords: clean.mentionsOffAppPayment, messageId: rows[0].id } });
    }
    const recipient = side === 'customer' ? booking.worker_user_id : booking.customer_id;
    await notify(db, recipient, 'chat', 'New message', clean.text.slice(0, 80));
    return rows[0];
  });
  res.status(201).json({
    message: msg,
    notice: clean.redacted ? 'Contact details and payment IDs are hidden to keep your booking protected.' : null,
  });
});

const callLimiter = rateLimit({ windowMs: 10 * 60_000, limit: config.isTest ? 1000 : 6, standardHeaders: 'draft-8', legacyHeaders: false });

commsRouter.post('/bookings/:id/call', callLimiter, async (req, res) => {
  const { booking, side } = await loadBookingParty(parse(z.uuid(), req.params.id), req.auth);
  assertChannelOpen(booking);
  const { rows } = await query(
    `SELECT (SELECT phone_enc FROM users WHERE id = $1) AS customer_phone,
            (SELECT phone_enc FROM users WHERE id = $2) AS worker_phone`,
    [booking.customer_id, booking.worker_user_id],
  );
  const customerPhone = decrypt(rows[0].customer_phone);
  const workerPhone = decrypt(rows[0].worker_phone);
  const out = await calls.bridge({
    fromE164: side === 'customer' ? customerPhone : workerPhone,
    toE164: side === 'customer' ? workerPhone : customerPhone,
  });
  await query(
    `INSERT INTO masked_calls (booking_id, initiated_by_role, customer_id, worker_id, provider_call_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [booking.id, side, booking.customer_id, booking.worker_id, out.callId],
  );
  res.json({ ok: true, message: 'Connecting you through a masked number. Your phone will ring shortly.' });
});
