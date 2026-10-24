import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { OnboardingFrame } from '../../components/onboarding/OnboardingFrame';
import { Avatar } from '../../components/ui/Avatar';
import { Button } from '../../components/ui/Button';
import { Poster } from '../../components/ui/Poster';
import { Text } from '../../components/ui/Text';
import { colors, radius, space } from '../../constants/theme';
import { track } from '../../lib/analytics';
import { registerDevicePushToken } from '../../lib/api/pushToken';
import { fandomById, FANDOMS } from '../../lib/fandoms';
import { useApp } from '../../lib/hooks';
import { withAlpha } from '../../lib/motion';
import { ensureNotificationPermission } from '../../lib/reminders';

/**
 * Finale — Personalized Hallyu Premiere Pass Preview + Episode Premiere Alerts -> Enter Hallyu.
 */
export default function NotificationsStep() {
  const router = useRouter();
  const { state, dispatch, me, getDrama } = useApp();

  const chosenWorlds = useMemo(() => {
    const ids = state.profile.fandoms?.length ? state.profile.fandoms : state.onboarding.fandoms;
    return ids.length ? ids.map((id) => fandomById(id)) : FANDOMS.slice(0, 2);
  }, [state.profile.fandoms, state.onboarding.fandoms]);

  const pinDramas = useMemo(() => {
    const ids = state.profile.favoriteDramaIds.length
      ? state.profile.favoriteDramaIds
      : Object.keys(state.watchlist).slice(0, 4);
    return ids
      .map((id) => getDrama(id))
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .slice(0, 4);
  }, [state.profile.favoriteDramaIds, state.watchlist, getDrama]);

  const watchedCount = Object.keys(state.watchlist).length;
  const leadTint = chosenWorlds[0]?.tint ?? colors.accent;

  const [submitting, setSubmitting] = useState(false);

  const finish = async (enable: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    dispatch({
      type: 'prefs',
      patch: {
        notifications: {
          ...state.prefs.notifications,
          episodes: enable,
          social: enable,
          highlights: enable,
          system: enable,
        },
      },
    });
    if (enable) {
      if (Platform.OS === 'web') {
        await Promise.race([
          registerDevicePushToken(true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4500)),
        ]);
      } else {
        const status = await ensureNotificationPermission();
        if (status === 'granted') {
          const registered = await Promise.race([
            registerDevicePushToken(true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4500)),
          ]);
          if (!registered) {
            setTimeout(() => {
              void registerDevicePushToken(true);
            }, 3000);
          }
        }
      }
    }
    dispatch({ type: 'onboarding', patch: { done: true, step: 5 } });
    track('onboarding.done');
    router.replace('/(tabs)');
  };

  const rows: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }[] = [
    {
      icon: 'radio-outline',
      title: 'Live Episode Rooms',
      body: 'Pinged the moment a show you follow drops so you can react live without spoilers.',
    },
    {
      icon: 'chatbubble-ellipses-outline',
      title: 'Replies, Mentions & DMs',
      body: 'Only real conversations directed at you — zero spam.',
    },
  ];

  return (
    <OnboardingFrame
      step={5}
      eyebrow="FINALE · PREMIERE PASS READY"
      title="Your pass is ready."
      subtitle="Turn on episode-night alerts so you never miss a finale room, then step straight into Hallyu."
      skippable={false}
      continueLabel="Turn on alerts & enter Hallyu"
      onContinue={() => finish(true)}
    >
      {/* Personalized Hallyu Premiere Pass Card */}
      <LinearGradient
        colors={[withAlpha(leadTint, 0.28), colors.surface2, colors.surface1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.passCard, { borderColor: withAlpha(leadTint, 0.5) }]}
      >
        <View style={styles.passHeader}>
          <Avatar uri={me.avatarUrl} name={me.displayName} size="lg" />
          <View style={{ flex: 1 }}>
            <Text variant="overline" style={{ color: leadTint }}>
              HALLYU PREMIERE PASS
            </Text>
            <Text variant="title">{me.displayName}</Text>
            <Text variant="caption" tone="secondary">
              @{me.handle} · 🛡️ {watchedCount} shielded
            </Text>
          </View>
        </View>

        <View style={styles.worldStrip}>
          {chosenWorlds.map((w) => (
            <View
              key={w.id}
              style={[
                styles.worldBadge,
                { borderColor: withAlpha(w.tint, 0.5), backgroundColor: withAlpha(w.tint, 0.14) },
              ]}
            >
              <Text style={{ fontSize: 12 }}>{w.flag}</Text>
              <Text variant="caption" style={{ color: w.tint, fontWeight: '700' }}>
                {w.short}
              </Text>
            </View>
          ))}
        </View>

        {pinDramas.length > 0 ? (
          <View style={styles.posterStrip}>
            {pinDramas.map((d) => (
              <Poster key={d.id} drama={d} width={58} rounded={8} />
            ))}
          </View>
        ) : null}
      </LinearGradient>

      <View style={{ gap: space.x3, marginTop: space.x4 }}>
        {rows.map((r) => (
          <View key={r.title} style={styles.row}>
            <View style={styles.icon}>
              <Ionicons name={r.icon} size={20} color={colors.accentText} />
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

      <Button
        label="Not now — enter Hallyu"
        variant="ghost"
        style={{ alignSelf: 'center', marginTop: space.x4 }}
        onPress={() => finish(false)}
      />
    </OnboardingFrame>
  );
}

const styles = StyleSheet.create({
  passCard: {
    borderRadius: radius.lg,
    padding: space.x4,
    borderWidth: 1,
    gap: space.x3,
  },
  passHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
  },
  worldStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  worldBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  posterStrip: {
    flexDirection: 'row',
    gap: space.x2,
    paddingTop: space.x1,
  },
  row: {
    flexDirection: 'row',
    gap: space.x3,
    backgroundColor: colors.surface1,
    borderRadius: radius.md,
    padding: space.x4,
    alignItems: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
