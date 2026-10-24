import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { colors, fonts, radius, space } from '../../constants/theme';
import { haptic, useApp } from '../../lib/hooks';
import { Drama, Episode, WatchlistItem } from '../../lib/model';
import { postsForEpisode } from '../../lib/selectors';
import { Poster } from '../ui/Poster';
import { ProgressBar, SectionHeader } from '../ui/Section';
import { Tap } from '../ui/Tap';
import { Text } from '../ui/Text';
import { useToast } from '../ui/Toast';

export interface UpNextItem {
  item: WatchlistItem;
  drama: Drama;
  episode: Episode;
}

/**
 * "Keep watching": next unwatched episode of everything you're actively watching.
 * One tap enters the live Episode Watch Room; "+1 Ep" marks watched in place with instant Undo or React CTA.
 */
export function UpNextRail({ items, onSeeAll }: { items: UpNextItem[]; onSeeAll?: () => void }) {
  const router = useRouter();
  const { state, dispatch } = useApp();
  const toast = useToast();
  if (!items.length) return null;

  return (
    <View style={{ marginBottom: space.section }}>
      <SectionHeader eyebrow="Continue watching" title="Up next" onAction={onSeeAll} actionLabel="Watchlist" />
      <FlatList
        horizontal
        data={items}
        keyExtractor={(x) => x.episode.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.gutter }}
        renderItem={({ item: { item, drama, episode } }) => {
          const rawTotal = drama.seasons.find((s) => s.number === episode.season)?.episodeCount ?? drama.episodeCount;
          const total = rawTotal || (drama.mediaType === 'movie' ? 1 : 16);
          const multi = drama.seasons.length > 1;
          const talking = postsForEpisode(state, drama.id, episode.season, episode.number).length;

          const markWatched = () => {
            haptic.success();
            dispatch({ type: 'progress', dramaId: drama.id, season: episode.season, episode: episode.number, total });
            toast.show({
              message: episode.number >= total ? `${drama.title} completed 🎉` : `Watched Ep ${episode.number} · Share your reaction?`,
              tone: 'success',
              icon: 'checkmark-circle',
              actionLabel: 'React',
              onAction: () =>
                router.push({
                  pathname: '/create/[type]',
                  params: {
                    type: 'reaction',
                    dramaId: drama.id,
                    season: String(episode.season),
                    episode: String(episode.number),
                  },
                }),
            });
          };

          return (
            <Tap
              onPress={() => router.push(`/episode/${drama.id}/${episode.season}/${episode.number}`)}
              accessibilityRole="button"
              accessibilityLabel={`${drama.title}, up next ${multi ? `season ${episode.season} ` : ''}episode ${episode.number} of ${total}`}
              style={styles.card}
            >
              <Poster drama={drama} width={58} />
              <View style={{ flex: 1, justifyContent: 'space-between' }}>
                <View>
                  <Text variant="titleSmall" numberOfLines={1}>
                    {drama.title}
                  </Text>
                  <Text variant="caption" tone="secondary" numberOfLines={1}>
                    {multi ? `S${episode.season} · ` : ''}Ep {episode.number} of {total}
                    {episode.title ? ` · ${episode.title}` : ''}
                  </Text>
                </View>
                <View>
                  <Text variant="caption" tone="tertiary" numberOfLines={1} style={{ marginBottom: 6 }}>
                    {talking ? `${talking} talking in live room` : 'Tap to enter Watch Room'}
                  </Text>
                  <ProgressBar value={item.currentEpisode} max={total} />
                </View>
              </View>
              <Pressable
                onPress={markWatched}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Mark episode ${episode.number} watched`}
                style={({ pressed }) => [styles.plusBtn, pressed ? { opacity: 0.82 } : null]}
              >
                <Ionicons name="checkmark" size={14} color={colors.onAccent} />
                <Text style={styles.plusText}>+1 Ep</Text>
              </Pressable>
            </Tap>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: space.x3,
    width: 306,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  plusBtn: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    height: 32,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  plusText: {
    fontFamily: fonts.bold,
    fontSize: 11,
    color: colors.onAccent,
  },
});
