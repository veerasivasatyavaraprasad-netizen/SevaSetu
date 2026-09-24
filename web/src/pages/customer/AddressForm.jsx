import { useState } from 'react';
import { api } from '../../api.js';
import { ErrorNote, Field, getPosition, useAction } from '../../ui.jsx';

export default function AddressForm({ onSaved, onCancel }) {
  const [f, setF] = useState({ label: 'Home', line1: '', line2: '', landmark: '', city: '', pincode: '' });
  const [pos, setPos] = useState(null);
  const { busy, error, run, setError } = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const locate = async () => {
    try {
      setError(null);
      setPos(await getPosition());
    } catch (e) { setError(e); }
  };

  const save = (e) => {
    e.preventDefault();
    run(async () => {
      if (!pos) throw new Error('Please pin your location so the professional can find you');
      const r = await api('/addresses', { method: 'POST', body: { ...f, lat: pos.lat, lng: pos.lng } });
      onSaved(r.id);
    });
  };

  return (
    <form onSubmit={save} className="card">
      <h2>Add address</h2>
      <Field label="Label"><input value={f.label} onChange={set('label')} maxLength={30} /></Field>
      <Field label="House / flat, street"><input value={f.line1} onChange={set('line1')} required minLength={3} maxLength={200} autoComplete="address-line1" /></Field>
      <Field label="Area (optional)"><input value={f.line2} onChange={set('line2')} maxLength={200} autoComplete="address-line2" /></Field>
      <Field label="Landmark (optional)"><input value={f.landmark} onChange={set('landmark')} maxLength={120} /></Field>
      <div className="grid2">
        <Field label="City"><input value={f.city} onChange={set('city')} required autoComplete="address-level2" /></Field>
        <Field label="PIN code"><input value={f.pincode} onChange={set('pincode')} required inputMode="numeric" pattern="[1-9][0-9]{5}" maxLength={6} autoComplete="postal-code" /></Field>
      </div>
      <button type="button" className="btn block" onClick={locate}>
        {pos ? `📍 Location pinned (±${pos.accuracyM} m) — re-pin` : '📍 Pin my current location'}
      </button>
      <p className="small muted" style={{ marginTop: 6 }}>Use this while you're at the address. The professional must check in near this point.</p>
      <ErrorNote error={error} />
      <div className="row mt">
        {onCancel && <button type="button" className="btn grow" onClick={onCancel}>Cancel</button>}
        <button className="btn primary grow" disabled={busy}>Save address</button>
      </div>
    </form>
  );
}
