import { Image } from 'expo-image';
import { WatchNav } from '../../components/watch/WatchNav';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useCompletedDownloads, useTransfers } from '../../components/watch/useWatchDownloads';
import { ScrollScreen, Screen } from '../../components/ui/Screen';
import { ProgressBar } from '../../components/ui/Section';
import { EmptyState, InlineNotice } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { colors, radius, space } from '../../constants/theme';
import { fetchWatchDownloadUrl } from '../../lib/api/moviebox';
import {
  cancelDownload,
  listProgress,
  pauseDownload,
  removeDownload,
  resumeDownload,
  type DownloadEntry,
  type ProgressEntry,
  type TransferEntry,
} from '../../lib/watchStore';
import { formatBytes, formatClock, formatEta, formatSpeed, progressFraction } from '../../lib/watchRules';
import { subscribeWatchPerf, watchPerfSnapshot, type WatchPerfSpan } from '../../lib/watchPerf';

const FAILURE_NOTE: Record<string, string> = {
  link_expired: 'The link expired. Tap retry to get a new one.',
  network: 'Connection lost. Retry to restart with a fresh link.',
  http_error: 'The server returned an error. Try again later.',
  invalid_file: 'The file was not a playable video and was removed.',
  insufficient_storage: 'Not enough free storage. Free up space and try again.',
};

function episodeLabel(season: number | null, episode: number | null): string {
  if (season && episode) return `S${season} · E${episode}`;
  return 'Movie';
}

interface ShowGroup {
  subjectId: string;
  title: string;
  cover: string | null;
  detailPath: string | null;
  episodes: DownloadEntry[];
  totalBytes: number;
  isSeries: boolean;
}

function groupDownloads(completed: DownloadEntry[]): ShowGroup[] {
  const map = new Map<string, ShowGroup>();
  for (const d of completed) {
    const existing = map.get(d.subjectId);
    if (!existing) {
      map.set(d.subjectId, {
        subjectId: d.subjectId,
        title: d.title,
        cover: d.cover,
        detailPath: d.detailPath,
        episodes: [d],
        totalBytes: d.bytes,
        isSeries: d.season !== null || d.episode !== null,
      });
    } else {
      existing.episodes.push(d);
      existing.totalBytes += d.bytes;
      if (d.season !== null || d.episode !== null) existing.isSeries = true;
      if (!existing.cover && d.cover) existing.cover = d.cover;
    }
  }
  return Array.from(map.values()).map((g) => {
    g.episodes.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
    return g;
  });
}

/**
 * Downloads: Series are grouped as unified Show Collages with episode stacks and storage tallies.
 * Active downloads display real-time speed (MB/s) and ETA. Completed media lives strictly in the
 * private app sandbox and plays offline without network dependencies.
 */
