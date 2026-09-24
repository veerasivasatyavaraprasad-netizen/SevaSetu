import { Link, useParams } from 'react-router-dom';
import { fmtDate, rupees } from '../../api.js';
import { ErrorNote, Loading, useApi } from '../../ui.jsx';

export default function ServiceDetail() {
  const { id } = useParams();
  const [data, error] = useApi(`/services/${id}`);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const s = data.service;
  return (
    <div className="stack">
      <div className="card">
        <h1>{s.name}</h1>
        <p className="muted">{s.description}</p>
        <div className="row between mt">
          <div>
            <div className="big">{rupees(s.fixed_price_paise)}</div>
            <div className="small muted">Fixed price · about {s.duration_minutes} min</div>
          </div>
          <Link to={`/book/${s.id}`} className="btn primary">Book now</Link>
        </div>
        <p className="small muted mt">Same-day bookings within {6} hours carry a {s.urgent_premium_bps / 100}% urgent premium, shown before you pay.</p>
      </div>
      <div className="card">
        <h2>What's included</h2>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Background-verified professional</li>
          <li>Pay securely in the app — never in cash</li>
          <li>Job is marked done only when you share your completion code</li>
          <li>Refund protection if something goes wrong</li>
        </ul>
      </div>
      <div className="card">
        <h2>Reviews</h2>
        {data.reviews.length === 0 && <p className="muted small">No reviews yet.</p>}
        {data.reviews.map((r, i) => (
          <div key={i} style={{ borderTop: i ? '1px solid var(--border)' : 0, paddingTop: i ? 10 : 0, marginTop: i ? 10 : 0 }}>
            <div className="row between small"><strong>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</strong><span className="muted">{r.customer} · {fmtDate(r.created_at)}</span></div>
            <p className="small" style={{ margin: '4px 0 0' }}>{r.comment}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
