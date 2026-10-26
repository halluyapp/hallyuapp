import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useCompletedDownloads, useTransfers } from '../../components/watch/useWatchDownloads';
import { ScrollScreen, Screen } from '../../components/ui/Screen';
import { ProgressBar } from '../../components/ui/Section';
import { EmptyState, InlineNotice } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { colors, radius, space } from '../../constants/theme';
import { fetchWatchDownloadUrl } from '../../lib/api/moviebox';
import { cancelDownload, pauseDownload, removeDownload, resumeDownload, type DownloadEntry, type TransferEntry } from '../../lib/watchStore';
import { formatBytes, progressFraction } from '../../lib/watchRules';

const FAILURE_NOTE: Record<string, string> = {
  link_expired: 'The link expired. Tap retry to get a new one.',
  network: 'Connection lost. Resume when you are back online.',
  http_error: 'The server returned an error. Try again later.',
  invalid_file: 'The file was not a playable video and was removed.',
  insufficient_storage: 'Not enough free storage. Free up space and try again.',
};

function episodeLabel(season: number | null, episode: number | null): string {
  if (season && episode) return `S${season} · E${episode}`;
  return 'Movie';
}

/**
 * Downloads: every title Hallyu TV is saving, paused, failed, or has saved. Each item shows its real
 * bytes and its real state, with only the controls that apply. Downloads run while Hallyu is open.
 */
