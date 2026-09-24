import { push } from './comms.js';
import { pool } from '../db.js';

// Writes an in-app notification inside the caller's transaction. Push is
// delivered best-effort after commit so a push failure
// never rolls back a business action.
export async function notify(db, userId, kind, title, body) {
  await db.query(
    'INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, $2, $3, $4)',
    [userId, kind, title, body],
  );
  const send = () => pool.query('SELECT token FROM device_tokens WHERE user_id = $1', [userId])
    .then(({ rows }) => push.send(rows.map((r) => r.token), { title, body, data: { kind } }))
    .catch((err) => console.error('push failed:', err.message));
  if (db.afterCommit) db.afterCommit(send);
  else send();
}
