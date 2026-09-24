import { useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { api, fmtDateTime, rupees } from '../../api.js';
import Chat from '../../Chat.jsx';
import { payOrder } from '../../checkout.js';
import { ErrorNote, Field, Loading, StatusBadge, useAction, useApi } from '../../ui.jsx';
import Sponsored from '../../Sponsored.jsx';

const EVENT_LABELS = {
  pending_payment: 'Booking created', paid: 'Payment received', assigned: 'Professional assigned',
  in_progress: 'Professional checked in at your address', completed: 'Job marked complete with your code',
  confirmed: 'Confirmed', disputed: 'Issue raised', cancelled: 'Cancelled', refunded: 'Refunded',
};

export default function BookingDetail() {
  const { id } = useParams();
  const loc = useLocation();
  const [data, loadError, reload] = useApi(`/bookings/${id}`);
  const { busy, error, run } = useAction();
  const [panel, setPanel] = useState(null);
  const [msg, setMsg] = useState(loc.state?.justPaid ? 'Payment successful! We are assigning a verified professional.' : null);

  if (loadError) return <ErrorNote error={loadError} />;
  if (!data) return <Loading />;
  const b = data.booking;
  const act = (fn, done) => run(async () => { await fn(); setPanel(null); if (done) setMsg(done); reload(); });

  return (
    <div className="stack">
      <div className="row between"><h1 style={{ margin: 0 }}>{b.serviceName}</h1><StatusBadge status={b.status} /></div>
      {loc.state?.payError && b.status === 'pending_payment' && <div className="banner warn">{loc.state.payError}. Your booking is saved — complete payment below.</div>}
      {msg && <div className="banner ok">{msg}</div>}
      <ErrorNote error={error} />

      <div className="card">
        <div className="row between small"><span className="muted">When</span><strong>{fmtDateTime(b.scheduledTime)}</strong></div>
        <div className="row between small"><span className="muted">Where</span><span>{b.address.line1}, {b.address.pincode}</span></div>
        <div className="row between small"><span className="muted">Paid</span><strong>{rupees(b.amount)}{b.isUrgent ? ' (incl. urgent)' : ''}</strong></div>
        {b.worker && <div className="row between small"><span className="muted">Professional</span><span>{b.worker.firstName} · ★ {b.worker.rating || 'New'}</span></div>}
        {b.isWarrantyRevisit && <div className="banner info small mt">Free warranty revisit — nothing to pay.</div>}
        {b.warrantyFee > 0 && (
          <div className="row between small"><span className="muted">Guarantee</span>
            <span>{b.warrantyActive ? `Covered until ${new Date(b.warrantyUntil).toLocaleDateString('en-IN')}` : b.warrantyUntil ? 'Expired' : 'Starts when you confirm the job'}</span></div>
        )}
      </div>
      {loc.state?.justPaid && <Sponsored slot="booking_confirmed" pincode={b.address.pincode} />}

      {b.status === 'pending_payment' && b.pendingOrder && (
        <button className="btn primary block" disabled={busy} onClick={() => act(() => payOrder(b.pendingOrder, { description: b.serviceName }), 'Payment successful!')}>
          Pay {rupees(b.amount)} securely
        </button>
      )}

      {b.completionOtp && (
        <div className="card">
          <h2>Your completion code</h2>
          <div className="otp-display" aria-label={`Completion code ${b.completionOtp.split('').join(' ')}`}>{b.completionOtp}</div>
          <p className="small muted mt">Share this code with the professional <strong>only when the job is done to your satisfaction</strong>. It is how the job gets marked complete.</p>
        </div>
      )}

      {['assigned', 'in_progress'].includes(b.status) && (
        <div className="card">
          <div className="banner warn small"><strong>Never pay in cash.</strong> You have already paid in the app. Cash payments aren't covered by our service guarantee.</div>
          {b.cashReported ? <p className="small ok mt">Thanks — your report was sent to our team.</p> : (
            <button className="btn danger block mt" disabled={busy} onClick={() => act(() => api(`/bookings/${id}/report-cash`, { method: 'POST', body: {} }), 'Report received. Do not pay cash — our team will review.')}>
              ⚠ Worker asked for cash
            </button>
          )}
        </div>
      )}

      {b.status === 'completed' && (
        <div className="card">
          <h2>Is the job done?</h2>
          <p className="small muted">Confirm, or it will auto-confirm 24 hours after completion.</p>
          <div className="row">
            <button className="btn primary grow" disabled={busy} onClick={() => setPanel('review')}>Confirm & rate</button>
            <button className="btn grow" onClick={() => setPanel('dispute')}>Report a problem</button>
          </div>
        </div>
      )}
      {b.status === 'confirmed' && !b.review && panel !== 'review' && (
        <button className="btn primary block" onClick={() => setPanel('review')}>Rate this service</button>
      )}
      {b.review && <div className="card small">You rated this {'★'.repeat(b.review.rating)}{b.review.comment ? ` — “${b.review.comment}”` : ''}</div>}
      {panel === 'review' && <ReviewForm busy={busy} onSubmit={(body) => act(() => api(`/bookings/${id}/review`, { method: 'POST', body }), 'Thanks for your feedback!')} />}

      {['in_progress', 'confirmed'].includes(b.status) && !b.disputeStatus && panel !== 'dispute' && (
        <button className="btn block" onClick={() => setPanel('dispute')}>Report a problem</button>
      )}
      {b.status === 'confirmed' && b.warrantyActive && panel !== 'warranty' && (
        <button className="btn primary block" onClick={() => setPanel('warranty')}>Claim free revisit under guarantee</button>
      )}
      {panel === 'dispute' && <DisputeForm busy={busy} onSubmit={(body) => act(() => api(`/bookings/${id}/dispute`, { method: 'POST', body }), 'Your issue has been raised. Our team will get back to you.')} />}
      {panel === 'warranty' && <DisputeForm warranty busy={busy} onSubmit={(body) => act(() => api(`/bookings/${id}/dispute`, { method: 'POST', body }), 'Guarantee claim raised. We will schedule a free revisit.')} />}

      {b.cancellation && (
        <div className="card">
          <p className="small muted">{b.cancellation.fee ? `Cancelling now retains a ${rupees(b.cancellation.fee)} late-cancellation fee.` : 'Free cancellation is available.'} Refund: {rupees(b.cancellation.refund)}.</p>
          <button className="btn danger block" disabled={busy} onClick={() => {
            // eslint-disable-next-line no-alert
            if (window.confirm('Cancel this booking?')) act(() => api(`/bookings/${id}/cancel`, { method: 'POST', body: {} }), 'Booking cancelled. Any refund goes to your original payment method.');
          }}>Cancel booking</button>
        </div>
      )}

      {b.workerAssigned && !['cancelled', 'refunded'].includes(b.status) && <Chat bookingId={id} me="customer" />}

      <div className="card">
        <h2>Timeline</h2>
        <ul className="timeline">
          {b.events.map((e, i) => <li key={i}>{EVENT_LABELS[e.to_status] || e.to_status}<div className="small muted">{fmtDateTime(e.created_at)}</div></li>)}
        </ul>
      </div>
    </div>
  );
}

function ReviewForm({ onSubmit, busy }) {
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [askedForCash, setCash] = useState(false);
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); onSubmit({ rating, comment: comment || undefined, askedForCash }); }}>
      <h2>Rate the service</h2>
      <div className="stars" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => <button type="button" key={n} className={n <= rating ? 'on' : ''} onClick={() => setRating(n)} aria-label={`${n} star`} aria-checked={n === rating} role="radio">★</button>)}
      </div>
      <Field label="Comment (optional)"><textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} /></Field>
      <label className="check"><input type="checkbox" checked={askedForCash} onChange={(e) => setCash(e.target.checked)} /><span>The professional asked me to pay in cash or outside the app</span></label>
      <button className="btn primary block" disabled={busy}>Submit</button>
    </form>
  );
}

function DisputeForm({ onSubmit, busy, warranty = false }) {
  const [reason, setReason] = useState(warranty ? 'warranty_claim' : 'not_completed');
  const [description, setDesc] = useState('');
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); onSubmit({ reason, description }); }}>
      <h2>{warranty ? 'Claim under guarantee' : 'Report a problem'}</h2>
      {!warranty && <Field label="What went wrong?">
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="not_completed">Job not completed</option>
          <option value="poor_quality">Poor quality</option>
          <option value="damage">Damage to property</option>
          <option value="overcharged">Asked to pay extra</option>
          <option value="asked_for_cash">Asked to pay in cash</option>
          <option value="other">Other</option>
        </select>
      </Field>}
      <Field label="Details"><textarea value={description} onChange={(e) => setDesc(e.target.value)} minLength={10} maxLength={2000} required /></Field>
      <p className="small muted">The professional's payout is held while we review.</p>
      <button className="btn primary block" disabled={busy}>Submit</button>
    </form>
  );
}
