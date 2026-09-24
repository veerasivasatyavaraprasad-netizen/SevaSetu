// Worker app API (Section 3.2).

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { encrypt, encryptBuffer, sha256Hex } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { normalizeIdNumber, sniffMime } from '../lib/idproof.js';
import { WORKER_POLICY_SHA256, WORKER_POLICY_TEXT } from '../lib/policy.js';
import { parse } from '../lib/validate.js';
import { authenticate, requireApprovedWorker, requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import {
  acceptJob, checkIn, cityForPincode, completeJob, declineJob, FEATURED_SQL, priorityWindowMinutes, workerView, workerWithdraw,
} from '../services/bookings.js';
import { payments } from '../services/payments.js';

export const workerRouter = Router();
workerRouter.use(authenticate(), requireRole('worker'));

const uuid = z.uuid();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const SKILLS = ['cleaning', 'repairs', 'ac_service', 'pest_control', 'tutoring', 'plumbing', 'electrical', 'appliance_repair'];

async function loadWorker(userId) {
  const { rows } = await query(
    `SELECT w.*, u.name, u.phone_last4 FROM workers w JOIN users u ON u.id = w.user_id WHERE w.user_id = $1`,
    [userId],
  );
  return rows[0];
}

workerRouter.get('/me', async (req, res) => {
  const w = await loadWorker(req.auth.userId);
  const { rows: docs } = await query('SELECT doc_type, uploaded_at FROM kyc_documents WHERE worker_id = $1', [w.id]);
  res.json({
    worker: {
      id: w.id,
      name: w.name,
      phoneLast4: w.phone_last4,
      skillCategory: w.skill_category,
      serviceAreaPincode: w.service_area_pincode,
      kycStatus: w.kyc_status,
      kycRejectionReason: w.kyc_rejection_reason,
      idType: w.id_type,
      idLast4: w.id_last4,
      payoutMethod: w.payout_method,
      payoutMasked: w.payout_masked,
      payoutVerified: !!w.payout_verified_at,
      commissionRatePercent: w.commission_rate_bps / 100,
      rating: Number(w.rating_avg),
      ratingCount: w.rating_count,
      totalJobs: w.total_jobs,
      status: w.status,
      suspendedUntil: w.suspended_until,
      strikes: w.strikes,
      payoutHold: w.payout_hold,
      policyAccepted: w.policy_ack_version === config.policyVersion,
      documents: docs,
    },
    skills: SKILLS,
  });
});

// ---------------------------------------------------------- onboarding
function assertEditableKyc(w) {
  if (!['not_submitted', 'rejected'].includes(w.kyc_status)) {
    throw conflict('Your KYC is already submitted. Contact support to change it.');
  }
}

workerRouter.post('/onboarding', async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(3).max(80),
    skillCategory: z.enum(SKILLS),
    serviceAreaPincode: z.string().regex(/^[1-9]\d{5}$/),
    idType: z.enum(['aadhaar', 'pan', 'voter_id', 'driving_licence']),
    idNumber: z.string().max(30),
  }).strict(), req.body);
  const idNumber = normalizeIdNumber(body.idType, body.idNumber);
  if (!idNumber) throw badRequest('That ID number is not valid');
  const w = await loadWorker(req.auth.userId);
  assertEditableKyc(w);
  await tx(async (db) => {
    await cityForPincode(db, body.serviceAreaPincode);
    await db.query('UPDATE users SET name = $2, updated_at = now() WHERE id = $1', [req.auth.userId, body.name]);
    await db.query(
      `UPDATE workers SET skill_category = $2, service_area_pincode = $3, id_type = $4, id_number_enc = $5,
              id_last4 = $6, updated_at = now() WHERE id = $1`,
      [w.id, body.skillCategory, body.serviceAreaPincode, body.idType, encrypt(idNumber), idNumber.slice(-4)],
    );
  });
  res.json({ ok: true });
});

const DOC_TYPES = ['id_front', 'id_back', 'selfie'];

