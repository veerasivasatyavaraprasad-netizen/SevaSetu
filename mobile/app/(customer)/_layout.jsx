import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { Text } from 'react-native';
import { useSession } from '../../src/session';
import { useTheme } from '../../src/ui';

const icon = (glyph) => ({ color }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;

export default function CustomerTabs() {
  const t = useTheme();
  const { user } = useSession();
  if (!user) return <Redirect href="/login" />;
  if (user.role !== 'customer') return <Redirect href="/" />;
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: t.brand, headerStyle: { backgroundColor: t.surface }, headerTintColor: t.text, tabBarStyle: { backgroundColor: t.surface } }}>
      <Tabs.Screen name="home" options={{ title: 'Home', headerTitle: 'SevaSetu', tabBarIcon: icon('⌂') }} />
      <Tabs.Screen name="bookings" options={{ title: 'Bookings', tabBarIcon: icon('☰') }} />
      <Tabs.Screen name="plans" options={{ title: 'Plans', tabBarIcon: icon('↻') }} />
      <Tabs.Screen name="account" options={{ title: 'Account', tabBarIcon: icon('☺') }} />
    </Tabs>
  );
}
