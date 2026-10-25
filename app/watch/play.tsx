import { useLocalSearchParams } from 'expo-router';
import { AVPlaybackStatus, ResizeMode, Video } from 'expo-av';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { ScrollScreen, Screen } from '../../components/ui/Screen';
import { ErrorState } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { space } from '../../constants/theme';
import { fetchWatchPlayback } from '../../lib/api/moviebox';
import { getProgress, saveProgress, type WatchEpisodeRef } from '../../lib/watchStore';

const SAVE_EVERY_MS = 5000;

/**
 * Plays either a proxy stream (fetched fresh from `playback`, so the link never expires mid-session)
 * or a file saved on this device. Progress is written every few seconds so Continue Watching stays
 * accurate after a crash. A failed stream is retried once with a new link before showing an error.
 */
export default function WatchPlayer() {
  const params = useLocalSearchParams<{
    subjectId: string;
    title?: string;
    cover?: string;
    detailPath?: string;
    season?: string;
    episode?: string;
    quality?: string;
    local?: string;
  }>();
  const video = useRef<Video>(null);
  const lastSaved = useRef(0);
  const latest = useRef<{ positionMs: number; durationMs: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [remote, setRemote] = useState<{ uri: string } | null>(null);
  const [loading, setLoading] = useState(!params.local);
  const attempts = useRef(0);

  const season = params.season ? Number(params.season) : null;
  const episode = params.episode ? Number(params.episode) : null;
  const ref: WatchEpisodeRef = {
    subjectId: String(params.subjectId ?? ''),
    title: String(params.title ?? ''),
    cover: params.cover ? String(params.cover) : null,
    detailPath: params.detailPath ? String(params.detailPath) : null,
    season: season && Number.isFinite(season) ? season : null,
    episode: episode && Number.isFinite(episode) ? episode : null,
  };

  const loadRemote = async () => {
    setLoading(true);
    const r = await fetchWatchPlayback(ref.subjectId, ref.season ?? undefined, ref.episode ?? undefined, params.quality ? String(params.quality) : null);
    setLoading(false);
    if (r.ok) setRemote({ uri: r.value.playbackUrl });
    else setFailed(true);
  };

  useEffect(() => {
    if (!params.local) loadRemote();
    // One fetch per mounted player. Retries reuse the same route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const source = params.local ? { uri: String(params.local) } : remote;

  const onPlaybackFailure = () => {
    // One fresh link, then an error. A broken link is not retried forever.
    if (!params.local && attempts.current < 1) {
      attempts.current += 1;
      setRemote(null);
      loadRemote();
      return;
    }
    setFailed(true);
  };

  useEffect(() => {
    return () => {
      const last = latest.current;
      if (last && last.durationMs > 0) saveProgress(ref, last.positionMs, last.durationMs);
    };
    // The ref is stable for one playback session; the player mounts once per route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onStatus = (status: AVPlaybackStatus) => {
    if (!status.isLoaded) {
      if (status.error) onPlaybackFailure();
      return;
    }
    const positionMs = status.positionMillis;
    const durationMs = status.durationMillis ?? 0;
    latest.current = { positionMs, durationMs };
    if (durationMs > 0 && Date.now() - lastSaved.current >= SAVE_EVERY_MS) {
      lastSaved.current = Date.now();
      saveProgress(ref, positionMs, durationMs);
    }
  };

  const onLoad = async () => {
    const p = await getProgress(`${ref.subjectId}:${ref.season ?? 0}:${ref.episode ?? 0}`);
    if (p && p.positionMs > 5000 && p.durationMs > 0 && p.positionMs / p.durationMs < 0.95) {
      await video.current?.setPositionAsync(p.positionMs).catch(() => {});
    }
  };

  return (
    <Screen header={<TopBar title={ref.title || 'Watch'} mode="stack" transparent />}>
      <ScrollScreen contentContainerStyle={{ flexGrow: 1 }} padded={false}>
        <View style={styles.stage}>
          {loading && !source ? (
            <View style={styles.center}>
              <ActivityIndicator color="#fff" />
            </View>
          ) : failed || !source ? (
            <View style={{ padding: space.x4 }}>
              <ErrorState
                kind="server"
                title="This stream could not be played"
                body="The stream could not be loaded. Go back, open the title again, and try once more."
              />
            </View>
          ) : (
            <Video
              ref={video}
              source={source}
              style={styles.video}
              useNativeControls
              resizeMode={ResizeMode.CONTAIN}
              shouldPlay
              onPlaybackStatusUpdate={onStatus}
              onLoad={onLoad}
              onError={onPlaybackFailure}
            />
          )}
        </View>
        {!failed && source ? (
          <Text variant="caption" tone="tertiary" style={{ padding: space.x4 }}>
            {params.local ? 'Playing from this device.' : 'Streaming. Playback needs a connection.'}
          </Text>
        ) : null}
      </ScrollScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stage: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000' },
  video: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
