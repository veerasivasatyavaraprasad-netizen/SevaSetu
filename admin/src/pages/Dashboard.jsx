import { fmtDateTime, rupees } from '../api.js';
import { ErrorNote, Loading, useApi } from '../ui.jsx';
import { Stat } from './common.jsx';

export default function Dashboard() {
  const [d, error] = useApi('/admin/dashboard');
  if (error) return <ErrorNote error={error} />;
  if (!d) return <Loading />;
  const f = d.openFlags;
  return (
    <div className="stack">
      <h1>Dashboard</h1>
      <div className="stats">
        <Stat label="Bookings today" value={d.bookings_today} />
        <Stat label="Confirmed GMV today" value={rupees(d.gmv_today)} />
        <Stat label="Commission today" value={rupees(d.commission_today)} />
        <Stat label="Commission, last 7 days" value={rupees(d.commission_7d)} />
        <Stat label="Active workers" value={d.active_workers} />
        <Stat label="Paid, unassigned" value={d.unassigned_paid} tone={d.unassigned_paid ? 'warn' : undefined} />
      </div>
      <h2 className="mt">Needs attention</h2>
      <div className="stats">
        <Stat label="Critical / high fraud flags" value={`${f.critical || 0} / ${f.high || 0}`} tone={(f.critical || f.high) ? 'danger' : undefined} />
        <Stat label="Medium / low flags" value={`${f.medium || 0} / ${f.low || 0}`} />
        <Stat label="KYC awaiting review" value={d.pending_kyc} />
        <Stat label="Open disputes" value={d.open_disputes} />
        <Stat label="Refunds awaiting approval" value={d.pending_refunds} />
        <Stat label="Changes awaiting approval" value={d.pending_changes} />
        <Stat label="Open payout batches" value={d.open_payout_batches} />
        <Stat label="Earnings on hold" value={rupees(d.held_payouts)} />
      </div>
      <h2 className="mt">Background jobs</h2>
      <div className="card small">
        {d.lastRuns.length === 0 && <p className="muted">No runs yet.</p>}
        {d.lastRuns.map((r) => (
          <div key={r.job} className="row between" style={{ padding: '4px 0' }}>
            <span className="mono">{r.job}</span>
            <span><span className={`badge ${r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'danger' : ''}`}>{r.status}</span> <span className="muted">{fmtDateTime(r.started_at)}</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}
