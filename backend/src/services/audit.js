// Section 9.8: every admin (and security-relevant system) action is
// written to the append-only, hash-chained audit_logs table.

export async function audit(db, { actorId = null, actorRole, action, targetTable = null, targetId = null,
  oldValue = null, newValue = null, ip = null }) {
  await db.query(
    `INSERT INTO audit_logs (actor_id, actor_role, action, target_table, target_id, old_value, new_value, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [actorId, actorRole, action, targetTable, targetId === null ? null : String(targetId),
      oldValue === null ? null : JSON.stringify(oldValue),
      newValue === null ? null : JSON.stringify(newValue), ip],
  );
}

// Recomputes the chain; returns the first broken row id or null.
export async function verifyAuditChain(db) {
  const { rows } = await db.query(`
    SELECT id, row_hash, prev_hash,
      encode(sha256(convert_to(
        prev_hash || '|' || id || '|' || COALESCE(actor_id::text, '') || '|' || actor_role || '|' ||
        action || '|' || COALESCE(target_table, '') || '|' || COALESCE(target_id, '') || '|' ||
        COALESCE(old_value::text, '') || '|' || COALESCE(new_value::text, '') || '|' ||
        COALESCE(ip_address, '') || '|' ||
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'UTF8')), 'hex') AS recomputed,
      LAG(row_hash) OVER (ORDER BY id) AS previous
    FROM audit_logs ORDER BY id`);
  for (const r of rows) {
    if (r.recomputed !== r.row_hash) return { brokenAt: r.id, reason: 'row hash mismatch', checked: rows.length };
    if (r.previous !== null && r.previous !== r.prev_hash) return { brokenAt: r.id, reason: 'chain link mismatch', checked: rows.length };
  }
  return { brokenAt: null, checked: rows.length };
}
