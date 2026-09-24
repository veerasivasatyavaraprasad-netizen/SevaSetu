import { Link } from 'react-router-dom';
import { fmtDateTime, rupees } from '../../api.js';
import { ErrorNote, Loading, StatusBadge, useApi } from '../../ui.jsx';

const ACTIVE = ['pending_payment', 'paid', 'assigned', 'in_progress', 'completed', 'disputed'];

export default function MyBookings() {
  const [data, error] = useApi('/bookings');
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const upcoming = data.bookings.filter((b) => ACTIVE.includes(b.status));
  const past = data.bookings.filter((b) => !ACTIVE.includes(b.status));
  const Section = ({ title, items }) => (
    <>
      <h2 className="mt">{title}</h2>
      {items.length === 0 && <p className="muted small">Nothing here.</p>}
      {items.map((b) => (
        <Link key={b.id} to={`/bookings/${b.id}`} className="card list-item">
          <div className="row between">
            <div className="grow">
              <h3 style={{ margin: 0 }}>{b.serviceName}</h3>
              <div className="small muted">{fmtDateTime(b.scheduledTime)} · {rupees(b.amount)}</div>
            </div>
            <StatusBadge status={b.status} />
          </div>
        </Link>
      ))}
    </>
  );
  return (
    <div className="stack">
      <h1>My bookings</h1>
      <Section title="Upcoming & active" items={upcoming} />
      <Section title="Past" items={past} />
    </div>
  );
}
