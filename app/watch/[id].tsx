import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Chip, ChipRow } from '../../components/ui/Chip';
import { ScrollScreen, Screen } from '../../components/ui/Screen';
import { ProgressBar } from '../../components/ui/Section';
import { ErrorState, InlineNotice } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { colors, radius, space } from '../../constants/theme';
import {
  fetchWatchDetail,
  fetchWatchStreams,
  isDownloadable,
  pickStream,
  qualityOptions,
  type WatchDiagnostic,
  type WatchDetail,
  type WatchStream,
} from '../../lib/api/moviebox';
import {
  downloadsSupported,
  findDownload,
  getProgress,
  removeDownload,
  startDownload,
  type DownloadEntry,
  type DownloadHandle,
  type ProgressEntry,
} from '../../lib/watchStore';

type Playable = { streams: WatchStream[] } | null;

/** One title: details, season and episode picker, Watch Now (only when a stream exists), and downloads. */
export default function WatchTitleScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; detailPath: string; title?: string }>();
  const subjectId = String(params.id ?? '');
  const detailPath = String(params.detailPath ?? '');

  const [detail, setDetail] = useState<WatchDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [episode, setEpisode] = useState<number | null>(null);
  const [playable, setPlayable] = useState<Playable | undefined>(undefined);
  const [playError, setPlayError] = useState<string | null>(null);
  const [quality, setQuality] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<WatchDiagnostic[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [saved, setSaved] = useState<DownloadEntry | null>(null);
  const [resume, setResume] = useState<ProgressEntry | null>(null);
  const [downloadFraction, setDownloadFraction] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const handle = useRef<DownloadHandle | null>(null);

  const isSeries = (detail?.seasons.length ?? 0) > 0;

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setDetailError(null);
    fetchWatchDetail(detailPath).then((r) => {
      if (!alive) return;
      if (!r.ok) return setDetailError(r.reason);
      setDetail(r.value);
      const first = r.value.seasons[0];
      if (first) {
        setSeason(first.se);
        setEpisode(1);
      }
    });
    return () => {
      alive = false;
    };
  }, [detailPath]);

  // Decide once whether this title has a playable stream. Movies are requested without a season or episode.
  useEffect(() => {
    if (!detail) return;
    if (isSeries && (season === null || episode === null)) return;
    let alive = true;
    setPlayable(undefined);
    setPlayError(null);
    fetchWatchStreams(subjectId, isSeries ? season ?? undefined : undefined, isSeries ? episode ?? undefined : undefined).then((r) => {
      if (!alive) return;
      if (!r.ok) {
        setPlayable(null);
        setDiagnostics(r.diagnostics ?? []);
        // No full-length stream is a normal outcome, not a playback fault.
        setPlayError(r.reason === 'no_full_stream' ? null : r.reason);
        return;
      }
      setPlayable({ streams: r.value.streams });
    });
    return () => {
      alive = false;
    };
  }, [detail, subjectId, isSeries, season, episode]);

  useEffect(() => {
    let alive = true;
    const ref = { subjectId, season: isSeries ? season : null, episode: isSeries ? episode : null };
    Promise.all([findDownload(subjectId, ref.season, ref.episode), getProgress(`${subjectId}:${ref.season ?? 0}:${ref.episode ?? 0}`)]).then(([d, p]) => {
      if (!alive) return;
      setSaved(d);
      setResume(p && p.positionMs > 5000 ? p : null);
    });
    return () => {
      alive = false;
    };
  }, [subjectId, isSeries, season, episode]);

  useEffect(() => () => {
    handle.current?.cancel();
  }, []);

  const ref = () => ({
    subjectId,
    title: detail?.title ?? String(params.title ?? ''),
    cover: detail?.cover ?? null,
    detailPath,
    season: isSeries ? season : null,
    episode: isSeries ? episode : null,
  });

  const watch = (stream: WatchStream) => {
    router.push({
      pathname: '/watch/play',
      params: {
        subjectId,
        title: ref().title,
        cover: ref().cover ?? '',
        detailPath,
        season: ref().season ?? '',
        episode: ref().episode ?? '',
        url: stream.url,
        headers: JSON.stringify(stream.requiredHeaders),
      },
    });
  };

  const download = (stream: WatchStream) => {
    setDownloadFailed(false);
    setDownloading(true);
    setDownloadFraction(0);
    const h = startDownload(ref(), stream, setDownloadFraction);
    handle.current = h;
    h.promise.then((entry) => {
      setDownloading(false);
      setDownloadFraction(null);
      handle.current = null;
      if (entry) setSaved(entry);
      else setDownloadFailed(true);
    });
  };

  const cancelDownload = () => {
    handle.current?.cancel();
  };

  const qualities = playable ? qualityOptions(playable.streams) : [];
  const watchable = playable ? pickStream(playable.streams, quality) : undefined;
  const downloadable = playable ? playable.streams.filter((s) => s.quality === (watchable?.quality ?? null)).find(isDownloadable) ?? playable.streams.find(isDownloadable) : undefined;

  return (
    <Screen header={<TopBar title={detail?.title ?? String(params.title ?? 'Title')} mode="stack" />}>
      <ScrollScreen contentContainerStyle={{ paddingBottom: space.x8 }}>
        {detailError ? (
          <View style={{ padding: space.x4 }}>
            {detailError === 'not_found' ? (
              <InlineNotice tone="warning" text="This title is no longer available." />
            ) : (
              <ErrorState kind="server" title="Could not load this title" body="Check your connection and try again." onRetry={() => router.replace({ pathname: '/watch/[id]', params: { id: subjectId, detailPath, title: String(params.title ?? '') } })} />
            )}
          </View>
        ) : null}

        {!detail && !detailError ? <ActivityIndicator color={colors.accent} style={{ marginTop: space.x8 }} /> : null}

        {detail ? (
          <View style={{ padding: space.x4, gap: space.x3 }}>
            <View style={styles.hero}>
              {detail.cover ? <Image source={{ uri: detail.cover }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
            </View>
            <Text variant="title">{detail.title}</Text>
            <Text variant="caption" tone="tertiary">
              {[detail.releaseDate?.slice(0, 4), detail.genre, detail.countryName, detail.rating ? `IMDb ${detail.rating}` : null].filter(Boolean).join(' · ')}
            </Text>
            {detail.description ? <Text variant="body" tone="secondary">{detail.description}</Text> : null}

            {isSeries ? (
              <>
                <Text variant="caption" tone="tertiary">Season</Text>
                <ChipRow>
                  {detail.seasons.map((s) => (
                    <Chip key={s.se} label={`Season ${s.se}`} selected={season === s.se} onPress={() => { setSeason(s.se); setEpisode(1); }} />
                  ))}
                </ChipRow>
                <Text variant="caption" tone="tertiary">Episode</Text>
                <ChipRow>
                  {Array.from({ length: detail.seasons.find((s) => s.se === season)?.maxEp ?? 0 }, (_, i) => i + 1).map((ep) => (
                    <Chip key={ep} label={`${ep}`} selected={episode === ep} onPress={() => setEpisode(ep)} />
                  ))}
                </ChipRow>
              </>
            ) : null}

            {playable === undefined && !playError ? <ActivityIndicator color={colors.accent} style={{ alignSelf: 'flex-start' }} /> : null}
            {playError ? <InlineNotice tone="warning" text="Playback check failed. Reopen this title to try again." /> : null}
            {playable === null && !playError ? (
              <InlineNotice tone="info" text={isSeries ? 'Only short previews are available for this episode, so it cannot be played in full.' : 'Only short previews are available for this title, so it cannot be played in full.'} />
            ) : null}

            {__DEV__ && playable === null && diagnostics.length > 0 ? (
              <View style={{ gap: space.x2 }}>
                <Pressable onPress={() => setShowDebug((v) => !v)} accessibilityRole="button" style={styles.ghost}>
                  <Text variant="caption" tone="tertiary">{showDebug ? 'Hide' : 'Show'} debug info ({diagnostics.length} candidates)</Text>
                </Pressable>
                {showDebug ? diagnostics.map((d, i) => (
                  <Text key={i} variant="caption" tone="tertiary">
                    {`${d.full ? 'FULL' : 'rejected'} · ${d.host ?? 'no host'}${d.hostAllowed ? '' : ' (host not allowed)'} · ${d.source ?? 'no source'} · ${d.format ?? '?'} ${d.quality ?? '?'} · ${d.durationSec ?? 'no duration'}s · ${d.sizeMb ?? 'no size'}MB`}
                  </Text>
                )) : null}
              </View>
            ) : null}

            {qualities.length > 1 ? (
              <>
                <Text variant="caption" tone="tertiary">Quality</Text>
                <ChipRow>
                  {qualities.map((q) => (
                    <Chip key={q} label={q} selected={(watchable?.quality ?? null) === q} onPress={() => setQuality(q)} />
                  ))}
                </ChipRow>
              </>
            ) : null}

            {resume && watchable ? (
              <Text variant="caption" tone="secondary">Resume at {Math.floor(resume.positionMs / 60000)}:{String(Math.floor(resume.positionMs / 1000) % 60).padStart(2, '0')}</Text>
            ) : null}

            {watchable ? (
              <Pressable onPress={() => watch(watchable)} accessibilityRole="button" accessibilityLabel="Watch now" style={styles.primary}>
                <Text variant="body" tone="onAccent">{resume ? 'Resume' : 'Watch now'}</Text>
              </Pressable>
            ) : null}

            {saved ? (
              <View style={{ gap: space.x2 }}>
                <Pressable onPress={() => router.push({ pathname: '/watch/play', params: { subjectId, title: ref().title, season: ref().season ?? '', episode: ref().episode ?? '', local: saved.fileUri } })} accessibilityRole="button" style={styles.secondary}>
                  <Text variant="body">Play offline · {Math.round(saved.bytes / 1048576)} MB</Text>
                </Pressable>
                <Pressable onPress={() => removeDownload(saved).then(() => setSaved(null))} accessibilityRole="button" style={styles.ghost}>
                  <Text variant="caption" tone="danger">Remove download</Text>
                </Pressable>
              </View>
            ) : null}

            {!saved && downloadable && downloadsSupported() ? (
              downloading ? (
                <View style={{ gap: space.x2 }}>
                  <Text variant="caption" tone="secondary">
                    Downloading{downloadFraction !== null ? ` · ${Math.round(downloadFraction * 100)}%` : ''}
                  </Text>
                  <ProgressBar value={downloadFraction ?? 0} max={1} />
                  <Pressable onPress={cancelDownload} accessibilityRole="button" style={styles.ghost}>
                    <Text variant="caption" tone="danger">Cancel download</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable onPress={() => download(downloadable)} accessibilityRole="button" style={styles.secondary}>
                  <Text variant="body">Download · {downloadable.quality ?? 'MP4'}{downloadable.sizeMb ? ` · ${Math.round(downloadable.sizeMb)} MB` : ''}</Text>
                </Pressable>
              )
            ) : null}
            {downloadFailed ? <InlineNotice tone="danger" text="The download did not finish. Check your connection and try again." /> : null}
            {!downloadsSupported() && watchable ? <Text variant="caption" tone="tertiary">Downloads are available in the Android and iOS apps.</Text> : null}
          </View>
        ) : null}
      </ScrollScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { width: '100%', aspectRatio: 16 / 9, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.surface1 },
  primary: { height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent },
  secondary: { height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderSubtle },
  ghost: { alignSelf: 'flex-start', paddingVertical: space.x1 },
});
