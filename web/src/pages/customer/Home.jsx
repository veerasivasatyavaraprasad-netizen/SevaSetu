import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, rupees } from '../../api.js';
import { useSession } from '../../session.jsx';
import { ErrorNote, Field, Loading, useApi } from '../../ui.jsx';

const CATEGORY_LABELS = {
  cleaning: 'Cleaning', ac_service: 'AC service', pest_control: 'Pest control', plumbing: 'Plumbing',
  electrical: 'Electrical', appliance_repair: 'Appliances', repairs: 'Repairs', tutoring: 'Tutoring',
};

export default function Home() {
  const { user, reload } = useSession();
  const [data, error] = useApi('/services');
  const [cat, setCat] = useState('all');
  const [q, setQ] = useState('');

  const services = useMemo(() => (data?.services || []).filter((s) =>
    (cat === 'all' || s.category === cat) && s.name.toLowerCase().includes(q.toLowerCase())), [data, cat, q]);
  const cats = [...new Set((data?.services || []).map((s) => s.category))];

  return (
    <div className="stack">
      {!user.name && <NameCard onDone={reload} />}
      <div>
        <h1>What do you need help with?</h1>
        <input type="search" placeholder="Search services" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search services" />
      </div>
      <div className="chips">
        <button type="button" className={`chip ${cat === 'all' ? 'active' : ''}`} onClick={() => setCat('all')}>All</button>
        {cats.map((c) => (
          <button type="button" key={c} className={`chip ${cat === c ? 'active' : ''}`} onClick={() => setCat(c)}>{CATEGORY_LABELS[c] || c}</button>
        ))}
      </div>
      <div className="banner info small">
        Prices are fixed and shown upfront. <strong>Only pay inside the app</strong> — it protects your payment and your service guarantee.
      </div>
      <ErrorNote error={error} />
      {!data && !error && <Loading />}
      {services.map((s) => (
        <Link key={s.id} to={`/services/${s.id}`} className="card list-item">
          <div className="row between">
            <div className="grow">
              <h3>{s.name}</h3>
              <p className="small muted" style={{ margin: 0 }}>{s.duration_minutes} min · {Number(s.rating) > 0 ? `★ ${s.rating} (${s.reviews})` : 'New'}</p>
            </div>
            <div className="big">{rupees(s.fixed_price_paise)}</div>
          </div>
        </Link>
      ))}
      {data && services.length === 0 && <p className="muted center">No services match.</p>}
    </div>
  );
}

function NameCard({ onDone }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    try {
      await api('/me', { method: 'PATCH', body: { name, ...(email ? { email } : {}) } });
      onDone();
    } catch (x) { setErr(x); }
  };
  return (
    <form className="card" onSubmit={save}>
      <h2>Welcome! What should we call you?</h2>
      <Field label="Your name"><input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} /></Field>
      <Field label="Email (optional)"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <ErrorNote error={err} />
      <button className="btn primary block">Save</button>
    </form>
  );
}
