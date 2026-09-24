import { useCallback, useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { api } from './api';
import { Banner, Button, Card, ErrorNote, H, Row, T, useAction, useInterval, useTheme } from './ui';

// In-app chat + masked call. Phone numbers are never shown; the API hides
// contact details and payment IDs typed into messages.
export default function Chat({ bookingId, me }) {
  const t = useTheme();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [notice, setNotice] = useState(null);
  const { busy, error, run } = useAction();
  const load = useCallback(() => api(`/bookings/${bookingId}/messages`).then((d) => setMessages(d.messages)).catch(() => {}), [bookingId]);
  useEffect(() => { load(); }, [load]);
  useInterval(load, 10000);

  return (
    <Card>
      <Row>
        <H level={2}>Chat</H>
        <Button small title="📞 Masked call" busy={busy}
          onPress={() => run(async () => setNotice((await api(`/bookings/${bookingId}/call`, { method: 'POST' })).message))} />
      </Row>
      <T small muted>Your number stays private. Keep all communication in the app.</T>
      <View style={{ gap: 6, marginVertical: 6 }}>
        {messages.length === 0 && <T small muted center>No messages yet.</T>}
        {messages.slice(-30).map((m) => (
          <View key={m.id} style={{ alignSelf: m.sender_role === me ? 'flex-end' : 'flex-start', maxWidth: '85%',
            backgroundColor: m.sender_role === me ? t.brand : t.surface2, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 }}>
            <T small style={{ color: m.sender_role === me ? t.brandInk : t.text }}>{m.body}</T>
          </View>
        ))}
      </View>
      {notice && <Banner>{notice}</Banner>}
      <ErrorNote error={error} />
      <Row>
        <TextInput value={text} onChangeText={setText} placeholder="Message" placeholderTextColor={t.muted} maxLength={1000}
          accessibilityLabel="Message"
          style={{ flex: 1, borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 10, color: t.text, backgroundColor: t.surface }} />
        <Button kind="primary" title="Send" busy={busy} disabled={!text.trim()} onPress={() => run(async () => {
          const r = await api(`/bookings/${bookingId}/messages`, { method: 'POST', body: { body: text } });
          setMessages((m) => [...m, r.message]);
          setText('');
          setNotice(r.notice);
        })} />
      </Row>
    </Card>
  );
}
