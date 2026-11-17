import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { colors, radius, space } from '../../constants/theme';
import { countdown, dayLabel, now, runtimeLabel, shortDate, timeOfDay } from '../../lib/format';
import { haptic, useApp, useRequireMember } from '../../lib/hooks';
import { Drama, Episode } from '../../lib/model';
import { hasWatched } from '../../lib/spoiler';
import { ReminderBell } from './Reminder';
import { Tap } from '../ui/Tap';
import { Text } from '../ui/Text';

export function episodeState(e: Episode, dramaStatus?: Drama['status']): 'aired' | 'live' | 'upcoming' {
  if (!e.airDate) return dramaStatus === 'upcoming' ? 'upcoming' : 'aired';
  const dt = now().getTime() - new Date(e.airDate).getTime();
  if (dt < 0) return 'upcoming';
  if (dt < 3 * 3_600_000) return 'live';
  return 'aired';
}

interface EpisodeCardProps {
  drama: Drama;
  episode: Episode;
  postCount?: number;
  style?: StyleProp<ViewStyle>;
  showDrama?: boolean;
}

/** Episode row: number · title · date/runtime · watched check · conversation count. Tap → Episode room. */
function EpisodeCardBase({ drama, episode, postCount, style, showDrama }: EpisodeCardProps) {
  const router = useRouter();
  const { watch, dispatch } = useApp();
  const require = useRequireMember();
  const item = watch(drama.id);
  const watched = hasWatched(item, episode.season, episode.number);
  const st = episodeState(episode, drama.status);
  // The frontier episode: the first one you haven't watched in the season you're on.
  const current =
    !!item && item.status !== 'completed' && item.season === episode.season && episode.number === (item.currentEpisode ?? 0) + 1 && !watched;
  const rawTotal = drama.seasons.find((s) => s.number === episode.season)?.episodeCount ?? drama.episodeCount;
  const total = rawTotal || (drama.mediaType === 'movie' ? 1 : 16);
  const multi = drama.seasons.length > 1;
  const dateLine =
    st === 'upcoming' && episode.airDate
      ? `${dayLabel(episode.airDate)} · ${timeOfDay(episode.airDate)} · ${countdown(episode.airDate)}`
      : [episode.airDate ? shortDate(episode.airDate) : drama.status === 'upcoming' ? 'TBA' : `${drama.year}`, runtimeLabel(episode.runtime ?? drama.runtime)].filter(Boolean).join(' · ');

  const toggleWatched = () =>
    require('mark episodes watched', () => {
      haptic.light();
      const target = watched ? episode.number - 1 : episode.number;
      dispatch({ type: 'progress', dramaId: drama.id, season: episode.season, episode: target, total });
    });

  return (
    <View style={[styles.row, style]}>
      <Tap
        onPress={() => router.push(`/episode/${drama.id}/${episode.season}/${episode.number}`)}
        accessibilityRole="button"
        accessibilityLabel={`${multi ? `Season ${episode.season} ` : ''}Episode ${episode.number}${episode.title ? `, ${episode.title}` : ''}, ${watched ? 'watched' : st}`}
        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.x3 }}
      >
        <View style={[styles.num, watched ? styles.numWatched : null, current ? styles.numCurrent : null]}>
          {st === 'live' ? <View style={styles.live} /> : null}
          <Text variant="titleSmall" numeric style={{ color: watched ? colors.textSecondary : colors.textPrimary }}>
            {episode.number}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          {showDrama ? (
            <Text variant="caption" tone="accent" numberOfLines={1}>
              {drama.title}
            </Text>
          ) : null}
          <Text variant="titleSmall" numberOfLines={1} style={{ color: watched ? colors.textSecondary : colors.textPrimary }}>
            {episode.title ?? `Episode ${episode.number}`}
          </Text>
          <Text variant="caption" tone={st === 'live' ? 'accent' : 'tertiary'} numberOfLines={1}>
            {st === 'live' ? 'Just aired · conversation is live' : dateLine}
          </Text>
        </View>
        {postCount ? (
          <View style={styles.count}>
            <Ionicons name="chatbubble-outline" size={14} color={colors.textTertiary} />
            <Text variant="caption" tone="tertiary" numeric>
              {postCount}
            </Text>
          </View>
        ) : null}
      </Tap>
      {st !== 'upcoming' ? (
        <Tap
          onPress={toggleWatched}
          hitSlop={8}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: watched }}
          accessibilityLabel={watched ? 'Mark as not watched' : 'Mark as watched'}
          style={styles.check}
        >
          {/* Spec 1.1 — crimson is progress: watched check is the accent, never green. */}
          <Ionicons name={watched ? 'checkmark-circle' : 'ellipse-outline'} size={26} color={watched ? colors.accent : colors.borderStrong} />
        </Tap>
      ) : (
        <ReminderBell drama={drama} episode={episode} />
      )}
    </View>
  );
}

/** Compact chip used in context strips and pickers: "Ep 7". */
export function EpisodeChip({ label, selected, onPress, live }: { label: string; selected?: boolean; onPress?: () => void; live?: boolean }) {
  return (
    <Tap onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: !!selected }} style={[styles.chip, selected ? styles.chipOn : null]}>
      {live ? <View style={styles.live} /> : null}
      <Text variant="label" style={{ color: selected ? colors.accentText : colors.textSecondary }} numeric>
        {label}
      </Text>
    </Tap>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.x3, paddingVertical: space.x3, paddingHorizontal: space.margin, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  num: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  numWatched: { backgroundColor: colors.surface1 },
  numCurrent: { borderWidth: 2, borderColor: colors.accent, backgroundColor: colors.surface1 },
  live: { position: 'absolute', top: 5, right: 5, width: 6, height: 6, borderRadius: 3, backgroundColor: colors.live },
  count: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  check: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', marginRight: -12 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: colors.surface2, borderWidth: 1, borderColor: 'transparent' },
  chipOn: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
});

/** Memoised: with tracked store getters, a card re-renders only when its own data changes. */
export const EpisodeCard = React.memo(EpisodeCardBase);
