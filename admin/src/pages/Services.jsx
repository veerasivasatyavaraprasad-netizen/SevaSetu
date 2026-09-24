import { useState } from 'react';
import { api, rupees } from '../api.js';
import { ErrorNote, Field, Loading, useAction, useApi } from '../ui.jsx';
import { Table } from './common.jsx';

const CATS = ['cleaning', 'repairs', 'ac_service', 'pest_control', 'tutoring', 'plumbing', 'electrical', 'appliance_repair'];
const empty = { id: null, name: '', category: 'cleaning', price: '', durationMinutes: 60, description: '', urgentPremiumPercent: 25, warranty: 0, active: true };

export default function Services() {
  const [data, error, reload] = useApi('/admin/services');
  const [f, setF] = useState(null);
  const act = useAction();
  if (!data) return error ? <ErrorNote error={error} /> : <Loading />;
  const set = (k, t) => (e) => setF({ ...f, [k]: t === 'bool' ? e.target.checked : t === 'num' ? Number(e.target.value) : e.target.value });
  const save = (e) => {
    e.preventDefault();
    act.run(async () => {
      const body = { name: f.name, category: f.category, fixedPricePaise: Math.round(Number(f.price) * 100), durationMinutes: f.durationMinutes, description: f.description, urgentPremiumPercent: f.urgentPremiumPercent, warrantyFeePaise: Math.round(Number(f.warranty || 0) * 100), active: f.active };
      await api(f.id ? `/admin/services/${f.id}` : '/admin/services', { method: f.id ? 'PATCH' : 'POST', body });
      setF(null);
      reload();
    });
  };
  return (
    <div className="stack">
      <div className="row between"><h1 style={{ margin: 0 }}>Services & pricing</h1><button className="btn primary" onClick={() => setF(empty)}>+ New service</button></div>
      <p className="small muted">Prices are fixed and shown to customers before booking. Changes apply to new bookings only and are audited.</p>
      <ErrorNote error={error || act.error} />
      <Table rows={data.services} onRow={(s) => setF({ id: s.id, name: s.name, category: s.category, price: s.fixed_price_paise / 100, durationMinutes: s.duration_minutes, description: s.description, urgentPremiumPercent: s.urgent_premium_bps / 100, warranty: s.warranty_fee_paise / 100, active: s.active })} cols={[
        ['name', 'Service'], ['category', 'Category'], ['fixed_price_paise', 'Price', (r) => rupees(r.fixed_price_paise)],
        ['duration_minutes', 'Minutes'], ['urgent_premium_bps', 'Urgent premium', (r) => `${r.urgent_premium_bps / 100}%`],
        ['warranty_fee_paise', '30-day warranty', (r) => (r.warranty_fee_paise ? rupees(r.warranty_fee_paise) : 'not offered')],
        ['active', 'Active', (r) => (r.active ? <span className="badge ok">active</span> : <span className="badge">hidden</span>)],
      ]} />
      {f && (
        <form className="card" onSubmit={save}>
          <h2>{f.id ? 'Edit service' : 'New service'}</h2>
          <div className="cols">
            <Field label="Name"><input value={f.name} onChange={set('name')} required minLength={3} /></Field>
            <Field label="Category"><select value={f.category} onChange={set('category')}>{CATS.map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="Fixed price (₹)"><input type="number" min={1} step="0.01" value={f.price} onChange={set('price')} required /></Field>
            <Field label="Duration (minutes)"><input type="number" min={15} max={600} value={f.durationMinutes} onChange={set('durationMinutes', 'num')} /></Field>
            <Field label="Urgent premium (%)"><input type="number" min={0} max={100} value={f.urgentPremiumPercent} onChange={set('urgentPremiumPercent', 'num')} /></Field>
            <Field label="30-day warranty fee (₹, 0 = not offered)"><input type="number" min={0} step="0.01" value={f.warranty} onChange={set('warranty')} /></Field>
          </div>
          <Field label="Description"><textarea value={f.description} onChange={set('description')} maxLength={2000} /></Field>
          <label className="check"><input type="checkbox" checked={f.active} onChange={set('active', 'bool')} /><span>Visible to customers</span></label>
          <div className="row"><button type="button" className="btn" onClick={() => setF(null)}>Cancel</button><button className="btn primary" disabled={act.busy}>Save</button></div>
        </form>
      )}
      <FeaturedPlans />
    </div>
  );
}

// Plan §2: workers pay for priority visibility on new jobs.
function FeaturedPlans() {
  const [data, error, reload] = useApi('/admin/featured-plans');
  const [f, setF] = useState({ name: '', days: 7, price: '' });
  const act = useAction();
  if (!data) return error ? <ErrorNote error={error} /> : <Loading />;
  const add = (e) => {
    e.preventDefault();
    act.run(async () => { await api('/admin/featured-plans', { method: 'POST', body: { name: f.name, days: Number(f.days), pricePaise: Math.round(Number(f.price) * 100) } }); setF({ name: '', days: 7, price: '' }); reload(); });
  };
  return (
    <div className="card">
      <h2>Featured-professional plans</h2>
      <p className="small muted">Featured professionals see and can accept new jobs in their area before everyone else.</p>
      <ErrorNote error={act.error} />
      <Table rows={data.plans} cols={[
        ['name', 'Plan'], ['days', 'Days'], ['price_paise', 'Price', (r) => rupees(r.price_paise)],
        ['active', '', (r) => <button className="btn sm" onClick={() => act.run(async () => { await api(`/admin/featured-plans/${r.id}`, { method: 'PATCH', body: { active: !r.active } }); reload(); })}>{r.active ? 'Retire' : 'Offer again'}</button>],
      ]} />
      <form className="row wrap mt" onSubmit={add}>
        <input placeholder="Plan name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required style={{ width: 160 }} />
        <input type="number" min={1} max={365} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} aria-label="Days" style={{ width: 90 }} />
        <input type="number" min={1} step="0.01" placeholder="Price ₹" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} required style={{ width: 120 }} />
        <button className="btn sm primary" disabled={act.busy}>Add plan</button>
      </form>
      <h3 className="mt">Currently featured</h3>
      {data.activeListings.length === 0 ? <p className="small muted">None.</p> : data.activeListings.map((l) => <div key={l.id} className="small">{l.worker_name} · until {new Date(l.ends_at).toLocaleDateString('en-IN')}</div>)}
    </div>
  );
}
