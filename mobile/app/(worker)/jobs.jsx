import { router } from 'expo-router';
import { api, fmtDateTime, rupees } from '../../src/api';
import {
  Badge, Banner, Button, Card, ErrorNote, H, Loading, Row, Screen, StatusBadge, T, useAction, useApi,
} from '../../src/ui';

export default function Jobs() {
  const [me, , reloadMe] = useApi('/worker/me');
  const [earn, , reloadEarn] = useApi('/worker/earnings');
  const [mine, , reloadMine] = useApi('/worker/jobs');
  const [open, openErr, reloadOpen] = useApi('/worker/jobs/open');
  const { busy, error, run } = useAction();
  const reloadAll = () => Promise.all([reloadMe(), reloadEarn(), reloadMine(), reloadOpen()]);
  if (!me || !earn || !mine) return <Screen><Loading /></Screen>;
  const w = me.worker;
  const active = mine.jobs.filter((j) => ['assigned', 'in_progress', 'completed'].includes(j.status));
  const act = (path) => run(async () => { await api(path, { method: 'POST' }); await reloadAll(); });

  return (
    <Screen onRefresh={reloadAll}>
      <H>Hi {w.name?.split(' ')[0]}</H>
      {w.status !== 'active' && <Banner tone="danger">{`Your account is ${w.status}. Contact support.`}</Banner>}
      {!w.policyAccepted && w.status === 'active' && (
        <Banner tone="warn"><T small>Please re-read and accept the platform policy before taking new jobs.</T><Button small title="Open policy" onPress={() => router.push('/policy')} /></Banner>
      )}
      {w.payoutHold && <Banner tone="warn">Your payouts are on hold while our team reviews your account.</Banner>}
      <Row>
        <Card style={{ flex: 1 }}><T big>{earn.summary.jobsToday}</T><T small muted>Jobs today</T></Card>
        <Card style={{ flex: 1 }}><T big>{rupees(earn.summary.pending)}</T><T small muted>Next payout</T></Card>
      </Row>
      <Row>
        <Card style={{ flex: 1 }}><T big>★ {w.rating || '—'}</T><T small muted>{w.ratingCount} ratings</T></Card>
        <Card style={{ flex: 1 }}><T big>{w.commissionRatePercent}%</T><T small muted>Commission</T></Card>
      </Row>

      <H level={2}>Your jobs</H>
      {active.length === 0 && <T small muted>No active jobs.</T>}
      {active.map((j) => (
        <Card key={j.id} onPress={() => router.push(`/job/${j.id}`)}>
          <Row><T bold style={{ flex: 1 }}>{j.serviceName}</T><StatusBadge status={j.status} forWorker /></Row>
          <T small muted>{fmtDateTime(j.scheduledTime)} · {j.address?.line1} · you earn {rupees(j.yourEarning)}</T>
        </Card>
      ))}

      <Row><H level={2}>New job requests</H>{open?.featured && <Badge tone="ok">★ Featured</Badge>}</Row>
      {open && !open.featured && (
        <Card onPress={() => router.push('/featured')}>
          <T small>{open.hiddenInPriorityWindow > 0
            ? `${open.hiddenInPriorityWindow} new job(s) are with featured professionals right now and open to you shortly.`
            : 'Featured professionals see new jobs first.'} <T small bold>Get jobs first →</T></T>
        </Card>
      )}
      <ErrorNote error={openErr || error} />
      {open?.jobs.length === 0 && <T small muted>No open requests in {w.serviceAreaPincode} right now.</T>}
      {open?.jobs.map((j) => (
        <Card key={j.id}>
          <Row><T bold style={{ flex: 1 }}>{j.serviceName}</T>{j.isUrgent && <Badge tone="warn">Urgent</Badge>}</Row>
          <T small muted>{fmtDateTime(j.scheduledTime)} · PIN {j.pincode} · ~{j.durationMinutes} min</T>
          <Row>
            <T>You earn <T bold>{rupees(j.yourEarning)}</T></T>
            <Row>
              <Button small title="Skip" busy={busy} onPress={() => act(`/worker/jobs/${j.id}/decline`)} />
              <Button small kind="primary" title="Accept" busy={busy} onPress={() => act(`/worker/jobs/${j.id}/accept`)} />
            </Row>
          </Row>
        </Card>
      ))}
      <T small muted center>The full address is shown after you accept. The customer has already paid in the app.</T>
    </Screen>
  );
}
