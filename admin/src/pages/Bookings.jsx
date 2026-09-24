import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDateTime, rupees } from '../api.js';
import { ErrorNote, Loading, StatusBadge, useAction, useApi } from '../ui.jsx';
import { ask, SEVERITY_TONE, Table } from './common.jsx';

const STATUSES = ['', 'pending_payment', 'paid', 'assigned', 'in_progress', 'completed', 'confirmed', 'disputed', 'cancelled', 'refunded'];

export function Bookings() {
  const [status, setStatus] = useState('');
  const [recon, setRecon] = useState('');
  const qs = new URLSearchParams({ ...(status && { status }), ...(recon && { reconciliation: recon }) });
  const [data, error] = useApi(`/admin/bookings?${qs}`);
  return (
    <div>
      <h1>Bookings</h1>
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">{STATUSES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}</select>
        <select value={recon} onChange={(e) => setRecon(e.target.value)} aria-label="Reconciliation">
          <option value="">Any reconciliation</option><option value="pending">pending</option><option value="clean">clean</option><option value="mismatch">mismatch</option>
        </select>
      </div>
      <ErrorNote error={error} />
      {!data ? <Loading /> : (
        <Table onRow="/bookings/" rows={data.bookings} cols={[
          ['service_name', 'Service'],
          ['scheduled_time', 'When', (r) => fmtDateTime(r.scheduled_time)],
          ['customer_name', 'Customer', (r) => `${r.customer_name || '—'} ••${r.customer_phone_last4 || ''}`],
          ['worker_name', 'Worker', (r) => r.worker_name || '—'],
          ['amount', 'Amount', (r) => rupees(r.amount)],
          ['status', 'Status', (r) => <StatusBadge status={r.status} />],
          ['reconciliation_status', 'Recon', (r) => <span className={`badge ${r.reconciliation_status === 'clean' ? 'ok' : r.reconciliation_status === 'mismatch' ? 'danger' : ''}`}>{r.reconciliation_status}</span>],
        ]} />
      )}
    </div>
  );
}

export function BookingDetail() {
  const { id } = useParams();
  const [d, error, reload] = useApi(`/admin/bookings/${id}`);
  const [workerId, setWorkerId] = useState('');
  const act = useAction();
  if (error) return <ErrorNote error={error} />;
  if (!d) return <Loading />;
  const b = d.booking;

  const reassign = () => {
    const reason = ask('Reason for reassignment?');
    if (reason) act.run(async () => { await api(`/admin/bookings/${id}/assign`, { method: 'POST', body: { workerId: workerId || null, reason } }); reload(); });
  };
  const cancel = () => {
    const reason = ask('Reason for cancellation? (a full refund request will be created for a second admin to approve)');
    if (reason) act.run(async () => { await api(`/admin/bookings/${id}/cancel`, { method: 'POST', body: { reason } }); reload(); });
  };

  return (
    <div className="stack">
      <div className="row between"><h1 style={{ margin: 0 }}>{b.serviceName}</h1><StatusBadge status={b.status} /></div>
      <ErrorNote error={act.error} />
      <div className="cols">
        <div className="card">
          <dl className="kv">
            <dt>Booking</dt><dd className="mono small">{b.id}</dd>
            <dt>When</dt><dd>{fmtDateTime(b.scheduledTime)}{b.isUrgent ? ' (urgent)' : ''}</dd>
            <dt>Customer</dt><dd>{b.customer.name} ••{b.customer.phoneLast4}</dd>
            <dt>Worker</dt><dd>{b.worker ? <Link to={`/workers/${b.worker.id}`}>{b.worker.name}</Link> : '—'}</dd>
            <dt>Address</dt><dd>{b.address.line1}, {b.address.city} {b.address.pincode}</dd>
            <dt>Amount</dt><dd>{rupees(b.amount)}</dd>
            <dt>Commission</dt><dd>{b.commissionAmount !== null ? `${rupees(b.commissionAmount)} (${b.commissionRateBps / 100}%)` : '—'}</dd>
            <dt>Worker payout</dt><dd>{b.workerPayout !== null ? rupees(b.workerPayout) : '—'}</dd>
            <dt>Reconciliation</dt><dd>{b.reconciliationStatus}</dd>
            <dt>Check-in distance</dt><dd>{b.checkinDistanceM ?? '—'} m</dd>
            <dt>Check-out distance</dt><dd>{b.checkoutDistanceM ?? '—'} m</dd>
            <dt>Wrong OTP attempts</dt><dd>{b.otpAttempts}</dd>
          </dl>
        </div>
        <div className="card">
          <h3>Actions</h3>
          {['paid', 'assigned', 'in_progress'].includes(b.status) && (
            <>
              <input placeholder="Worker ID (blank = back to open pool)" value={workerId} onChange={(e) => setWorkerId(e.target.value.trim())} />
              <button className="btn block mt" disabled={act.busy} onClick={reassign}>Reassign</button>
            </>
          )}
          {['pending_payment', 'paid', 'assigned'].includes(b.status) && <button className="btn danger block mt" disabled={act.busy} onClick={cancel}>Cancel & refund</button>}
          <h3 className="mt">Payments</h3>
          {d.payments.map((p) => <div key={p.id} className="small">{rupees(p.amount)} · {p.payment_status} · <span className="mono">{p.gateway_txn_id || p.gateway_order_id}</span>{p.refunded_amount ? ` · refunded ${rupees(p.refunded_amount)}` : ''}</div>)}
          {d.refunds.length > 0 && <><h3 className="mt">Refunds</h3>{d.refunds.map((r) => <div key={r.id} className="small">{rupees(r.amount)} · {r.status} · {r.reason}</div>)}</>}
          {d.flags.length > 0 && <><h3 className="mt">Fraud flags</h3>{d.flags.map((f) => <div key={f.id} className="small"><span className={`badge ${SEVERITY_TONE[f.severity]}`}>{f.severity}</span> {f.flag_type} ({f.status})</div>)}</>}
        </div>
      </div>
      <div className="cols">
        <div className="card">
          <h3>Timeline</h3>
          <ul className="timeline">{d.events.map((e, i) => <li key={i}>{e.from_status || '∅'} → <strong>{e.to_status}</strong> <span className="muted">by {e.actor_role}</span><div className="small muted">{fmtDateTime(e.created_at)}</div></li>)}</ul>
        </div>
        <div className="card">
          <h3>GPS log</h3>
          {d.gps.length === 0 && <p className="small muted">No GPS records.</p>}
          {d.gps.map((g, i) => <div key={i} className="small">{g.kind} · {g.distance_m} m · ±{g.accuracy_m ?? '?'} m{g.is_mock ? ' · MOCK' : ''} · {fmtDateTime(g.created_at)}</div>)}
          <h3 className="mt">Chat ({d.messages.length})</h3>
          {d.messages.map((m, i) => <div key={i} className="small"><strong>{m.sender_role}:</strong> {m.body}{m.redacted ? ' [redacted]' : ''}</div>)}
        </div>
      </div>
    </div>
  );
}
