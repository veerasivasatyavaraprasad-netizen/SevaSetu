// Section 7.3: subscriptions are charged upfront; the system generates
// each visit as a regular booking that follows the same GPS + OTP +
// payout rules.

import { decryptJson, encrypt, encryptJson, randomDigits } from '../lib/crypto.js';
import { tx } from '../db.js';
import { notify } from './notify.js';
import { notifyEligibleWorkers } from './bookings.js';

export const FREQUENCY_MONTHS = { monthly: 1, quarterly: 3, half_yearly: 6 };

function addMonths(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

// Generates visits due within the next 7 days.
export async function generateDueVisits() {
  return tx(async (db) => {
    const { rows } = await db.query(
      `SELECT s.*, a.details_enc, a.city, a.pincode, a.lat, a.lng, a.label
         FROM subscriptions s JOIN addresses a ON a.id = s.address_id
        WHERE s.status = 'active' AND s.visits_generated < s.visits_total
          AND s.next_due_date <= (now() AT TIME ZONE 'Asia/Kolkata')::date + 7
        FOR UPDATE OF s SKIP LOCKED`,
    );
    let created = 0;
    for (const s of rows) {
      const due = s.next_due_date;
      const hh = String(s.preferred_hour).padStart(2, '0');
      const scheduled = new Date(`${due}T${hh}:00:00+05:30`);
      const { rows: b } = await db.query(
        `INSERT INTO bookings (customer_id, service_id, subscription_id, address_id, address_enc, pincode, lat, lng,
                               scheduled_time, amount, completion_otp_enc, status, paid_at, city_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'paid', now(),
                 (SELECT city_id FROM city_pincodes WHERE pincode = $6)) RETURNING *`,
        [s.customer_id, s.service_id, s.id, s.address_id,
          encryptJson({ ...decryptJson(s.details_enc), city: s.city, pincode: s.pincode, label: s.label }),
          s.pincode, s.lat, s.lng, scheduled, s.per_visit_paise, encrypt(randomDigits(4))],
      );
      await db.query(
        `INSERT INTO booking_events (booking_id, to_status, actor_role, meta) VALUES ($1, 'paid', 'system', $2)`,
        [b[0].id, JSON.stringify({ subscriptionId: s.id, visit: s.visits_generated + 1 })],
      );
      const generated = s.visits_generated + 1;
      await db.query(
        `UPDATE subscriptions SET visits_generated = $2, next_due_date = $3,
                status = CASE WHEN $2 >= visits_total THEN 'completed' ELSE status END
          WHERE id = $1`,
        [s.id, generated, addMonths(due, FREQUENCY_MONTHS[s.frequency])],
      );
      await notify(db, s.customer_id, 'subscription', 'Upcoming scheduled visit',
        `Visit ${generated} of ${s.visits_total} is scheduled for ${due}. You can see it in My Bookings.`);
      await notifyEligibleWorkers(db, b[0]);
      created += 1;
    }
    return created;
  });
}
