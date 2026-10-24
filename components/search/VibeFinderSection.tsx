import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { DramaListRow } from '../drama/DramaCard';
import { Text } from '../ui/Text';
import { InlineNotice } from '../ui/States';
import { ListSkeleton } from '../ui/Skeleton';
import { space } from '../../constants/theme';
import { discoverCatalogTitles, type CatalogFilterQuery } from '../../lib/api/features';
import { adoptDramas } from '../../lib/catalogSync';
import { haptic, useApp, useLoad } from '../../lib/hooks';
import { searchLocal } from '../../lib/selectors';
import { describeVibeQuery, parseVibeQuery, rankVibeResults, type VibeContext } from '../../lib/vibeFinder';

/** Minimum words before the box reads a sentence as a Vibe Finder request rather than a title name. */
const MIN_WORDS = 3;

/**
 * Vibe Finder results inside Search. Reads the typed sentence with the rules-based reader, asks the
 * catalogue for the filters it can express, applies the rest on the device, and explains each match
 * from the fields that matched. No AI model is called; the note on screen says so.
 */
export function VibeFinderSection({ text }: { text: string }) {
  const { state, dispatch } = useApp();
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const enabled = words >= MIN_WORDS && !text.trim().startsWith('#');
  const query = useMemo(() => parseVibeQuery(text), [text]);

  const remote = useLoad(
    async () => {
      // The catalogue filter takes one genre. Only send it when the member asked for exactly one;
      // otherwise the device filter keeps any title that matches one of several genres.
      const rpc: CatalogFilterQuery = {
        world: query.world,
        status: query.status,
        genre: query.genres.length === 1 ? query.genres[0] : null,
        minRating: query.minRating,
        sort: query.minRating !== null ? 'rating' : 'popular',
        limit: 60,
      };
      const items = await discoverCatalogTitles(rpc, state.importedDramas);
      return adoptDramas(items);
    },
    [text],
    enabled && query.signalCount > 0,
  );

  const ctx: VibeContext = useMemo(
    () => ({
      mutedDramaIds: state.mutedDramas,
      completedDramaIds: Object.values(state.watchlist)
        .filter((w) => w.status === 'completed')
        .map((w) => w.dramaId),
      favouriteWorlds: state.onboarding.fandoms,
    }),
    [state.mutedDramas, state.watchlist, state.onboarding.fandoms],
  );

  // Without structured signals, fall back to ordinary local text matching so the box still helps.
  const fallback = useMemo(
    () => (enabled && query.signalCount === 0 ? searchLocal(state, text).dramas : []),
    [enabled, query.signalCount, text, state],
  );

  if (!enabled) return null;

  const candidates = query.signalCount === 0 ? fallback : remote.data ?? [];
  const ranking = rankVibeResults(candidates, query, ctx);
  const readAs = describeVibeQuery(query);
  const loading = query.signalCount > 0 && remote.loading && !remote.data;

  return (
    <View style={styles.wrap} accessibilityLabel="Vibe Finder results">
      <Text variant="overline" tone="accent">
        VIBE FINDER
      </Text>
      <Text variant="caption" tone="secondary" style={styles.note}>
        {readAs.length ? `Read as: ${readAs.join(' · ')}.` : 'Could not read filters from that.'} {ranking.note}
      </Text>

      {remote.error && query.signalCount > 0 ? (
        <InlineNotice tone="warning" icon="cloud-offline-outline" text="Couldn’t reach the catalogue for this request. Showing matches from this device only." />
      ) : null}

      {loading ? <ListSkeleton rows={3} /> : null}

      {!loading && ranking.results.length === 0 ? (
        <Text variant="body" tone="secondary" style={styles.empty}>
          No titles match all of that. Try removing one detail, such as the world or the rating.
        </Text>
      ) : null}

      {ranking.results.map(({ drama, reasons }) => (
        <DramaListRow
          key={drama.id}
          drama={drama}
          subtitle={reasons.length ? reasons.join(' · ') : undefined}
          right={
            <Pressable
              onPress={() => {
                haptic.select();
                dispatch({ type: 'muteDrama', dramaId: drama.id, on: true });
              }}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={`Not interested in ${drama.title}`}
              accessibilityHint="Hides this title from feeds and results. You can undo it in Settings, Blocked, Muted."
            >
              <Text variant="label" tone="secondary">
                Not interested
              </Text>
            </Pressable>
          }
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space.margin, paddingTop: space.x3, gap: space.x2 },
  note: { marginBottom: space.x1 },
  empty: { paddingVertical: space.x3 },
});

