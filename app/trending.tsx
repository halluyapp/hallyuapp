import React, { useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { DramaListRow } from '../components/drama/DramaCard';
import { PostCard } from '../components/feed/PostCard';
import { Chip, ChipRow } from '../components/ui/Chip';
import { Screen, useListPadding } from '../components/ui/Screen';
import { Segmented } from '../components/ui/Segmented';
import { ListSkeleton } from '../components/ui/Skeleton';
import { ErrorState, classifyError } from '../components/ui/States';
import { Text } from '../components/ui/Text';
import { TopBar } from '../components/ui/TopBar';
import { space } from '../constants/theme';
import { catalog } from '../lib/catalog';
import { adoptDramas } from '../lib/catalogSync';
import { FANDOMS, formatFandomOf } from '../lib/fandoms';
import { useApp, useLoad } from '../lib/hooks';
import { Drama, FandomId } from '../lib/model';
import { trendingDiscussions, trendingDramas } from '../lib/selectors';

/** Trending — dramas with momentum this week (live from TMDB) and the conversations around them. */
export default function Trending() {
  const { state, getDrama } = useApp();
  const padding = useListPadding(false);
  const [tab, setTab] = useState<'dramas' | 'posts'>('dramas');
  const [worldFilter, setWorldFilter] = useState<FandomId | 'all'>('all');
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
  const saved = useMemo(() => trendingDramas(state, 20), [state]);
  const rawDramas = useMemo(
    () => (live.data?.length ? live.data : !live.loading ? saved : []),
    [live.data, live.loading, saved],
  );
  const dramas = useMemo(
    () => (worldFilter === 'all' ? rawDramas : rawDramas.filter((d) => formatFandomOf(d) === worldFilter)),
    [rawDramas, worldFilter],
  );
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
    <Screen header={<TopBar mode="stack" title="Trending" subtitle={tab === 'dramas' ? (live.data ? 'This week across your worlds' : 'Across K-Drama, C-Drama, Anime & Hollywood') : 'Top conversations'} />}>
      <Segmented
        items={[
          { key: 'dramas', label: 'Dramas' },
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
                <ErrorState kind={classifyError(live.error)} onRetry={live.reload} />
              </View>
            }
            renderItem={({ item, index }) => (
              <DramaListRow
                drama={item}
                subtitle={[item.rating ? `★ ${item.rating.toFixed(1)}` : null, item.status === 'airing' ? 'Airing' : String(item.year), item.network ?? null].filter(Boolean).join(' · ')}
                right={
                  <Text variant="titleSmall" tone="tertiary" numeric>
                    {index + 1}
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
