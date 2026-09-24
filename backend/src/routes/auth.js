// Section 5: phone-OTP login for customers and workers.

import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { encrypt, lookupHash, randomDigits, timingSafeEqualStr } from '../lib/crypto.js';
import { forbidden, tooMany, unauthorized, badRequest } from '../lib/errors.js';
import { normalizeIndianMobile } from '../lib/phone.js';
import { parse } from '../lib/validate.js';
import { authenticate } from '../middleware/auth.js';
import { sms } from '../services/comms.js';
import {
  clearRefreshCookie, createSession, refreshCookieName, revokeSession, rotateRefreshToken, setRefreshCookie,
} from '../services/sessions.js';

export const authRouter = Router();

// IP-level limiter on top of the per-number DB limit below.
const otpIpLimiter = rateLimit({
  windowMs: 10 * 60_000, limit: config.isTest ? 1000 : 20, standardHeaders: 'draft-8', legacyHeaders: false,
});

const roleSchema = z.enum(['customer', 'worker']);

authRouter.post('/otp/request', otpIpLimiter, async (req, res) => {
  const body = parse(z.object({ phone: z.string().max(20), role: roleSchema }).strict(), req.body);
  const phone = normalizeIndianMobile(body.phone);
  const phoneHash = lookupHash(phone);

  const code = randomDigits(6);
  await tx(async (db) => {
    // Serialise per number so concurrent requests can't slip past the limit.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [phoneHash.toString('hex')]);
    // Section 10: max 3 OTP requests per 10 minutes per number.
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM otp_requests
        WHERE phone_hash = $1 AND created_at > now() - ($2 || ' seconds')::interval`,
      [phoneHash, String(config.otp.windowSec)],
    );
    if (rows[0].n >= config.otp.maxPerWindow) {
      throw tooMany('Too many OTP requests for this number. Try again in a few minutes.');
    }
    // Any older, still-valid codes stop working once a new one is issued.
    await db.query(
      'UPDATE otp_requests SET consumed_at = now() WHERE phone_hash = $1 AND consumed_at IS NULL',
      [phoneHash],
    );
    await db.query(
      `INSERT INTO otp_requests (phone_hash, role, code_hash, expires_at, ip_address)
       VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval, $5)`,
      [phoneHash, body.role, lookupHash(`${phone}:${code}`), String(config.otp.ttlSec), req.ip],
    );
  });
  await sms.sendOtp(phone, code);
  // Same response whether or not the account exists (no enumeration).
  res.json({ sent: true, expiresInSec: config.otp.ttlSec });
});

const verifySchema = z.object({
  phone: z.string().max(20),
  role: roleSchema,
  code: z.string().regex(/^\d{6}$/),
  acceptPrivacyPolicy: z.boolean().optional(),
}).strict();

authRouter.post('/otp/verify', otpIpLimiter, async (req, res) => {
  const body = parse(verifySchema, req.body);
  const phone = normalizeIndianMobile(body.phone);
  const phoneHash = lookupHash(phone);

  const result = await tx(async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM otp_requests
        WHERE phone_hash = $1 AND role = $2 AND consumed_at IS NULL AND expires_at > now()
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [phoneHash, body.role],
    );
    const otp = rows[0];
    if (!otp) return { error: unauthorized('OTP expired or not requested. Request a new one.') };
    if (otp.attempts >= config.otp.maxAttempts) {
      await db.query('UPDATE otp_requests SET consumed_at = now() WHERE id = $1', [otp.id]);
      return { error: tooMany('Too many wrong attempts. Request a new OTP.') };
    }
    const ok = timingSafeEqualStr(otp.code_hash.toString('hex'), lookupHash(`${phone}:${body.code}`).toString('hex'));
    if (!ok) {
      await db.query('UPDATE otp_requests SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
      return { error: unauthorized('Incorrect OTP') };
    }
    let { rows: users } = await db.query(
      'SELECT * FROM users WHERE phone_hash = $1 AND role = $2',
      [phoneHash, body.role],
    );
    let user = users[0];
    let isNew = false;
    if (!user) {
      // DPDP: explicit consent before we create an account holding PII.
      if (!body.acceptPrivacyPolicy) {
        // OTP stays valid so the user can retry after ticking consent.
        return { error: badRequest('Please accept the privacy policy to create an account', [{ path: 'acceptPrivacyPolicy', message: 'required' }]) };
      }
      ({ rows: users } = await db.query(
        `INSERT INTO users (role, phone_enc, phone_hash, phone_last4)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [body.role, encrypt(phone), phoneHash, phone.slice(-4)],
      ));
      user = users[0];
      isNew = true;
      await db.query(
        `INSERT INTO consents (user_id, purpose, policy_version, ip_address) VALUES ($1, 'privacy_policy', $2, $3)`,
        [user.id, config.privacyPolicyVersion, req.ip],
      );
      if (body.role === 'worker') {
        await db.query('INSERT INTO workers (user_id, commission_rate_bps) VALUES ($1, $2)',
          [user.id, config.defaultCommissionBps]);
      }
    }
    await db.query('UPDATE otp_requests SET consumed_at = now() WHERE id = $1', [otp.id]);
    if (user.status !== 'active') {
      return { error: forbidden('This account is suspended or deactivated. Contact support.') };
    }
    const session = await createSession(db, {
      userId: user.id, role: user.role, ip: req.ip, userAgent: req.get('user-agent'),
    });
    const { rows: w } = await db.query('SELECT kyc_status FROM workers WHERE user_id = $1', [user.id]);
    return { user, isNew, session, kycStatus: w[0]?.kyc_status || null };
  });

  if (result.error) throw result.error;

  setRefreshCookie(res, result.user.role, result.session.refreshToken);
  res.json({
    accessToken: result.session.accessToken,
    isNewUser: result.isNew,
    user: {
      id: result.user.id, role: result.user.role, name: result.user.name, phoneLast4: result.user.phone_last4,
      needsProfile: !result.user.name,
    },
    // Section 5.4: route new workers to onboarding, not home.
    next: result.user.role === 'worker'
      ? (result.kycStatus === 'approved' ? 'dashboard' : 'onboarding')
      : 'home',
    kycStatus: result.kycStatus,
  });
});

authRouter.post('/refresh', async (req, res) => {
  const token = req.cookies?.[refreshCookieName('customer')];
  const out = await tx((db) => rotateRefreshToken(db, token, {
    ip: req.ip, userAgent: req.get('user-agent'), expectedRole: 'app',
  })).then((r) => {
    if (r.error) throw r.error;
    return r;
  }).catch((err) => {
    clearRefreshCookie(res, 'customer');
    throw err;
  });
  setRefreshCookie(res, out.role, out.refreshToken);
  res.json({ accessToken: out.accessToken, role: out.role });
});

authRouter.post('/logout', authenticate(), async (req, res) => {
  await revokeSession({ query }, req.auth.sessionId);
  clearRefreshCookie(res, 'customer');
  res.json({ ok: true });
});
