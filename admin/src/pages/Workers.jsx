import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, fmtDateTime, rupees } from '../api.js';
import { useAdmin } from '../session.jsx';
import { ErrorNote, Field, Loading, useAction, useApi } from '../ui.jsx';
import { ask, SEVERITY_TONE, Table } from './common.jsx';

export function Workers() {
  const [kyc, setKyc] = useState('under_review');
  const [status, setStatus] = useState('');
  const qs = new URLSearchParams({ ...(kyc && { kyc }), ...(status && { status }) });
  const [data, error] = useApi(`/admin/workers?${qs}`);
  return (
    <div>
      <h1>Workers</h1>
      <div className="toolbar">
        <select value={kyc} onChange={(e) => setKyc(e.target.value)} aria-label="KYC status">
          <option value="">Any KYC</option><option value="under_review">KYC under review</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="not_submitted">Not submitted</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Account status">
          <option value="">Any status</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="deactivated">Deactivated</option>
        </select>
      </div>
      <ErrorNote error={error} />
      {!data ? <Loading /> : (
        <Table onRow="/workers/" rows={data.workers} cols={[
          ['name', 'Name', (r) => `${r.name || '—'} ••${r.phone_last4}`],
          ['skill_category', 'Skill'],
          ['service_area_pincode', 'PIN'],
          ['kyc_status', 'KYC'],
          ['status', 'Status', (r) => <span className={`badge ${r.status === 'active' ? 'ok' : 'danger'}`}>{r.status}</span>],
          ['rating_avg', 'Rating', (r) => `★ ${r.rating_avg} (${r.rating_count})`],
          ['total_jobs', 'Jobs'],
          ['strikes', 'Strikes'],
          ['open_flags', 'Open flags', (r) => (r.open_flags ? <span className="badge danger">{r.open_flags}</span> : 0)],
          ['commission_rate_bps', 'Commission', (r) => `${r.commission_rate_bps / 100}%`],
        ]} />
      )}
    </div>
  );
}

