// First-run admin accounts from environment variables, for hosts with no
// shell access (e.g. Render free tier). Runs only while no admin exists,
// and creates two people so maker-checker works from day one:
//   ops     — runs the platform, prepares payouts, creates admins
//   finance — approves payouts, refunds and other admins' changes
// Both must enrol TOTP 2FA at first login.

import argon2 from 'argon2';
import { config } from '../config.js';
import { tx } from '../db.js';
import { validatePermissionSet } from '../lib/permissions.js';
import { ARGON_OPTS, validatePasswordStrength } from '../routes/adminAuth.js';
import { audit } from './audit.js';

export const OPS_PERMISSIONS = [
  'reports.view', 'bookings.manage', 'workers.kyc', 'workers.enforce', 'commission.request', 'customers.view',
  'payouts.prepare', 'disputes.manage', 'fraud.review', 'catalog.manage', 'audit.view', 'admins.manage',
];
export const FINANCE_PERMISSIONS = ['payouts.approve', 'refunds.approve', 'changes.approve', 'reports.view', 'audit.view'];

export async function bootstrapAdmins() {
  const b = config.bootstrap;
  const wanted = [
    [b.opsEmail, b.opsPassword, 'Operations', OPS_PERMISSIONS],
    [b.financeEmail, b.financePassword, 'Finance', FINANCE_PERMISSIONS],
  ].filter(([email]) => email);
  if (wanted.length === 0) return;
  await tx(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['bootstrap_admins']);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`);
    if (rows[0].n > 0) return;
    for (const [email, password, name, perms] of wanted) {
      const weak = validatePasswordStrength(password);
      if (weak) throw new Error(`Bootstrap admin ${email}: ${weak}`);
      const permErr = validatePermissionSet(perms);
      if (permErr) throw new Error(permErr);
      const { rows: u } = await db.query(`INSERT INTO users (role, name, email) VALUES ('admin', $1, lower($2)) RETURNING id`, [name, email]);
      await db.query('INSERT INTO admin_accounts (user_id, password_hash, permissions) VALUES ($1, $2, $3)',
        [u[0].id, await argon2.hash(password, ARGON_OPTS), perms]);
      await audit(db, { actorRole: 'system', action: 'admin.bootstrapped', targetTable: 'users', targetId: u[0].id, newValue: { email, permissions: perms } });
      console.log(`bootstrapped admin ${email}; 2FA enrolment required at first login`);
    }
  });
}
