import { fmtDate, rupees } from '../../src/api';
import { Badge, Card, ErrorNote, H, Loading, Row, Screen, T, useApi } from '../../src/ui';

const ITEM = { pending: ['Next payout', 'brand'], held: ['On hold', 'warn'], batched: ['Processing', 'brand'], paid: ['Paid', 'ok'], cancelled: ['Cancelled', ''] };

export default function Earnings() {
  const [data, error, reload] = useApi('/worker/earnings');
  const [reviews] = useApi('/worker/reviews');
  if (error && !data) return <Screen><ErrorNote error={error} /></Screen>;
  if (!data) return <Screen><Loading /></Screen>;
  const s = data.summary;
  return (
    <Screen onRefresh={reload}>
      <Row>
        <Card style={{ flex: 1 }}><T big>{rupees(s.pending)}</T><T small muted>Pending (next weekly payout)</T></Card>
        <Card style={{ flex: 1 }}><T big>{rupees(s.paid_total)}</T><T small muted>Paid to date</T></Card>
      </Row>
      <Row>
        <Card style={{ flex: 1 }}><T big>{rupees(s.processing)}</T><T small muted>Processing</T></Card>
        <Card style={{ flex: 1 }}><T big>{rupees(s.held)}</T><T small muted>On hold</T></Card>
      </Row>
      <T small muted>Payouts go weekly to your verified account after the customer confirms and nightly checks pass.</T>
      <Card>
        <H level={2}>Payouts</H>
        {data.payouts.length === 0 && <T small muted>No payouts yet.</T>}
        {data.payouts.map((p) => (
          <Row key={p.id}>
            <T small style={{ flex: 1 }}>{fmtDate(p.week_start)} – {fmtDate(p.week_end)}{p.utr_number ? `\nUTR ${p.utr_number}` : ''}</T>
            <T small bold>{rupees(p.total_amount)}</T>
            <Badge tone={p.status === 'paid' ? 'ok' : p.status === 'failed' ? 'danger' : ''}>{p.status}</Badge>
          </Row>
        ))}
      </Card>
      <Card>
        <H level={2}>Jobs</H>
        {data.items.map((i) => {
          const [label, tone] = ITEM[i.status] || [i.status, ''];
          return (
            <Row key={i.booking_id}>
              <T small style={{ flex: 1 }}>{i.service_name} · {fmtDate(i.created_at)}{i.hold_reason ? `\n${i.hold_reason}` : ''}</T>
              <T small bold>{rupees(i.amount)}</T>
              <Badge tone={tone}>{label}</Badge>
            </Row>
          );
        })}
      </Card>
      <Card>
        <H level={2}>Ratings</H>
        {reviews?.reviews.length === 0 && <T small muted>No ratings yet.</T>}
        {reviews?.reviews.map((r, i) => <T small key={i}>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)} {r.comment ? `— ${r.comment}` : ''}</T>)}
      </Card>
    </Screen>
  );
}
