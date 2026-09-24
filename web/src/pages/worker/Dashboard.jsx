import { Link } from 'react-router-dom';
import { api, fmtDateTime, rupees } from '../../api.js';
import { ErrorNote, Loading, StatusBadge, useAction, useApi } from '../../ui.jsx';

export default function Dashboard() {
  const [me] = useApi('/worker/me');
  const [earn] = useApi('/worker/earnings');
  const [mine, , reloadMine] = useApi('/worker/jobs');
  const [open, openErr, reloadOpen] = useApi('/worker/jobs/open');
  const { busy, error, run } = useAction();

  if (!me || !earn || !mine) return <Loading />;
  const w = me.worker;
  const active = mine.jobs.filter((j) => ['assigned', 'in_progress', 'completed'].includes(j.status));
  const act = (path) => run(async () => { await api(path, { method: 'POST' }); reloadOpen(); reloadMine(); });

  return (
    <div className="stack">
      <h1>Hi {w.name?.split(' ')[0]}</h1>
      {w.status !== 'active' && <div className="banner danger">Your account is {w.status}{w.suspendedUntil ? ` until ${fmtDateTime(w.suspendedUntil)}` : ''}. Contact support.</div>}
      {!w.policyAccepted && w.status === 'active' && <div className="banner warn">Please <Link to="/policy">re-read and accept the platform policy</Link> before taking new jobs.</div>}
      {w.payoutHold && <div className="banner warn small">Your payouts are on hold while our team reviews your account.</div>}

      <div className="grid2">
        <div className="stat"><div className="v">{earn.summary.jobsToday}</div><div className="l">Jobs today</div></div>
        <div className="stat"><div className="v">{rupees(earn.summary.pending)}</div><div className="l">Next payout (pending)</div></div>
        <div className="stat"><div className="v">★ {w.rating || '—'}</div><div className="l">{w.ratingCount} ratings</div></div>
        <div className="stat"><div className="v">{w.commissionRatePercent}%</div><div className="l">Your commission rate</div></div>
      </div>

      <h2 className="mt">Your jobs</h2>
      {active.length === 0 && <p className="small muted">No active jobs.</p>}
      {active.map((j) => (
        <Link key={j.id} to={`/jobs/${j.id}`} className="card list-item">
          <div className="row between"><strong>{j.serviceName}</strong><StatusBadge status={j.status} forWorker /></div>
          <div className="small muted">{fmtDateTime(j.scheduledTime)} · {j.address?.line1} · you earn {rupees(j.yourEarning)}</div>
        </Link>
      ))}

      <h2 className="mt">New job requests</h2>
      <ErrorNote error={openErr || error} />
      {open?.jobs.length === 0 && <p className="small muted">No open requests in {w.serviceAreaPincode} right now.</p>}
      {open?.jobs.map((j) => (
        <div key={j.id} className="card">
          <div className="row between"><strong>{j.serviceName}</strong>{j.isUrgent && <span className="badge warn">Urgent</span>}</div>
          <div className="small muted">{fmtDateTime(j.scheduledTime)} · PIN {j.pincode} · ~{j.durationMinutes} min</div>
          <div className="row between mt">
            <span>You earn <strong>{rupees(j.yourEarning)}</strong></span>
            <div className="row">
              <button className="btn sm" disabled={busy} onClick={() => act(`/worker/jobs/${j.id}/decline`)}>Skip</button>
              <button className="btn primary sm" disabled={busy} onClick={() => act(`/worker/jobs/${j.id}/accept`)}>Accept</button>
            </div>
          </div>
        </div>
      ))}
      <p className="small muted center">The full address is shown after you accept. The customer has already paid in the app.</p>
    </div>
  );
}
