import { useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, View } from 'react-native';
import { DramaCard } from '../../components/drama/DramaCard';
import { Screen, useListPadding } from '../../components/ui/Screen';
import { Skeleton } from '../../components/ui/Skeleton';
import { EmptyState, ErrorState, classifyError } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { colors, space } from '../../constants/theme';
import { catalog } from '../../lib/catalog';
import { adoptDramas } from '../../lib/catalogSync';
import { useApp, useLayout } from '../../lib/hooks';
import { Drama } from '../../lib/model';
import { dramasByGenre } from '../../lib/selectors';

/**
 * Genre browse — the backend's own relevance order, endless grid. Falls back to saved titles
 * offline. The ordering is Hallyu's, not the provider's raw popularity figure: that is the same
 * ranking Trending and the world rails use, so a title cannot be #1 in one and last in the other.
 */
export default function GenrePage() {
  const { genre } = useLocalSearchParams<{ genre: string }>();
  const name = decodeURIComponent(genre ?? '');
  const { state } = useApp();
  const { columns } = useLayout();
  const padding = useListPadding(false);
  const [pages, setPages] = useState<Drama[][]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(catalog.available);
  const [error, setError] = useState<Error | null>(null);
  const [done, setDone] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  const load = useCallback(
    async (p: number) => {
      if (!catalog.available) return;
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setLoading(true);
      setError(null);
      try {
        const got = adoptDramas(await catalog.byGenre(name, p, c.signal));
        if (c.signal.aborted) return;
        setPages((prev) => {
          const next = [...prev];
          next[p - 1] = got;
          return next;
        });
        if (got.length < 15) setDone(true);
      } catch (e) {
        if (c.signal.aborted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    },
    [name],
  );

  useEffect(() => {
    setPages([]);
    setPage(1);
    setDone(false);
    load(1);
    return () => ctrl.current?.abort();
  }, [load]);

  const live = useMemo(() => {
    const seen = new Set<string>();
    return pages.flat().filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
  }, [pages]);
  const saved = useMemo(() => dramasByGenre(state, name), [state, name]);
  const list = live.length ? live : !loading ? saved : live;
  const offlineFallback = !live.length && !!error && saved.length > 0;

  const more = () => {
    if (loading || done || error || !live.length) return;
    const next = page + 1;
    setPage(next);
    load(next);
  };

  return (
    <Screen
      header={
        <TopBar mode="stack" title={name} subtitle={offlineFallback ? `${saved.length} saved titles` : list.length ? `${list.length}${done ? '' : '+'} titles · by relevance` : 'Across all 4 fandoms'} />
      }
    >
      {loading && !list.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.gutter, paddingHorizontal: space.margin, paddingTop: space.x4 }} accessibilityLabel="Loading dramas">
          {Array.from({ length: columns * 3 }).map((_, i) => (
            <View key={i} style={{ flexBasis: `${100 / columns - 3}%`, flexGrow: 1, gap: space.x2 }}>
              <Skeleton width="100%" height={180} radius={12} />
              <Skeleton width="70%" height={12} />
            </View>
          ))}
        </View>
      ) : (
        <FlatList
          key={columns}
          data={list}
          numColumns={columns}
          keyExtractor={(d) => d.id}
          columnWrapperStyle={{ gap: space.gutter, paddingHorizontal: space.margin }}
          contentContainerStyle={[padding, { gap: space.x4, paddingTop: space.x4 }]}
          onEndReached={more}
          onEndReachedThreshold={0.6}
          ListHeaderComponent={
            offlineFallback ? (
              <Text variant="caption" tone="tertiary" style={{ paddingHorizontal: space.margin, marginBottom: space.x2 }}>
                Couldn’t reach the catalog — showing titles saved on this device.
              </Text>
            ) : null
          }
          renderItem={({ item }) => <DramaCard drama={item} size="m" style={{ flex: 1 / columns }} meta={item.rating ? `★ ${item.rating.toFixed(1)}` : String(item.year)} />}
          ListFooterComponent={
            loading && list.length ? (
              <View style={{ paddingVertical: space.x4 }}>
                <ActivityIndicator color={colors.accent} />
              </View>
            ) : done && list.length ? (
              <Text variant="caption" tone="tertiary" align="center" style={{ paddingVertical: space.x4 }}>
                That’s everything TMDB lists for {name}.
              </Text>
            ) : null
          }
          ListEmptyComponent={
            error ? (
              <ErrorState kind={classifyError(error)} onRetry={() => load(page)} />
            ) : !catalog.available ? (
              <EmptyState icon="key-outline" title="Catalog not configured" body="Live titles need the TMDB credentials in this build." />
            ) : (
              <EmptyState icon="film-outline" title={`No ${name} dramas found`} body="Try another genre — or search a title you know." />
            )
          }
        />
      )}
    </Screen>
  );
}