export default function WatchDownloads() {
  const router = useRouter();
  const transfers = useTransfers();
  const completed = useCompletedDownloads();
  const [message, setMessage] = useState<string | null>(null);
  const [timings, setTimings] = useState<WatchPerfSpan[]>(() => watchPerfSnapshot());
  const [showTimings, setShowTimings] = useState(false);
  const [expandedShows, setExpandedShows] = useState<Record<string, boolean>>({});
  const [progressMap, setProgressMap] = useState<Map<string, ProgressEntry>>(new Map());

  useEffect(() => subscribeWatchPerf(() => setTimings(watchPerfSnapshot())), []);

  useEffect(() => {
    let alive = true;
    void listProgress().then((list) => {
      if (!alive) return;
      const m = new Map<string, ProgressEntry>();
      for (const p of list) {
        m.set(`${p.subjectId}:${p.season ?? 0}:${p.episode ?? 0}`, p);
      }
      setProgressMap(m);
    });
    return () => {
      alive = false;
    };
  }, [completed]);

  const downloading = transfers.filter((t) => t.status === 'downloading');
  const queued = transfers.filter((t) => t.status === 'queued');
  const needsAttention = transfers.filter((t) => t.status === 'paused' || t.status === 'failed');
  const empty = transfers.length === 0 && completed.length === 0;

  const showGroups = groupDownloads(completed);

  const toggleExpand = (subjectId: string) => {
    setExpandedShows((prev) => ({ ...prev, [subjectId]: !prev[subjectId] }));
  };

  const resume = async (t: TransferEntry) => {
    setMessage(null);
    const r = await resumeDownload(t.key, () =>
      fetchWatchDownloadUrl(t.subjectId, t.season ?? undefined, t.episode ?? undefined, t.quality, t.detailPath),
    );
    if (!r.ok) setMessage(r.message ?? 'This download could not be resumed.');
  };

  const pause = async (t: TransferEntry) => {
    setMessage(null);
    const ok = await pauseDownload(t.key);
    if (!ok) setMessage('This download could not be paused. It may have just finished.');
  };

  const removeSingle = (d: DownloadEntry) => {
    void removeDownload(d);
  };

  const removeAllEpisodes = (group: ShowGroup) => {
    Alert.alert(
      'Remove downloaded episodes?',
      `Delete all ${group.episodes.length} episodes of ${group.title} (${formatBytes(group.totalBytes)}) from this device?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete All',
          style: 'destructive',
          onPress: () => {
            for (const ep of group.episodes) {
              void removeDownload(ep);
            }
          },
        },
      ],
    );
  };

  const playEpisode = (d: DownloadEntry) => {
    router.push({
      pathname: '/watch/play',
      params: {
        subjectId: d.subjectId,
        title: d.title,
        season: d.season ?? '',
        episode: d.episode ?? '',
        quality: d.quality ?? '',
        local: d.fileUri,
      },
    });
  };

  const playShowNext = (group: ShowGroup) => {
    // Find earliest episode with partial progress, or first episode
    const uncompleted = group.episodes.find((ep) => {
      const p = progressMap.get(`${ep.subjectId}:${ep.season ?? 0}:${ep.episode ?? 0}`);
      return p && p.durationMs > 0 && p.positionMs / p.durationMs < 0.95;
    }) ?? group.episodes[0];

    if (uncompleted) {
      playEpisode(uncompleted);
    }
  };

  const row = (t: TransferEntry) => {
    const frac = progressFraction(t.bytesWritten, t.totalBytes);
    const sizeLine =
      t.totalBytes !== null
        ? `${formatBytes(t.bytesWritten)} of ${formatBytes(t.totalBytes)}`
        : t.bytesWritten > 0
          ? `${formatBytes(t.bytesWritten)} saved · size calculating`
          : 'Connecting to download stream…';

    const speedStr = formatSpeed(t.speedBytesPerSec);
    const etaStr = formatEta(t.etaSeconds);
    const liveStats = [speedStr, etaStr].filter(Boolean).join(' · ');

    const statusLabel =
      t.status === 'downloading'
        ? t.nativeWaiting
          ? 'Waiting for network connection'
          : t.engine === 'native'
            ? 'Downloading in background'
            : 'Downloading'
        : t.status === 'paused'
          ? 'Paused'
          : t.status === 'queued'
            ? 'Queued'
            : 'Needs attention';

    return (
      <View key={t.key} style={styles.card}>
        <View style={styles.cardTop}>
          {t.cover ? (
            <Image source={{ uri: t.cover }} style={styles.poster} contentFit="cover" />
          ) : (
            <View style={styles.posterFallback} />
          )}
          <View style={{ flex: 1, gap: 3 }}>
            <Text variant="label" numberOfLines={2}>
              {t.title}
            </Text>
            <Text variant="caption" tone="tertiary">
              {[episodeLabel(t.season, t.episode), t.quality].filter(Boolean).join(' · ')}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Text variant="caption" tone={t.status === 'failed' ? 'danger' : 'secondary'}>
                {statusLabel}
              </Text>
              {liveStats && t.status === 'downloading' ? (
                <View style={styles.liveBadge}>
                  <Text variant="caption" tone="accent" style={{ fontWeight: '600' }}>
                    {liveStats}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text variant="caption" tone="tertiary">
              {sizeLine}
            </Text>
          </View>
        </View>
        {t.status !== 'failed' && frac !== null ? <ProgressBar value={frac} max={1} /> : null}
        {t.status === 'failed' ? (
          <Text variant="caption" tone="danger">
            {t.error ?? FAILURE_NOTE.network}
          </Text>
        ) : null}
        <View style={styles.actions}>
          {t.status === 'downloading' && t.engine === 'native' ? (
            <Text variant="caption" tone="tertiary">
              {t.nativeWaiting
                ? 'Will resume automatically when connected'
                : 'Runs in the background even if you switch apps'}
            </Text>
          ) : t.status === 'downloading' ? (
            <Pressable onPress={() => void pause(t)} accessibilityRole="button" style={styles.btn}>
              <Text variant="caption">Pause</Text>
            </Pressable>
          ) : null}
          {t.status === 'paused' ? (
            <Pressable onPress={() => void resume(t)} accessibilityRole="button" style={[styles.btn, styles.btnPrimary]}>
              <Text variant="caption" tone="onAccent">
                Resume
              </Text>
            </Pressable>
          ) : null}
          {t.status === 'queued' ? (
            <Text variant="caption" tone="tertiary">
              Starts when the active download finishes
            </Text>
          ) : null}
          {t.status === 'failed' ? (
            <Pressable onPress={() => void resume(t)} accessibilityRole="button" style={[styles.btn, styles.btnPrimary]}>
              <Text variant="caption" tone="onAccent">
                Retry
              </Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => void cancelDownload(t.key)} accessibilityRole="button" style={styles.btn}>
            <Text variant="caption" tone="danger">
              Cancel
            </Text>
          </Pressable>
        </View>
      </View>
    );
  };

  const doneShowCard = (group: ShowGroup) => {
    const isExpanded = expandedShows[group.subjectId] ?? (showGroups.length === 1);

    // If standalone movie (single item without series flag)
    if (!group.isSeries && group.episodes.length === 1) {
      const d = group.episodes[0];
      const prog = progressMap.get(`${d.subjectId}:${d.season ?? 0}:${d.episode ?? 0}`);
      const hasProgress = prog && prog.durationMs > 0 && prog.positionMs > 5000;
      return (
        <View key={group.subjectId} style={styles.card}>
          <View style={styles.cardTop}>
            {d.cover ? (
              <Image source={{ uri: d.cover }} style={styles.poster} contentFit="cover" />
            ) : (
              <View style={styles.posterFallback} />
            )}
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="label" numberOfLines={2}>
                {d.title}
              </Text>
              <Text variant="caption" tone="tertiary">
                {[d.quality, formatBytes(d.bytes)].filter(Boolean).join(' · ')}
              </Text>
              <Text variant="caption" tone="success">
                Ready offline
              </Text>
              {hasProgress ? (
                <Text variant="caption" tone="accent">
                  {`Resume from ${formatClock(prog.positionMs)}`}
                </Text>
              ) : null}
            </View>
          </View>
          <View style={styles.actions}>
            <Pressable onPress={() => playEpisode(d)} accessibilityRole="button" style={[styles.btn, styles.btnPrimary]}>
              <Ionicons name="play" size={13} color="#fff" style={{ marginRight: 4 }} />
              <Text variant="caption" tone="onAccent">
                {hasProgress ? 'Resume' : 'Play offline'}
              </Text>
            </Pressable>
            <Pressable onPress={() => removeSingle(d)} accessibilityRole="button" style={styles.btn}>
              <Text variant="caption" tone="danger">
                Remove
              </Text>
            </Pressable>
          </View>
        </View>
      );
    }

    // Series Collage / Stack Card
    return (
      <View key={group.subjectId} style={styles.collageCard}>
        {/* Collage Header: Stacked poster thumbnail + series metadata */}
        <Pressable
          onPress={() => toggleExpand(group.subjectId)}
          accessibilityRole="button"
          accessibilityLabel={`${group.title}, ${group.episodes.length} episodes downloaded. Tap to ${isExpanded ? 'collapse' : 'expand'}`}
          style={styles.collageHeader}
        >
          {/* Stacked Collage Poster Visual */}
          <View style={styles.stackWrapper}>
            <View style={styles.stackLayer2} />
            <View style={styles.stackLayer1} />
            {group.cover ? (
              <Image source={{ uri: group.cover }} style={styles.stackPoster} contentFit="cover" />
            ) : (
              <View style={[styles.stackPoster, styles.posterFallback]} />
            )}
            <View style={styles.stackBadge}>
              <Text variant="caption" tone="onAccent" style={styles.stackBadgeText}>
                {`${group.episodes.length} EPS`}
              </Text>
            </View>
          </View>

          {/* Series Info */}
          <View style={{ flex: 1, gap: 3 }}>
            <Text variant="label" numberOfLines={2} style={{ fontSize: 16 }}>
              {group.title}
            </Text>
            <Text variant="caption" tone="secondary">
              {`${group.episodes.length} ${group.episodes.length === 1 ? 'Episode' : 'Episodes'} · ${formatBytes(group.totalBytes)}`}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={styles.statusDot} />
              <Text variant="caption" tone="success">
                Downloaded · Offline Ready
              </Text>
            </View>
          </View>

          {/* Expand / Collapse Chevron */}
          <View style={styles.chevronWrap}>
            <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={20} color={colors.textSecondary} />
          </View>
        </Pressable>

        {/* Show Action Bar */}
        <View style={styles.collageActions}>
          <Pressable
            onPress={() => playShowNext(group)}
            accessibilityRole="button"
            accessibilityLabel={`Play next episode of ${group.title}`}
            style={[styles.btn, styles.btnPrimary, { flex: 1, justifyContent: 'center' }]}
          >
            <Ionicons name="play" size={14} color="#fff" style={{ marginRight: 6 }} />
            <Text variant="caption" tone="onAccent" style={{ fontWeight: '600' }}>
              {`Watch Next (${episodeLabel(group.episodes[0].season, group.episodes[0].episode)})`}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => toggleExpand(group.subjectId)}
            accessibilityRole="button"
            style={[styles.btn, { paddingHorizontal: 12 }]}
          >
            <Text variant="caption" tone="secondary">
              {isExpanded ? 'Hide' : 'Episodes'}
            </Text>
          </Pressable>
        </View>

        {/* Expanded Episode List Tray */}
        {isExpanded ? (
          <View style={styles.episodesTray}>
            <View style={styles.trayHeader}>
              <Text variant="caption" tone="tertiary" style={{ fontWeight: '600', letterSpacing: 0.5 }}>
                DOWNLOADED EPISODES
              </Text>
              <Pressable
                onPress={() => removeAllEpisodes(group)}
                accessibilityRole="button"
                accessibilityLabel="Delete all episodes of this show"
                hitSlop={8}
              >
                <Text variant="caption" tone="danger">
                  Delete All
                </Text>
              </Pressable>
            </View>

            {group.episodes.map((ep) => {
              const progKey = `${ep.subjectId}:${ep.season ?? 0}:${ep.episode ?? 0}`;
              const prog = progressMap.get(progKey);
              const hasProgress = prog && prog.durationMs > 0 && prog.positionMs > 5000;
              const frac = hasProgress ? prog.positionMs / prog.durationMs : 0;

              return (
                <View key={ep.key} style={styles.episodeRow}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="label" numberOfLines={1}>
                      {episodeLabel(ep.season, ep.episode)}
                    </Text>
                    <Text variant="caption" tone="tertiary">
                      {[ep.quality, formatBytes(ep.bytes)].filter(Boolean).join(' · ')}
                    </Text>
                    {hasProgress ? (
                      <View style={{ gap: 2, marginTop: 2 }}>
                        <ProgressBar value={frac} max={1} />
                        <Text variant="caption" tone="accent" style={{ fontSize: 11 }}>
                          {`Resume from ${formatClock(prog.positionMs)} (${Math.round(frac * 100)}%)`}
                        </Text>
                      </View>
                    ) : null}
                  </View>

                  <View style={styles.episodeActions}>
                    <Pressable
                      onPress={() => playEpisode(ep)}
                      accessibilityRole="button"
                      accessibilityLabel={`Play ${episodeLabel(ep.season, ep.episode)}`}
                      style={[styles.iconPlayBtn, styles.btnPrimary]}
                    >
                      <Ionicons name="play" size={14} color="#fff" />
                    </Pressable>
                    <Pressable
                      onPress={() => removeSingle(ep)}
                      accessibilityRole="button"
                      accessibilityLabel={`Delete ${episodeLabel(ep.season, ep.episode)}`}
                      style={styles.iconDeleteBtn}
                      hitSlop={6}
                    >
                      <Ionicons name="trash-outline" size={16} color={colors.danger} />
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}
      </View>
    );
  };

  const section = (label: string, items: React.ReactNode[]) =>
    items.length > 0 ? (
      <View style={{ gap: space.x2 }}>
        <Text variant="caption" tone="tertiary">
          {label.toUpperCase()}
        </Text>
        {items}
      </View>
    ) : null;

  return (
    <Screen header={<TopBar title="Downloads" mode="stack" />}>
      <ScrollScreen contentContainerStyle={{ padding: space.x4, gap: space.x5, paddingBottom: space.x8 }}>
        <WatchNav active="downloads" />
        <Text variant="caption" tone="tertiary">
          Downloads stay private inside Hallyu’s sandbox and are not added to your device gallery. On supported
          Android builds they continue in the background. Finished episodes play offline without a connection.
        </Text>
        {message ? <InlineNotice tone="warning" text={message} /> : null}
        {empty ? (
          <EmptyState
            title="No downloads yet"
            body="Open any drama or film in Hallyu TV and tap Download. Downloaded media will be stacked here for offline watching."
          />
        ) : null}
        {section('Active Transfers', downloading.map(row))}
        {section('Queued', queued.map(row))}
        {section('Needs Attention', needsAttention.map(row))}
        {section('Downloaded Titles', showGroups.map(doneShowCard))}

        {/* Load timings audit report */}
        <View style={{ gap: space.x2, marginTop: space.x2 }}>
          <Pressable onPress={() => setShowTimings((v) => !v)} accessibilityRole="button" style={styles.btn}>
            <Text variant="caption" tone="accent">
              {showTimings ? 'Hide load timings' : 'Show load timings'}
            </Text>
          </Pressable>
          {showTimings ? (
            timings.length === 0 ? (
              <Text variant="caption" tone="tertiary">
                No Watch timings recorded yet in this session. Open a title, then come back.
              </Text>
            ) : (
              timings
                .slice(0, 10)
                .map((s) => (
                  <Text key={`${s.label}-${s.at}`} variant="caption" tone="tertiary">{`${s.label} · ${s.ms} ms`}</Text>
                ))
            )
          ) : null}
        </View>
      </ScrollScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: space.x3,
    gap: space.x2,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surface1,
  },
  cardTop: { flexDirection: 'row', gap: space.x3 },
  poster: { width: 56, height: 80, borderRadius: radius.sm, backgroundColor: colors.surface2 },
  posterFallback: { width: 56, height: 80, borderRadius: radius.sm, backgroundColor: colors.surface2 },
  liveBadge: {
    backgroundColor: colors.accentSoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  actions: { flexDirection: 'row', gap: space.x2, flexWrap: 'wrap', alignItems: 'center' },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.x3,
    paddingVertical: space.x2,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  btnPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },

  /* Collage / Stack Card Styles */
  collageCard: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surface1,
    overflow: 'hidden',
  },
  collageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    padding: space.x3,
  },
  stackWrapper: {
    width: 64,
    height: 92,
    position: 'relative',
    justifyContent: 'flex-end',
  },
  stackLayer2: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 52,
    height: 78,
    borderRadius: radius.sm,
    backgroundColor: colors.surface3,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    opacity: 0.5,
  },
  stackLayer1: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 54,
    height: 80,
    borderRadius: radius.sm,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    opacity: 0.8,
  },
  stackPoster: {
    width: 56,
    height: 84,
    borderRadius: radius.sm,
    backgroundColor: colors.surface2,
  },
  stackBadge: {
    position: 'absolute',
    bottom: -4,
    left: 2,
    backgroundColor: colors.accent,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  stackBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.live,
  },
  chevronWrap: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  collageActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    paddingHorizontal: space.x3,
    paddingBottom: space.x3,
  },
  episodesTray: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surface2,
    padding: space.x3,
    gap: space.x3,
  },
  trayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 2,
  },
  episodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: space.x2,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    gap: space.x2,
  },
  episodeActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
  },
  iconPlayBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconDeleteBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(239,68,68,0.1)',
  },
});
