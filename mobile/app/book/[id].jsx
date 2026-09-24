import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { api, rupees } from '../../src/api';
import AddressForm from '../../src/AddressForm';
import { payOrder } from '../../src/payments';
import {
  Banner, Button, Card, Check, Chips, ErrorNote, H, Loading, Row, Screen, T, useAction, useApi,
} from '../../src/ui';

function istDate(offsetDays) {
  return new Date(Date.now() + 5.5 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}
const DAYS = Array.from({ length: 14 }, (_, i) => i);
const HOURS = Array.from({ length: 14 }, (_, i) => 7 + i);
const hourLabel = (h) => (h > 12 ? `${h - 12} PM` : `${h} ${h === 12 ? 'PM' : 'AM'}`);

export default function Book() {
  const { id } = useLocalSearchParams();
  const [svc] = useApi(`/services/${id}`);
  const [addrs, , reloadAddrs] = useApi('/addresses');
  const [addressId, setAddressId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [day, setDay] = useState(1);
  const [hour, setHour] = useState(10);
  const [warranty, setWarranty] = useState(false);
  const [agree, setAgree] = useState(false);
  const [quote, setQuote] = useState(null);
  const { busy, error, run, setError } = useAction();
  const date = istDate(day);
  const scheduledTime = useMemo(() => `${date}T${String(hour).padStart(2, '0')}:00:00+05:30`, [date, hour]);
  const list = addrs?.addresses || [];

  useEffect(() => { if (!addressId && list.length) setAddressId(list[0].id); }, [list, addressId]);
  useEffect(() => {
    setQuote(null);
    setError(null);
    api('/bookings/quote', { method: 'POST', body: { serviceId: id, scheduledTime, withWarranty: warranty } }).then(setQuote).catch(setError);
  }, [id, scheduledTime, warranty, setError]);

  if (!svc || !addrs) return <Screen><Loading /></Screen>;
  if (adding || list.length === 0) {
    return (
      <Screen>
        <AddressForm onSaved={(aid) => { setAddressId(aid); setAdding(false); reloadAddrs(); }} onCancel={list.length ? () => setAdding(false) : null} />
      </Screen>
    );
  }

  const book = () => run(async () => {
    const r = await api('/bookings', { method: 'POST', body: { serviceId: id, addressId, scheduledTime, acceptCancellationPolicy: true, withWarranty: warranty } });
    try {
      await payOrder(r.order, { description: svc.service.name });
    } catch (e) {
      router.replace({ pathname: `/booking/${r.booking.id}`, params: { payError: e.message } });
      return;
    }
    router.replace({ pathname: `/booking/${r.booking.id}`, params: { justPaid: '1' } });
  });

  return (
    <Screen>
      <H>{svc.service.name}</H>
      <Card>
        <T small muted>Address</T>
        <Chips value={addressId} onChange={setAddressId} options={list.map((a) => [a.id, `${a.label}: ${a.line1}`])} />
        <Button kind="ghost" small title="+ New address" onPress={() => setAdding(true)} />
      </Card>
      <Card>
        <T small muted>Day</T>
        <Chips value={day} onChange={setDay} options={DAYS.map((d) => [d, d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : new Date(`${istDate(d)}T00:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })])} />
        <T small muted>Time (IST)</T>
        <Chips value={hour} onChange={setHour} options={HOURS.map((h) => [h, hourLabel(h)])} />
      </Card>
      <Card>
        <H level={2}>Price</H>
        {!quote && !error && <Loading />}
        {quote && (
          <>
            <Row><T small>Service</T><T small>{rupees(quote.quote.basePrice)}</T></Row>
            {quote.quote.isUrgent && <Row><T small>Urgent (same-day) premium</T><T small>{rupees(quote.quote.urgentPremium)}</T></Row>}
            {quote.quote.warrantyAvailable && (
              <Check checked={warranty} onChange={setWarranty}>
                Add a {quote.quote.warrantyDays}-day service guarantee for {rupees(quote.quote.warrantyOptionFee)}: if the problem comes back, the professional revisits free.
              </Check>
            )}
            {quote.quote.warrantyFee > 0 && <Row><T small>{quote.quote.warrantyDays}-day guarantee</T><T small>{rupees(quote.quote.warrantyFee)}</T></Row>}
            <Row><T bold>Total</T><T big>{rupees(quote.quote.total)}</T></Row>
            <Banner tone="warn">{`Cancellation policy. ${quote.cancellationPolicy.text}`}</Banner>
            <Check checked={agree} onChange={setAgree}>I agree to the cancellation & refund policy.</Check>
          </>
        )}
        <ErrorNote error={error} />
        <Button kind="primary" title={quote ? `Pay ${rupees(quote.quote.total)} securely` : 'Pay'} onPress={book} busy={busy} disabled={!quote || !agree || !addressId} />
        <T small muted center>You pay the platform, not the professional. Never pay in cash.</T>
      </Card>
    </Screen>
  );
}
