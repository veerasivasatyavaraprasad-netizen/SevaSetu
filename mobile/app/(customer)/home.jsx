import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { TextInput } from 'react-native';
import { api, rupees } from '../../src/api';
import { useSession } from '../../src/session';
import Sponsored from '../../src/Sponsored';
import {
  Banner, Button, Card, Chips, ErrorNote, Field, H, Loading, Row, Screen, T, useAction, useApi, useTheme,
} from '../../src/ui';

const CATEGORY = {
  cleaning: 'Cleaning', ac_service: 'AC service', pest_control: 'Pest control', plumbing: 'Plumbing',
  electrical: 'Electrical', appliance_repair: 'Appliances', repairs: 'Repairs', tutoring: 'Tutoring',
};

export default function Home() {
  const t = useTheme();
  const { user, reload: reloadUser } = useSession();
  const [data, error, reload] = useApi('/services');
  const [cat, setCat] = useState('all');
  const [q, setQ] = useState('');
  const services = useMemo(() => (data?.services || []).filter((s) =>
    (cat === 'all' || s.category === cat) && s.name.toLowerCase().includes(q.toLowerCase())), [data, cat, q]);
  const cats = [...new Set((data?.services || []).map((s) => s.category))];

  return (
    <Screen onRefresh={reload}>
      {!user.name && <NameCard onDone={reloadUser} />}
      <H>What do you need help with?</H>
      <TextInput value={q} onChangeText={setQ} placeholder="Search services" placeholderTextColor={t.muted}
        accessibilityLabel="Search services"
        style={{ borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 12, color: t.text, backgroundColor: t.surface, fontSize: 16 }} />
      <Chips value={cat} onChange={setCat} options={[['all', 'All'], ...cats.map((c) => [c, CATEGORY[c] || c])]} />
      <Banner>Prices are fixed and shown upfront. Only pay inside the app — it protects your payment and your service guarantee.</Banner>
      <ErrorNote error={error} />
      <Sponsored slot="home_banner" category={cat === 'all' ? undefined : cat} />
      {!data && !error && <Loading />}
      {services.map((s) => (
        <Card key={s.id} onPress={() => router.push(`/service/${s.id}`)}>
          <Row>
            <T bold style={{ flex: 1 }}>{s.name}</T>
            <T big>{rupees(s.fixed_price_paise)}</T>
          </Row>
          <T small muted>{s.duration_minutes} min · {Number(s.rating) > 0 ? `★ ${s.rating} (${s.reviews})` : 'New'}</T>
        </Card>
      ))}
    </Screen>
  );
}

function NameCard({ onDone }) {
  const [name, setName] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Card>
      <H level={2}>Welcome! What should we call you?</H>
      <Field label="Your name" value={name} onChangeText={setName} autoComplete="name" />
      <ErrorNote error={error} />
      <Button kind="primary" title="Save" busy={busy} disabled={name.trim().length < 2}
        onPress={() => run(async () => { await api('/me', { method: 'PATCH', body: { name } }); onDone(); })} />
    </Card>
  );
}
