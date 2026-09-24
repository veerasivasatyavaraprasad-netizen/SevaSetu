import { router } from 'expo-router';
import { Fragment } from 'react';
import { fmtDateTime, rupees } from '../../src/api';
import { Card, ErrorNote, H, Loading, Row, Screen, StatusBadge, T, useApi } from '../../src/ui';

const ACTIVE = ['pending_payment', 'paid', 'assigned', 'in_progress', 'completed', 'disputed'];

export default function Bookings() {
  const [data, error, reload] = useApi('/bookings');
  if (error && !data) return <Screen><ErrorNote error={error} /></Screen>;
  if (!data) return <Screen><Loading /></Screen>;
  const groups = [['Upcoming & active', data.bookings.filter((b) => ACTIVE.includes(b.status))], ['Past', data.bookings.filter((b) => !ACTIVE.includes(b.status))]];
  return (
    <Screen onRefresh={reload}>
      {groups.map(([title, items]) => (
        <Fragment key={title}>
          <H level={2}>{title}</H>
          {items.length === 0 && <T small muted>Nothing here.</T>}
          {items.map((b) => (
            <Card key={b.id} onPress={() => router.push(`/booking/${b.id}`)}>
              <Row><T bold style={{ flex: 1 }}>{b.serviceName}</T><StatusBadge status={b.status} /></Row>
              <T small muted>{fmtDateTime(b.scheduledTime)} · {rupees(b.amount)}</T>
            </Card>
          ))}
        </Fragment>
      ))}
    </Screen>
  );
}
