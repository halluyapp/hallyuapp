import { Ionicons } from '@expo/vector-icons';
import { AVPlaybackStatus, ResizeMode, Video } from 'expo-av';
import { Image } from 'expo-image';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { colors, radius, space } from '../../constants/theme';
import { normalizeMediaUrl } from '../../lib/api/client';
import { refreshSignedUrl } from '../../lib/api/media';
import { haptic, useAutoplayAllowed } from '../../lib/hooks';
import { Post } from '../../lib/model';
import { Text } from '../ui/Text';
import { feedSound, useFeedViewport } from './FeedViewport';

const MIN_ASPECT = 4 / 5; // tallest a feed video gets (portrait clips are cropped like X does)
const MAX_ASPECT = 16 / 9;

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

interface Props {
  post: Post;
  width: number;
  /** Tap on a playing/loaded video — open the post (or the vertical player for shorts). */
  onOpen: () => void;
  /** Detail screens: bigger controls, no crop clamp for portrait. */
  detail?: boolean;
}

/**
 * Inline feed video, the way X does it: the most visible video plays muted on its own (per the
 * autoplay setting), shows a time badge and a thin progress line, has a speaker toggle that is
 * remembered for the session, loops quietly, and a tap opens it big with sound. Only the active
 * card mounts a player, so a long timeline costs one decoder.
 */
