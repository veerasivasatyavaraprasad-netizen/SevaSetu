import { useState } from 'react';
import { api } from '../api.js';
import { ErrorNote, Field, Loading, useAction, useApi } from '../ui.jsx';
import { Table } from './common.jsx';

// Plan §2 franchise / city licensing and §12 "franchise-ready tooling".
export default function Cities() {
  const [data, error, reload] = useApi('/admin/cities');
  const [f, setF] = useState(null);
  const [pins, setPins] = useState('');
  const act = useAction();
  if (!data) return error ? <ErrorNote error={error} /> : <Loading />;

  const save = (e) => {
    e.preventDefault();
    act.run(async () => {
      const body = { name: f.name, active: f.active, franchiseOperator: f.franchiseOperator || null, franchiseRevenueSharePercent: Number(f.share) };
      const r = await api(f.id ? `/admin/cities/${f.id}` : '/admin/cities', { method: f.id ? 'PATCH' : 'POST', body });
      const cityId = f.id || r.city.id;
      const list = pins.split(/[\s,]+/).filter(Boolean);
      const add = list.filter((p) => !p.startsWith('-'));
      const remove = list.filter((p) => p.startsWith('-')).map((p) => p.slice(1));
      if (add.length || remove.length) await api(`/admin/cities/${cityId}/pincodes`, { method: 'POST', body: { add, remove } });
      setF(null);
      setPins('');
      reload();
    });
  };

  return (
    <div className="stack">
      <div className="row between"><h1 style={{ margin: 0 }}>Cities & franchises</h1>
        <button className="btn primary" onClick={() => setF({ name: '', active: true, franchiseOperator: '', share: 0 })}>+ Launch city</button></div>
      <p className="small muted">Bookings and worker service areas are accepted only for PIN codes listed here. A franchise operator earns the stated share of the platform commission from their city (see Reports → franchise settlement).</p>
      <ErrorNote error={act.error} />
      <Table rows={data.cities} onRow={(c) => setF({ id: c.id, name: c.name, active: c.active, franchiseOperator: c.franchise_operator || '', share: c.franchise_revenue_share_bps / 100 })} cols={[
        ['name', 'City'],
        ['active', 'Status', (c) => <span className={`badge ${c.active ? 'ok' : ''}`}>{c.active ? 'live' : 'paused'}</span>],
        ['franchise_operator', 'Franchise operator', (c) => c.franchise_operator || '— (company-run)'],
        ['share', 'Operator share', (c) => `${c.franchise_revenue_share_bps / 100}% of commission`],
        ['pincodes', 'PIN codes', (c) => <span className="small mono">{c.pincodes.join(', ') || '—'}</span>],
      ]} />
      {f && (
        <form className="card" onSubmit={save}>
          <h2>{f.id ? `Edit ${f.name}` : 'Launch a city'}</h2>
          <div className="cols">
            <Field label="City name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} /></Field>
            <Field label="Franchise operator (blank = company-run)"><input value={f.franchiseOperator} onChange={(e) => setF({ ...f, franchiseOperator: e.target.value })} /></Field>
            <Field label="Operator share of commission (%)"><input type="number" min={0} max={100} step="0.01" value={f.share} onChange={(e) => setF({ ...f, share: e.target.value })} /></Field>
          </div>
          <Field label="PIN codes to add (space or comma separated; prefix with - to remove)">
            <textarea value={pins} onChange={(e) => setPins(e.target.value)} placeholder="560001 560002 -560099" />
          </Field>
          <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /><span>Live (accepting bookings)</span></label>
          <div className="row"><button type="button" className="btn" onClick={() => setF(null)}>Cancel</button><button className="btn primary" disabled={act.busy}>Save</button></div>
        </form>
      )}
    </div>
  );
}
