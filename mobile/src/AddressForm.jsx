import { useState } from 'react';
import { api } from './api';
import { currentPosition } from './location';
import { Button, Card, ErrorNote, Field, H, Row, T, useAction } from './ui';

export default function AddressForm({ onSaved, onCancel }) {
  const [f, setF] = useState({ label: 'Home', line1: '', line2: '', landmark: '', city: '', pincode: '' });
  const [pos, setPos] = useState(null);
  const { busy, error, run, setError } = useAction();
  const set = (k) => (v) => setF({ ...f, [k]: v });

  const locate = async () => {
    try {
      setError(null);
      setPos(await currentPosition());
    } catch (e) { setError(e); }
  };

  const save = () => run(async () => {
    if (!pos) throw new Error('Please pin your location so the professional can find you');
    const s = await api(`/serviceability?pincode=${encodeURIComponent(f.pincode)}`);
    if (!s.serviceable) throw new Error(`Sorry, we don't serve PIN code ${f.pincode} yet.`);
    const r = await api('/addresses', { method: 'POST', body: { ...f, lat: pos.lat, lng: pos.lng } });
    onSaved(r.id);
  });

  return (
    <Card>
      <H level={2}>Add address</H>
      <Field label="Label" value={f.label} onChangeText={set('label')} maxLength={30} />
      <Field label="House / flat, street" value={f.line1} onChangeText={set('line1')} autoComplete="street-address" />
      <Field label="Area (optional)" value={f.line2} onChangeText={set('line2')} />
      <Field label="Landmark (optional)" value={f.landmark} onChangeText={set('landmark')} />
      <Field label="City" value={f.city} onChangeText={set('city')} />
      <Field label="PIN code" value={f.pincode} onChangeText={set('pincode')} keyboardType="number-pad" maxLength={6} autoComplete="postal-code" />
      <Button title={pos ? `📍 Pinned (±${pos.accuracyM} m) — re-pin` : '📍 Pin my current location'} onPress={locate} />
      <T small muted>Do this while you're at the address. The professional must check in near this point.</T>
      <ErrorNote error={error} />
      <Row>
        {onCancel && <Button title="Cancel" onPress={onCancel} />}
        <Button kind="primary" title="Save address" onPress={save} busy={busy} disabled={f.line1.length < 3 || f.city.length < 2 || f.pincode.length !== 6} />
      </Row>
    </Card>
  );
}
