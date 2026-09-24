// Seeds the service catalogue (idempotent). Prices are placeholders —
// set real prices from the admin panel.
import { pool, tx } from '../db.js';
import { migrate } from '../lib/migrate.js';

const SERVICES = [
  ['Home deep cleaning (2BHK)', 'cleaning', 349900, 240, 'Full home deep clean: kitchen, bathrooms, floors, windows.'],
  ['Bathroom cleaning', 'cleaning', 69900, 60, 'Descaling, tiles, fittings and floor.'],
  ['AC service (split)', 'ac_service', 59900, 60, 'Filter and coil cleaning, gas pressure check.'],
  ['AC gas refill', 'ac_service', 249900, 90, 'Leak check and refrigerant top-up.'],
  ['General pest control', 'pest_control', 119900, 60, 'Cockroach and ant treatment, odourless.'],
  ['Tap / leak repair', 'plumbing', 29900, 45, 'Fix leaking taps, pipes and fittings.'],
  ['Switch / socket repair', 'electrical', 19900, 30, 'Repair or replace switches and sockets.'],
  ['Washing machine repair', 'appliance_repair', 39900, 60, 'Diagnosis and repair labour.'],
  ['Furniture & door repair', 'repairs', 34900, 60, 'Hinges, handles, drawers and minor carpentry.'],
  ['Home tutoring (1 hour)', 'tutoring', 49900, 60, 'Verified tutor, school curriculum.'],
];

try {
  await migrate({ log: () => {} });
  await tx(async (db) => {
    for (const [name, category, price, mins, desc] of SERVICES) {
      await db.query(
        `INSERT INTO services (name, category, fixed_price_paise, duration_minutes, description)
         SELECT $1, $2, $3, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM services WHERE name = $1)`,
        [name, category, price, mins, desc]);
    }
  });
  console.log(`seeded ${SERVICES.length} services`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
