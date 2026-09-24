import { useState } from 'react';
import { api, fmtDate, rupees } from '../../api.js';
import { payOrder } from '../../checkout.js';
import { ErrorNote, Loading, useAction, useApi } from '../../ui.jsx';

// Plan §2: workers pay for priority visibility — featured professionals
// see and can accept new jobs before others.
export default function Featured() {
  const [data, error, reload] = useApi('/worker/featured');
  const { busy, error: actError, run } = useAction();
  const [msg, setMsg] = useState(null);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const buy = (plan) => run(async () => {
    const r = await api('/worker/featured', { method: 'POST', body: { planId: plan.id } });
    await payOrder(r.order, { description: `Featured professional — ${plan.name}` });
    setMsg('You are now featured. New jobs in your area reach you first.');
    reload();
  });
  const active = data.active[0];
  return (
    <div className="stack">
      <h1>Get jobs first</h1>
      <p className="muted">Featured professionals see new paid jobs in their area {data.priorityMinutes} minutes before everyone else, and get the first notification.</p>
      {msg && <div className="banner ok">{msg}</div>}
      {active && <div className="banner info">Featured until <strong>{fmtDate(active.ends_at)}</strong>. Buying again extends it.</div>}
      <ErrorNote error={actError} />
      {data.plans.length === 0 && <p className="small muted">No plans are on offer right now.</p>}
      {data.plans.map((p) => (
        <div key={p.id} className="card row between">
          <div><strong>{p.name}</strong><div className="small muted">{p.days} days of priority access</div></div>
          <button className="btn primary" disabled={busy} onClick={() => buy(p)}>{rupees(p.price_paise)}</button>
        </div>
      ))}
      <p className="small muted center">Paid securely in the app. Featured status never changes prices or your commission.</p>
    </div>
  );
}