export default function WatchDownloads() {
  const router = useRouter();
  const transfers = useTransfers();
  const completed = useCompletedDownloads();
  const [message, setMessage] = useState<string | null>(null);

  const downloading = transfers.filter((t) => t.status === 'downloading');
  const queued = transfers.filter((t) => t.status === 'queued');
  const paused = transfers.filter((t) => t.status === 'paused');
  const failed = transfers.filter((t) => t.status === 'failed');
  const empty = transfers.length === 0 && completed.length === 0;

  const resume = async (t: TransferEntry) => {
    setMessage(null);
    const r = await resumeDownload(t.key, () => fetchWatchDownloadUrl(t.subjectId, t.season ?? undefined, t.episode ?? undefined, t.quality));
    if (!r.ok) setMessage(r.message ?? 'This download could not be resumed.');
  };

  const pause = async (t: TransferEntry) => {
    setMessage(null);
    const ok = await pauseDownload(t.key);
    if (!ok) setMessage('This download could not be paused. It may have just finished.');
  };

  const remove = (d: DownloadEntry) => {
    void removeDownload(d);
  };

  const row = (t: TransferEntry) => {
    const frac = progressFraction(t.bytesWritten, t.totalBytes);
    const sizeLine =
      t.totalBytes !== null
        ? `${formatBytes(t.bytesWritten)} of ${formatBytes(t.totalBytes)}`
        : t.bytesWritten > 0
          ? `${formatBytes(t.bytesWritten)} saved · total size unavailable`
          : 'Size unavailable until the transfer starts';
    const statusLabel = t.status === 'downloading' ? 'Downloading' : t.status === 'paused' ? 'Paused' : t.status === 'queued' ? 'Queued' : 'Failed';
    return (
      <View key={t.key} style={styles.card}>
        <View style={styles.cardTop}>
          {t.cover ? <Image source={{ uri: t.cover }} style={styles.poster} contentFit="cover" /> : <View style={styles.posterFallback} />}
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="label" numberOfLines={2}>{t.title}</Text>
            <Text variant="caption" tone="tertiary">{[episodeLabel(t.season, t.episode), t.quality].filter(Boolean).join(' · ')}</Text>
            <Text variant="caption" tone={t.status === 'failed' ? 'danger' : 'secondary'}>{statusLabel}</Text>
            <Text variant="caption" tone="tertiary">{sizeLine}</Text>
          </View>
        </View>
        {t.status !== 'failed' && frac !== null ? (
          <ProgressBar value={frac} max={1} />
        ) : null}
        {t.status === 'failed' ? <Text variant="caption" tone="danger">{t.error ?? FAILURE_NOTE.network}</Text> : null}
        <View style={styles.actions}>
          {t.status === 'downloading' && t.engine === 'native' ? (
            <Text variant="caption" tone="tertiary">Runs in the background until it finishes</Text>
          ) : t.status === 'downloading' ? (
            <Pressable onPress={() => void pause(t)} accessibilityRole="button" style={styles.btn}>
              <Text variant="caption">Pause</Text>
            </Pressable>
          ) : null}
          {t.status === 'paused' ? (
            <Pressable onPress={() => void resume(t)} accessibilityRole="button" style={[styles.btn, styles.btnPrimary]}>
              <Text variant="caption" tone="onAccent">Resume</Text>
            </Pressable>
          ) : null}
          {t.status === 'queued' ? <Text variant="caption" tone="tertiary">Starts when the current download finishes</Text> : null}
          {t.status === 'failed' ? (
            <Pressable onPress={() => void resume(t)} accessibilityRole="button" style={[styles.btn, styles.btnPrimary]}>
              <Text variant="caption" tone="onAccent">Retry</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => void cancelDownload(t.key)} accessibilityRole="button" style={styles.btn}>
            <Text variant="caption" tone="danger">Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  const doneRow = (d: DownloadEntry) => (
    <View key={d.key} style={styles.card}>
      <View style={styles.cardTop}>
        {d.cover ? <Image source={{ uri: d.cover }} style={styles.poster} contentFit="cover" /> : <View style={styles.posterFallback} />}
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label" numberOfLines={2}>{d.title}</Text>
          <Text variant="caption" tone="tertiary">{[episodeLabel(d.season, d.episode), d.quality].filter(Boolean).join(' · ')}</Text>
          <Text variant="caption" tone="success">Ready offline</Text>
          <Text variant="caption" tone="tertiary">{formatBytes(d.bytes)}</Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Pressable
          onPress={() => router.push({ pathname: '/watch/play', params: { subjectId: d.subjectId, title: d.title, season: d.season ?? '', episode: d.episode ?? '', quality: d.quality ?? '', local: d.fileUri } })}
          accessibilityRole="button"
          style={[styles.btn, styles.btnPrimary]}
        >
          <Text variant="caption" tone="onAccent">Play offline</Text>
        </Pressable>
        <Pressable onPress={() => remove(d)} accessibilityRole="button" style={styles.btn}>
          <Text variant="caption" tone="danger">Remove</Text>
        </Pressable>
      </View>
    </View>
  );

  const section = (label: string, items: React.ReactNode[]) =>
    items.length > 0 ? (
      <View style={{ gap: space.x2 }}>
        <Text variant="caption" tone="tertiary">{label.toUpperCase()}</Text>
        {items}
      </View>
    ) : null;

  return (
    <Screen header={<TopBar title="Downloads" mode="stack" />}>
      <ScrollScreen contentContainerStyle={{ padding: space.x4, gap: space.x5, paddingBottom: space.x8 }}>
        <Text variant="caption" tone="tertiary">
          Downloads are saved privately inside Hallyu. They are not added to your gallery. They run while Hallyu is open, and pause when you leave the app.
        </Text>
        {message ? <InlineNotice tone="warning" text={message} /> : null}
        {empty ? (
          <EmptyState title="No downloads yet" body="Open a title in Hallyu TV and tap Download. Finished episodes play here without a connection." />
        ) : null}
        {section('Downloading', downloading.map(row))}
        {section('Queued', queued.map(row))}
        {section('Paused', paused.map(row))}
        {section('Failed', failed.map(row))}
        {section('Completed', completed.map(doneRow))}
      </ScrollScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { padding: space.x3, gap: space.x2, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderSubtle, backgroundColor: colors.surface1 },
  cardTop: { flexDirection: 'row', gap: space.x3 },
  poster: { width: 56, height: 80, borderRadius: radius.sm, backgroundColor: colors.surface2 },
  posterFallback: { width: 56, height: 80, borderRadius: radius.sm, backgroundColor: colors.surface2 },
  actions: { flexDirection: 'row', gap: space.x2, flexWrap: 'wrap' },
  btn: { paddingHorizontal: space.x3, paddingVertical: space.x2, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderSubtle },
  btnPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
});
