import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fmtDateTime, rupees } from '../../api.js';
import Chat from '../../Chat.jsx';
import { ErrorNote, Field, getPosition, Loading, StatusBadge, useAction, useApi } from '../../ui.jsx';

export default function JobDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, loadErr, reload] = useApi(`/worker/jobs/${id}`);
  const [otp, setOtp] = useState('');
  const [msg, setMsg] = useState(null);
  const { busy, error, run } = useAction();

  if (loadErr) return <ErrorNote error={loadErr} />;
  if (!data) return <Loading />;
  const j = data.job;
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${j.location.lat},${j.location.lng}`;

  // The browser can't detect mock locations; the native app reports
  // Location.isMock() in the same field.
  const checkIn = () => run(async () => {
    const pos = await getPosition();
    const r = await api(`/worker/jobs/${id}/checkin`, { method: 'POST', body: { ...pos, isMock: false } });
    setMsg(`Checked in (${r.distanceM} m from the address).`);
    reload();
  });

  const complete = (e) => {
    e.preventDefault();
    run(async () => {
      const pos = await getPosition();
      await api(`/worker/jobs/${id}/complete`, { method: 'POST', body: { otp, ...pos, isMock: false } });
      setMsg('Job completed. Your earning moves to the payout queue once the customer confirms.');
      setOtp('');
      reload();
    });
  };

  const withdraw = () => {
    // eslint-disable-next-line no-alert
    const reason = window.prompt('Why can you no longer do this job?');
    if (!reason) return;
    run(async () => { await api(`/worker/jobs/${id}/withdraw`, { method: 'POST', body: { reason } }); nav('/'); });
  };

  return (
    <div className="stack">
      <div className="row between"><h1 style={{ margin: 0 }}>{j.serviceName}</h1><StatusBadge status={j.status} forWorker /></div>
      {msg && <div className="banner ok">{msg}</div>}
      <ErrorNote error={error} />
      <div className="card">
        <div className="row between small"><span className="muted">When</span><strong>{fmtDateTime(j.scheduledTime)}</strong></div>
        <div className="row between small"><span className="muted">Customer</span><span>{j.customerFirstName}</span></div>
        <div className="small mt"><span className="muted">Address</span><br />{j.address.line1}{j.address.line2 ? `, ${j.address.line2}` : ''}{j.address.landmark ? ` (near ${j.address.landmark})` : ''}<br />{j.address.city} {j.address.pincode}</div>
        <div className="row between small mt"><span className="muted">You earn</span><strong>{rupees(j.yourEarning)}</strong></div>
        <a className="btn block mt" href={mapsUrl} target="_blank" rel="noopener noreferrer">🧭 Navigate</a>
      </div>

      {j.status === 'assigned' && (
        <div className="card">
          <h2>Arrived?</h2>
          <p className="small muted">Check in at the customer's address (within {j.checkinRadiusM} m) to start the job.</p>
          <button className="btn primary block" disabled={busy} onClick={checkIn}>📍 Check in with GPS</button>
          <button className="btn ghost block mt" disabled={busy} onClick={withdraw}>I can't do this job</button>
        </div>
      )}

      {j.status === 'in_progress' && (
        <form className="card" onSubmit={complete}>
          <h2>Finish the job</h2>
          <p className="small muted">Ask the customer for their 4-digit completion code once they are satisfied. Never accept cash — they have already paid in the app.</p>
          <Field label="Completion code">
            <input className="otp-input" inputMode="numeric" maxLength={4} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} required />
          </Field>
          <p className="small muted">{j.otpAttemptsLeft} attempts left.</p>
          <button className="btn primary block" disabled={busy || otp.length !== 4}>Mark complete</button>
        </form>
      )}

      {j.status === 'completed' && <div className="banner info">Waiting for the customer to confirm (auto-confirms after 24 hours).</div>}

      <Chat bookingId={id} me="worker" />
    </div>
  );
}
