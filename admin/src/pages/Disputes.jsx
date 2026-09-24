import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDateTime, rupees } from '../api.js';
import { useAdmin } from '../session.jsx';
import { ErrorNote, Field, Loading, useAction, useApi } from '../ui.jsx';
import { Table } from './common.jsx';

export function Disputes() {
  const [status, setStatus] = useState('open');
  const [data, error, reload] = useApi(`/admin/disputes?status=${status}`);
  const [sel, setSel] = useState(null);
  const [f, setF] = useState({ outcome: 'worker_favour', amount: '', resolution: '' });
  const act = useAction();
  const [msg, setMsg] = useState(null);
  const resolve = (e) => {
    e.preventDefault();
    act.run(async () => {
      const body = { outcome: f.outcome, resolution: f.resolution, ...(f.outcome === 'refund_partial' ? { amountPaise: Math.round(Number(f.amount) * 100) } : {}) };
      const r = await api(`/admin/disputes/${sel.id}/resolve`, { method: 'POST', body });
      setMsg(r.refundRequestId ? 'Resolved. The refund now needs approval by a different admin.' : 'Resolved in the worker\'s favour.');
      setSel(null);
      reload();
    });
  };
  return (
    <div className="stack">
      <h1>Disputes</h1>
      <div className="toolbar"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Open</option><option value="resolved">Resolved</option></select></div>
      {msg && <div className="banner ok">{msg}</div>}
      <ErrorNote error={error || act.error} />
      {!data ? <Loading /> : (
        <Table rows={data.disputes} onRow={status === 'open' ? setSel : undefined} cols={[
          ['created_at', 'Raised', (r) => fmtDateTime(r.created_at)],
          ['service_name', 'Service', (r) => <Link to={`/bookings/${r.booking_id}`} onClick={(e) => e.stopPropagation()}>{r.service_name}</Link>],
          ['customer_name', 'Customer'], ['worker_name', 'Worker'],
          ['amount', 'Amount', (r) => rupees(r.amount)],
          ['reason', 'Reason'], ['description', 'Details'],
          ['resolution', 'Resolution', (r) => r.resolution || '—'],
        ]} />
      )}
      {sel && (
        <form className="card" onSubmit={resolve}>
          <h2>Resolve: {sel.service_name} ({rupees(sel.amount)})</h2>
          <p className="small">{sel.description}</p>
          <Field label="Outcome">
            <select value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}>
              <option value="worker_favour">No refund — release to worker</option>
              <option value="refund_partial">Partial refund</option>
              <option value="refund_full">Full refund</option>
            </select>
          </Field>
          {f.outcome === 'refund_partial' && <Field label="Refund amount (₹)"><input type="number" min={1} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required /></Field>}
          <Field label="Resolution note (sent to the customer)"><textarea value={f.resolution} onChange={(e) => setF({ ...f, resolution: e.target.value })} minLength={5} required /></Field>
          <div className="row"><button type="button" className="btn" onClick={() => setSel(null)}>Close</button><button className="btn primary" disabled={act.busy}>Resolve</button></div>
        </form>
      )}
    </div>
  );
}

export function Refunds() {
  const { can, admin } = useAdmin();
  const [status, setStatus] = useState('requested');
  const [data, error, reload] = useApi(`/admin/refund-requests?status=${status}`);
  const act = useAction();
  const decide = (id, approve) => act.run(async () => { await api(`/admin/refund-requests/${id}/decision`, { method: 'POST', body: { approve } }); reload(); });
  return (
    <div className="stack">
      <h1>Refund approvals</h1>
      <p className="small muted">Maker-checker: a refund requested by one admin must be approved by a different admin with refund approval rights.</p>
      <div className="toolbar"><select value={status} onChange={(e) => setStatus(e.target.value)}>{['requested', 'processed', 'rejected', 'failed'].map((s) => <option key={s}>{s}</option>)}</select></div>
      <ErrorNote error={error || act.error} />
      {!data ? <Loading /> : (
        <Table rows={data.refundRequests} cols={[
          ['created_at', 'Requested', (r) => fmtDateTime(r.created_at)],
          ['booking_id', 'Booking', (r) => <Link to={`/bookings/${r.booking_id}`}>view</Link>],
          ['amount', 'Refund', (r) => `${rupees(r.amount)} of ${rupees(r.booking_amount)}`],
          ['reason', 'Reason'], ['requested_by_name', 'Requested by', (r) => r.requested_by_name || 'system'],
          ['actions', '', (r) => (r.status === 'requested' && can('refunds.approve') && r.requested_by !== admin.id ? (
            <div className="row"><button className="btn sm primary" disabled={act.busy} onClick={() => decide(r.id, true)}>Approve & pay</button><button className="btn sm" disabled={act.busy} onClick={() => decide(r.id, false)}>Reject</button></div>
          ) : r.failure_reason || '')],
        ]} />
      )}
    </div>
  );
}
