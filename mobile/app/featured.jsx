import { useState } from 'react';
import { api, fmtDate, rupees } from '../src/api';
import { payOrder } from '../src/payments';
import { Banner, Button, Card, ErrorNote, Loading, Row, Screen, T, useAction, useApi } from '../src/ui';

// Plan §2: workers pay for priority visibility on new jobs.
export default function Featured() {
  const [data, error, reload] = useApi('/worker/featured');
  const { busy, error: actError, run } = useAction();
  const [msg, setMsg] = useState(null);
  if (error && !data) return <Screen><ErrorNote error={error} /></Screen>;
  if (!data) return <Screen><Loading /></Screen>;
  const active = data.active[0];
  return (
    <Screen>
      <T muted>Featured professionals see new paid jobs in their area {data.priorityMinutes} minutes before everyone else, and get the first notification.</T>
      {msg && <Banner tone="ok">{msg}</Banner>}
      {active && <Banner>{`Featured until ${fmtDate(active.ends_at)}. Buying again extends it.`}</Banner>}
      <ErrorNote error={actError} />
      {data.plans.length === 0 && <T small muted>No plans are on offer right now.</T>}
      {data.plans.map((p) => (
        <Card key={p.id}>
          <Row>
            <T style={{ flex: 1 }}><T bold>{p.name}</T>{'\n'}<T small muted>{p.days} days of priority access</T></T>
            <Button kind="primary" title={rupees(p.price_paise)} busy={busy} onPress={() => run(async () => {
              const r = await api('/worker/featured', { method: 'POST', body: { planId: p.id } });
              await payOrder(r.order, { description: `Featured professional — ${p.name}` });
              setMsg('You are now featured. New jobs in your area reach you first.');
              await reload();
            })} />
          </Row>
        </Card>
      ))}
      <T small muted center>Paid securely in the app. Featured status never changes prices or your commission.</T>
    </Screen>
  );
}
