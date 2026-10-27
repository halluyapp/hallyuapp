import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { WatchCard, WatchRail } from '../../components/watch/WatchCard';
import { WatchNav } from '../../components/watch/WatchNav';
import { SearchField } from '../../components/search/SearchField';
import { ScrollScreen, Screen } from '../../components/ui/Screen';
import { EmptyState, ErrorState, InlineNotice } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { colors, radius, space } from '../../constants/theme';
import { fetchWatchHome, readWatchHomeCache, searchWatch, type WatchResult, type WatchRow, type WatchTitle } from '../../lib/api/moviebox';
import { useCompletedDownloads, useTransfers } from '../../components/watch/useWatchDownloads';
import { listProgress, type ProgressEntry } from '../../lib/watchStore';
import { PosterRowSkeleton } from '../../components/ui/Skeleton';

function downloadsSummary(completed: number, active: number): string {
  if (completed === 0 && active === 0) return 'Save episodes to watch without a connection.';
  const parts = [];
  if (completed > 0) parts.push(`${completed} ready to watch offline`);
  if (active > 0) parts.push(`${active} in progress`);
  return parts.join(' · ');
}

/** Watch — Hallyu's Moviebox-backed title browser: search, home rows, Continue Watching, downloads. */
export default function WatchHome() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<WatchRow[] | null>(null);
  const [homeError, setHomeError] = useState<string | null>(null);
  const [results, setResults] = useState<WatchTitle[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const completedCount = useCompletedDownloads().length;
  const activeCount = useTransfers().length;
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    let networkFinished = false;
    setHomeError(null);
    void readWatchHomeCache().then((cached) => {
      if (alive && !networkFinished && cached) setRows(cached);
    });
    fetchWatchHome().then((r: WatchResult<WatchRow[]>) => {
      networkFinished = true;
      if (!alive) return;
      if (r.ok) setRows(r.value);
      else setHomeError(r.reason);
    });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      listProgress().then((p) => alive && setProgress(p));
    };
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      setSearchError(null);
      return;
    }
    let alive = true;
    setSearching(true);
    const t = setTimeout(() => {
      searchWatch(term).then((r) => {
        if (!alive) return;
        setSearching(false);
        if (r.ok) {
          setResults(r.value);
          setSearchError(null);
        } else {
          setResults([]);
          setSearchError(r.reason);
        }
      });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  const open = (t: { subjectId: string; title: string; detailPath: string | null }) => {
    if (!t.detailPath) return;
    router.push({ pathname: '/watch/[id]', params: { id: t.subjectId, detailPath: t.detailPath, title: t.title } });
  };

  const searchMode = q.trim().length >= 2;

  return (
    <Screen header={<TopBar title="Hallyu TV" mode="stack" />}>
      <ScrollScreen contentContainerStyle={{ paddingBottom: space.x8 }}>
        <View style={styles.search}>
          <SearchField value={q} onChangeText={setQ} placeholder="Search films and series" />
        </View>
        <WatchNav active="browse" />

        {searchMode ? (
          <View style={{ paddingHorizontal: space.x4, marginTop: space.x4 }}>
            {searching ? <ActivityIndicator color={colors.accent} /> : null}
            {searchError ? <InlineNotice tone="danger" text="Search is unavailable right now. Try again in a moment." /> : null}
            {results && results.length === 0 && !searching && !searchError ? (
              <EmptyState title="No titles found" body="Try another name or spelling." compact />
            ) : null}
            {results && results.length > 0 ? (
              <FlatList
                data={results}
                numColumns={3}
                keyExtractor={(t) => t.subjectId}
                columnWrapperStyle={{ gap: space.x3, marginBottom: space.x4 }}
                renderItem={({ item }) => (
                  <WatchCard title={item.title} cover={item.cover} meta={item.rating ? `IMDb ${item.rating}` : item.releaseDate?.slice(0, 4)} width={112} onPress={() => open(item)} />
                )}
                scrollEnabled={false}
              />
            ) : null}
          </View>
        ) : (
          <>
            {rows && rows[0] && rows[0].items[0] ? (
              <Pressable onPress={() => open(rows[0].items[0])} accessibilityRole="button" accessibilityLabel={`Open ${rows[0].items[0].title}`} style={styles.hero}>
                {rows[0].items[0].cover ? (
                  <Image source={{ uri: rows[0].items[0].cover }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="disk" transition={150} />
                ) : null}
                <View style={styles.heroShade} />
                <View style={styles.heroText}>
                  <Text variant="caption" tone="accent">{rows[0].title}</Text>
                  <Text variant="title" numberOfLines={2}>{rows[0].items[0].title}</Text>
                  <Text variant="caption" tone="secondary">
                    {[rows[0].items[0].releaseDate?.slice(0, 4), rows[0].items[0].rating ? `IMDb ${rows[0].items[0].rating}` : null].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              </Pressable>
            ) : null}

            {progress.length > 0 ? (
              <WatchRail
                label="Continue watching"
                data={progress.map((p) => ({ ...p, key: p.key }))}
                render={(p) => (
                  <WatchCard
                    title={p.title}
                    cover={p.cover}
                    meta={p.season ? `S${p.season} E${p.episode}` : null}
                    progress={p.durationMs > 0 ? p.positionMs / p.durationMs : 0}
                    onPress={() => open(p)}
                  />
                )}
              />
            ) : null}

            <Pressable onPress={() => router.push('/watch/downloads')} accessibilityRole="button" accessibilityLabel="Open Downloads" style={styles.downloadsCard}>
              <View style={{ flex: 1, gap: space.x1 }}>
                <Text variant="label">Downloads</Text>
                <Text variant="caption" tone="tertiary">
                  {downloadsSummary(completedCount, activeCount)}
                </Text>
              </View>
              <Text variant="caption" tone="accent">Open</Text>
            </Pressable>

            {homeError ? (
              <View style={{ padding: space.x4 }}>
                {homeError === 'offline' || homeError === 'signed_out' ? (
                  <InlineNotice tone="info" text={homeError === 'signed_out' ? 'Sign in to browse Watch.' : 'You are offline. Watch needs a connection to browse.'} />
                ) : homeError === 'not_configured' ? (
                  <InlineNotice tone="warning" text="Watch is not configured on this server yet." />
                ) : (
                  <ErrorState kind="server" onRetry={() => setReloadKey((k) => k + 1)} />
                )}
              </View>
            ) : null}
            {!rows && !homeError ? (
              <View style={{ gap: space.x5, marginTop: space.x5 }}>
                <PosterRowSkeleton count={4} />
                <PosterRowSkeleton count={4} />
                <PosterRowSkeleton count={4} />
              </View>
            ) : null}
            {rows?.map((row, i) => (
              <WatchRail
                key={`${i}-${row.title}`}
                label={row.title}
                data={row.items.map((t) => ({ ...t, key: t.subjectId }))}
                render={(t) => (
                  <WatchCard title={t.title} cover={t.cover} meta={t.rating ? `IMDb ${t.rating}` : t.releaseDate?.slice(0, 4)} onPress={() => open(t)} />
                )}
              />
            ))}
          </>
        )}
      </ScrollScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { marginHorizontal: space.x4, marginTop: space.x3, height: 200, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.surface1, justifyContent: 'flex-end' },
  heroShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)' },
  heroText: { padding: space.x4, gap: space.x1 },
  search: { paddingHorizontal: space.x4, paddingTop: space.x2 },
  downloadsCard: { marginHorizontal: space.x4, marginTop: space.x5, padding: space.x4, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderSubtle, backgroundColor: colors.surface1, flexDirection: 'row', alignItems: 'center', gap: space.x3 },
});
