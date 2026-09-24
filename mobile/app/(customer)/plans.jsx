import { useState } from 'react';
import { api, fmtDate, rupees } from '../../src/api';
import { payOrder } from '../../src/payments';
import {
  Badge, Banner, Button, Card, Check, Chips, ErrorNote, H, Loading, Row, Screen, T, useAction, useApi,
} from '../../src/ui';

const FREQ = [['monthly', 'Monthly'], ['quarterly', 'Every 3 months'], ['half_yearly', 'Every 6 months']];
const startDates = Array.from({ length: 14 }, (_, i) => new Date(Date.now() + 5.5 * 3600_000 + (i + 1) * 86400_000).toISOString().slice(0, 10));

export default function Plans() {
  const [subs, , reload] = useApi('/subscriptions');
  const [svcs] = useApi('/services');
  const [addrs] = useApi('/addresses');
  const [f, setF] = useState({ serviceId: null, addressId: null, frequency: 'quarterly', visits: 4, preferredHour: 10, startDate: startDates[0] });
  const [agree, setAgree] = useState(false);
  const [ok, setOk] = useState(null);
  const { busy, error, run } = useAction();
  if (!subs || !svcs || !addrs) return <Screen><Loading /></Screen>;
  const svc = svcs.services.find((s) => s.id === f.serviceId);
  const maxVisits = f.frequency === 'half_yearly' ? 4 : 12;

  return (
    <Screen onRefresh={reload}>
      <T small muted>Pay once upfront; each visit is scheduled for you and completed with your code like any booking.</T>
      {ok && <Banner tone="ok">{ok}</Banner>}
      {subs.subscriptions.map((s) => (
        <Card key={s.id}>
          <Row><T bold style={{ flex: 1 }}>{s.service_name}</T><Badge tone={s.status === 'active' ? 'ok' : 'warn'}>{s.status.replace('_', ' ')}</Badge></Row>
          <T small muted>{s.visits_generated}/{s.visits_total} visits scheduled · next {fmtDate(s.next_due_date)} · {rupees(s.amount)}</T>
        </Card>
      ))}
      <Card>
        <H level={2}>New plan</H>
        <T small muted>Service</T>
        <Chips value={f.serviceId} onChange={(v) => setF({ ...f, serviceId: v })} options={svcs.services.map((s) => [s.id, `${s.name} · ${rupees(s.fixed_price_paise)}`])} />
        <T small muted>Address</T>
        {addrs.addresses.length === 0 ? <T small>Add an address from Account first.</T>
          : <Chips value={f.addressId} onChange={(v) => setF({ ...f, addressId: v })} options={addrs.addresses.map((a) => [a.id, `${a.label}: ${a.line1}`])} />}
        <T small muted>Frequency</T>
        <Chips value={f.frequency} onChange={(v) => setF({ ...f, frequency: v, visits: Math.min(f.visits, v === 'half_yearly' ? 4 : 12) })} options={FREQ} />
        <T small muted>Visits</T>
        <Chips value={f.visits} onChange={(v) => setF({ ...f, visits: v })} options={Array.from({ length: maxVisits - 1 }, (_, i) => [i + 2, String(i + 2)])} />
        <T small muted>First visit</T>
        <Chips value={f.startDate} onChange={(v) => setF({ ...f, startDate: v })} options={startDates.map((d) => [d, fmtDate(`${d}T12:00:00+05:30`)])} />
        <T small muted>Preferred time (IST)</T>
        <Chips value={f.preferredHour} onChange={(v) => setF({ ...f, preferredHour: v })} options={Array.from({ length: 14 }, (_, i) => [7 + i, `${7 + i}:00`])} />
        {svc && <Row><T bold>Total upfront</T><T big>{rupees(svc.fixed_price_paise * f.visits)}</T></Row>}
        <Check checked={agree} onChange={setAgree}>I agree to be charged the full plan amount now. Unused visits can be refunded through support.</Check>
        <ErrorNote error={error} />
        <Button kind="primary" title="Pay & activate" busy={busy} disabled={!agree || !f.serviceId || !f.addressId} onPress={() => run(async () => {
          const r = await api('/subscriptions', { method: 'POST', body: { ...f, acceptTerms: true } });
          await payOrder(r.order, { description: `${svc.name} plan` });
          setOk('Your plan is active. Visits will appear in Bookings automatically.');
          await reload();
        })} />
      </Card>
    </Screen>
  );
}
