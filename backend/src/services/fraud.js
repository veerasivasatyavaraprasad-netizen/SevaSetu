// Fraud flags (Section 9.5) and worker enforcement (Section 9.6).
//
// Automation only *flags*; a human in the admin fraud queue decides. The
// exceptions are the ones the plan names explicitly: payout holds (a hold
// is not a punishment — it just stops money leaving while someone looks)
// and GPS tampering, which the plan treats as an immediate security
// suspension.

import { audit } from './audit.js';
import { notify } from './notify.js';
import { revokeAllForUser } from './sessions.js';

export async function raiseFlag(db, { workerId = null, customerId = null, bookingId = null, type, severity, details = {} }) {
  const { rows } = await db.query(
    `INSERT INTO fraud_flags (worker_id, customer_id, booking_id, flag_type, severity, details)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [workerId, customerId, bookingId, type, severity, JSON.stringify(details)],
  );
  if (rows[0]) {
    await audit(db, {
      actorRole: 'system', action: 'fraud.flag_raised', targetTable: 'fraud_flags', targetId: rows[0].id,
      newValue: { type, severity, workerId, customerId, bookingId, details },
    });
  }
  return rows[0]?.id || null;
}

export async function holdWorkerPayouts(db, workerId, reason, actor = { role: 'system', id: null }) {
  const { rows } = await db.query(
    `UPDATE workers SET payout_hold = true, payout_hold_reason = $2, updated_at = now()
      WHERE id = $1 AND payout_hold = false RETURNING id`,
    [workerId, reason],
  );
  if (rows[0]) {
    await audit(db, {
      actorId: actor.id, actorRole: actor.role, action: 'worker.payout_hold', targetTable: 'workers',
      targetId: workerId, oldValue: { payout_hold: false }, newValue: { payout_hold: true, reason },
    });
  }
}

export async function holdPayoutItem(db, bookingId, reason) {
  await db.query(
    `UPDATE payout_items SET status = 'held', hold_reason = $2
      WHERE booking_id = $1 AND status = 'pending'`,
    [bookingId, reason],
  );
}

async function workerUser(db, workerId) {
  const { rows } = await db.query('SELECT user_id FROM workers WHERE id = $1', [workerId]);
  return rows[0].user_id;
}

// Section 9.6 enforcement table.
export async function applyStrike(db, { workerId, violation, flagId = null, actor }) {
  const { rows: prior } = await db.query(
    'SELECT count(*)::int AS n FROM strikes WHERE worker_id = $1 AND violation = $2',
    [workerId, violation],
  );
  const { rows: before } = await db.query(
    'SELECT status, suspended_until, payout_hold, policy_ack_version FROM workers WHERE id = $1 FOR UPDATE',
    [workerId],
  );
  const userId = await workerUser(db, workerId);
  let action;

  switch (violation) {
    case 'cash_demand': {
      const offence = prior[0].n + 1;
      if (offence === 1) {
        action = 'formal_warning_and_retraining';
        await db.query('UPDATE workers SET policy_ack_version = NULL WHERE id = $1', [workerId]);
        await notify(db, userId, 'strike', 'Formal warning: cash payment request',
          'A customer report of asking for cash was confirmed. Please re-read and accept the platform policy before taking new jobs. A second offence means a 7-day suspension.');
      } else if (offence === 2) {
        action = 'suspended_7_days';
        await db.query(
          `UPDATE workers SET status = 'suspended', suspended_until = now() + interval '7 days' WHERE id = $1`,
          [workerId],
        );
        await notify(db, userId, 'strike', 'Account suspended for 7 days',
          'A second confirmed cash-payment request. A third offence results in permanent deactivation.');
      } else {
        action = 'deactivated';
        await db.query(`UPDATE workers SET status = 'deactivated', suspended_until = NULL WHERE id = $1`, [workerId]);
        await db.query(`UPDATE users SET status = 'deactivated', updated_at = now() WHERE id = $1`, [userId]);
        await revokeAllForUser(db, userId, 'deactivated');
      }
      break;
    }
    case 'off_app_diversion':
      action = 'deactivated_payout_hold';
      await db.query(
        `UPDATE workers SET status = 'deactivated', payout_hold = true,
                payout_hold_reason = 'Confirmed off-app job diversion' WHERE id = $1`,
        [workerId],
      );
      await db.query(`UPDATE users SET status = 'deactivated', updated_at = now() WHERE id = $1`, [userId]);
      await revokeAllForUser(db, userId, 'deactivated');
      break;
    case 'minor_mismatch':
      action = 'reminder_and_30_day_monitoring';
      await db.query(`UPDATE workers SET monitoring_until = now() + interval '30 days' WHERE id = $1`, [workerId]);
      await notify(db, userId, 'reminder', 'Reminder: always complete jobs in the app',
        'We noticed a mismatch on a recent job. Please always check in at the customer address and complete with the customer OTP. Your account is under closer monitoring for 30 days.');
      break;
    case 'gps_tampering':
      action = 'suspended_security_violation';
      await db.query(
        `UPDATE workers SET status = 'suspended', suspended_until = NULL, payout_hold = true,
                payout_hold_reason = 'GPS tampering' WHERE id = $1`,
        [workerId],
      );
      break;
    default:
      throw new Error(`unknown violation ${violation}`);
  }

  await db.query('UPDATE workers SET strikes = strikes + 1, updated_at = now() WHERE id = $1', [workerId]);
  const { rows: strike } = await db.query(
    `INSERT INTO strikes (worker_id, violation, fraud_flag_id, action_taken, issued_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [workerId, violation, flagId, action, actor.id],
  );
  const { rows: after } = await db.query(
    'SELECT status, suspended_until, payout_hold, policy_ack_version FROM workers WHERE id = $1',
    [workerId],
  );
  await audit(db, {
    actorId: actor.id, actorRole: actor.role, action: `worker.strike.${violation}`, targetTable: 'workers',
    targetId: workerId, oldValue: before[0], newValue: { ...after[0], action, strikeId: strike[0].id }, ip: actor.ip,
  });
  return action;
}
