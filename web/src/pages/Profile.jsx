import { useState } from 'react';
import { api, fmtDateTime } from '../api.js';
import { useSession } from '../session.jsx';
import { ErrorNote, Field, Loading, useAction, useApi } from '../ui.jsx';
import AddressForm from './customer/AddressForm.jsx';

export default function Profile() {
  const { user, signOut, reload } = useSession();
  const [notes, , reloadNotes] = useApi('/notifications');
  const [name, setName] = useState(user.name || '');
  const [email, setEmail] = useState(user.email || '');
  const { busy, error, run } = useAction();
  const [saved, setSaved] = useState(false);

  const save = (e) => {
    e.preventDefault();
    run(async () => {
      await api('/me', { method: 'PATCH', body: { name, email } });
      setSaved(true);
      reload();
    });
  };

  const exportData = () => run(async () => {
    const blob = await api('/me/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(blob, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'my-data.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  const deleteAccount = () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Delete your account and personal data? This cannot be undone. Payment records are kept as required by law.')) return;
    run(async () => {
      await api('/me/delete', { method: 'POST' });
      await signOut();
    });
  };

  return (
    <div className="stack">
      <h1>Account</h1>
      <form className="card" onSubmit={save}>
        <p className="small muted">Mobile ending {user.phone_last4}</p>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} disabled={user.role === 'worker'} minLength={2} maxLength={80} /></Field>
        <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        {saved && <p className="small">Saved.</p>}
        <button className="btn primary block" disabled={busy}>Save</button>
      </form>

      {user.role === 'customer' && <Addresses />}

      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Notifications</h2>
          <button className="btn ghost sm" onClick={() => api('/notifications/read', { method: 'POST' }).then(reloadNotes)}>Mark all read</button>
        </div>
        {!notes && <Loading />}
        {notes?.notifications.length === 0 && <p className="small muted">No notifications.</p>}
        {notes?.notifications.map((n) => (
          <div key={n.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8, opacity: n.read_at ? 0.65 : 1 }}>
            <strong className="small">{n.title}</strong>
            <div className="small">{n.body}</div>
            <div className="small muted">{fmtDateTime(n.created_at)}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Your data</h2>
        <p className="small muted">Under India's DPDP Act you can download or erase your personal data.</p>
        <ErrorNote error={error} />
        <div className="row wrap">
          <button className="btn" onClick={exportData} disabled={busy}>Download my data</button>
          <button className="btn danger" onClick={deleteAccount} disabled={busy}>Delete account</button>
        </div>
      </div>
      <button className="btn block" onClick={signOut}>Sign out</button>
    </div>
  );
}

function Addresses() {
  const [data, , reload] = useApi('/addresses');
  const [adding, setAdding] = useState(false);
  if (!data) return <Loading />;
  return (
    <div className="card">
      <h2>Saved addresses</h2>
      {data.addresses.map((a) => (
        <div key={a.id} className="row between small" style={{ padding: '6px 0' }}>
          <span><strong>{a.label}</strong> — {a.line1}, {a.city} {a.pincode}</span>
          <button className="btn ghost sm" onClick={() => api(`/addresses/${a.id}`, { method: 'DELETE' }).then(reload)}>Remove</button>
        </div>
      ))}
      {adding ? <AddressForm onSaved={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} />
        : <button className="btn block mt" onClick={() => setAdding(true)}>+ Add address</button>}
    </div>
  );
}
