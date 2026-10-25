import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { WatchCard, WatchRail } from '../../components/watch/WatchCard';
import { SearchField } from '../../components/search/SearchField';
import { ScrollScreen, Screen } from '../../components/ui/Screen';
import { EmptyState, ErrorState, InlineNotice } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { colors, space } from '../../constants/theme';
import { fetchWatchHome, searchWatch, type WatchResult, type WatchRow, type WatchTitle } from '../../lib/api/moviebox';
import { listDownloads, listProgress, type DownloadEntry, type ProgressEntry } from '../../lib/watchStore';

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
  const [downloads, setDownloads] = useState<DownloadEntry[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setHomeError(null);
    fetchWatchHome().then((r: WatchResult<WatchRow[]>) => {
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
      listDownloads().then((d) => alive && setDownloads(d));
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

            {downloads.length > 0 ? (
              <View style={{ paddingHorizontal: space.x4, marginTop: space.x5 }}>
                <Text variant="title">Downloads on this device</Text>
                <Text variant="caption" tone="tertiary" style={{ marginTop: space.x1 }}>
                  Saved privately in Hallyu. Downloads only continue while the app is open.
                </Text>
                {downloads.map((d) => (
                  <Pressable
                    key={d.key}
                    onPress={() => router.push({ pathname: '/watch/play', params: { subjectId: d.subjectId, title: d.title, season: d.season ?? '', episode: d.episode ?? '', local: d.fileUri } })}
                    accessibilityRole="button"
                    style={styles.downloadRow}
                  >
                    <Text variant="body">{d.title}{d.season ? ` · S${d.season} E${d.episode}` : ''}</Text>
                    <Text variant="caption" tone="tertiary">{Math.round(d.bytes / 1048576)} MB · play offline</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

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
            {!rows && !homeError ? <ActivityIndicator color={colors.accent} style={{ marginTop: space.x6 }} /> : null}
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
  search: { paddingHorizontal: space.x4, paddingTop: space.x2 },
  downloadRow: { marginTop: space.x3, paddingVertical: space.x2 },
});
