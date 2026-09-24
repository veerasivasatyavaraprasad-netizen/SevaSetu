// Bootstrap an admin account (Section 5.3: no public signup).
//   npm run create-admin -- --email ops@example.com --name "Asha" \
//        --permissions bookings.manage,workers.kyc,...
// The password is read from ADMIN_PASSWORD (never a CLI argument, so it
// stays out of shell history). The admin must enrol 2FA at first login.

import argon2 from 'argon2';
import { parseArgs } from 'node:util';
import { tx, pool } from '../db.js';
import { PERMISSIONS, validatePermissionSet } from '../lib/permissions.js';
import { ARGON_OPTS, validatePasswordStrength } from '../routes/adminAuth.js';
import { audit } from '../services/audit.js';
import { migrate } from '../lib/migrate.js';

const { values } = parseArgs({
  options: { email: { type: 'string' }, name: { type: 'string' }, permissions: { type: 'string' } },
});
const password = process.env.ADMIN_PASSWORD || '';

try {
  if (!values.email || !values.name || !values.permissions) {
    throw new Error(`usage: ADMIN_PASSWORD=... npm run create-admin -- --email X --name Y --permissions a,b\npermissions: ${Object.keys(PERMISSIONS).join(', ')}`);
  }
  const weak = validatePasswordStrength(password);
  if (weak) throw new Error(`ADMIN_PASSWORD: ${weak}`);
  const perms = values.permissions.split(',').map((p) => p.trim()).filter(Boolean);
  const permErr = validatePermissionSet(perms);
  if (permErr) throw new Error(permErr);
  await migrate({ log: () => {} });
  await tx(async (db) => {
    const { rows } = await db.query(`INSERT INTO users (role, name, email) VALUES ('admin', $1, lower($2)) RETURNING id`, [values.name, values.email]);
    await db.query('INSERT INTO admin_accounts (user_id, password_hash, permissions) VALUES ($1, $2, $3)',
      [rows[0].id, await argon2.hash(password, ARGON_OPTS), perms]);
    await audit(db, { actorRole: 'cli', action: 'admin.created', targetTable: 'users', targetId: rows[0].id, newValue: { email: values.email, permissions: perms } });
    console.log(`created admin ${values.email} (${rows[0].id}); 2FA enrolment required at first login`);
  });
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
