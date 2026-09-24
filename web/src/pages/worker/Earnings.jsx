import { fmtDate, rupees } from '../../api.js';
import { ErrorNote, Loading, useApi } from '../../ui.jsx';

const ITEM_STATUS = { pending: ['Next payout', 'brand'], held: ['On hold', 'warn'], batched: ['Processing', 'brand'], paid: ['Paid', 'ok'], cancelled: ['Cancelled', ''] };

export default function Earnings() {
  const [data, error] = useApi('/worker/earnings');
  const [reviews] = useApi('/worker/reviews');
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const s = data.summary;
  return (
    <div className="stack">
      <h1>Earnings</h1>
      <div className="grid2">
        <div className="stat"><div className="v">{rupees(s.pending)}</div><div className="l">Pending (next weekly payout)</div></div>
        <div className="stat"><div className="v">{rupees(s.processing)}</div><div className="l">Processing</div></div>
        <div className="stat"><div className="v">{rupees(s.held)}</div><div className="l">On hold (under review)</div></div>
        <div className="stat"><div className="v">{rupees(s.paid_total)}</div><div className="l">Paid to date</div></div>
      </div>
      <p className="small muted">Payouts are sent weekly to your verified account. Jobs are paid after the customer confirms and our nightly checks pass.</p>

      <div className="card">
        <h2>Payouts</h2>
        {data.payouts.length === 0 && <p className="small muted">No payouts yet.</p>}
        {data.payouts.map((p) => (
          <div key={p.id} className="row between small" style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
            <span>{fmtDate(p.week_start)} – {fmtDate(p.week_end)}{p.utr_number ? <span className="muted mono"> · UTR {p.utr_number}</span> : null}</span>
            <span><strong>{rupees(p.total_amount)}</strong> <span className={`badge ${p.status === 'paid' ? 'ok' : p.status === 'failed' ? 'danger' : ''}`}>{p.status}</span></span>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Jobs</h2>
        {data.items.map((i) => {
          const [label, tone] = ITEM_STATUS[i.status] || [i.status, ''];
          return (
            <div key={i.booking_id} className="row between small" style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
              <span>{i.service_name} <span className="muted">· {fmtDate(i.created_at)}</span>{i.hold_reason ? <div className="muted">{i.hold_reason}</div> : null}</span>
              <span><strong>{rupees(i.amount)}</strong> <span className={`badge ${tone}`}>{label}</span></span>
            </div>
          );
        })}
      </div>

      <div className="card">
        <h2>Ratings</h2>
        {reviews?.reviews.length === 0 && <p className="small muted">No ratings yet.</p>}
        {reviews?.reviews.map((r, i) => (
          <div key={i} className="small" style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
            {'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)} {r.comment && `— ${r.comment}`}
          </div>
        ))}
      </div>
    </div>
  );
}
