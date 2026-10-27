import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useTransfers } from '../../components/watch/useWatchDownloads';
import { Chip, ChipRow } from '../../components/ui/Chip';
import { ScrollScreen, Screen } from '../../components/ui/Screen';
import { ProgressBar } from '../../components/ui/Section';
import { ErrorState, InlineNotice } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { colors, radius, space } from '../../constants/theme';
import {
  fetchWatchDetail,
  fetchWatchDownloadUrl,
  fetchWatchStreams,
  isDownloadable,
  pickStream,
  qualityOptions,
  type WatchDetail,
  type WatchDiagnostic,
  type WatchStream,
} from '../../lib/api/moviebox';
import {
  cancelDownload,
  downloadsSupported,
  findDownload,
  getPreferredQuality,
  getProgress,
  pauseDownload,
  removeDownload,
  resumeDownload,
  setPreferredQuality,
  startDownload,
  episodeKey,
  type DownloadEntry,
  type ProgressEntry,
} from '../../lib/watchStore';
import { formatBytes, progressFraction } from '../../lib/watchRules';

type Playable = { streams: WatchStream[] } | null;

/** One title: details, season and episode picker, Watch Now (only when a full-length stream exists), and downloads. */
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
  const [preferred, setPreferred] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<WatchDiagnostic[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [saved, setSaved] = useState<DownloadEntry | null>(null);
  const [resume, setResume] = useState<ProgressEntry | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const transfers = useTransfers();

  const isSeries = (detail?.seasons.length ?? 0) > 0;
  const seasonValue = isSeries ? season : null;
  const episodeValue = isSeries ? episode : null;
  const key = episodeKey(subjectId, seasonValue, episodeValue);

  useEffect(() => {
    void getPreferredQuality().then(setPreferred);
  }, []);

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

  // Decide once per episode whether a full-length stream exists. Movies are requested without season or episode.
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
    Promise.all([findDownload(subjectId, seasonValue, episodeValue), getProgress(key)]).then(([d, p]) => {
      if (!alive) return;
      setSaved(d);
      setResume(p && p.positionMs > 5000 ? p : null);
    });
    return () => {
      alive = false;
    };
  }, [subjectId, isSeries, season, episode, key, seasonValue, episodeValue, transfers.length]);

  const ref = () => ({
    subjectId,
    title: detail?.title ?? String(params.title ?? ''),
    cover: detail?.cover ?? null,
    detailPath,
    season: seasonValue,
    episode: episodeValue,
  });

  // The quality the viewer chose this session, else their saved preference, else the default rule (480p, 360p, best).
  const chosen = quality ?? preferred;
  const qualities = playable ? qualityOptions(playable.streams) : [];
  const watchable = playable ? pickStream(playable.streams, chosen) : undefined;
  const downloadable = watchable && isDownloadable(watchable) ? watchable : undefined;
  const active = transfers.filter((t) => t.key === key);

  const pickQuality = (q: string) => {
    setQuality(q);
    void setPreferredQuality(q);
  };

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
        quality: stream.quality ?? '',
      },
    });
  };

  const download = async (stream: WatchStream) => {
    setMessage(null);
    const url = await fetchWatchDownloadUrl(subjectId, seasonValue ?? undefined, episodeValue ?? undefined, stream.quality);
    if (!url) {
      setMessage('Could not get a download link for this quality. Check your connection and try again.');
      return;
    }
    // The provider's size is only a hint for the free-space check. Completion uses the server's own length.
    const hint = stream.sizeMb ? stream.sizeMb * 1024 * 1024 : null;
    const r = await startDownload(ref(), { downloadUrl: url, quality: stream.quality }, hint);
    if (!r.ok) setMessage(r.message ?? 'The download could not start.');
  };

  const retryOrResume = async (t: { key: string; subjectId: string; season: number | null; episode: number | null; quality: string | null }) => {
    setMessage(null);
    const r = await resumeDownload(t.key, () => fetchWatchDownloadUrl(t.subjectId, t.season ?? undefined, t.episode ?? undefined, t.quality));
    if (!r.ok) setMessage(r.message ?? 'The download could not be resumed.');
  };

  const sameQualityActive = active.find((t) => t.quality === (downloadable?.quality ?? null));
  const anyActive = active[0];

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

            {qualities.length > 0 ? (
              <>
                <Text variant="caption" tone="tertiary">Quality</Text>
                <ChipRow>
                  {qualities.map((q) => (
                    <Chip key={q} label={q} selected={(watchable?.quality ?? null) === q} onPress={() => pickQuality(q)} />
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
                <Pressable onPress={() => router.push({ pathname: '/watch/play', params: { subjectId, title: ref().title, season: ref().season ?? '', episode: ref().episode ?? '', quality: saved.quality ?? '', local: saved.fileUri } })} accessibilityRole="button" style={styles.secondary}>
                  <Text variant="body">Play offline · {formatBytes(saved.bytes)}{saved.quality ? ` · ${saved.quality}` : ''}</Text>
                </Pressable>
                <Pressable onPress={() => void removeDownload(saved).then(() => setSaved(null))} accessibilityRole="button" style={styles.ghost}>
                  <Text variant="caption" tone="danger">Remove download</Text>
                </Pressable>
              </View>
            ) : null}

            {!saved && anyActive ? (
              <View style={styles.transfer}>
                <Text variant="caption" tone="secondary">
                  {anyActive.status === 'downloading' ? 'Downloading' : anyActive.status === 'paused' ? 'Paused' : 'Download stopped'}
                  {anyActive.quality ? ` · ${anyActive.quality}` : ''}
                </Text>
                {progressFraction(anyActive.bytesWritten, anyActive.totalBytes) !== null ? (
                  <ProgressBar value={progressFraction(anyActive.bytesWritten, anyActive.totalBytes) ?? 0} max={1} />
                ) : null}
                <Text variant="caption" tone="tertiary">
                  {anyActive.totalBytes !== null ? `${formatBytes(anyActive.bytesWritten)} of ${formatBytes(anyActive.totalBytes)}` : anyActive.bytesWritten > 0 ? `${formatBytes(anyActive.bytesWritten)} saved` : 'Waiting for the server…'}
                </Text>
                {anyActive.error ? <Text variant="caption" tone="danger">{anyActive.error}</Text> : null}
                <View style={styles.transferActions}>
                  {anyActive.status === 'downloading' && anyActive.engine === 'native' ? (
                    <Text variant="caption" tone="tertiary">Runs in the background until it finishes</Text>
                  ) : anyActive.status === 'downloading' ? (
                    <Pressable onPress={() => void pauseDownload(anyActive.key)} accessibilityRole="button" style={styles.chipBtn}>
                      <Text variant="caption">Pause</Text>
                    </Pressable>
                  ) : (
                    <Pressable onPress={() => void retryOrResume(anyActive)} accessibilityRole="button" style={[styles.chipBtn, styles.chipBtnOn]}>
                      <Text variant="caption" tone="onAccent">{anyActive.status === 'paused' ? 'Resume' : 'Retry'}</Text>
                    </Pressable>
                  )}
                  <Pressable onPress={() => void cancelDownload(anyActive.key)} accessibilityRole="button" style={styles.chipBtn}>
                    <Text variant="caption" tone="danger">Cancel</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            {!saved && !anyActive && downloadable && downloadsSupported() ? (
              <Pressable onPress={() => void download(downloadable)} accessibilityRole="button" style={styles.secondary}>
                <Text variant="body">
                  Download · {downloadable.quality ?? 'MP4'}
                  {downloadable.sizeMb ? ` · about ${formatBytes(downloadable.sizeMb * 1024 * 1024)} from source` : ''}
                </Text>
              </Pressable>
            ) : null}
            {sameQualityActive ? <Text variant="caption" tone="tertiary">This quality is already downloading. Open Downloads to manage it.</Text> : null}
            {message ? <InlineNotice tone="warning" text={message} /> : null}
            {!downloadsSupported() && watchable ? <Text variant="caption" tone="tertiary">Downloads are available in the Android and iOS apps.</Text> : null}
            <Pressable onPress={() => router.push('/watch/downloads')} accessibilityRole="button" style={styles.ghost}>
              <Text variant="caption" tone="accent">Open Downloads</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { width: '100%', aspectRatio: 16 / 9, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.surface1 },
  primary: { height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent },
  secondary: { minHeight: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.x3, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderSubtle },
  ghost: { alignSelf: 'flex-start', paddingVertical: space.x1 },
  transfer: { gap: space.x2, padding: space.x3, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderSubtle, backgroundColor: colors.surface1 },
  transferActions: { flexDirection: 'row', gap: space.x2 },
  chipBtn: { paddingHorizontal: space.x3, paddingVertical: space.x2, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderSubtle },
  chipBtnOn: { backgroundColor: colors.accent, borderColor: colors.accent },
});
