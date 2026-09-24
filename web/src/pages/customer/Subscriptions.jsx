import { useState } from 'react';
import { api, fmtDate, rupees } from '../../api.js';
import { payOrder } from '../../checkout.js';
import { ErrorNote, Field, Loading, useAction, useApi } from '../../ui.jsx';

const FREQ = { monthly: 'Every month', quarterly: 'Every 3 months', half_yearly: 'Every 6 months' };

export default function Subscriptions() {
  const [subs, , reload] = useApi('/subscriptions');
  const [svcs] = useApi('/services');
  const [addrs] = useApi('/addresses');
  const [f, setF] = useState({ serviceId: '', addressId: '', frequency: 'quarterly', visits: 4, preferredHour: 10, startDate: '' });
  const [agree, setAgree] = useState(false);
  const { busy, error, run } = useAction();
  const [ok, setOk] = useState(null);

  if (!subs || !svcs || !addrs) return <Loading />;
  const svc = svcs.services.find((s) => s.id === f.serviceId);
  const set = (k, num) => (e) => setF({ ...f, [k]: num ? Number(e.target.value) : e.target.value });

  const create = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api('/subscriptions', { method: 'POST', body: { ...f, acceptTerms: true } });
      await payOrder(r.order, { description: `${svc.name} plan` });
      setOk('Your plan is active. Visits will appear in My Bookings automatically.');
      reload();
    });
  };

  return (
    <div className="stack">
      <h1>Maintenance plans</h1>
      <p className="muted small">Pay once upfront; each visit is scheduled for you and completed with your OTP like any booking.</p>
      {ok && <div className="banner ok">{ok}</div>}
      {subs.subscriptions.map((s) => (
        <div key={s.id} className="card">
          <div className="row between"><h3 style={{ margin: 0 }}>{s.service_name}</h3><span className={`badge ${s.status === 'active' ? 'ok' : 'warn'}`}>{s.status.replace('_', ' ')}</span></div>
          <div className="small muted">{FREQ[s.frequency]} · {s.visits_generated}/{s.visits_total} visits scheduled · next {fmtDate(s.next_due_date)} · {rupees(s.amount)}</div>
        </div>
      ))}
      <form className="card" onSubmit={create}>
        <h2>New plan</h2>
        <Field label="Service">
          <select value={f.serviceId} onChange={set('serviceId')} required>
            <option value="">Choose…</option>
            {svcs.services.map((s) => <option key={s.id} value={s.id}>{s.name} — {rupees(s.fixed_price_paise)}/visit</option>)}
          </select>
        </Field>
        <Field label="Address">
          <select value={f.addressId} onChange={set('addressId')} required>
            <option value="">Choose…</option>
            {addrs.addresses.map((a) => <option key={a.id} value={a.id}>{a.label}: {a.line1}</option>)}
          </select>
        </Field>
        {addrs.addresses.length === 0 && <p className="small muted">Add an address from your first booking or your profile.</p>}
        <div className="grid2">
          <Field label="Frequency">
            <select value={f.frequency} onChange={set('frequency')}>{Object.entries(FREQ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </Field>
          <Field label="Visits"><input type="number" min={2} max={f.frequency === 'half_yearly' ? 4 : 12} value={f.visits} onChange={set('visits', true)} /></Field>
          <Field label="First visit"><input type="date" value={f.startDate} onChange={set('startDate')} required /></Field>
          <Field label="Preferred hour (IST)">
            <select value={f.preferredHour} onChange={set('preferredHour', true)}>
              {Array.from({ length: 14 }, (_, i) => 7 + i).map((h) => <option key={h} value={h}>{h}:00</option>)}
            </select>
          </Field>
        </div>
        {svc && <div className="row between"><strong>Total upfront</strong><span className="big">{rupees(svc.fixed_price_paise * f.visits)}</span></div>}
        <label className="check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>I agree to be charged the full plan amount now. Unused visits can be refunded through support.</span></label>
        <ErrorNote error={error} />
        <button className="btn primary block" disabled={busy || !agree}>Pay & activate</button>
      </form>
    </div>
  );
}
