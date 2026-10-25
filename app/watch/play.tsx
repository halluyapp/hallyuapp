import { useLocalSearchParams } from 'expo-router';
import { AVPlaybackStatus, ResizeMode, Video } from 'expo-av';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ScrollScreen, Screen } from '../../components/ui/Screen';
import { ErrorState } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { space } from '../../constants/theme';
import { watchProxySource } from '../../lib/api/moviebox';
import { getProgress, saveProgress, type WatchEpisodeRef } from '../../lib/watchStore';

const SAVE_EVERY_MS = 5000;

/**
 * Plays either a remote stream (sent with the headers the CDN requires) or a file saved on this
 * device. Progress is written every few seconds so Continue Watching stays accurate after a crash.
 */
export default function WatchPlayer() {
  const params = useLocalSearchParams<{
    subjectId: string;
    title?: string;
    cover?: string;
    detailPath?: string;
    season?: string;
    episode?: string;
    url?: string;
    headers?: string;
    local?: string;
  }>();
  const video = useRef<Video>(null);
  const lastSaved = useRef(0);
  const latest = useRef<{ positionMs: number; durationMs: number } | null>(null);
  const [failed, setFailed] = useState(false);

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

  // Direct link first (with the headers the CDN needs). If it fails, retry once through the allowlisted proxy.
  const [proxied, setProxied] = useState<{ uri: string; headers: Record<string, string> } | null>(null);
  const source = params.local
    ? { uri: String(params.local) }
    : proxied ?? { uri: String(params.url ?? ''), headers: parseHeaders(params.headers) };

  const onPlaybackFailure = () => {
    if (!params.local && !proxied && params.url) {
      watchProxySource(String(params.url)).then((p) => {
        if (p) setProxied(p);
        else setFailed(true);
      });
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
          {failed || !source.uri ? (
            <View style={{ padding: space.x4 }}>
              <ErrorState
                kind="server"
                title="This stream could not be played"
                body="Stream links expire. Go back, open the title again, and choose a stream."
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
        {!failed && source.uri ? (
          <Text variant="caption" tone="tertiary" style={{ padding: space.x4 }}>
            {params.local ? 'Playing from this device.' : 'Streaming. Playback needs a connection.'}
          </Text>
        ) : null}
      </ScrollScreen>
    </Screen>
  );
}

function parseHeaders(raw?: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

const styles = StyleSheet.create({
  stage: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000' },
  video: { flex: 1, backgroundColor: '#000' },
});