workerRouter.post('/kyc/documents', upload.single('file'), async (req, res) => {
  const body = parse(z.object({ docType: z.enum(DOC_TYPES) }).strict(), req.body);
  if (!req.file) throw badRequest('Attach a file');
  const mime = sniffMime(req.file.buffer);
  if (!mime) throw badRequest('Upload a JPEG, PNG or PDF file');
  if (body.docType === 'selfie' && mime === 'application/pdf') throw badRequest('Selfie must be a photo');
  const w = await loadWorker(req.auth.userId);
  assertEditableKyc(w);
  await tx(async (db) => {
    await db.query('DELETE FROM kyc_documents WHERE worker_id = $1 AND doc_type = $2', [w.id, body.docType]);
    // Encrypted at rest (Section 10).
    await db.query(
      `INSERT INTO kyc_documents (worker_id, doc_type, mime_type, size_bytes, sha256, content_enc)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [w.id, body.docType, mime, req.file.size, sha256Hex(req.file.buffer), encryptBuffer(req.file.buffer)],
    );
  });
  res.status(201).json({ ok: true });
});

// Section 8/10: bank/UPI verified via penny drop; only a tokenised
// reference from the gateway is stored, never the raw account number.
workerRouter.post('/payout-account', async (req, res) => {
  const body = parse(z.discriminatedUnion('method', [
    z.object({
      method: z.literal('bank_account'),
      holderName: z.string().trim().min(3).max(100),
      accountNumber: z.string().regex(/^\d{9,18}$/),
      ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/),
    }).strict(),
    z.object({
      method: z.literal('vpa'),
      holderName: z.string().trim().min(3).max(100),
      vpa: z.string().regex(/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/),
    }).strict(),
  ]), req.body);
  const w = await loadWorker(req.auth.userId);
  // Changing payout details is a high-risk action: re-verification needed.
  const result = await payments.registerAndVerifyPayoutAccount({
    workerId: w.id,
    name: body.holderName,
    method: body.method,
    bankAccount: body.method === 'bank_account' ? { accountNumber: body.accountNumber, ifsc: body.ifsc } : null,
    vpa: body.method === 'vpa' ? body.vpa : null,
  });
  if (!result.verified) {
    throw badRequest(result.pending
      ? 'Verification is taking longer than usual. Please try again in a few minutes.'
      : 'We could not verify this account. Check the details and try again.');
  }
  const masked = body.method === 'bank_account'
    ? `A/c ••••${body.accountNumber.slice(-4)} (${body.ifsc.slice(0, 4)})`
    : `${body.vpa.slice(0, 2)}•••@${body.vpa.split('@')[1]}`;
  await tx(async (db) => {
    const { rows: before } = await db.query('SELECT payout_masked, payout_verified_at FROM workers WHERE id = $1 FOR UPDATE', [w.id]);
    await db.query(
      `UPDATE workers SET payout_ref_token = $2, payout_method = $3, payout_masked = $4, payout_verified_at = now(),
              updated_at = now() WHERE id = $1`,
      [w.id, result.fundAccountId, body.method, masked],
    );
    await audit(db, { actorId: req.auth.userId, actorRole: 'worker', action: 'worker.payout_account_changed',
      targetTable: 'workers', targetId: w.id, oldValue: { masked: before[0].payout_masked }, newValue: { masked }, ip: req.ip });
  });
  res.json({ ok: true, payoutMasked: masked });
});

workerRouter.get('/policy', (_req, res) => {
  res.json({ version: config.policyVersion, sha256: WORKER_POLICY_SHA256, text: WORKER_POLICY_TEXT });
});

workerRouter.post('/policy/accept', async (req, res) => {
  const body = parse(z.object({ version: z.string(), sha256: z.string(), agree: z.literal(true) }).strict(), req.body);
  if (body.version !== config.policyVersion || body.sha256 !== WORKER_POLICY_SHA256) {
    throw conflict('The policy has changed. Please reload and read the latest version.');
  }
  const w = await loadWorker(req.auth.userId);
  await tx(async (db) => {
    await db.query(
      `INSERT INTO policy_acknowledgements (worker_id, policy_version, policy_sha256, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [w.id, body.version, body.sha256, req.ip, (req.get('user-agent') || '').slice(0, 300)],
    );
    await db.query('UPDATE workers SET policy_ack_version = $2, policy_ack_at = now() WHERE id = $1', [w.id, body.version]);
  });
  res.json({ ok: true });
});

workerRouter.post('/kyc/submit', async (req, res) => {
  const w = await loadWorker(req.auth.userId);
  assertEditableKyc(w);
  const { rows: docs } = await query('SELECT doc_type FROM kyc_documents WHERE worker_id = $1', [w.id]);
  const have = new Set(docs.map((d) => d.doc_type));
  const missing = [];
  if (!w.name || !w.skill_category || !w.service_area_pincode || !w.id_number_enc) missing.push('profile');
  for (const d of ['id_front', 'selfie']) if (!have.has(d)) missing.push(d);
  if (!w.payout_verified_at) missing.push('payout_account');
  if (w.policy_ack_version !== config.policyVersion) missing.push('policy');
  if (missing.length) throw badRequest('Onboarding incomplete', missing.map((m) => ({ path: m, message: 'required' })));
  await query(`UPDATE workers SET kyc_status = 'under_review', kyc_rejection_reason = NULL WHERE id = $1`, [w.id]);
  res.json({ kycStatus: 'under_review' });
});

// ---------------------------------------------------------------- jobs
const approved = requireApprovedWorker();
const canWork = requireApprovedWorker({ forWork: true });

workerRouter.get('/jobs/open', canWork, async (req, res) => {
  const w = await loadWorker(req.auth.userId);
  const { rows: f } = await query(`SELECT ${FEATURED_SQL} AS featured FROM workers w WHERE w.id = $1`, [w.id]);
  const featured = f[0].featured;
  const { rows: all } = await query(
    `SELECT b.*, s.name AS service_name, s.duration_minutes FROM bookings b JOIN services s ON s.id = b.service_id
      WHERE b.status = 'paid' AND b.worker_id IS NULL AND b.pincode = $1 AND s.category = $2
        AND b.scheduled_time > now()
        AND NOT EXISTS (SELECT 1 FROM booking_declines d WHERE d.booking_id = b.id AND d.worker_id = $3)
      ORDER BY b.scheduled_time LIMIT 50`,
    [w.service_area_pincode, w.skill_category, w.id],
  );
  // Featured professionals see new jobs first (Phase 3).
  const rows = featured ? all : all.filter((b) =>
    Date.now() >= new Date(b.paid_at || b.created_at).getTime() + priorityWindowMinutes(b) * 60_000);
  res.json({
    featured,
    hiddenInPriorityWindow: all.length - rows.length,
    jobs: rows.map((b) => ({
      ...workerView(b, { assignedToMe: false, commissionRateBps: w.commission_rate_bps }),
      serviceName: b.service_name,
      durationMinutes: b.duration_minutes,
    })),
  });
});

workerRouter.post('/jobs/:id/accept', canWork, async (req, res) => {
  const id = parse(uuid, req.params.id);
  const b = await tx((db) => acceptJob(db, { bookingId: id, worker: { id: req.auth.worker.id, userId: req.auth.userId } }));
  res.json({ job: workerView(b, { assignedToMe: true }) });
});

workerRouter.post('/jobs/:id/decline', canWork, async (req, res) => {
  await declineJob({ query }, { bookingId: parse(uuid, req.params.id), workerId: req.auth.worker.id });
  res.json({ ok: true });
});

workerRouter.get('/jobs', approved, async (req, res) => {
  const { rows } = await query(
    `SELECT b.*, s.name AS service_name FROM bookings b JOIN services s ON s.id = b.service_id
      WHERE b.worker_id = $1 ORDER BY b.scheduled_time DESC LIMIT 100`,
    [req.auth.worker.id],
  );
  res.json({ jobs: rows.map((b) => ({ ...workerView(b, { assignedToMe: true }), serviceName: b.service_name })) });
});

workerRouter.get('/jobs/:id', approved, async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { rows } = await query(
    `SELECT b.*, s.name AS service_name, s.duration_minutes, u.name AS customer_name
       FROM bookings b JOIN services s ON s.id = b.service_id JOIN users u ON u.id = b.customer_id
      WHERE b.id = $1 AND b.worker_id = $2`,
    [id, req.auth.worker.id],
  );
  if (!rows[0]) throw notFound();
  const b = rows[0];
  res.json({
    job: {
      ...workerView(b, { assignedToMe: true }),
      serviceName: b.service_name,
      durationMinutes: b.duration_minutes,
      // First name only. The customer's phone number is never exposed.
      customerFirstName: (b.customer_name || 'Customer').split(' ')[0],
      checkinRadiusM: config.booking.checkinRadiusM,
    },
  });
});

