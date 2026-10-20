import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { OnboardingFrame } from '../../components/onboarding/OnboardingFrame';
import { Button } from '../../components/ui/Button';
import { Text } from '../../components/ui/Text';
import { colors, radius, space } from '../../constants/theme';
import { useStore } from '../../lib/store';
import { track } from '../../lib/analytics';
import { registerDevicePushToken } from '../../lib/api/pushToken';
import { ensureNotificationPermission } from '../../lib/reminders';

/** Step 5 — notifications, asked with a reason. Then Enter Hallyu. */
export default function NotificationsStep() {
  const router = useRouter();
  const { state, dispatch } = useStore();
  const finish = async (enable: boolean) => {
    dispatch({ type: 'prefs', patch: { notifications: { ...state.prefs.notifications, episodes: enable, social: enable, highlights: enable } } });
    if (enable) {
      const status = await ensureNotificationPermission();
      if (status === 'granted') void registerDevicePushToken();
    }
    dispatch({ type: 'onboarding', patch: { done: true, step: 5 } });
    track('onboarding.done');
    router.replace('/(tabs)');
  };
  const rows: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }[] = [
    { icon: 'radio-outline', title: 'Episode nights', body: 'When a drama you follow airs — so you can join the room while it’s live.' },
    { icon: 'chatbubble-ellipses-outline', title: 'Replies and mentions', body: 'Only when someone talks to you. Never “someone you may know”.' },
    { icon: 'sparkles-outline', title: 'Highlights', body: 'One digest at most per day. Quiet hours respected.' },
  ];
  return (
    <OnboardingFrame
      step={5}
      title="Never miss an episode night."
      subtitle="You control every category later in Settings. Nothing is on by default that you didn’t choose here."
      skippable={false}
      continueLabel="Turn on and enter Hallyu"
      onContinue={() => finish(true)}
    >
      <View style={{ gap: space.x3 }}>
        {rows.map((r) => (
          <View key={r.title} style={styles.row}>
            <View style={styles.icon}>
              <Ionicons name={r.icon} size={20} color={colors.textPrimary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall">{r.title}</Text>
              <Text variant="bodySmall" tone="secondary">
                {r.body}
              </Text>
            </View>
          </View>
        ))}
      </View>
      <Button label="Not now — enter Hallyu" variant="ghost" style={{ alignSelf: 'center', marginTop: space.x6 }} onPress={() => finish(false)} />
    </OnboardingFrame>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.x3, backgroundColor: colors.surface1, borderRadius: radius.md, padding: space.x4, alignItems: 'flex-start' },
  icon: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.surface3, alignItems: 'center', justifyContent: 'center' },
});
