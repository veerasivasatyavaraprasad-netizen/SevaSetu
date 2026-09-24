import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { Text } from 'react-native';
import { useSession } from '../../src/session';
import { useTheme } from '../../src/ui';

const icon = (glyph) => ({ color }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;

export default function WorkerTabs() {
  const t = useTheme();
  const { user, worker } = useSession();
  if (!user) return <Redirect href="/login" />;
  if (user.role !== 'worker') return <Redirect href="/" />;
  // §5.2: dashboard only once KYC is approved.
  if (worker?.kycStatus !== 'approved') return <Redirect href="/onboarding" />;
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: t.brand, headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text, tabBarStyle: { backgroundColor: t.surface } }}>
      <Tabs.Screen name="jobs" options={{ title: 'Jobs', tabBarIcon: icon('⌂') }} />
      <Tabs.Screen name="earnings" options={{ title: 'Earnings', tabBarIcon: icon('₹') }} />
      <Tabs.Screen name="profile" options={{ title: 'Account', tabBarIcon: icon('☺') }} />
    </Tabs>
  );
}
