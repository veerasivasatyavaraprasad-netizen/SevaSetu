import { useState } from 'react';
import { api, fmtDate, fmtDateTime, rupees } from '../api.js';
import { ErrorNote, Loading, StatusBadge, useAction, useApi } from '../ui.jsx';
import { ask, Table } from './common.jsx';

export default function Customers() {
  const [phone, setPhone] = useState('');
  const [query, setQuery] = useState('');
  const [data, error, reload] = useApi(`/admin/customers${query ? `?phone=${encodeURIComponent(query)}` : ''}`);
  const [sel, setSel] = useState(null);
  const [detail] = useApi(sel ? `/admin/customers/${sel}` : null, [sel]);
  const act = useAction();
  return (
    <div className="stack">
      <h1>Customers</h1>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setQuery(phone); }}>
        <input placeholder="Search by full mobile number" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button className="btn sm">Search</button>
        {query && <button type="button" className="btn ghost sm" onClick={() => { setPhone(''); setQuery(''); }}>Clear</button>}
      </form>
      <p className="small muted">Phone numbers are encrypted; search matches an exact number via a keyed hash.</p>
      <ErrorNote error={error || act.error} />
      {!data ? <Loading /> : (
        <Table rows={data.customers} onRow={(r) => setSel(r.id)} cols={[
          ['name', 'Name', (r) => r.name || '—'], ['phone_last4', 'Phone', (r) => `••${r.phone_last4 || ''}`],
          ['bookings', 'Bookings'], ['disputes', 'Disputes'], ['status', 'Status'], ['created_at', 'Joined', (r) => fmtDate(r.created_at)],
        ]} />
      )}
      {detail && (
        <div className="card">
          <div className="row between"><h2>{detail.customer.name}</h2>
            <button className="btn sm" onClick={() => { const reason = ask('Reason'); if (reason) act.run(async () => { await api(`/admin/customers/${sel}/status`, { method: 'POST', body: { status: detail.customer.status === 'active' ? 'suspended' : 'active', reason } }); reload(); setSel(null); }); }}>
              {detail.customer.status === 'active' ? 'Suspend' : 'Reactivate'}
            </button>
          </div>
          {detail.bookings.map((b) => <div key={b.id} className="small row between"><span>{b.service_name} · {fmtDateTime(b.scheduled_time)}</span><span>{rupees(b.amount)} <StatusBadge status={b.status} /></span></div>)}
        </div>
      )}
    </div>
  );
}
