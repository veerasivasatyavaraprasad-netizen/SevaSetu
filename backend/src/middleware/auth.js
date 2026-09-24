// Section 5.5: backend middleware checks token + role before every
// protected route. The role is never taken from the client: the token
// is verified, then the session and user are re-loaded from the database
// on every request so revocation, suspension and permission changes take
// effect immediately.

import { config } from '../config.js';
import { query } from '../db.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../services/sessions.js';

export function authenticate({ allowPendingMfa = false } = {}) {
  return async (req, _res, next) => {
    const header = req.get('authorization') || '';
    const m = /^Bearer (.+)$/.exec(header);
    if (!m) throw unauthorized();
    const claims = verifyAccessToken(m[1]);

    const { rows } = await query(
      `SELECT s.id, s.revoked_at, s.expires_at, s.last_seen_at, s.mfa_satisfied,
              u.id AS user_id, u.role, u.status, u.name,
              a.permissions,
              w.id AS worker_id, w.kyc_status, w.status AS worker_status, w.suspended_until,
              w.policy_ack_version
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN admin_accounts a ON a.user_id = u.id
         LEFT JOIN workers w ON w.user_id = u.id
        WHERE s.id = $1 AND s.user_id = $2`,
      [claims.sid, claims.sub],
    );
    const r = rows[0];
    if (!r || r.revoked_at || new Date(r.expires_at) < new Date()) throw unauthorized('Session ended');
    if (r.role !== claims.role) throw unauthorized('Role mismatch');
    // Worker suspensions live on workers.status (they can still see
    // earnings); users.status other than active blocks all access.
    if (r.status !== 'active') throw unauthorized('Account disabled');
    if (!r.mfa_satisfied && !allowPendingMfa) throw unauthorized('Two-factor authentication required');

    if (r.role === 'admin') {
      const idleMs = Date.now() - new Date(r.last_seen_at).getTime();
      if (idleMs > config.adminIdleMinutes * 60_000) {
        await query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'idle' WHERE id = $1`, [r.id]);
        throw unauthorized('Session expired due to inactivity');
      }
      if (idleMs > 30_000) {
        await query(
          `UPDATE sessions SET last_seen_at = now(),
                  expires_at = GREATEST(expires_at, now() + ($2 || ' minutes')::interval)
            WHERE id = $1`,
          [r.id, String(config.adminIdleMinutes)],
        );
      }
    }

    req.auth = {
      userId: r.user_id,
      role: r.role,
      sessionId: r.id,
      name: r.name,
      userStatus: r.status,
      mfa: r.mfa_satisfied,
      permissions: r.permissions || [],
      worker: r.worker_id ? {
        id: r.worker_id,
        kycStatus: r.kyc_status,
        status: r.worker_status,
        suspendedUntil: r.suspended_until,
        policyAckVersion: r.policy_ack_version,
      } : null,
    };
    next();
  };
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) throw forbidden();
    next();
  };
}

export function requirePermission(permission) {
  return (req, _res, next) => {
    if (!req.auth || req.auth.role !== 'admin' || !req.auth.permissions.includes(permission)) {
      throw forbidden(`Requires permission: ${permission}`);
    }
    next();
  };
}

// Section 5.2: returning worker gets the dashboard only if KYC approved.
// Accepting and working jobs additionally requires an active (not
// suspended) account and a current anti-cash policy acknowledgement.
export function requireApprovedWorker({ forWork = false } = {}) {
  return async (req, _res, next) => {
    const w = req.auth?.worker;
    if (req.auth?.role !== 'worker' || !w) throw forbidden();
    if (w.kycStatus !== 'approved') throw forbidden('Your account is under review');
    if (forWork) {
      if (w.status === 'suspended' && w.suspendedUntil && new Date(w.suspendedUntil) <= new Date()) {
        await query(
          `UPDATE workers SET status = 'active', suspended_until = NULL
            WHERE id = $1 AND status = 'suspended' AND suspended_until <= now()`,
          [w.id],
        );
        w.status = 'active';
      }
      if (w.status !== 'active') throw forbidden('Your account is suspended');
      if (w.policyAckVersion !== config.policyVersion) {
        throw forbidden('Please review and accept the current platform policy before taking jobs');
      }
    }
    next();
  };
}
