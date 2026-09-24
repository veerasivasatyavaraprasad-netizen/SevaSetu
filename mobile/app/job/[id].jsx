import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, Platform } from 'react-native';
import { api, fmtDateTime, rupees } from '../../src/api';
import Chat from '../../src/Chat';
import { currentPosition } from '../../src/location';
import {
  Banner, Button, Card, ErrorNote, Field, H, Loading, Row, Screen, StatusBadge, T, useAction, useApi,
} from '../../src/ui';

export default function JobDetail() {
  const { id } = useLocalSearchParams();
  const [data, loadErr, reload] = useApi(`/worker/jobs/${id}`);
  const [otp, setOtp] = useState('');
  const [msg, setMsg] = useState(null);
  const { busy, error, run } = useAction();
  if (loadErr && !data) return <Screen><ErrorNote error={loadErr} /></Screen>;
  if (!data) return <Screen><Loading /></Screen>;
  const j = data.job;
  const navigate = () => {
    const { lat, lng } = j.location;
    Linking.openURL(Platform.OS === 'ios' ? `maps://?daddr=${lat},${lng}` : `google.navigation:q=${lat},${lng}`)
      .catch(() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`));
  };

  // The OS mock-location flag is sent as-is; the API suspends on spoofing (§9.6).
  const checkIn = () => run(async () => {
    const pos = await currentPosition();
    const r = await api(`/worker/jobs/${id}/checkin`, { method: 'POST', body: pos });
    setMsg(`Checked in (${r.distanceM} m from the address).`);
    await reload();
  });
  const complete = () => run(async () => {
    const pos = await currentPosition();
    await api(`/worker/jobs/${id}/complete`, { method: 'POST', body: { otp, ...pos } });
    setMsg('Job completed. Your earning moves to the payout queue once the customer confirms.');
    setOtp('');
    await reload();
  });
  const withdraw = () => Alert.prompt
    ? Alert.prompt('Withdraw from job', 'Why can you no longer do this job?', (reason) => reason && run(async () => {
      await api(`/worker/jobs/${id}/withdraw`, { method: 'POST', body: { reason } });
      router.back();
    }))
    : Alert.alert('Withdraw from job?', 'The job goes back to other professionals.', [
      { text: 'Keep job', style: 'cancel' },
      { text: 'Withdraw', style: 'destructive', onPress: () => run(async () => {
        await api(`/worker/jobs/${id}/withdraw`, { method: 'POST', body: { reason: 'Unavailable (withdrawn in app)' } });
        router.back();
      }) },
    ]);

  return (
    <Screen onRefresh={reload}>
      <Row><H>{j.serviceName}</H><StatusBadge status={j.status} forWorker /></Row>
      {msg && <Banner tone="ok">{msg}</Banner>}
      <ErrorNote error={error} />
      {j.isWarrantyRevisit && <Banner>Warranty revisit — no charge to the customer. Complete it with the customer's new code.</Banner>}
      <Card>
        <Row><T small muted>When</T><T small bold>{fmtDateTime(j.scheduledTime)}</T></Row>
        <Row><T small muted>Customer</T><T small>{j.customerFirstName}</T></Row>
        <T small muted>Address</T>
        <T small>{j.address.line1}{j.address.line2 ? `, ${j.address.line2}` : ''}{j.address.landmark ? ` (near ${j.address.landmark})` : ''}</T>
        <T small>{j.address.city} {j.address.pincode}</T>
        {!j.isWarrantyRevisit && <Row><T small muted>You earn</T><T small bold>{rupees(j.yourEarning)}</T></Row>}
        <Button title="🧭 Navigate" onPress={navigate} />
      </Card>
      {j.status === 'assigned' && (
        <Card>
          <H level={2}>Arrived?</H>
          <T small muted>Check in at the customer's address (within {j.checkinRadiusM} m) to start the job.</T>
          <Button kind="primary" title="📍 Check in with GPS" busy={busy} onPress={checkIn} />
          <Button kind="ghost" title="I can't do this job" onPress={withdraw} />
        </Card>
      )}
      {j.status === 'in_progress' && (
        <Card>
          <H level={2}>Finish the job</H>
          <T small muted>Ask the customer for their 4-digit completion code once they're satisfied. Never accept cash — they already paid in the app.</T>
          <Field label="Completion code" value={otp} onChangeText={(v) => setOtp(v.replace(/\D/g, ''))} keyboardType="number-pad" maxLength={4}
            style={{ letterSpacing: 10, fontSize: 22, textAlign: 'center' }} />
          <T small muted>{j.otpAttemptsLeft} attempts left.</T>
          <Button kind="primary" title="Mark complete" busy={busy} disabled={otp.length !== 4} onPress={complete} />
        </Card>
      )}
      {j.status === 'completed' && <Banner>Waiting for the customer to confirm (auto-confirms after 24 hours).</Banner>}
      <Chat bookingId={id} me="worker" />
    </Screen>
  );
}