export function WorkerDetail() {
  const { id } = useParams();
  const { can } = useAdmin();
  const [d, error, reload] = useApi(`/admin/workers/${id}`);
  const act = useAction();
  const [rate, setRate] = useState('');
  const [msg, setMsg] = useState(null);
  if (error) return <ErrorNote error={error} />;
  if (!d) return <Loading />;
  const w = d.worker;
  const post = (path, body, done) => act.run(async () => { await api(path, { method: 'POST', body }); if (done) setMsg(done); reload(); });

  const viewDoc = (doc) => act.run(async () => {
    const blob = await api(`/admin/workers/${id}/documents/${doc.id}`);
    window.open(URL.createObjectURL(blob), '_blank', 'noopener');
  });

  return (
    <div className="stack">
      <div className="row between"><h1 style={{ margin: 0 }}>{w.name}</h1><span className={`badge ${w.status === 'active' ? 'ok' : 'danger'}`}>{w.status}</span></div>
      {msg && <div className="banner ok">{msg}</div>}
      <ErrorNote error={act.error} />
      <div className="cols">
        <div className="card">
          <dl className="kv">
            <dt>Phone</dt><dd>••{w.phone_last4}</dd>
            <dt>Skill / area</dt><dd>{w.skill_category} · {w.service_area_pincode}</dd>
            <dt>ID</dt><dd>{w.id_type} ••{w.id_last4}</dd>
            <dt>KYC</dt><dd>{w.kyc_status}{w.kyc_rejection_reason ? ` — ${w.kyc_rejection_reason}` : ''}</dd>
            <dt>Payout account</dt><dd>{w.payout_masked || '—'} {w.payout_verified_at ? '(verified)' : ''}</dd>
            <dt>Payout hold</dt><dd>{w.payout_hold ? `YES — ${w.payout_hold_reason}` : 'No'}</dd>
            <dt>Commission</dt><dd>{w.commission_rate_bps / 100}%</dd>
            <dt>Rating</dt><dd>★ {w.rating_avg} ({w.rating_count}) · {w.total_jobs} jobs</dd>
            <dt>Strikes</dt><dd>{w.strikes}</dd>
            <dt>Monitoring until</dt><dd>{w.monitoring_until ? fmtDate(w.monitoring_until) : '—'}</dd>
            <dt>Policy accepted</dt><dd>{w.policy_ack_version || 'not current'}</dd>
            <dt>Earnings</dt><dd>{d.earnings.map((e) => `${e.status}: ${rupees(e.total)}`).join(' · ') || '—'}</dd>
          </dl>
        </div>
        <div className="card">
          <h3>KYC documents</h3>
          <p className="small muted">Each view is recorded in the audit log.</p>
          {d.documents.map((doc) => <button key={doc.id} className="btn sm" style={{ margin: 4 }} onClick={() => viewDoc(doc)}>{doc.doc_type}</button>)}
          {w.kyc_status === 'under_review' && (
            <div className="row mt">
              <button className="btn primary grow" disabled={act.busy} onClick={() => post(`/admin/workers/${id}/kyc`, { decision: 'approve' }, 'KYC approved')}>Approve KYC</button>
              <button className="btn danger grow" disabled={act.busy} onClick={() => { const reason = ask('Rejection reason (shown to the worker)'); if (reason) post(`/admin/workers/${id}/kyc`, { decision: 'reject', reason }, 'KYC rejected'); }}>Reject</button>
            </div>
          )}
          {can('workers.enforce') && (
            <>
              <h3 className="mt">Enforcement</h3>
              <div className="row wrap">
                <button className="btn sm" onClick={() => { const reason = ask('Reason for suspension'); const days = ask('Days (blank = until reactivated)'); if (reason) post(`/admin/workers/${id}/suspend`, { reason, days: days ? Number(days) : null }, 'Suspended'); }}>Suspend</button>
                <button className="btn sm" onClick={() => { const reason = ask('Reason for payout hold'); if (reason) post(`/admin/workers/${id}/payout-hold`, { reason }, 'Payouts held'); }}>Hold payouts</button>
                {['cash_demand', 'off_app_diversion', 'minor_mismatch', 'gps_tampering'].map((v) => (
                  <button key={v} className="btn sm danger" onClick={() => { if (window.confirm(`Issue a "${v}" strike? This applies the enforcement table automatically.`)) post(`/admin/workers/${id}/strike`, { violation: v }, `Strike issued: ${v}`); }}>Strike: {v}</button>
                ))}
              </div>
              <h3 className="mt">Requests needing a second admin</h3>
              <div className="row wrap">
                {w.status !== 'active' && <button className="btn sm" onClick={() => { const reason = ask('Why reactivate?'); if (reason) post(`/admin/workers/${id}/change-requests`, { kind: 'worker_reactivation', reason }, 'Reactivation requested'); }}>Request reactivation</button>}
                {w.payout_hold && <button className="btn sm" onClick={() => { const reason = ask('Why release the hold?'); if (reason) post(`/admin/workers/${id}/change-requests`, { kind: 'payout_hold_release', reason }, 'Hold release requested'); }}>Request hold release</button>}
              </div>
            </>
          )}
          {can('commission.request') && (
            <form className="mt" onSubmit={(e) => { e.preventDefault(); const reason = ask('Reason for commission change'); if (reason) post(`/admin/workers/${id}/change-requests`, { kind: 'commission_rate', commissionRatePercent: Number(rate), reason }, 'Commission change requested — awaiting approval'); }}>
              <Field label="Propose commission rate (%)"><input type="number" min={0} max={50} step={0.01} value={rate} onChange={(e) => setRate(e.target.value)} required /></Field>
              <button className="btn sm">Request change</button>
            </form>
          )}
        </div>
      </div>
      <div className="cols">
        <div className="card">
          <h3>Fraud flags</h3>
          {d.flags.length === 0 && <p className="small muted">None.</p>}
          {d.flags.map((f) => <div key={f.id} className="small"><span className={`badge ${SEVERITY_TONE[f.severity]}`}>{f.severity}</span> {f.flag_type} · {f.status} · {fmtDateTime(f.created_at)} {f.booking_id && <Link to={`/bookings/${f.booking_id}`}>booking</Link>}</div>)}
        </div>
        <div className="card">
          <h3>Strike record</h3>
          {d.strikes.length === 0 && <p className="small muted">None.</p>}
          {d.strikes.map((s, i) => <div key={i} className="small">{fmtDateTime(s.created_at)} · {s.violation} → {s.action_taken}{s.issued_by ? '' : ' (automated)'}</div>)}
          <h3 className="mt">Policy acknowledgements</h3>
          {d.policyAcks.map((a, i) => <div key={i} className="small">{a.policy_version} · {fmtDateTime(a.acknowledged_at)}</div>)}
        </div>
      </div>
    </div>
  );
}