workerRouter.post('/jobs/:id/withdraw', canWork, async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ reason: z.string().trim().min(3).max(300) }).strict(), req.body);
  await tx((db) => workerWithdraw(db, { bookingId: id, worker: { id: req.auth.worker.id, userId: req.auth.userId }, reason: body.reason }));
  res.json({ ok: true });
});

const gpsSchema = {
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100000),
  // Reported by the native app (Android Location.isMock / isFromMockProvider).
  isMock: z.boolean().default(false),
};

workerRouter.post('/jobs/:id/checkin', canWork, async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object(gpsSchema).strict(), req.body);
  const out = await tx((db) => checkIn(db, {
    bookingId: id, worker: { id: req.auth.worker.id, userId: req.auth.userId }, ...body, accuracyM: Math.round(body.accuracyM),
  }));
  if (out.suspended) throw forbidden('Location spoofing detected. Your account has been suspended pending review.');
  if (!out.ok) {
    throw badRequest(`You are ${out.distanceM} m from the booked address. Check-in works within ${out.radiusM} m.`,
      [{ path: 'distanceM', message: String(out.distanceM) }]);
  }
  res.json({ ok: true, distanceM: out.distanceM, job: workerView(out.booking, { assignedToMe: true }) });
});

workerRouter.post('/jobs/:id/complete', canWork, async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ otp: z.string().regex(/^\d{4}$/), ...gpsSchema }).strict(), req.body);
  const out = await tx((db) => completeJob(db, {
    bookingId: id, worker: { id: req.auth.worker.id, userId: req.auth.userId }, ...body, accuracyM: Math.round(body.accuracyM),
  }));
  if (out.suspended) throw forbidden('Location spoofing detected. Your account has been suspended pending review.');
  if (!out.ok) throw badRequest(`Incorrect completion code. ${out.attemptsLeft} attempt(s) left.`);
  res.json({ ok: true, job: workerView(out.booking, { assignedToMe: true }) });
});

