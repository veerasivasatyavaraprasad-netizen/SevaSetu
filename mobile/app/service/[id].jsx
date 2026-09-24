import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { fmtDate, rupees } from '../../src/api';
import { Button, Card, ErrorNote, H, Loading, Row, Screen, T, useApi } from '../../src/ui';

export default function ServiceDetail() {
  const { id } = useLocalSearchParams();
  const [data, error] = useApi(`/services/${id}`);
  if (error) return <Screen><ErrorNote error={error} /></Screen>;
  if (!data) return <Screen><Loading /></Screen>;
  const s = data.service;
  return (
    <Screen>
      <Card>
        <H>{s.name}</H>
        <T muted>{s.description}</T>
        <Row style={{ marginTop: 8 }}>
          <View>
            <T big>{rupees(s.fixed_price_paise)}</T>
            <T small muted>Fixed price · about {s.duration_minutes} min</T>
          </View>
          <Button kind="primary" title="Book now" onPress={() => router.push(`/book/${s.id}`)} />
        </Row>
        {s.warranty_fee_paise > 0 && <T small muted>Optional 30-day service guarantee: {rupees(s.warranty_fee_paise)}.</T>}
      </Card>
      <Card>
        <H level={2}>What's included</H>
        <T small>• Background-verified professional</T>
        <T small>• Pay securely in the app — never in cash</T>
        <T small>• Job is marked done only when you share your completion code</T>
        <T small>• Refund protection if something goes wrong</T>
      </Card>
      <Card>
        <H level={2}>Reviews</H>
        {data.reviews.length === 0 && <T small muted>No reviews yet.</T>}
        {data.reviews.map((r, i) => (
          <View key={i} style={{ marginTop: 6 }}>
            <T small bold>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)} <T small muted>{r.customer} · {fmtDate(r.created_at)}</T></T>
            <T small>{r.comment}</T>
          </View>
        ))}
      </Card>
    </Screen>
  );
}
