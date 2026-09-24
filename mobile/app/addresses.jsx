import { useState } from 'react';
import { api } from '../src/api';
import AddressForm from '../src/AddressForm';
import { Button, Card, Loading, Row, Screen, T, useApi } from '../src/ui';

export default function Addresses() {
  const [data, , reload] = useApi('/addresses');
  const [adding, setAdding] = useState(false);
  if (!data) return <Screen><Loading /></Screen>;
  return (
    <Screen>
      {data.addresses.map((a) => (
        <Card key={a.id}>
          <Row>
            <T small style={{ flex: 1 }}><T small bold>{a.label}</T> — {a.line1}, {a.city} {a.pincode}</T>
            <Button kind="ghost" small title="Remove" onPress={() => api(`/addresses/${a.id}`, { method: 'DELETE' }).then(reload)} />
          </Row>
        </Card>
      ))}
      {adding ? <AddressForm onSaved={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} />
        : <Button title="+ Add address" onPress={() => setAdding(true)} />}
    </Screen>
  );
}
