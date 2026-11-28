import * as Notifications from 'expo-notifications';
import { router, Stack, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { notificationTarget } from '../lib/logic';
import { SessionProvider, useSession } from '../lib/session';
import { colors } from '../lib/ui';

function Gate() {
  const { state } = useSession();
  const segments = useSegments();
  const onSignIn = segments[0] === 'sign-in';

  useEffect(() => {
    if (state.status === 'signedOut' && !onSignIn) router.replace('/sign-in');
    if (state.status === 'signedIn' && onSignIn) router.replace('/');
  }, [state.status, onSignIn]);

  // A tapped notification opens its lead (also when the tap started the app).
  useEffect(() => {
    if (state.status !== 'signedIn' || Platform.OS === 'web') return;
    const open = (data: unknown) => {
      const to = notificationTarget(data);
      if (to) router.push(to as never);
    };
    const last = Notifications.getLastNotificationResponse();
    if (last) open(last.notification.request.content.data);
    const sub = Notifications.addNotificationResponseReceivedListener((r) =>
      open(r.notification.request.content.data),
    );
    return () => sub.remove();
  }, [state.status]);

  if (state.status === 'loading')
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  return (
    <Stack screenOptions={{ headerTintColor: colors.primary }}>
      <Stack.Screen name="index" options={{ title: "Today's work" }} />
      <Stack.Screen name="leads" options={{ title: 'My leads' }} />
      <Stack.Screen name="lead/[id]" options={{ title: 'Lead' }} />
      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function Root() {
  return (
    <SessionProvider>
      <StatusBar style="dark" />
      <Gate />
    </SessionProvider>
  );
}
