import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDateTime } from '../api.js';
import { useAdmin } from '../session.jsx';
import { ErrorNote, Loading, useAction, useApi } from '../ui.jsx';
import { Table } from './common.jsx';

export default function Changes() {
  const { can, admin } = useAdmin();
  const [status, setStatus] = useState('pending');
  const [data, error, reload] = useApi(`/admin/change-requests?status=${status}`);
  const act = useAction();
  const decide = (id, approve) => act.run(async () => { await api(`/admin/change-requests/${id}/decision`, { method: 'POST', body: { approve } }); reload(); });
  return (
    <div className="stack">
      <h1>Change approvals</h1>
      <p className="small muted">Commission changes, reactivations and payout-hold releases take effect only after a second admin approves.</p>
      <div className="toolbar"><select value={status} onChange={(e) => setStatus(e.target.value)}>{['pending', 'approved', 'rejected'].map((s) => <option key={s}>{s}</option>)}</select></div>
      <ErrorNote error={error || act.error} />
      {!data ? <Loading /> : (
        <Table rows={data.changeRequests} cols={[
          ['created_at', 'Requested', (r) => fmtDateTime(r.created_at)],
          ['kind', 'Change', (r) => r.kind.replaceAll('_', ' ')],
          ['worker_name', 'Worker', (r) => <Link to={`/workers/${r.target_id}`}>{r.worker_name}</Link>],
          ['old_value', 'From', (r) => <pre className="json">{JSON.stringify(r.old_value)}</pre>],
          ['new_value', 'To', (r) => <pre className="json">{JSON.stringify(r.new_value)}</pre>],
          ['reason', 'Reason'], ['requested_by_name', 'By'],
          ['actions', '', (r) => (r.status === 'pending' && can('changes.approve') && r.requested_by !== admin.id ? (
            <div className="row"><button className="btn sm primary" disabled={act.busy} onClick={() => decide(r.id, true)}>Approve</button><button className="btn sm" disabled={act.busy} onClick={() => decide(r.id, false)}>Reject</button></div>
          ) : '')],
        ]} />
      )}
    </div>
  );
}
