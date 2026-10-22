import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { SettingsGroup, SettingsRow, SettingsToggle } from '../../components/settings/Rows';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { toast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import {
  getPushRegistrationState,
  isStandaloneWebApp,
  registerDevicePushToken,
  sendServerTestNotification,
  subscribePushRegistrationState,
  type PushRegistrationState,
} from '../../lib/api/pushToken';
import { useAuth } from '../../lib/auth';
import { useApp } from '../../lib/hooks';
import {
  ensureNotificationPermission,
  notificationPermission,
  PermissionState,
  plannedReminders,
  remindersSupported,
  syncLivePulseBanner,
} from '../../lib/reminders';

/** Notification controls — Android FCM HTTP v1, iOS/Web VAPID Push, Live Pulse Shade Banner & Test Push. */
export default function NotificationSettings() {
  const auth = useAuth();
  const { state, dispatch } = useApp();
  const n = state.prefs.notifications;
  const set = (patch: Partial<typeof n>) =>
    dispatch({ type: 'prefs', patch: { notifications: { ...n, ...patch } } });
  const [perm, setPerm] = useState<PermissionState>(
    remindersSupported || Platform.OS === 'web' ? 'undetermined' : 'unsupported',
  );
  const [pushReg, setPushReg] = useState<PushRegistrationState>(getPushRegistrationState());
  const [sendingTest, setSendingTest] = useState(false);

  const refreshPermission = useCallback(async () => {
    if (Platform.OS === 'web') {
      if (typeof Notification === 'undefined') {
        setPerm('unsupported');
        return 'unsupported' as PermissionState;
      }
      const mapped: PermissionState =
        Notification.permission === 'granted'
          ? 'granted'
          : Notification.permission === 'denied'
            ? 'denied'
            : 'undetermined';
      setPerm(mapped);
      return mapped;
    }
    const nativePerm = await notificationPermission();
    setPerm(nativePerm);
    return nativePerm;
  }, []);

  useEffect(() => subscribePushRegistrationState(setPushReg), []);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      refreshPermission().then((p) => {
        if (!alive) return;
        if (p === 'granted' && auth.status === 'signedIn') {
          void registerDevicePushToken(false);
        }
      });
      return () => {
        alive = false;
      };
    }, [auth.status, refreshPermission]),
  );

  const planned = plannedReminders(state);
  const next = planned[0];
  const permValue =
    perm === 'granted'
      ? 'Allowed'
      : perm === 'denied'
        ? 'Blocked'
        : perm === 'unsupported'
          ? 'Add to Home Screen'
          : 'Tap to enable';

  const permDetail =
    perm === 'granted'
      ? next
        ? `${planned.length} upcoming episode ${planned.length === 1 ? 'alert' : 'alerts'} ready · next: ${next.title.replace(' is airing', '')}`
        : Platform.OS === 'web'
          ? `Browser / Home-Screen Web Push active${isStandaloneWebApp() ? ' (Full-Screen App)' : ''}`
          : 'High-priority OS banners & lock-screen delivery enabled'
      : perm === 'denied'
        ? 'Allow notifications in your device or browser settings to receive live alerts'
        : perm === 'unsupported'
          ? 'On iPhone/iPad, tap Share → Add to Home Screen in Safari to unlock Apple lock-screen push alerts'
          : 'Tap to enable instant episode drops, replies, DMs & creator clips';

  const remoteValue =
    pushReg.status === 'registered'
      ? `Active (${pushReg.tokenType === 'webpush' ? 'WEB PUSH' : 'FCM'})`
      : pushReg.status === 'registering'
        ? 'Connecting…'
        : pushReg.status === 'permission_denied'
          ? 'Permission needed'
          : 'Tap to sync';

  const remoteDetail =
    pushReg.status === 'registered'
      ? `Connected (${pushReg.tokenPreview ?? 'verified'}) — delivers alerts even when Hallyu is closed`
      : pushReg.lastError
        ? `${pushReg.lastError}`
        : 'Syncs this device for instant background & lock-screen delivery';

  const handleRequestPermission = async () => {
    if (Platform.OS === 'web') {
      const ok = await registerDevicePushToken(true);
      await refreshPermission();
      if (ok) {
        toast.show({ message: 'Web Push lock-screen notifications active!', tone: 'success' });
      }
      return;
    }
    const nextPerm = await ensureNotificationPermission();
    setPerm(nextPerm);
    if (nextPerm === 'granted' && auth.status === 'signedIn') {
      await registerDevicePushToken(true);
    }
  };

  const handleSendTest = async () => {
    if (sendingTest) return;
    if (auth.status !== 'signedIn') {
      toast.show({
        message: 'Sign in first to test live server push delivery.',
        tone: 'danger',
      });
      return;
    }
    setSendingTest(true);
    try {
      await registerDevicePushToken(true);
      await refreshPermission();
      const res = await sendServerTestNotification();
      toast.show({
        message:
          res.queued_deliveries > 0
            ? `Live push dispatched to ${res.queued_deliveries} registered device(s)!`
            : 'Live server notification delivered to your inbox & banner!',
        tone: 'success',
      });
    } catch (e) {
      toast.show({
        message: e instanceof Error ? e.message : 'Could not send test push',
        tone: 'danger',
      });
    } finally {
      setSendingTest(false);
    }
  };

  const handleToggleLivePulse = async (enabled: boolean) => {
    if (enabled && Platform.OS === 'android') {
      const p = await ensureNotificationPermission();
      setPerm(p);
      if (p !== 'granted') {
        toast.show({ message: 'Allow notifications first to pin the Live Pulse banner.' });
        return;
      }
    }
    dispatch({ type: 'prefs', patch: { livePulseBanner: enabled } });
    await syncLivePulseBanner({
      ...state,
      prefs: { ...state.prefs, livePulseBanner: enabled },
    });
    toast.show({
      message: enabled
        ? 'Hallyu Live Pulse pinned cleanly to your notification shade!'
        : 'Live Pulse shade banner hidden',
      tone: 'success',
    });
  };

  return (
    <Screen header={<TopBar mode="stack" title="Notifications" />}>
      <ScrollScreen>
        <SettingsGroup
          title="Live Delivery Status"
          footer="Hallyu delivers real background push alerts on Android (Firebase FCM) and iPhone / Desktop (Apple & Web Push)."
        >
          <SettingsRow
            icon={perm === 'granted' ? 'notifications-outline' : 'notifications-off-outline'}
            label="System notifications"
            detail={permDetail}
            value={permValue}
            chevron={perm !== 'granted'}
            onPress={
              perm === 'denied' && Platform.OS !== 'web'
                ? () => Linking.openSettings().catch(() => {})
                : perm !== 'granted'
                  ? () => void handleRequestPermission()
                  : undefined
            }
          />
          {auth.status === 'signedIn' ? (
            <>
              <SettingsRow
                icon="cloud-done-outline"
                label="Background push sync"
                detail={remoteDetail}
                value={remoteValue}
                chevron
                onPress={() => void registerDevicePushToken(true)}
              />
              <SettingsRow
                icon="paper-plane-outline"
                label={sendingTest ? 'Dispatching live push…' : 'Send live test push'}
                detail="Sends a real server push alert straight to your phone & lock screen"
                chevron
                onPress={() => void handleSendTest()}
              />
            </>
          ) : null}
        </SettingsGroup>

        {Platform.OS === 'android' ? (
          <SettingsGroup
            title="Hallyu Live Pulse Banner"
            footer="Silent, zero-buzz status strip in your Android notification drawer & lock screen showing tonight's live shows and 1-tap Watch Party access."
          >
            <SettingsToggle
              icon="pulse-outline"
              label="Pin Live Pulse to Notification Shade"
              detail="Silent companion banner · instant jump into tonight's rooms"
              value={!!state.prefs.livePulseBanner}
              onChange={(v) => void handleToggleLivePulse(v)}
            />
          </SettingsGroup>
        ) : null}

        <SettingsGroup
          title="Alert Categories"
          footer="Tap the bell on any show page to customize individual premiere & finale alerts."
        >
          <SettingsToggle
            icon="radio-outline"
            label="Episodes & Watch Parties"
            detail="Premieres, live watch rooms & episode airings"
            value={n.episodes}
            onChange={(v) => set({ episodes: v })}
          />
          <SettingsToggle
            icon="chatbubbles-outline"
            label="Social, Mentions & DMs"
            detail="Direct messages, replies, mentions, reactions & new followers"
            value={n.social}
            onChange={(v) => set({ social: v })}
          />
          <SettingsToggle
            icon="videocam-outline"
            label="Creator Clips & Highlights"
            detail="New Shorts from creators you follow & major community moments"
            value={n.highlights}
            onChange={(v) => set({ highlights: v })}
          />
          <SettingsToggle
            icon="shield-checkmark-outline"
            label="Account & Official Announcements"
            detail="Security alerts, Creator Pass updates & major Hallyu events"
            value={n.system}
            onChange={(v) => set({ system: v })}
          />
        </SettingsGroup>

        <SettingsGroup
          title="Quiet Hours"
          footer="22:00 – 08:00 local time. Live Watch Party reminders you explicitly RSVP to still come through."
        >
          <SettingsToggle
            icon="moon-outline"
            label="Quiet hours"
            value={n.quietHours}
            onChange={(v) => set({ quietHours: v })}
          />
        </SettingsGroup>
      </ScrollScreen>
    </Screen>
  );
}
