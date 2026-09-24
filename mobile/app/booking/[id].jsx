import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { api, fmtDate, fmtDateTime, rupees } from '../../src/api';
import Chat from '../../src/Chat';
import { payOrder } from '../../src/payments';
import Sponsored from '../../src/Sponsored';
import {
  Banner, Button, Card, Check, Chips, ErrorNote, Field, H, Loading, Row, Screen, StatusBadge, T, useAction, useApi, useTheme,
} from '../../src/ui';

const EVENTS = {
  pending_payment: 'Booking created', paid: 'Payment received', assigned: 'Professional assigned',
  in_progress: 'Professional checked in at your address', completed: 'Job marked complete with your code',
  confirmed: 'Confirmed', disputed: 'Issue raised', cancelled: 'Cancelled', refunded: 'Refunded',
};

export default function BookingDetail() {
  const t = useTheme();
  const { id, justPaid, payError } = useLocalSearchParams();
  const [data, loadError, reload] = useApi(`/bookings/${id}`);
  const { busy, error, run } = useAction();
  const [panel, setPanel] = useState(null);
  const [msg, setMsg] = useState(justPaid ? 'Payment successful! We are assigning a verified professional.' : null);
  if (loadError && !data) return <Screen><ErrorNote error={loadError} /></Screen>;
  if (!data) return <Screen><Loading /></Screen>;
  const b = data.booking;
  const act = (fn, done) => run(async () => { await fn(); setPanel(null); if (done) setMsg(done); await reload(); });
  const post = (path, body, done) => act(() => api(`/bookings/${id}/${path}`, { method: 'POST', body }), done);

  return (
    <Screen onRefresh={reload}>
      <Row><H>{b.serviceName}</H><StatusBadge status={b.status} /></Row>
      {payError && b.status === 'pending_payment' && <Banner tone="warn">{`${payError}. Your booking is saved — complete payment below.`}</Banner>}
      {msg && <Banner tone="ok">{msg}</Banner>}
      <ErrorNote error={error} />
      <Card>
        <Row><T small muted>When</T><T small bold>{fmtDateTime(b.scheduledTime)}</T></Row>
        <Row><T small muted>Where</T><T small style={{ flexShrink: 1, textAlign: 'right' }}>{b.address.line1}, {b.address.pincode}</T></Row>
        <Row><T small muted>Paid</T><T small bold>{b.isWarrantyRevisit ? 'Free warranty revisit' : rupees(b.amount)}</T></Row>
        {b.worker && <Row><T small muted>Professional</T><T small>{b.worker.firstName} · ★ {b.worker.rating || 'New'}</T></Row>}
        {b.warrantyFee > 0 && (
          <Row><T small muted>Guarantee</T>
            <T small>{b.warrantyActive ? `Covered until ${fmtDate(b.warrantyUntil)}` : b.warrantyUntil ? 'Expired' : 'Starts when you confirm'}</T></Row>
        )}
      </Card>
      {justPaid && <Sponsored slot="booking_confirmed" pincode={b.address.pincode} />}

      {b.status === 'pending_payment' && b.pendingOrder && (
        <Button kind="primary" title={`Pay ${rupees(b.amount)} securely`} busy={busy}
          onPress={() => act(() => payOrder(b.pendingOrder, { description: b.serviceName }), 'Payment successful!')} />
      )}

      {b.completionOtp && (
        <Card>
          <H level={2}>Your completion code</H>
          <View style={{ backgroundColor: t.brandSoft, borderRadius: 12, padding: 12 }}>
            <T style={{ fontSize: 36, fontWeight: '800', letterSpacing: 12, textAlign: 'center', color: t.brand }}
              accessibilityLabel={`Completion code ${b.completionOtp.split('').join(' ')}`}>{b.completionOtp}</T>
          </View>
          <T small muted>Share this code with the professional only when the job is done to your satisfaction.</T>
        </Card>
      )}

      {['assigned', 'in_progress'].includes(b.status) && (
        <Card>
          <Banner tone="warn">Never pay in cash. You have already paid in the app. Cash payments aren't covered by our service guarantee.</Banner>
          {b.cashReported ? <T small>Thanks — your report was sent to our team.</T> : (
            <Button kind="danger" title="⚠ Worker asked for cash" busy={busy}
              onPress={() => post('report-cash', {}, 'Report received. Do not pay cash — our team will review.')} />
          )}
        </Card>
      )}

      {b.status === 'completed' && (
        <Card>
          <H level={2}>Is the job done?</H>
          <T small muted>Confirm, or it will auto-confirm 24 hours after completion.</T>
          <Row>
            <View style={{ flex: 1 }}><Button kind="primary" title="Confirm & rate" onPress={() => setPanel('review')} /></View>
            <View style={{ flex: 1 }}><Button title="Report a problem" onPress={() => setPanel('dispute')} /></View>
          </Row>
        </Card>
      )}
      {b.status === 'confirmed' && !b.review && panel !== 'review' && <Button kind="primary" title="Rate this service" onPress={() => setPanel('review')} />}
      {b.review && <Card><T small>You rated this {'★'.repeat(b.review.rating)}{b.review.comment ? ` — “${b.review.comment}”` : ''}</T></Card>}
      {panel === 'review' && <ReviewForm busy={busy} onSubmit={(body) => post('review', body, 'Thanks for your feedback!')} />}

      {['in_progress', 'confirmed'].includes(b.status) && !b.disputeStatus && !panel && <Button title="Report a problem" onPress={() => setPanel('dispute')} />}
      {b.status === 'confirmed' && b.warrantyActive && !panel && <Button kind="primary" title="Claim free revisit under guarantee" onPress={() => setPanel('warranty')} />}
      {panel === 'dispute' && <DisputeForm busy={busy} onSubmit={(body) => post('dispute', body, 'Your issue has been raised. Our team will get back to you.')} />}
      {panel === 'warranty' && <DisputeForm warranty busy={busy} onSubmit={(body) => post('dispute', body, 'Guarantee claim raised. We will schedule a free revisit.')} />}

      {b.cancellation && (
        <Card>
          <T small muted>{b.cancellation.fee ? `Cancelling now retains a ${rupees(b.cancellation.fee)} late-cancellation fee.` : 'Free cancellation is available.'} Refund: {rupees(b.cancellation.refund)}.</T>
          <Button kind="danger" title="Cancel booking" busy={busy} onPress={() => Alert.alert('Cancel this booking?', undefined, [
            { text: 'Keep it', style: 'cancel' },
            { text: 'Cancel booking', style: 'destructive', onPress: () => post('cancel', {}, 'Booking cancelled. Any refund goes to your original payment method.') },
          ])} />
        </Card>
      )}

      {b.workerAssigned && !['cancelled', 'refunded'].includes(b.status) && <Chat bookingId={id} me="customer" />}

      <Card>
        <H level={2}>Timeline</H>
        {b.events.map((e, i) => <T small key={i}>• {EVENTS[e.to_status] || e.to_status} <T small muted>{fmtDateTime(e.created_at)}</T></T>)}
      </Card>
    </Screen>
  );
}

