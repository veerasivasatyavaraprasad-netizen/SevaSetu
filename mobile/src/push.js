// Push notifications via Firebase Cloud Messaging. On Android the native
// device token is an FCM token, which the API sends to directly (FCM HTTP
// v1). iOS needs APNs routed through Firebase; see README.

import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export async function registerForPush() {
  if (!Device.isDevice || Platform.OS !== 'android') return;
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return;
  const token = await Notifications.getDevicePushTokenAsync();
  await api('/devices', { method: 'POST', body: { token: String(token.data), platform: 'android' } });
}
