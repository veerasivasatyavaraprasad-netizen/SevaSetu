import { useState } from 'react';
import { api, fmtDate, fmtDateTime } from '../api.js';
import { useAdmin } from '../session.jsx';
import { ErrorNote, Field, Loading, useAction, useApi } from '../ui.jsx';
import { Table } from './common.jsx';

export default function Admins() {
  const { allPermissions, admin: me, can } = useAdmin();
  const [data, error, reload] = useApi('/admin/admins');
  const [f, setF] = useState(null);
  const act = useAction();
  if (!data) return error ? <ErrorNote error={error} /> : <Loading />;
  const reviewDue = (a) => Date.now() - new Date(a.access_reviewed_at).getTime() > data.accessReviewDueDays * 86400_000;
  const togglePerm = (p) => setF({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter((x) => x !== p) : [...f.permissions, p] });

  const save = (e) => {
    e.preventDefault();
    act.run(async () => {
      if (f.id) await api(`/admin/admins/${f.id}`, { method: 'PATCH', body: { permissions: f.permissions } });
      else await api('/admin/admins', { method: 'POST', body: { name: f.name, email: f.email, temporaryPassword: f.password, permissions: f.permissions } });
      setF(null);
      reload();
    });
  };
  const post = (path, body) => act.run(async () => { await api(path, { method: body?.method || 'POST', body: body?.body }); reload(); });

  return (
    <div className="stack">
      <div className="row between"><h1 style={{ margin: 0 }}>Admins & access</h1>{can('admins.manage') && <button className="btn primary" onClick={() => setF({ name: '', email: '', password: '', permissions: [] })}>+ New admin</button>}</div>
      <p className="small muted">Each person gets their own account. Review access every quarter and remove what isn't needed. Conflicting duties (e.g. approving payouts and changing commission) can't be combined. New access only takes effect after a second admin approves it; removing access is immediate.</p>
      <ErrorNote error={act.error} />
      <Table rows={data.admins} cols={[
        ['name', 'Name', (r) => `${r.name}${r.id === me.id ? ' (you)' : ''}`], ['email', 'Email'],
        ['permissions', 'Permissions', (r) => (
          <span className="small">
            {r.permissions.join(', ') || <em className="muted">none</em>}
            {r.pending_permissions && (
              <span style={{ display: 'block', marginTop: 4 }}>
                <span className="badge warn">pending</span> {r.pending_permissions.join(', ')}
                {can('changes.approve') && r.pending_requested_by !== me.id && r.id !== me.id && (
                  <span className="row" style={{ marginTop: 4 }}>
                    <button className="btn sm primary" onClick={() => post(`/admin/admins/${r.id}/approve-access`, { body: { approve: true } })}>Approve access</button>
                    <button className="btn sm" onClick={() => post(`/admin/admins/${r.id}/approve-access`, { body: { approve: false } })}>Reject</button>
                  </span>
                )}
              </span>
            )}
          </span>
        )],
        ['totp_enabled', '2FA', (r) => (r.totp_enabled ? 'on' : <span className="badge warn">not enrolled</span>)],
        ['last_login_at', 'Last login', (r) => (r.last_login_at ? fmtDateTime(r.last_login_at) : '—')],
        ['access_reviewed_at', 'Access reviewed', (r) => <span className={reviewDue(r) ? 'badge danger' : ''}>{fmtDate(r.access_reviewed_at)}</span>],
        ['status', 'Status'],
        ['actions', '', (r) => (r.id === me.id || !can('admins.manage') ? '' : (
          <div className="row wrap">
            <button className="btn sm" onClick={() => setF({ id: r.id, name: r.name, permissions: r.permissions })}>Edit</button>
            <button className="btn sm" onClick={() => post(`/admin/admins/${r.id}/access-reviewed`)}>Mark reviewed</button>
            <button className="btn sm" onClick={() => { if (window.confirm('Reset 2FA? They must re-enrol at next login.')) post(`/admin/admins/${r.id}/reset-2fa`); }}>Reset 2FA</button>
            <button className="btn sm danger" onClick={() => post(`/admin/admins/${r.id}`, { method: 'PATCH', body: { status: r.status === 'active' ? 'deactivated' : 'active' } })}>{r.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>
          </div>
        ))],
      ]} />
      {f && (
        <form className="card" onSubmit={save}>
          <h2>{f.id ? `Edit ${f.name}` : 'New admin'}</h2>
          {!f.id && (
            <div className="cols">
              <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
              <Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
              <Field label="Temporary password (12+ chars, mixed)"><input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={12} /></Field>
            </div>
          )}
          <h3>Permissions</h3>
          {Object.entries(allPermissions).map(([p, desc]) => (
            <label key={p} className="check"><input type="checkbox" checked={f.permissions.includes(p)} onChange={() => togglePerm(p)} /><span><span className="mono small">{p}</span> — {desc}</span></label>
          ))}
          <div className="row"><button type="button" className="btn" onClick={() => setF(null)}>Cancel</button><button className="btn primary" disabled={act.busy}>Save</button></div>
        </form>
      )}
    </div>
  );
}
