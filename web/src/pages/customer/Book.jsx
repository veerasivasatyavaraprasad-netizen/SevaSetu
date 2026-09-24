import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, rupees } from '../../api.js';
import { payOrder } from '../../checkout.js';
import { ErrorNote, Field, Loading, useAction, useApi } from '../../ui.jsx';
import AddressForm from './AddressForm.jsx';

function istDateStr(offsetDays) {
  const d = new Date(Date.now() + 5.5 * 3600_000 + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

const HOURS = Array.from({ length: 14 }, (_, i) => 7 + i); // 7:00–20:00 IST

export default function Book() {
  const { id } = useParams();
  const nav = useNavigate();
  const [svc] = useApi(`/services/${id}`);
  const [addrData, , reloadAddrs] = useApi('/addresses');
  const [addressId, setAddressId] = useState('');
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState(istDateStr(1));
  const [hour, setHour] = useState(10);
  const [quote, setQuote] = useState(null);
  const [agree, setAgree] = useState(false);
  const { busy, error, run, setError } = useAction();

  const scheduledTime = useMemo(() => `${date}T${String(hour).padStart(2, '0')}:00:00+05:30`, [date, hour]);
  const addresses = addrData?.addresses || [];

  useEffect(() => {
    if (!addressId && addresses.length) setAddressId(addresses[0].id);
  }, [addresses, addressId]);

  useEffect(() => {
    setQuote(null);
    setError(null);
    api('/bookings/quote', { method: 'POST', body: { serviceId: id, scheduledTime } })
      .then(setQuote).catch(setError);
  }, [id, scheduledTime, setError]);

  if (!svc || !addrData) return <Loading />;
  if (adding || addresses.length === 0) {
    return <AddressForm onSaved={(aid) => { setAddressId(aid); setAdding(false); reloadAddrs(); }} onCancel={addresses.length ? () => setAdding(false) : null} />;
  }

  const book = () => run(async () => {
    const r = await api('/bookings', { method: 'POST', body: { serviceId: id, addressId, scheduledTime, acceptCancellationPolicy: true } });
    try {
      await payOrder(r.order, { description: svc.service.name });
    } catch (e) {
      // Booking exists but is unpaid: the customer can pay from its page.
      nav(`/bookings/${r.booking.id}`, { state: { payError: e.message } });
      return;
    }
    nav(`/bookings/${r.booking.id}`, { state: { justPaid: true } });
  });

  return (
    <div className="stack">
      <h1>Book {svc.service.name}</h1>
      <div className="card">
        <Field label="Address">
          <select value={addressId} onChange={(e) => setAddressId(e.target.value)}>
            {addresses.map((a) => <option key={a.id} value={a.id}>{a.label}: {a.line1}, {a.pincode}</option>)}
          </select>
        </Field>
        <button type="button" className="btn ghost sm" onClick={() => setAdding(true)}>+ New address</button>
      </div>
      <div className="card">
        <div className="grid2">
          <Field label="Date"><input type="date" value={date} min={istDateStr(0)} max={istDateStr(60)} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Time (IST)">
            <select value={hour} onChange={(e) => setHour(Number(e.target.value))}>
              {HOURS.map((h) => <option key={h} value={h}>{h > 12 ? `${h - 12}:00 PM` : `${h}:00 ${h === 12 ? 'PM' : 'AM'}`}</option>)}
            </select>
          </Field>
        </div>
      </div>
      <div className="card">
        <h2>Price</h2>
        {!quote && !error && <Loading />}
        {quote && (
          <>
            <div className="row between small"><span>Service</span><span>{rupees(quote.quote.basePrice)}</span></div>
            {quote.quote.isUrgent && <div className="row between small"><span>Urgent (same-day) premium</span><span>{rupees(quote.quote.urgentPremium)}</span></div>}
            <div className="row between mt"><strong>Total</strong><span className="big">{rupees(quote.quote.total)}</span></div>
            <div className="banner warn small mt"><strong>Cancellation policy.</strong> {quote.cancellationPolicy.text}</div>
            <label className="check">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <span>I agree to the cancellation & refund policy.</span>
            </label>
          </>
        )}
        <ErrorNote error={error} />
        <button className="btn primary block" disabled={!quote || !agree || busy} onClick={book}>
          {busy ? 'Processing…' : quote ? `Pay ${rupees(quote.quote.total)} securely` : 'Pay'}
        </button>
        <p className="small muted center" style={{ marginTop: 8 }}>You pay the platform, not the professional. Never pay in cash.</p>
      </div>
    </div>
  );
}
