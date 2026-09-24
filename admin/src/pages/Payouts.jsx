import { useState } from 'react';
import { api, fmtDate, rupees } from '../api.js';
import { useAdmin } from '../session.jsx';
import { ErrorNote, Field, Loading, useAction, useApi } from '../ui.jsx';
import { Stat, Table } from './common.jsx';

function lastMonday() {
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  const day = (ist.getUTCDay() + 6) % 7;
  ist.setUTCDate(ist.getUTCDate() - day - 7);
  return ist.toISOString().slice(0, 10);
}

export default function Payouts() {
  const { can, admin } = useAdmin();
  const [data, error, reload] = useApi('/admin/payout-batches');
  const [week, setWeek] = useState(lastMonday());
  const [open, setOpen] = useState(null);
  const [detail, , reloadDetail] = useApi(open ? `/admin/payout-batches/${open}` : null, [open]);
  const act = useAction();
  const [msg, setMsg] = useState(null);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const q = Object.fromEntries(data.queue.map((r) => [r.status, r]));
  const post = (path, done) => act.run(async () => { const r = await api(path, { method: 'POST', body: path.endsWith('payout-batches') ? { weekStart: week } : undefined }); setMsg(done(r)); reload(); reloadDetail(); });

  const exportCsv = (id) => act.run(async () => {
    const blob = await api(`/admin/payout-batches/${id}?format=csv`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `payout-batch-${id}.csv`;
    a.click();
  });

  return (
    <div className="stack">
      <h1>Weekly payouts</h1>
      <p className="small muted">Only confirmed, reconciled-clean jobs of workers without a payout hold are included. The preparer can never approve; batches above {rupees(data.twoPersonThreshold)} need two different approvers.</p>
      <div className="stats">
        <Stat label="Pending (eligible after reconciliation)" value={rupees(q.pending?.total)} />
        <Stat label="Held for review" value={rupees(q.held?.total)} tone={q.held?.total ? 'warn' : undefined} />
        <Stat label="In open batches" value={rupees(q.batched?.total)} />
        <Stat label="Paid to date" value={rupees(q.paid?.total)} />
      </div>
      {msg && <div className="banner ok">{msg}</div>}
      <ErrorNote error={act.error} />
      {can('payouts.prepare') && (
        <form className="card row wrap" onSubmit={(e) => { e.preventDefault(); post('/admin/payout-batches', (r) => `Batch prepared: ${rupees(r.batch.total_amount)}`); }}>
          <Field label="Week starting (Monday)"><input type="date" value={week} onChange={(e) => setWeek(e.target.value)} /></Field>
          <button className="btn primary" disabled={act.busy}>Prepare batch</button>
        </form>
      )}
      <Table rows={data.batches} onRow={(r) => setOpen(r.id)} cols={[
        ['week_start', 'Week', (r) => `${fmtDate(r.week_start)} – ${fmtDate(r.week_end)}`],
        ['total_amount', 'Total', (r) => rupees(r.total_amount)],
        ['payouts', 'Workers'],
        ['prepared_by_name', 'Prepared by'],
        ['approvals', 'Approvals', (r) => `${(r.approvals || []).map((a) => a.name).join(', ') || '—'} (${(r.approvals || []).length}/${r.required_approvals})`],
        ['status', 'Status', (r) => <span className={`badge ${r.status === 'released' ? 'ok' : r.status === 'cancelled' ? '' : 'warn'}`}>{r.status}</span>],
        ['actions', '', (r) => (
          <div className="row" onClick={(e) => e.stopPropagation()}>
            {can('payouts.approve') && r.status === 'draft' && r.prepared_by !== admin.id && !(r.approvals || []).some((a) => a.adminId === admin.id) && (
              <button className="btn sm primary" disabled={act.busy} onClick={() => post(`/admin/payout-batches/${r.id}/approve`, (x) => `Approved (${x.approvals}/${x.required})`)}>Approve</button>
            )}
            {can('payouts.approve') && r.status === 'approved' && r.prepared_by !== admin.id && (
              <button className="btn sm primary" disabled={act.busy} onClick={() => { if (window.confirm(`Release ${rupees(r.total_amount)} to ${r.payouts} workers?`)) post(`/admin/payout-batches/${r.id}/release`, (x) => `Released: ${x.results.filter((y) => y.status !== 'failed').length} sent, ${x.results.filter((y) => y.status === 'failed').length} failed`); }}>Release</button>
            )}
            {['draft', 'approved'].includes(r.status) && <button className="btn sm" disabled={act.busy} onClick={() => post(`/admin/payout-batches/${r.id}/cancel`, () => 'Batch cancelled')}>Cancel</button>}
            <button className="btn sm ghost" onClick={() => exportCsv(r.id)}>CSV</button>
          </div>
        )],
      ]} />
      {open && detail && (
        <div className="card">
          <h2>Batch detail</h2>
          <Table rows={detail.payouts} cols={[
            ['worker_name', 'Worker'], ['payout_masked', 'Account'], ['jobs', 'Jobs'],
            ['total_amount', 'Amount', (r) => rupees(r.total_amount)], ['status', 'Status'], ['utr_number', 'UTR', (r) => <span className="mono">{r.utr_number || '—'}</span>],
            ['failure_reason', 'Note', (r) => r.failure_reason || ''],
          ]} />
        </div>
      )}
    </div>
  );
}