function ReviewForm({ onSubmit, busy }) {
  const t = useTheme();
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [askedForCash, setCash] = useState(false);
  return (
    <Card>
      <H level={2}>Rate the service</H>
      <Row style={{ justifyContent: 'flex-start' }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable key={n} onPress={() => setRating(n)} accessibilityRole="radio" accessibilityState={{ checked: n === rating }} accessibilityLabel={`${n} star`}>
            <T style={{ fontSize: 30, color: n <= rating ? '#f5b301' : t.border }}>★</T>
          </Pressable>
        ))}
      </Row>
      <Field label="Comment (optional)" value={comment} onChangeText={setComment} multiline maxLength={1000} style={{ minHeight: 80, textAlignVertical: 'top' }} />
      <Check checked={askedForCash} onChange={setCash}>The professional asked me to pay in cash or outside the app</Check>
      <Button kind="primary" title="Submit" busy={busy} onPress={() => onSubmit({ rating, comment: comment || undefined, askedForCash })} />
    </Card>
  );
}

const REASONS = [['not_completed', 'Not completed'], ['poor_quality', 'Poor quality'], ['damage', 'Damage'], ['overcharged', 'Asked to pay extra'], ['asked_for_cash', 'Asked for cash'], ['other', 'Other']];

function DisputeForm({ onSubmit, busy, warranty = false }) {
  const [reason, setReason] = useState(warranty ? 'warranty_claim' : 'not_completed');
  const [description, setDesc] = useState('');
  return (
    <Card>
      <H level={2}>{warranty ? 'Claim under guarantee' : 'Report a problem'}</H>
      {!warranty && <Chips value={reason} onChange={setReason} options={REASONS} />}
      <Field label="Details" value={description} onChangeText={setDesc} multiline maxLength={2000} style={{ minHeight: 90, textAlignVertical: 'top' }} />
      {!warranty && <T small muted>The professional's payout is held while we review.</T>}
      <Button kind="primary" title="Submit" busy={busy} disabled={description.trim().length < 10} onPress={() => onSubmit({ reason, description })} />
    </Card>
  );
}
