import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, FlatList, View } from 'react-native';
import { DramaListRow } from '../components/drama/DramaCard';
import { PostCard } from '../components/feed/PostCard';
import { Chip, ChipRow } from '../components/ui/Chip';
import { Screen, useListPadding } from '../components/ui/Screen';
import { Segmented } from '../components/ui/Segmented';
import { ListSkeleton } from '../components/ui/Skeleton';
import { ErrorState, classifyError } from '../components/ui/States';
import { Text } from '../components/ui/Text';
import { TopBar } from '../components/ui/TopBar';
import { colors, space } from '../constants/theme';
import { catalog, invalidateCatalogLists } from '../lib/catalog';
import { adoptDramas } from '../lib/catalogSync';
import { FANDOMS, formatFandomOf } from '../lib/fandoms';
import { useApp, useLoad } from '../lib/hooks';
import { Drama, FandomId } from '../lib/model';
import { trendingDiscussions, trendingDramas } from '../lib/selectors';
import { computeTopBillboard, formatBillboardUpdatedAt } from '../lib/topBillboard';

/** Trending — auto-updating Top 10 Billboard & weekly momentum across all four Hallyu worlds. */
export default function Trending() {
  const { state, getDrama } = useApp();
  const padding = useListPadding(false);
  const [tab, setTab] = useState<'dramas' | 'posts'>('dramas');
  const [worldFilter, setWorldFilter] = useState<FandomId | 'all'>('all');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const lastRefreshRef = useRef(0);

  const live = useLoad<Drama[]>(
    async (signal) =>
      adoptDramas(
        worldFilter === 'all'
          ? await catalog.trending(signal)
          : await catalog.byFandom(worldFilter, 'trending', 1, signal),
      ),
    [worldFilter],
    catalog.available,
  );

  useEffect(() => {
    if (live.data) {
      setUpdatedAt(Date.now());
      lastRefreshRef.current = Date.now();
    }
  }, [live.data]);

  const reloadTrending = useCallback(() => {
    invalidateCatalogLists();
    lastRefreshRef.current = Date.now();
    live.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (Date.now() - lastRefreshRef.current > 90_000) {
        reloadTrending();
      }
      const timer = setInterval(reloadTrending, 90_000);
      return () => clearInterval(timer);
    }, [reloadTrending]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active' && Date.now() - lastRefreshRef.current > 60_000) {
        reloadTrending();
      }
    });
    return () => sub.remove();
  }, [reloadTrending]);

  const saved = useMemo(() => trendingDramas(state, 20), [state]);
  const rawDramas = useMemo(
    () => (live.data?.length ? live.data : !live.loading ? saved : []),
    [live.data, live.loading, saved],
  );
  const dramas = useMemo(() => {
    const pool = worldFilter === 'all' ? rawDramas : rawDramas.filter((d) => formatFandomOf(d) === worldFilter);
    const ranked = computeTopBillboard({
      trending: pool,
      posts: state.posts,
      watchlist: state.watchlist,
      category: worldFilter,
      limit: 20,
    });
    return ranked.length ? ranked.map((r) => r.drama) : pool;
  }, [rawDramas, worldFilter, state.posts, state.watchlist]);

  const rawPosts = useMemo(() => trendingDiscussions(state, 30), [state]);
  const posts = useMemo(
    () =>
      worldFilter === 'all'
        ? rawPosts
        : rawPosts.filter((p) => {
            const d = getDrama(p.context.dramaId);
            return d && formatFandomOf(d) === worldFilter;
          }),
    [rawPosts, worldFilter, getDrama],
  );
  return (
    <Screen
      header={
        <TopBar
          mode="stack"
          title="Top 10 Billboard & Trending"
          subtitle={
            tab === 'dramas'
              ? live.data
                ? `Auto-updating · ${formatBillboardUpdatedAt(updatedAt)}`
                : 'Across K-Drama, C-Drama, Anime & Hollywood'
              : 'Top conversations'
          }
        />
      }
    >
      <Segmented
        items={[
          { key: 'dramas', label: 'Top Billboard' },
          { key: 'posts', label: 'Conversations' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <ChipRow style={{ paddingHorizontal: space.margin, paddingVertical: space.x2 }}>
        <Chip label="All worlds" selected={worldFilter === 'all'} onPress={() => setWorldFilter('all')} />
        {FANDOMS.map((w) => (
          <Chip key={w.id} label={`${w.flag} ${w.short}`} selected={worldFilter === w.id} onPress={() => setWorldFilter(w.id)} />
        ))}
      </ChipRow>
      {tab === 'dramas' ? (
        live.loading && !dramas.length ? (
          <ListSkeleton rows={8} />
        ) : (
          <FlatList
            data={dramas}
            keyExtractor={(d) => d.id}
            contentContainerStyle={padding}
            ListHeaderComponent={
              live.error && !live.data ? (
                <Text variant="caption" tone="tertiary" style={{ paddingHorizontal: space.margin, paddingVertical: space.x2 }}>
                  Couldn’t reach the catalog — showing what’s saved on this device.
                </Text>
              ) : null
            }
            ListEmptyComponent={
              <View style={{ paddingTop: space.x6 }}>
                <ErrorState kind={classifyError(live.error)} onRetry={reloadTrending} />
              </View>
            }
            renderItem={({ item, index }) => (
              <DramaListRow
                drama={item}
                subtitle={[item.rating ? `★ ${item.rating.toFixed(1)}` : null, item.status === 'airing' ? 'Airing' : String(item.year), item.network ?? null].filter(Boolean).join(' · ')}
                right={
                  <Text variant={index < 3 ? 'title' : 'titleSmall'} tone={index < 3 ? 'accent' : 'tertiary'} numeric style={index === 0 ? { color: colors.accent } : undefined}>
                    #{index + 1}
                  </Text>
                }
              />
            )}
          />
        )
      ) : (
        <FlatList data={posts} keyExtractor={(p) => p.id} contentContainerStyle={padding} renderItem={({ item }) => <PostCard post={item} />} />
      )}
    </Screen>
  );
}
