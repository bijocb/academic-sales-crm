import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let registered: string | null = null;

/**
 * Ask for permission, get this phone's Expo push token and register it for the signed-in user. Returns a reason when
 * push is not possible (simulator, permission denied, no EAS project id) instead of throwing.
 */
export async function registerForPush(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (Platform.OS === 'web') return { ok: false, reason: 'Push notifications need the phone app.' };
  if (!Device.isDevice) return { ok: false, reason: 'Push notifications need a real phone.' };
  if (Platform.OS === 'android')
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Leads and tasks',
      importance: Notifications.AndroidImportance.HIGH,
    });
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted')
    return {
      ok: false,
      reason: 'Notifications are turned off for this app in the phone settings.',
    };
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
    ?.eas?.projectId;
  if (!projectId || projectId.startsWith('REPLACE'))
    return { ok: false, reason: 'This build has no EAS project id (see docs/MOBILE.md).' };
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await api('/me/push-devices', {
    method: 'POST',
    body: {
      token,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      appVersion: Constants.expoConfig?.version,
    },
  });
  registered = token;
  return { ok: true };
}

/** Stop pushes to this phone (on sign-out). */
export async function unregisterPush(): Promise<void> {
  if (!registered) return;
  await api('/me/push-devices/remove', { method: 'POST', body: { token: registered } }).catch(
    () => undefined,
  );
  registered = null;
}
