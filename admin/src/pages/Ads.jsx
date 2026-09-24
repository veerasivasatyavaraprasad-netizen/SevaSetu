import { useState } from 'react';
import { api, fmtDate, rupees } from '../api.js';
import { ErrorNote, Field, Loading, useAction, useApi } from '../ui.jsx';
import { Table } from './common.jsx';

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

// Plan §2 advertising: brands pay for placement. Shown to customers with a
// "Sponsored" label; links must be https.
export default function Ads() {
  const [data, error, reload] = useApi('/admin/ads');
  const [cities] = useApi('/admin/cities');
  const [open, setOpen] = useState(false);
  const act = useAction();
  if (!data) return error ? <ErrorNote error={error} /> : <Loading />;

  const create = (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (!form.get('image')?.size) form.delete('image');
    form.set('contractAmountPaise', String(Math.round(Number(form.get('contractAmountPaise') || 0) * 100)));
    act.run(async () => { await api('/admin/ads', { method: 'POST', form }); setOpen(false); reload(); });
  };
  const toggle = (ad) => act.run(async () => { await api(`/admin/ads/${ad.id}`, { method: 'PATCH', body: { active: !ad.active } }); reload(); });

  return (
    <div className="stack">
      <div className="row between"><h1 style={{ margin: 0 }}>Sponsored placements</h1><button className="btn primary" onClick={() => setOpen(true)}>+ New placement</button></div>
      <ErrorNote error={act.error} />
      <Table rows={data.ads} cols={[
        ['brand', 'Brand'], ['title', 'Title'], ['slot', 'Slot'],
        ['dates', 'Runs', (a) => `${fmtDate(a.starts_on)} – ${fmtDate(a.ends_on)}`],
        ['contract_amount_paise', 'Contract', (a) => rupees(a.contract_amount_paise)],
        ['impressions', 'Impressions'], ['clicks', 'Clicks'],
        ['ctr', 'CTR', (a) => (a.impressions ? `${((a.clicks / a.impressions) * 100).toFixed(1)}%` : '—')],
        ['active', '', (a) => <button className="btn sm" onClick={() => toggle(a)}>{a.active ? 'Pause' : 'Resume'}</button>],
      ]} />
      {open && (
        <form className="card" onSubmit={create}>
          <h2>New placement</h2>
          <div className="cols">
            <Field label="Brand"><input name="brand" required minLength={2} /></Field>
            <Field label="Headline"><input name="title" required minLength={2} maxLength={120} /></Field>
            <Field label="Link (https only)"><input name="linkUrl" type="url" pattern="https://.*" required /></Field>
            <Field label="Slot"><select name="slot"><option value="home_banner">Home banner</option><option value="booking_confirmed">After a booking is paid</option></select></Field>
            <Field label="Service category (optional)"><input name="category" placeholder="e.g. ac_service" /></Field>
            <Field label="City (optional)">
              <select name="cityId"><option value="">All cities</option>{cities?.cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </Field>
            <Field label="Starts"><input type="date" name="startsOn" defaultValue={today()} required /></Field>
            <Field label="Ends"><input type="date" name="endsOn" required /></Field>
            <Field label="Contract value (₹)"><input type="number" name="contractAmountPaise" min={0} step="0.01" /></Field>
            <Field label="Image (JPEG/PNG, ≤1 MB)"><input type="file" name="image" accept="image/jpeg,image/png" /></Field>
          </div>
          <Field label="Body (optional)"><textarea name="body" maxLength={300} /></Field>
          <div className="row"><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button><button className="btn primary" disabled={act.busy}>Create</button></div>
        </form>
      )}
    </div>
  );
}