function FeedVideoBase({ post, width, onOpen, detail }: Props) {
  const video = post.video!;
  const vp = useFeedViewport();
  const autoplay = useAutoplayAllowed();
  const active = !!vp && vp.activeId === post.id && !vp.paused;
  const [manual, setManual] = useState(false);
  const [muted, setMuted] = useState(feedSound.muted);
  const [ready, setReady] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [videoUri, setVideoUri] = useState<string>(() => normalizeMediaUrl(video.url) ?? video.url);
  const [retried, setRetried] = useState(false);
  const [progress, setProgress] = useState<{ pos: number; dur: number; playing: boolean }>({ pos: 0, dur: video.duration * 1000, playing: false });
  const [aspect, setAspect] = useState<number | null>(post.type === 'short' ? 9 / 16 : null); // shorts are portrait by definition
  const ref = useRef<Video>(null);

  useEffect(() => {
    setVideoUri(normalizeMediaUrl(video.url) ?? video.url);
    setRetried(false);
    setFailed(false);
  }, [video.url]);

  useEffect(() => feedSound.subscribe(setMuted), []);
  // Scrolled away → drop the manual override so it doesn't keep playing off-screen.
  useEffect(() => {
    if (vp && !active) setManual(false);
  }, [vp, active]);

  const armed = detail || manual || active;
  const shouldPlay = (manual || (active && autoplay) || (detail && autoplay)) && !failed;

  const height = useMemo(() => {
    const a = aspect ?? 16 / 9;
    const clamped = detail ? Math.max(a, 9 / 16) : Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, a));
    return Math.round(width / clamped);
  }, [aspect, width, detail]);

  const onStatus = useCallback((st: AVPlaybackStatus) => {
    if (!st.isLoaded) {
      if (st.error) setFailed(true);
      return;
    }
    setBuffering(st.isBuffering && !st.isPlaying);
    setProgress((p) => {
      const dur = st.durationMillis ?? p.dur;
      const pos = st.positionMillis;
      return p.pos === pos && p.dur === dur && p.playing === st.isPlaying ? p : { pos, dur, playing: st.isPlaying };
    });
  }, []);

  const toggleMute = () => {
    haptic.select();
    feedSound.set(!feedSound.muted);
  };
  const play = () => {
    haptic.light();
    setFailed(false);
    setManual(true);
  };

  const rawPoster = video.poster ?? post.images?.[0];
  const poster = typeof rawPoster === 'string' ? normalizeMediaUrl(rawPoster) ?? rawPoster : rawPoster;
  const remaining = progress.playing || progress.pos > 0 ? clock(progress.dur - progress.pos) : clock(video.duration * 1000);
  const showPlayGlyph = !shouldPlay || failed;

  return (
    <View style={[styles.frame, { width, height }]} accessible accessibilityLabel={`Video, ${clock(video.duration * 1000)}${post.type === 'short' ? ', short' : ''}`}>
      {poster ? <Image source={typeof poster === 'string' ? { uri: poster } : poster} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} /> : null}
      {armed ? (
        <Video
          ref={ref}
          source={{ uri: videoUri }}
          style={[StyleSheet.absoluteFill, { opacity: ready ? 1 : 0 }]}
          resizeMode={ResizeMode.COVER}
          shouldPlay={shouldPlay}
          isMuted={muted}
          isLooping
          progressUpdateIntervalMillis={250}
          onPlaybackStatusUpdate={onStatus}
          onReadyForDisplay={(e) => {
            // Native reports naturalSize; on web the argument is the DOM `canplay` event, so read the element.
            const n = e?.naturalSize;
            const el = (e as unknown as { target?: { videoWidth?: number; videoHeight?: number } })?.target;
            const w = n?.width || el?.videoWidth;
            const h = n?.height || el?.videoHeight;
            if (w && h) setAspect(n?.orientation === 'portrait' && w > h ? h / w : w / h);
            setReady(true);
          }}
          onError={() => {
            if (!retried) {
              setRetried(true);
              void refreshSignedUrl(video.storagePath ?? videoUri).then((fresh) => {
                if (fresh) {
                  setVideoUri(fresh);
                  setFailed(false);
                } else {
                  setFailed(true);
                }
              });
              return;
            }
            setFailed(true);
          }}
          videoStyle={{ width: '100%', height: '100%' }}
          useNativeControls={false}
        />
      ) : null}

      {/* Tap surface: opens the post; the play glyph starts playback when autoplay is off or the card isn't active. */}
      <Pressable onPress={showPlayGlyph ? play : onOpen} style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel={showPlayGlyph ? 'Play video' : 'Open video'}>
        {showPlayGlyph ? (
          <View style={styles.center}>
            <View style={styles.playGlyph}>
              <Ionicons name={failed ? 'refresh' : 'play'} size={28} color={colors.onMedia} style={failed ? undefined : { marginLeft: 3 }} />
            </View>
            {failed ? (
              <Text variant="caption" tone="onMedia" style={styles.failText}>
                Couldn’t play · tap to retry
              </Text>
            ) : null}
          </View>
        ) : buffering || (!ready && armed) ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.onMedia} />
          </View>
        ) : null}
      </Pressable>

      {/* Chrome */}
      {post.type === 'short' ? (
        <View style={[styles.pill, styles.topLeft]}>
          <Ionicons name="flash" size={11} color={colors.onMedia} />
          <Text variant="caption" tone="onMedia">
            Short
          </Text>
        </View>
      ) : null}
      <View style={[styles.pill, styles.bottomLeft]}>
        <Text variant="caption" tone="onMedia" numeric>
          {remaining}
        </Text>
      </View>
      <Pressable
        onPress={toggleMute}
        style={[styles.round, styles.bottomRight]}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={muted ? 'Unmute' : 'Mute'}
        accessibilityState={{ checked: !muted }}
      >
        <Ionicons name={muted ? 'volume-mute' : 'volume-high'} size={16} color={colors.onMedia} />
      </Pressable>
      {progress.dur > 0 && (progress.playing || progress.pos > 0) ? (
        <View style={styles.track} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View style={[styles.fill, { width: `${Math.min(100, (progress.pos / progress.dur) * 100)}%` }]} />
        </View>
      ) : null}
    </View>
  );
}

export const FeedVideo = React.memo(FeedVideoBase);

const styles = StyleSheet.create({
  frame: { borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.surface2, marginTop: space.x1 },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: space.x2 },
  playGlyph: { width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(10,10,10,0.62)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  failText: { backgroundColor: 'rgba(10,10,10,0.62)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  pill: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, height: 22, borderRadius: 6, backgroundColor: 'rgba(10,10,10,0.7)' },
  round: { position: 'absolute', width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(10,10,10,0.7)', alignItems: 'center', justifyContent: 'center' },
  topLeft: { top: space.x2, left: space.x2 },
  bottomLeft: { bottom: space.x3, left: space.x2 },
  bottomRight: { bottom: space.x2, right: space.x2 },
  track: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, backgroundColor: 'rgba(255,255,255,0.18)' },
  fill: { height: 2, backgroundColor: colors.accent },
});
