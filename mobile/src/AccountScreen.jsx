import { router } from 'expo-router';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import { Alert } from 'react-native';
import { api, fmtDateTime } from './api';
import { useSession } from './session';
import { Banner, Button, Card, ErrorNote, Field, H, Row, Screen, T, useAction, useApi } from './ui';

export default function AccountScreen() {
  const { user, signOut, reload } = useSession();
  const [notes, , reloadNotes] = useApi('/notifications');
  const [name, setName] = useState(user.name || '');
  const [email, setEmail] = useState(user.email || '');
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();

  // DPDP: export personal data as a JSON file the user can save or share.
  const exportData = () => run(async () => {
    const data = await api('/me/export');
    const file = new File(Paths.cache, 'sevasetu-my-data.json');
    if (file.exists) file.delete();
    file.create();
    file.write(JSON.stringify(data, null, 2));
    await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: 'Your SevaSetu data' });
  });

  const deleteAccount = () => Alert.alert('Delete your account?',
    'Your personal data is erased. Payment records are kept as required by law. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => run(async () => { await api('/me/delete', { method: 'POST' }); await signOut(); router.replace('/login'); }) },
    ]);

  return (
    <Screen onRefresh={reloadNotes}>
      <Card>
        <T small muted>Mobile ending {user.phone_last4}</T>
        <Field label="Name" value={name} onChangeText={setName} editable={user.role !== 'worker'} />
        <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        {saved && <T small>Saved.</T>}
        <Button kind="primary" title="Save" busy={busy} onPress={() => run(async () => {
          await api('/me', { method: 'PATCH', body: { ...(user.role !== 'worker' ? { name } : {}), email } });
          setSaved(true);
          reload();
        })} />
      </Card>
      {user.role === 'customer' && <Button title="Saved addresses" onPress={() => router.push('/addresses')} />}
      {user.role === 'worker' && <Button title="Platform payment policy" onPress={() => router.push('/policy')} />}
      <Card>
        <Row>
          <H level={2}>Notifications</H>
          <Button kind="ghost" small title="Mark all read" onPress={() => api('/notifications/read', { method: 'POST' }).then(reloadNotes)} />
        </Row>
        {notes?.notifications.length === 0 && <T small muted>No notifications.</T>}
        {notes?.notifications.slice(0, 20).map((n) => (
          <Card key={n.id} style={{ opacity: n.read_at ? 0.6 : 1, padding: 10 }}>
            <T small bold>{n.title}</T>
            <T small>{n.body}</T>
            <T small muted>{fmtDateTime(n.created_at)}</T>
          </Card>
        ))}
      </Card>
      <Card>
        <H level={2}>Your data</H>
        <T small muted>Under India's DPDP Act you can download or erase your personal data.</T>
        <ErrorNote error={error} />
        <Button title="Download my data" busy={busy} onPress={exportData} />
        <Button kind="danger" title="Delete account" busy={busy} onPress={deleteAccount} />
      </Card>
      <Banner>Signed in as a {user.role}.</Banner>
      <Button title="Sign out" onPress={async () => { await signOut(); router.replace('/login'); }} />
    </Screen>
  );
}
