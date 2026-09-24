import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDateTime } from '../api.js';
import { ErrorNote, Field, Loading, useAction, useApi } from '../ui.jsx';
import { SEVERITY_TONE, Table } from './common.jsx';

const SUGGESTED = {
  cash_demand_report: 'cash_demand', repeated_cash_demand_reports: 'cash_demand', gps_mismatch: 'off_app_diversion',
  completed_without_payment: 'off_app_diversion', gps_tampering: 'gps_tampering', checkin_far_from_address: 'minor_mismatch',
  checkout_far_from_address: 'minor_mismatch', missing_customer_otp: 'minor_mismatch', chat_off_app_attempt: 'cash_demand',
};

export default function Fraud() {
  const [status, setStatus] = useState('open');
  const [data, error, reload] = useApi(`/admin/fraud-flags?status=${status}`);
  const [sel, setSel] = useState(null);
  const [f, setF] = useState({ decision: 'confirm', violation: '', note: '', releaseBookingPayout: false });
  const act = useAction();
  const [msg, setMsg] = useState(null);

  const open = (flag) => { setSel(flag); setF({ decision: 'confirm', violation: SUGGESTED[flag.flag_type] || '', note: '', releaseBookingPayout: false }); };
  const submit = (e) => {
    e.preventDefault();
    act.run(async () => {
      const body = { decision: f.decision, note: f.note, ...(f.decision === 'confirm' && f.violation ? { violation: f.violation } : {}), ...(f.decision === 'dismiss' ? { releaseBookingPayout: f.releaseBookingPayout } : {}) };
      const r = await api(`/admin/fraud-flags/${sel.id}/review`, { method: 'POST', body });
      setMsg(r.action ? `Confirmed. Enforcement applied: ${r.action.replaceAll('_', ' ')}` : `Flag ${f.decision}ed.`);
      setSel(null);
      reload();
    });
  };

  return (
    <div className="stack">
      <h1>Fraud & anomaly queue</h1>
      <p className="small muted">Automation flags; people decide. Ranked by severity. Confirming with a violation applies the Section 9.6 enforcement table.</p>
      <div className="toolbar"><select value={status} onChange={(e) => setStatus(e.target.value)}>{['open', 'confirmed', 'dismissed'].map((s) => <option key={s}>{s}</option>)}</select></div>
      {msg && <div className="banner ok">{msg}</div>}
      <ErrorNote error={error || act.error} />
      {!data ? <Loading /> : (
        <Table rows={data.flags} onRow={status === 'open' ? open : undefined} cols={[
          ['severity', 'Severity', (r) => <span className={`badge ${SEVERITY_TONE[r.severity]}`}>{r.severity}</span>],
          ['flag_type', 'Type', (r) => r.flag_type.replaceAll('_', ' ')],
          ['worker_name', 'Worker', (r) => (r.worker_id ? <Link to={`/workers/${r.worker_id}`} onClick={(e) => e.stopPropagation()}>{r.worker_name}</Link> : '—')],
          ['customer_name', 'Customer', (r) => r.customer_name || '—'],
          ['booking_id', 'Booking', (r) => (r.booking_id ? <Link to={`/bookings/${r.booking_id}`} onClick={(e) => e.stopPropagation()}>view</Link> : '—')],
          ['details', 'Details', (r) => <pre className="json">{JSON.stringify(r.details)}</pre>],
          ['created_at', 'Raised', (r) => fmtDateTime(r.created_at)],
          ['review_note', 'Review', (r) => r.review_note || ''],
        ]} />
      )}
      {sel && (
        <form className="card" onSubmit={submit}>
          <h2>Review: {sel.flag_type.replaceAll('_', ' ')}</h2>
          <Field label="Decision">
            <select value={f.decision} onChange={(e) => setF({ ...f, decision: e.target.value })}>
              <option value="confirm">Confirm (violation happened)</option>
              <option value="dismiss">Dismiss (false positive)</option>
            </select>
          </Field>
          {f.decision === 'confirm' && sel.worker_id && (
            <Field label="Violation (enforcement is applied automatically)">
              <select value={f.violation} onChange={(e) => setF({ ...f, violation: e.target.value })}>
                <option value="">None — confirm without strike</option>
                <option value="cash_demand">Cash-only demand (warning → 7-day suspension → deactivation)</option>
                <option value="off_app_diversion">Off-app job diversion (payout hold + deactivation)</option>
                <option value="minor_mismatch">Minor mismatch (reminder + 30-day monitoring)</option>
                <option value="gps_tampering">GPS tampering (immediate suspension)</option>
              </select>
            </Field>
          )}
          {f.decision === 'dismiss' && sel.booking_id && (
            <label className="check"><input type="checkbox" checked={f.releaseBookingPayout} onChange={(e) => setF({ ...f, releaseBookingPayout: e.target.checked })} /><span>I verified this booking manually — release its held payout</span></label>
          )}
          <Field label="Evidence / note"><textarea value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} minLength={3} required /></Field>
          <div className="row"><button type="button" className="btn" onClick={() => setSel(null)}>Close</button><button className="btn primary" disabled={act.busy}>Submit review</button></div>
        </form>
      )}
    </div>
  );
}
