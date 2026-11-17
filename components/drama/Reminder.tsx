import { Ionicons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { colors, radius, space } from '../../constants/theme';
import { catalog } from '../../lib/catalog';
import { requestWebEpisodeNotificationPermission } from '../../lib/episodeNotifications';
import { countdown, dayLabel, timeOfDay } from '../../lib/format';
import { haptic, useApp, useRequireMember } from '../../lib/hooks';
import { ensureNotificationPermission, syncEpisodeReminders } from '../../lib/reminders';
import { Drama, Episode } from '../../lib/model';
import { getState } from '../../lib/store';
import { Button } from '../ui/Button';
import { Text } from '../ui/Text';
import { useToast } from '../ui/Toast';

/**
 * An episode reminder is not a new concept — it is "follow this drama with episode alerts on".
 * One switch, two words, and the same thing the Drama Hub bell controls, so nothing can drift.
 */
export function useReminder(drama: Drama | undefined) {
  const { state, dispatch, isFollowing } = useApp();
  const require = useRequireMember();
  const toast = useToast();
  const following = drama ? isFollowing('dramas', drama.id) : false;
  const notify = drama ? (state.dramaNotify[drama.id] ?? true) : false;
  const on = following && notify && state.prefs.notifications.episodes;
  const toggle = useCallback(
    (episode?: Episode) => {
      if (!drama) return;
      require('set episode reminders', () => {
        if (on) {
          haptic.light();
          dispatch({ type: 'dramaNotify', id: drama.id, on: false });
          toast.show({ message: `Reminders off for ${drama.title}`, icon: 'notifications-off-outline' });
          return;
        }
        haptic.success();
        if (!following) dispatch({ type: 'follow', kind: 'dramas', id: drama.id, on: true });
        dispatch({ type: 'dramaNotify', id: drama.id, on: true });
        if (!state.prefs.notifications.episodes) dispatch({ type: 'prefs', patch: { notifications: { ...state.prefs.notifications, episodes: true } } });
        requestWebEpisodeNotificationPermission();

        // Hydrate full episode schedule immediately if this title only has a thin catalog stub
        if (drama.provider && !drama.episodes.some((e) => e.airDate)) {
          void catalog
            .getDrama(drama.provider.id, drama.mediaType ?? 'tv')
            .then((full) => {
              if (full) {
                dispatch({ type: 'import', dramas: [{ ...full, id: drama.id }] });
              }
            })
            .catch(() => {});
        }

        const when = episode?.airDate ? ` ${dayLabel(episode.airDate)} at ${timeOfDay(episode.airDate)}` : '';
        void ensureNotificationPermission().then((perm) => {
          if (perm === 'granted' || perm === 'unsupported') {
            void syncEpisodeReminders(getState());
            toast.show({
              message: episode ? `We’ll notify you when Episode ${episode.number} airs${when}` : `Episode alerts on for ${drama.title}`,
              tone: 'success',
              icon: 'notifications',
            });
          } else {
            toast.show({
              message: 'Reminder saved, but notifications are off for Hallyu on this device.',
              icon: 'notifications-off-outline',
              actionLabel: 'Open settings',
              onAction: () => Linking.openSettings().catch(() => {}),
              duration: 6000,
            });
          }
        });
      });
    },
    [drama, on, following, require, dispatch, toast, state.prefs.notifications],
  );
  return { on, following, toggle };
}

/** The upcoming-episode card in a room: when it airs, the countdown, and the one switch that matters. */
export function ReminderCard({ drama, episode }: { drama: Drama; episode: Episode }) {
  const { on, toggle } = useReminder(drama);
  const airs = episode.airDate ? `${dayLabel(episode.airDate)} · ${timeOfDay(episode.airDate)}` : 'Air date to be announced';
  return (
    <View style={styles.card} accessibilityRole="summary">
      <View style={styles.icon}>
        <Ionicons name={on ? 'notifications' : 'time-outline'} size={20} color={on ? colors.accentText : colors.textPrimary} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="titleSmall" numberOfLines={1}>
          {episode.airDate ? `Airs ${airs}` : airs}
        </Text>
        <Text variant="caption" tone="secondary" numberOfLines={2}>
          {episode.airDate ? `${countdown(episode.airDate) === 'now' ? 'Any moment now' : `Room opens ${countdown(episode.airDate)}`} · ` : ''}
          {on ? 'You’ll get a nudge when the room opens.' : 'Predictions and hype are welcome now; preview spoilers still need a level.'}
        </Text>
      </View>
      <Button
        label={on ? 'Reminder on' : 'Remind me'}
        size="sm"
        variant={on ? 'secondary' : 'primary'}
        icon={on ? 'checkmark' : 'notifications-outline'}
        onPress={() => toggle(episode)}
        accessibilityLabel={on ? 'Turn reminder off' : `Remind me when episode ${episode.number} airs`}
      />
    </View>
  );
}

/** The 48px bell used on episode rows: same switch, no card. */
export function ReminderBell({ drama, episode }: { drama: Drama; episode: Episode }) {
  const { on, toggle } = useReminder(drama);
  return (
    <Pressable
      onPress={() => toggle(episode)}
      hitSlop={4}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={on ? `Reminder on for episode ${episode.number}` : `Remind me when episode ${episode.number} airs`}
      style={({ pressed }) => [styles.bell, pressed ? { opacity: 0.6 } : null]}
    >
      <Ionicons name={on ? 'notifications' : 'notifications-outline'} size={20} color={on ? colors.accentText : colors.textTertiary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bell: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', marginRight: -12 },
  card: {
    marginHorizontal: space.margin,
    padding: space.x3,
    paddingLeft: space.x4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    backgroundColor: colors.surface1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  icon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
});