// ---------------------------------------------------------- earnings
workerRouter.get('/earnings', approved, async (req, res) => {
  const wid = req.auth.worker.id;
  const [summary, items, payouts] = await Promise.all([
    query(
      `SELECT
         COALESCE(sum(amount) FILTER (WHERE status = 'pending'), 0)::bigint AS pending,
         COALESCE(sum(amount) FILTER (WHERE status = 'held'), 0)::bigint AS held,
         COALESCE(sum(amount) FILTER (WHERE status = 'batched'), 0)::bigint AS processing,
         COALESCE(sum(amount) FILTER (WHERE status = 'paid'), 0)::bigint AS paid_total
       FROM payout_items WHERE worker_id = $1`, [wid]),
    query(
      `SELECT pi.booking_id, pi.amount, pi.status, pi.hold_reason, pi.created_at, s.name AS service_name, b.amount AS job_amount
         FROM payout_items pi JOIN bookings b ON b.id = pi.booking_id JOIN services s ON s.id = b.service_id
        WHERE pi.worker_id = $1 ORDER BY pi.created_at DESC LIMIT 100`, [wid]),
    query(
      `SELECT id, week_start, week_end, total_amount, status, utr_number, paid_at FROM payouts
        WHERE worker_id = $1 AND status <> 'cancelled' ORDER BY week_start DESC LIMIT 52`, [wid]),
  ]);
  const { rows: today } = await query(
    `SELECT count(*)::int AS n FROM bookings WHERE worker_id = $1 AND status IN ('assigned', 'in_progress')
        AND scheduled_time::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`, [wid]);
  res.json({ summary: { ...summary.rows[0], jobsToday: today[0].n }, items: items.rows, payouts: payouts.rows });
});

workerRouter.get('/reviews', approved, async (req, res) => {
  const { rows } = await query(
    `SELECT rating, comment, created_at FROM reviews WHERE worker_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.auth.worker.id],
  );
  res.json({ reviews: rows });
});

// ------------------------------------------------------ featured listing
// Plan §2: workers pay for priority visibility — featured professionals
// get new jobs in their area before everyone else.
workerRouter.get('/featured', approved, async (req, res) => {
  const [plans, mine] = await Promise.all([
    query('SELECT id, name, days, price_paise FROM featured_plans WHERE active ORDER BY days'),
    query(
      `SELECT id, days, amount, status, starts_at, ends_at FROM featured_listings
        WHERE worker_id = $1 AND status = 'active' AND ends_at > now() ORDER BY ends_at DESC`, [req.auth.worker.id]),
  ]);
  res.json({ plans: plans.rows, active: mine.rows, priorityMinutes: config.booking.featuredPriorityMinutes });
});

workerRouter.post('/featured', canWork, async (req, res) => {
  const body = parse(z.object({ planId: uuid }).strict(), req.body);
  const out = await tx(async (db) => {
    const { rows: p } = await db.query('SELECT * FROM featured_plans WHERE id = $1 AND active', [body.planId]);
    if (!p[0]) throw notFound('Plan not available');
    const { rows: fl } = await db.query(
      `INSERT INTO featured_listings (worker_id, plan_id, amount, days) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.auth.worker.id, p[0].id, p[0].price_paise, p[0].days]);
    const order = await payments.createOrder({ amount: p[0].price_paise, receipt: `ft_${fl[0].id.slice(0, 30)}`, notes: { featured_listing_id: fl[0].id } });
    await db.query('INSERT INTO payments (featured_listing_id, amount, gateway, gateway_order_id) VALUES ($1, $2, $3, $4)',
      [fl[0].id, p[0].price_paise, payments.name, order.orderId]);
    return { orderId: order.orderId, amount: p[0].price_paise, currency: 'INR', keyId: payments.publicKey(), provider: payments.name };
  });
  res.status(201).json({ order: out });
});
