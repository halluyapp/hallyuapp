import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { SettingsGroup, SettingsRow, SettingsToggle } from '../../components/settings/Rows';
import { ScrollScreen, Screen } from '../../components/ui/Screen';
import { toast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import {
  getPushRegistrationState,
  registerDevicePushToken,
  sendServerTestNotification,
  subscribePushRegistrationState,
  type PushRegistrationState,
} from '../../lib/api/pushToken';
import { useAuth } from '../../lib/auth';
import { useApp } from '../../lib/hooks';
import { ensureNotificationPermission, notificationPermission, PermissionState, plannedReminders, remindersSupported } from '../../lib/reminders';

/** Notification categories, remote push token registration diagnostics, self-test, and quiet hours. */
export default function NotificationSettings() {
  const auth = useAuth();
  const { state, dispatch } = useApp();
  const n = state.prefs.notifications;
  const set = (patch: Partial<typeof n>) => dispatch({ type: 'prefs', patch: { notifications: { ...n, ...patch } } });
  const [perm, setPerm] = useState<PermissionState>(remindersSupported ? 'undetermined' : 'unsupported');
  const [pushReg, setPushReg] = useState<PushRegistrationState>(getPushRegistrationState());
  const [sendingTest, setSendingTest] = useState(false);

  useEffect(() => subscribePushRegistrationState(setPushReg), []);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      notificationPermission().then((p) => {
        if (!alive) return;
        setPerm(p);
        if (p === 'granted' && auth.status === 'signedIn') {
          void registerDevicePushToken();
        }
      });
      return () => {
        alive = false;
      };
    }, [auth.status]),
  );

  const planned = plannedReminders(state);
  const next = planned[0];
  const permValue = perm === 'granted' ? 'Allowed' : perm === 'denied' ? 'Blocked' : perm === 'unsupported' ? 'Not on web' : 'Not asked yet';
  const permDetail =
    perm === 'granted'
      ? next
        ? `${planned.length} local episode ${planned.length === 1 ? 'reminder' : 'reminders'} scheduled · next: ${next.title.replace(' is airing', '')}`
        : 'System permission active · high-priority OS banners enabled'
      : perm === 'denied'
        ? 'Hallyu can’t show notifications until you allow notifications in system settings'
        : perm === 'unsupported'
          ? 'Native OS notifications run on Android and iOS devices'
          : 'Tap to enable system notifications for episodes, replies, and activity';

  const remoteValue =
    pushReg.status === 'registered'
      ? `Active (${pushReg.tokenType?.toUpperCase() ?? 'PUSH'})`
      : pushReg.status === 'registering'
        ? 'Syncing…'
        : pushReg.status === 'missing_native_push_credentials'
          ? 'Live while open'
          : pushReg.status === 'permission_denied'
            ? 'Needs permission'
            : pushReg.status === 'unsupported'
              ? 'Mobile only'
              : 'Ready';

  const remoteDetail =
    pushReg.status === 'registered'
      ? `Registered device token (${pushReg.tokenPreview ?? 'verified'}) for background & killed-app push delivery`
      : pushReg.status === 'missing_native_push_credentials'
        ? 'Server alerts deliver instant OS banners while Hallyu is open; background FCM wakes activate once Firebase credentials are bundled'
        : pushReg.lastError
          ? `Tap to retry push registration (${pushReg.lastError.slice(0, 72)})`
          : 'Registers this device with Hallyu so server notifications fan out automatically';

  const handleRequestPermission = async () => {
    const nextPerm = await ensureNotificationPermission();
    setPerm(nextPerm);
    if (nextPerm === 'granted' && auth.status === 'signedIn') {
      await registerDevicePushToken();
    }
  };

  const handleSendTest = async () => {
    if (sendingTest) return;
    if (auth.status !== 'signedIn') {
      toast.show({ message: 'Sign in first to verify remote server notifications.', tone: 'danger', icon: 'alert-circle' });
      return;
    }
    setSendingTest(true);
    try {
      const currentPerm = await ensureNotificationPermission();
      setPerm(currentPerm);
      if (currentPerm === 'granted') await registerDevicePushToken();
      const res = await sendServerTestNotification();
      toast.show({
        message:
          res.queued_deliveries > 0
            ? `Test alert queued to ${res.queued_deliveries} device token(s)`
            : 'Server notification created and delivered live to your inbox & OS banner',
        icon: 'checkmark-circle',
      });
    } catch (e) {
      toast.show({
        message: e instanceof Error ? e.message : 'Could not send test notification',
        tone: 'danger',
        icon: 'alert-circle',
      });
    } finally {
      setSendingTest(false);
    }
  };

  return (
    <Screen header={<TopBar mode="stack" title="Notifications" />}>
      <ScrollScreen>
        <SettingsGroup
          title="This device"
          footer={
            Platform.OS === 'android'
              ? 'Alerts use high-priority Android channels (Episode nights, Social activity, Account & system notices, Scheduled reminders).'
              : undefined
          }
        >
          <SettingsRow
            icon={perm === 'granted' ? 'notifications-outline' : 'notifications-off-outline'}
            label="System permission"
            detail={permDetail}
            value={permValue}
            chevron={perm !== 'granted' && perm !== 'unsupported'}
            onPress={perm === 'denied' ? () => Linking.openSettings().catch(() => {}) : perm === 'undetermined' ? handleRequestPermission : undefined}
          />
          {auth.status === 'signedIn' ? (
            <>
              <SettingsRow
                icon="cloud-done-outline"
                label="Remote delivery"
                detail={remoteDetail}
                value={remoteValue}
                chevron={pushReg.status !== 'registered' && pushReg.status !== 'unsupported'}
                onPress={pushReg.status !== 'unsupported' ? () => void registerDevicePushToken() : undefined}
              />
              <SettingsRow
                icon="paper-plane-outline"
                label={sendingTest ? 'Sending test alert…' : 'Send test notification'}
                detail="Creates a real server notification, fans out device deliveries, and triggers an OS banner"
                chevron
                onPress={handleSendTest}
              />
            </>
          ) : null}
        </SettingsGroup>
        <SettingsGroup title="Categories" footer="Per-drama episode alerts are set with the bell on each drama you follow.">
          <SettingsToggle icon="radio-outline" label="Episodes" detail="When a drama you follow airs or a room goes live" value={n.episodes} onChange={(v) => set({ episodes: v })} />
          <SettingsToggle icon="heart-outline" label="Social" detail="Reactions, comments, replies, new followers" value={n.social} onChange={(v) => set({ social: v })} />
          <SettingsToggle icon="sparkles-outline" label="Highlights" detail="Trending in your fandoms — at most one a day" value={n.highlights} onChange={(v) => set({ highlights: v })} />
          <SettingsToggle icon="information-circle-outline" label="System" detail="Security, policy and account notices (recommended)" value={n.system} onChange={(v) => set({ system: v })} />
        </SettingsGroup>
        <SettingsGroup title="Quiet hours" footer="22:00 – 08:00 local time. Episode-live alerts still arrive if you turned them on for that drama.">
          <SettingsToggle icon="moon-outline" label="Quiet hours" value={n.quietHours} onChange={(v) => set({ quietHours: v })} />
        </SettingsGroup>
      </ScrollScreen>
    </Screen>
  );
}
