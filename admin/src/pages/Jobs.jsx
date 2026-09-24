import { api, fmtDateTime } from '../api.js';
import { ErrorNote, Loading, useAction, useApi } from '../ui.jsx';
import { Table } from './common.jsx';

const DESCRIPTIONS = {
  reconciliation: 'Nightly: cross-checks payment, GPS and customer OTP for every completed booking (Section 9.4).',
  anomalies: 'Nightly: automated fraud pattern rules (Section 9.5).',
  auto_confirm: 'Every 10 min: confirms jobs completed more than 24 h ago.',
  subscriptions: 'Every 10 min: schedules upcoming subscription visits.',
  expire_payments: 'Every 10 min: cancels bookings left unpaid for 2 hours.',
};

export default function Jobs() {
  const [data, error, reload] = useApi('/admin/jobs');
  const act = useAction();
  if (!data) return error ? <ErrorNote error={error} /> : <Loading />;
  return (
    <div className="stack">
      <h1>Background jobs</h1>
      <ErrorNote error={act.error} />
      <div className="card">
        {data.jobs.map((j) => (
          <div key={j} className="row between" style={{ padding: '6px 0' }}>
            <div><span className="mono">{j}</span><div className="small muted">{DESCRIPTIONS[j]}</div></div>
            <button className="btn sm" disabled={act.busy} onClick={() => act.run(async () => { await api(`/admin/jobs/${j}/run`, { method: 'POST' }); reload(); })}>Run now</button>
          </div>
        ))}
      </div>
      <Table rows={data.runs} cols={[
        ['job', 'Job'], ['started_at', 'Started', (r) => fmtDateTime(r.started_at)],
        ['status', 'Status', (r) => <span className={`badge ${r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'danger' : ''}`}>{r.status}</span>],
        ['summary', 'Summary', (r) => <pre className="json">{JSON.stringify(r.summary)}</pre>],
      ]} />
    </div>
  );
}
