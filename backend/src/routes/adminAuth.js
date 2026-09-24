// Section 5.3: admin login — email + password, mandatory authenticator
// 2FA, 2-hour inactivity expiry, every attempt logged with IP + device.
// No public signup: admins are created via CLI or by another admin.

import argon2 from 'argon2';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tx } from '../db.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { generateSecret, otpauthUrl, verifyTotp } from '../lib/totp.js';
import { parse } from '../lib/validate.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import {
  clearRefreshCookie, createSession, refreshCookieName, revokeSession, rotateRefreshToken, setRefreshCookie,
} from '../services/sessions.js';

export const adminAuthRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: config.isTest ? 1000 : 30, standardHeaders: 'draft-8', legacyHeaders: false,
});

// Used to equalise timing when the email doesn't exist.
const DUMMY_HASH = await argon2.hash('dummy-password-for-timing', { type: argon2.argon2id });

export const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function validatePasswordStrength(pw) {
  if (pw.length < 12) return 'Password must be at least 12 characters';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) return 'Password must mix at least three of: lowercase, uppercase, digits, symbols';
  return null;
}

async function logAttempt(req, { email, userId, success, stage, reason }) {
  await query(
    `INSERT INTO admin_login_attempts (email, user_id, success, stage, reason, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [email.slice(0, 200), userId, success, stage, reason, req.ip, (req.get('user-agent') || '').slice(0, 300)],
  );
}

async function registerFailure(adminUserId) {
  await query(
    `UPDATE admin_accounts
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= $2
                                THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
      WHERE user_id = $1`,
    [adminUserId, config.admin.maxFailedLogins, String(config.admin.lockoutMinutes)],
  );
}

adminAuthRouter.post('/login', loginLimiter, async (req, res) => {
  const body = parse(z.object({ email: z.string().max(200), password: z.string().max(200) }).strict(), req.body);
  const email = body.email.trim().toLowerCase();
  const { rows } = await query(
    `SELECT u.id, u.status, a.password_hash, a.totp_enabled, a.locked_until
       FROM users u JOIN admin_accounts a ON a.user_id = u.id
      WHERE u.role = 'admin' AND lower(u.email) = $1`,
    [email],
  );
  const admin = rows[0];
  const passwordOk = await argon2.verify(admin?.password_hash || DUMMY_HASH, body.password);

  if (!admin) {
    await logAttempt(req, { email, userId: null, success: false, stage: 'password', reason: 'unknown_email' });
    throw unauthorized('Invalid email or password');
  }
  if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
    await logAttempt(req, { email, userId: admin.id, success: false, stage: 'password', reason: 'locked' });
    throw unauthorized('Account temporarily locked after repeated failures. Try again later.');
  }
  if (admin.status !== 'active') {
    await logAttempt(req, { email, userId: admin.id, success: false, stage: 'password', reason: 'disabled' });
    throw unauthorized('Invalid email or password');
  }
  if (!passwordOk) {
    await registerFailure(admin.id);
    await logAttempt(req, { email, userId: admin.id, success: false, stage: 'password', reason: 'bad_password' });
    throw unauthorized('Invalid email or password');
  }
  await logAttempt(req, { email, userId: admin.id, success: true, stage: 'password', reason: 'password_ok' });

  // A limited session that can only complete 2FA.
  const session = await createSession({ query }, {
    userId: admin.id, role: 'admin', mfaSatisfied: false, ip: req.ip, userAgent: req.get('user-agent'),
  });
  res.json({
    stage: admin.totp_enabled ? 'totp' : 'totp_setup',
    pendingToken: session.accessToken,
  });
});

adminAuthRouter.post('/totp/setup', authenticate({ allowPendingMfa: true }), requireRole('admin'), async (req, res) => {
  const { rows } = await query('SELECT totp_enabled FROM admin_accounts WHERE user_id = $1', [req.auth.userId]);
  if (rows[0].totp_enabled) throw badRequest('Two-factor authentication is already set up');
  const secret = generateSecret();
  await query('UPDATE admin_accounts SET totp_secret_enc = $2 WHERE user_id = $1', [req.auth.userId, encrypt(secret)]);
  const { rows: u } = await query('SELECT email FROM users WHERE id = $1', [req.auth.userId]);
  const url = otpauthUrl({ secret, label: u[0].email, issuer: config.admin.totpIssuer });
  res.json({ otpauthUrl: url, secret, qrDataUrl: await QRCode.toDataURL(url) });
});

adminAuthRouter.post('/totp/verify', loginLimiter, authenticate({ allowPendingMfa: true }), requireRole('admin'),
  async (req, res) => {
    const body = parse(z.object({ code: z.string().regex(/^\d{6}$/) }).strict(), req.body);
    if (req.auth.mfa) throw badRequest('Session already verified');
    const out = await tx(async (db) => {
      const { rows } = await db.query(
        `SELECT a.*, u.email FROM admin_accounts a JOIN users u ON u.id = a.user_id
          WHERE a.user_id = $1 FOR UPDATE OF a`,
        [req.auth.userId],
      );
      const a = rows[0];
      if (a.locked_until && new Date(a.locked_until) > new Date()) return { error: 'locked', email: a.email };
      if (!a.totp_secret_enc) return { error: 'no_secret', email: a.email };
      const step = verifyTotp(decrypt(a.totp_secret_enc), body.code, {
        lastUsedStep: a.last_totp_step === null ? null : Number(a.last_totp_step),
      });
      if (step === null) return { error: 'bad_code', email: a.email };
      await db.query(
        `UPDATE admin_accounts SET totp_enabled = true, last_totp_step = $2, failed_attempts = 0,
                locked_until = NULL, last_login_at = now() WHERE user_id = $1`,
        [req.auth.userId, step],
      );
      if (!a.totp_enabled) {
        await audit(db, { actorId: req.auth.userId, actorRole: 'admin', action: 'admin.totp_enrolled',
          targetTable: 'users', targetId: req.auth.userId, ip: req.ip });
      }
      await revokeSession(db, req.auth.sessionId, 'mfa_completed');
      const session = await createSession(db, {
        userId: req.auth.userId, role: 'admin', ip: req.ip, userAgent: req.get('user-agent'),
      });
      return { session, email: a.email };
    });
    if (out.error) {
      if (out.error === 'bad_code') await registerFailure(req.auth.userId);
      await logAttempt(req, { email: out.email, userId: req.auth.userId, success: false, stage: 'totp', reason: out.error });
      throw unauthorized(out.error === 'locked' ? 'Account temporarily locked' : 'Invalid authentication code');
    }
    await logAttempt(req, { email: out.email, userId: req.auth.userId, success: true, stage: 'totp', reason: 'login' });
    setRefreshCookie(res, 'admin', out.session.refreshToken);
    res.json({ accessToken: out.session.accessToken });
  });

adminAuthRouter.post('/refresh', async (req, res) => {
  const token = req.cookies?.[refreshCookieName('admin')];
  const out = await tx((db) => rotateRefreshToken(db, token, {
    ip: req.ip, userAgent: req.get('user-agent'), expectedRole: 'admin',
  })).then((r) => {
    if (r.error) throw r.error;
    return r;
  }).catch((err) => {
    clearRefreshCookie(res, 'admin');
    throw err;
  });
  setRefreshCookie(res, 'admin', out.refreshToken);
  res.json({ accessToken: out.accessToken });
});

adminAuthRouter.post('/logout', authenticate({ allowPendingMfa: true }), requireRole('admin'), async (req, res) => {
  await revokeSession({ query }, req.auth.sessionId);
  clearRefreshCookie(res, 'admin');
  res.json({ ok: true });
});

adminAuthRouter.post('/password', authenticate(), requireRole('admin'), async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) }).strict(), req.body);
  const weak = validatePasswordStrength(body.newPassword);
  if (weak) throw badRequest(weak);
  const { rows } = await query('SELECT password_hash FROM admin_accounts WHERE user_id = $1', [req.auth.userId]);
  if (!(await argon2.verify(rows[0].password_hash, body.currentPassword))) throw unauthorized('Current password is incorrect');
  await tx(async (db) => {
    await db.query('UPDATE admin_accounts SET password_hash = $2 WHERE user_id = $1',
      [req.auth.userId, await argon2.hash(body.newPassword, ARGON_OPTS)]);
    await audit(db, { actorId: req.auth.userId, actorRole: 'admin', action: 'admin.password_changed',
      targetTable: 'users', targetId: req.auth.userId, ip: req.ip });
    // Sign out every other session.
    await db.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = 'password_changed'
        WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [req.auth.userId, req.auth.sessionId],
    );
  });
  res.json({ ok: true });
});

