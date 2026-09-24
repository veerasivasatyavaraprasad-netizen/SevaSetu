// Section 5.5: JWT access tokens carry role + user_id; refresh tokens
// are stored hashed, rotated on each use, and revoked on logout. Reuse of
// an already-rotated refresh token revokes the whole session family.

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';

function sessionTtlMs(role) {
  return role === 'admin'
    ? config.adminSessionHours * 3600_000
    : config.customerSessionDays * 86400_000;
}

export function signAccessToken({ userId, role, sessionId, mfa }) {
  return jwt.sign({ role, sid: sessionId, mfa }, config.jwtSecret, {
    algorithm: 'HS256',
    subject: userId,
    expiresIn: config.accessTokenTtlSec,
    issuer: 'sevasetu-api',
    audience: role === 'admin' ? 'sevasetu-admin' : 'sevasetu-app',
  });
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'sevasetu-api',
      audience: ['sevasetu-admin', 'sevasetu-app'],
    });
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}

export async function createSession(db, { userId, role, mfaSatisfied = true, ip, userAgent, familyId }) {
  const refreshToken = randomToken(32);
  const { rows } = await db.query(
    `INSERT INTO sessions (user_id, role, family_id, refresh_hash, expires_at, mfa_satisfied, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval, $6, $7, $8)
     RETURNING id`,
    [userId, role, familyId || crypto.randomUUID(), sha256(refreshToken), String(sessionTtlMs(role)),
      mfaSatisfied, ip, (userAgent || '').slice(0, 300)],
  );
  const sessionId = rows[0].id;
  return {
    sessionId,
    refreshToken: mfaSatisfied ? refreshToken : null,
    accessToken: signAccessToken({ userId, role, sessionId, mfa: mfaSatisfied }),
  };
}

// Returns { error } (rather than throwing) when a revocation must be
// committed before the request is rejected.
export async function rotateRefreshToken(db, refreshToken, { ip, userAgent, expectedRole }) {
  if (!refreshToken) throw unauthorized('No session');
  const { rows } = await db.query(
    `SELECT s.*, u.status AS user_status FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.refresh_hash = $1 FOR UPDATE OF s`,
    [sha256(refreshToken)],
  );
  const s = rows[0];
  if (!s) throw unauthorized('Session not found');
  if (expectedRole === 'admin' ? s.role !== 'admin' : s.role === 'admin') throw unauthorized('Session not found');
  if (s.revoked_at) {
    if (s.replaced_by) {
      // A rotated token was presented again: likely stolen. Kill the family.
      // Returned (not thrown) so the caller's transaction commits it.
      await db.query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'refresh_reuse'
          WHERE family_id = $1 AND revoked_at IS NULL`,
        [s.family_id],
      );
      return { error: unauthorized('Session revoked') };
    }
    throw unauthorized('Session revoked');
  }
  if (new Date(s.expires_at) < new Date()) throw unauthorized('Session expired');
  if (!s.mfa_satisfied) throw unauthorized('Two-factor authentication not completed');
  if (s.user_status !== 'active') throw unauthorized('Account disabled');
  if (s.role === 'admin' && Date.now() - new Date(s.last_seen_at).getTime() > config.adminIdleMinutes * 60_000) {
    await db.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'idle' WHERE id = $1`, [s.id]);
    return { error: unauthorized('Session expired due to inactivity') };
  }
  const next = await createSession(db, {
    userId: s.user_id, role: s.role, ip, userAgent, familyId: s.family_id,
  });
  await db.query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = 'rotated', replaced_by = $2 WHERE id = $1`,
    [s.id, next.sessionId],
  );
  return { ...next, userId: s.user_id, role: s.role };
}

export async function revokeSession(db, sessionId, reason = 'logout') {
  await db.query(
    'UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL',
    [sessionId, reason],
  );
}

export async function revokeAllForUser(db, userId, reason) {
  await db.query(
    'UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL',
    [userId, reason],
  );
}

export function refreshCookieName(role) {
  return role === 'admin' ? 'hl_admin_rt' : 'hl_rt';
}

export function setRefreshCookie(res, role, token) {
  res.cookie(refreshCookieName(role), token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: role === 'admin' ? '/api/admin-auth' : '/api/auth',
    maxAge: sessionTtlMs(role),
  });
}

export function clearRefreshCookie(res, role) {
  res.clearCookie(refreshCookieName(role), {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: role === 'admin' ? '/api/admin-auth' : '/api/auth',
  });
}
