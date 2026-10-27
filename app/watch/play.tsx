import { Ionicons } from '@expo/vector-icons';
import { AVPlaybackStatus, ResizeMode, Video } from 'expo-av';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, PanResponder, Platform, Pressable, StatusBar, StyleSheet, useWindowDimensions, View } from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import { ScrollScreen, Screen } from '../../components/ui/Screen';
import { ErrorState } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { colors, radius, space } from '../../constants/theme';
import { fetchWatchPlayback } from '../../lib/api/moviebox';
import { fetchCaptionCues, fetchMovieboxCaptions, fetchOpenSubtitleCues, searchOpenSubtitles, type MovieboxCaption, type OpenSubtitleResult } from '../../lib/api/subtitles';
import { cueTextAt, type SubtitleCue } from '../../lib/subtitles';
import { getProgress, saveProgress, setTitleQuality, type WatchEpisodeRef } from '../../lib/watchStore';
import {
  BUFFER_STALL_MS,
  CONTROLS_AUTO_HIDE_MS,
  DOUBLE_TAP_WINDOW_MS,
  SAVE_PROGRESS_EVERY_MS,
  SKIP_MS,
  fractionAt,
  formatClock,
  isUnavailableReason,
  playerState,
  seekTarget,
  sortQualities,
  stalledForMs,
  volumeAfterSwipe,
  watchErrorMessage,
} from '../../lib/watchRules';
import { recordWatch } from '../../lib/watchPerf';

const HOLD_STEP_MS = 2000;
const HOLD_INTERVAL_MS = 250;
const FEEDBACK_MS = 700;
const RESUME_MIN_MS = 5000;

type Phase = 'loading' | 'ready' | 'error';
type Zone = 'left' | 'right';

/**
 * Hallyu TV player. Plays a proxy stream (fetched fresh from `playback`) or a file saved on this device.
 * Real controls drive the real video: play/pause, a timeline that seeks, double-tap and hold-to-seek on
 * the left and right thirds, a quality picker that keeps the position, and retry on failure. Full-screen
 * is shown when the phone is held sideways or when the viewer chooses it. Progress is saved every few
 * seconds, and playback pauses when the app goes to the background.
 */
export default function WatchPlayer() {
  const router = useRouter();
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
  const { width: winW, height: winH } = useWindowDimensions();
  const landscape = Platform.OS !== 'web' && winW > winH;

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
  const isLocal = !!params.local;

  const video = useRef<Video>(null);
  const latest = useRef({ positionMs: 0, durationMs: 0 });
  const lastSaved = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const retries = useRef(0);
  const wasPlaying = useRef(false);
  const trackWidth = useRef(0);
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTap = useRef<{ zone: Zone; at: number } | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);
  /** When the player last made forward progress; the watchdog measures stalls against this. */
  const lastProgressAt = useRef(Date.now());
  const mountedAt = useRef(Date.now());

  const [phase, setPhase] = useState<Phase>('loading');
  const [source, setSource] = useState<{ uri: string } | null>(null);
  const [playingQuality, setPlayingQuality] = useState<string | null>(null);
  const [qualities, setQualities] = useState<string[]>([]);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** Set only for reasons retrying can never fix; the player then shows "unavailable", never "error". */
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [scrubFraction, setScrubFraction] = useState<number | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);
  // Subtitles: MovieBox captions load automatically; OpenSubtitles is searched only when asked.
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [cueLabel, setCueLabel] = useState<string | null>(null);
  const [subsOpen, setSubsOpen] = useState(false);
  const [subsBusy, setSubsBusy] = useState(false);
  const [subsNote, setSubsNote] = useState<string | null>(null);
  const [captionChoices, setCaptionChoices] = useState<MovieboxCaption[]>([]);
  const [osChoices, setOsChoices] = useState<OpenSubtitleResult[] | null>(null);
  const [immersive, setImmersive] = useState(false);
  const [dismissLandscape, setDismissLandscape] = useState(false);
  const [rate, setRate] = useState(1);
  const [locked, setLocked] = useState(false);
  const [volume, setVolume] = useState(1);
  const volumeRef = useRef(1);
  const volumeStart = useRef(1);
  const dimsRef = useRef({ width: winW, height: winH });
  dimsRef.current = { width: winW, height: winH };
  const phaseRef = useRef<Phase>('loading');
  phaseRef.current = phase;
  const fullRef = useRef(false);
  const rateRef = useRef(1);
  const [interaction, setInteraction] = useState(0);

  const fullScreen = immersive || (landscape && !dismissLandscape);
  fullRef.current = fullScreen;

  /* ----- loading ----- */

  const loadRemote = async (quality: string | null, resumeAt: number | null, fresh = false): Promise<boolean> => {
    const seq = ++requestSeq.current;
    setPhase('loading');
    setErrorMessage(null);
    setStalled(false);
    setUnavailableReason(null);
    lastProgressAt.current = Date.now();
    pendingSeek.current = resumeAt;
    const startedAt = Date.now();
    const r = await fetchWatchPlayback(
      ref.subjectId,
      ref.season ?? undefined,
      ref.episode ?? undefined,
      quality,
      fresh,
    );
    recordWatch('play:link', Date.now() - startedAt);
    if (seq !== requestSeq.current) return false;
    if (!r.ok) {
      setUnavailableReason(isUnavailableReason(r.reason) ? r.reason : null);
      setErrorMessage(watchErrorMessage(r.reason, quality));
      setPhase('error');
      return false;
    }
    setSource({ uri: r.value.playbackUrl });
    setPlayingQuality(r.value.quality);
    setQualities(sortQualities([...r.value.qualities, ...(r.value.quality ? [r.value.quality] : [])]));
    return true;
  };

  useEffect(() => {
    if (isLocal) {
      setSource({ uri: String(params.local) });
      setPlayingQuality(params.quality ? String(params.quality) : null);
      setQualities(params.quality ? [String(params.quality)] : []);
      return;
    }
    const requested = params.quality ? String(params.quality) : null;
    void loadRemote(requested, null);
    // One initial load per mounted player. Later loads go through the handlers below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== 'loading' || !source?.uri) return;
    const timer = setTimeout(() => {
      if (phaseRef.current === 'loading') {
        requestSeq.current += 1;
        setErrorMessage('The stream took too long to start. Check your connection and try again.');
        setPhase('error');
      }
    }, 60_000);
    return () => clearTimeout(timer);
  }, [phase, source?.uri]);

  useEffect(() => () => { requestSeq.current += 1; }, []);

  // A buffering player is never allowed to spin forever: no forward progress for BUFFER_STALL_MS turns
  // into the error state, which shows the real reason and a working retry.
  useEffect(() => {
    if (!isBuffering || phase !== 'ready') {
      setStalled(false);
      return;
    }
    const id = setInterval(() => {
      if (stalledForMs(Date.now(), lastProgressAt.current, true) >= BUFFER_STALL_MS) setStalled(true);
    }, 2_000);
    return () => clearInterval(id);
  }, [isBuffering, phase]);

  /* ----- playback status ----- */

  const handleFailure = () => {
    if (isLocal) {
      setErrorMessage('This downloaded file cannot be played. It may be damaged. Remove it and download again.');
      setPhase('error');
      return;
    }
    // One fresh link before showing an error. A broken link is not retried forever.
    if (retries.current < 1) {
      retries.current += 1;
      void loadRemote(playingQuality, latest.current.positionMs > RESUME_MIN_MS ? latest.current.positionMs : null, true);
      return;
    }
    setErrorMessage('Playback stopped. Check your connection, then tap Try again.');
    setPhase('error');
  };

  // MovieBox captions first. A caption is used only when its file parses to real cues.
  useEffect(() => {
    if (isLocal) return;
    let cancelled = false;
    void (async () => {
      const r = await fetchMovieboxCaptions({ subjectId: ref.subjectId, season: ref.season ?? undefined, episode: ref.episode ?? undefined });
      if (cancelled || !r.ok) return;
      setCaptionChoices(r.value);
      const preferred = r.value.find((c) => /^en/i.test(c.language)) ?? r.value[0];
      if (!preferred) {
        setSubsNote('MovieBox has no captions for this title. Use Find subtitles online.');
        return;
      }
      const got = await fetchCaptionCues(preferred.url);
      if (cancelled) return;
      if (got.ok) {
        setCues(got.value.cues);
        setCueLabel(`MovieBox · ${preferred.label}`);
      } else {
        setSubsNote('MovieBox captions could not be loaded. Use Find subtitles online.');
      }
    })();
    return () => {
      cancelled = true;
    };
    // The title and episode identify the captions; `ref` is rebuilt every render.
  }, [ref.subjectId, ref.season, ref.episode]); // eslint-disable-line react-hooks/exhaustive-deps

  const subtitleReasonText = (reason: string): string => {
    switch (reason) {
      case 'signed_out':
        return 'Sign in to load subtitles.';
      case 'not_configured':
        return 'Online subtitles are not set up yet.';
      case 'quota':
        return 'The subtitle service is busy. Try again later.';
      case 'offline':
        return 'No connection. Subtitles need a network connection.';
      case 'timeout':
        return 'The subtitle service took too long. Try again.';
      case 'empty':
        return 'That subtitle file has no readable lines. Pick another.';
      default:
        return 'Subtitles could not be loaded. Try again.';
    }
  };

  const chooseCaption = async (c: MovieboxCaption) => {
    setSubsBusy(true);
    setSubsNote(null);
    const got = await fetchCaptionCues(c.url);
    setSubsBusy(false);
    if (!got.ok) {
      setSubsNote(subtitleReasonText(got.reason));
      return;
    }
    setCues(got.value.cues);
    setCueLabel(`MovieBox · ${c.label}`);
    setSubsOpen(false);
  };

  const findOnline = async () => {
    setSubsBusy(true);
    setSubsNote(null);
    const r = await searchOpenSubtitles({ query: ref.title, season: ref.season ?? undefined, episode: ref.episode ?? undefined, language: 'en' });
    setSubsBusy(false);
    if (!r.ok) {
      setSubsNote(subtitleReasonText(r.reason));
      return;
    }
    setOsChoices(r.value);
    if (r.value.length === 0) setSubsNote('No matching subtitles were found online for this episode.');
  };

  const chooseOnline = async (row: OpenSubtitleResult) => {
    setSubsBusy(true);
    setSubsNote(null);
    const got = await fetchOpenSubtitleCues(row.fileId);
    setSubsBusy(false);
    if (!got.ok) {
      setSubsNote(subtitleReasonText(got.reason));
      return;
    }
    setCues(got.value.cues);
    setCueLabel(`OpenSubtitles · ${row.release || row.language || 'subtitle'}`);
    setSubsOpen(false);
  };

  const subtitleText = cues.length > 0 ? cueTextAt(cues, positionMs) : null;

  const onStatus = (status: AVPlaybackStatus) => {
    if (!status.isLoaded) {
      if (status.error) handleFailure();
      return;
    }
    const pos = status.positionMillis;
    const dur = status.durationMillis ?? 0;
    // Forward progress is what the stall watchdog measures; a rewind also counts as progress.
    if (pos !== latest.current.positionMs) lastProgressAt.current = Date.now();
    if (status.isPlaying && stalled) setStalled(false);
    latest.current = { positionMs: pos, durationMs: dur };
    setPositionMs(pos);
    setDurationMs(dur);
    setIsPlaying(status.isPlaying);
    setIsBuffering(status.isBuffering);
    if (status.isPlaying && phase === 'loading') setPhase('ready');
    // Save on pause and every few seconds while playing. Never on every status tick.
    const justPaused = wasPlaying.current && !status.isPlaying;
    wasPlaying.current = status.isPlaying;
    if (dur > 0 && pos > RESUME_MIN_MS && (justPaused || (status.isPlaying && Date.now() - lastSaved.current >= SAVE_PROGRESS_EVERY_MS))) {
      lastSaved.current = Date.now();
      void saveProgress(ref, pos, dur);
    }
  };

  const applyRate = (value: number) => {
    rateRef.current = value;
    setRate(value);
    void video.current?.setRateAsync(value, true).catch(() => {});
  };

  const onLoad = async () => {
    retries.current = 0;
    lastProgressAt.current = Date.now();
    setStalled(false);
    recordWatch('play:start', Date.now() - mountedAt.current);
    setPhase('ready');
    void video.current?.setRateAsync(rateRef.current, true).catch(() => {});
    const seekTo = pendingSeek.current;
    if (seekTo !== null) {
      pendingSeek.current = null;
      await video.current?.setPositionAsync(seekTo).catch(() => {});
      return;
    }
    if (ref.subjectId === '') return;
    const p = await getProgress(`${ref.subjectId}:${ref.season ?? 0}:${ref.episode ?? 0}`);
    if (p && p.positionMs > RESUME_MIN_MS && p.durationMs > 0 && p.positionMs / p.durationMs < 0.95) {
      await video.current?.setPositionAsync(p.positionMs).catch(() => {});
    }
  };

  /* ----- commands ----- */

  const seekTo = (ms: number) => {
    const target = Math.max(0, Math.min(ms, latest.current.durationMs || ms));
    latest.current = { ...latest.current, positionMs: target };
    setPositionMs(target);
    void video.current?.setPositionAsync(target).catch(() => {});
  };

  const seekBy = (deltaMs: number) => {
    seekTo(seekTarget(latest.current.positionMs, deltaMs, latest.current.durationMs));
  };

  const togglePlay = async () => {
    if (phase !== 'ready') return;
    if (isPlaying) await video.current?.pauseAsync().catch(() => {});
    else await video.current?.playAsync().catch(() => {});
  };

  const showFeedback = (text: string) => {
    setFeedback(text);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), FEEDBACK_MS);
  };

  const touch = () => setInteraction((n) => n + 1);

  const switchQuality = async (q: string) => {
    if (q === playingQuality || switchingTo || isLocal) return;
    const resumeAt = latest.current.positionMs;
    const seq = ++requestSeq.current;
    setSwitchingTo(q);
    setNotice(null);
    setStalled(false);
    lastProgressAt.current = Date.now();
    const r = await fetchWatchPlayback(ref.subjectId, ref.season ?? undefined, ref.episode ?? undefined, q);
    if (seq !== requestSeq.current) return;
    if (!r.ok) {
      setSwitchingTo(null);
      setNotice(`Could not switch to ${q}. Still playing ${playingQuality ?? 'the current quality'}.`);
      return;
    }
    // Show only what the stream actually is. If the server offered something else, say so.
    if (r.value.quality !== q) setNotice(`${q} is not available right now. Playing ${r.value.quality ?? 'another quality'}.`);
    setSource({ uri: r.value.playbackUrl });
    setPlayingQuality(r.value.quality);
    pendingSeek.current = resumeAt > RESUME_MIN_MS ? resumeAt : null;
    setSwitchingTo(null);
    setPhase('loading');
    // Remembered for this title only, so a one-off higher quality never silently upgrades every other title.
    void setTitleQuality(ref.subjectId, ref.season, ref.episode, r.value.quality);
  };

  const retry = () => {
    retries.current = 0;
    setStalled(false);
    setUnavailableReason(null);
    lastProgressAt.current = Date.now();
    if (isLocal) {
      setPhase('loading');
      setErrorMessage(null);
      setSource({ uri: String(params.local) });
      return;
    }
    void loadRemote(playingQuality, latest.current.positionMs > RESUME_MIN_MS ? latest.current.positionMs : null, true);
  };

  /* ----- gestures: double tap and hold on the left and right thirds ----- */

  const onZoneTap = (zone: Zone) => {
    if (locked) return;
    touch();
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && prev.zone === zone && now - prev.at < DOUBLE_TAP_WINDOW_MS) {
      // Second tap on the same side: skip. Cancel the pending single-tap toggle.
      if (tapTimer.current) clearTimeout(tapTimer.current);
      tapTimer.current = null;
      lastTap.current = null;
      const delta = zone === 'left' ? -SKIP_MS : SKIP_MS;
      seekBy(delta);
      showFeedback(zone === 'left' ? `−${SKIP_MS / 1000}s` : `+${SKIP_MS / 1000}s`);
      return;
    }
    lastTap.current = { zone, at: now };
    if (tapTimer.current) clearTimeout(tapTimer.current);
    tapTimer.current = setTimeout(() => {
      lastTap.current = null;
      setControlsVisible((v) => !v);
    }, DOUBLE_TAP_WINDOW_MS);
  };

  const stopHold = () => {
    if (holdTimer.current) clearInterval(holdTimer.current);
    holdTimer.current = null;
    setFeedback(null);
  };

  const startHold = (zone: Zone) => {
    if (locked) return;
    touch();
    stopHold();
    const dir = zone === 'left' ? -1 : 1;
    setFeedback(zone === 'left' ? '◀◀ Seeking' : 'Seeking ▶▶');
    holdTimer.current = setInterval(() => seekBy(dir * HOLD_STEP_MS), HOLD_INTERVAL_MS);
  };

  // Clean up timers and save progress when leaving the screen. Also pause when the app is backgrounded.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') {
        void video.current?.pauseAsync().catch(() => {});
        const last = latest.current;
        if (last.durationMs > 0 && last.positionMs > RESUME_MIN_MS) void saveProgress(ref, last.positionMs, last.durationMs);
      }
    });
    return () => {
      sub.remove();
      stopHold();
      if (tapTimer.current) clearTimeout(tapTimer.current);
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      const last = latest.current;
      if (last.durationMs > 0 && last.positionMs > RESUME_MIN_MS) void saveProgress(ref, last.positionMs, last.durationMs);
    };
    // The ref is stable for one playback session; the player mounts once per route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exitFullScreen = () => {
    setImmersive(false);
    setDismissLandscape(true);
    if (Platform.OS !== 'web') void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  };

  const enterFullScreen = () => {
    setDismissLandscape(false);
    setImmersive(true);
  };

  // Explicit fullscreen is landscape-locked. Exit returns to portrait; after natural rotation, unlock again.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (immersive) void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
    else if (dismissLandscape) void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
    else void ScreenOrientation.unlockAsync().catch(() => {});
  }, [immersive, dismissLandscape]);

  useEffect(() => {
    if (Platform.OS !== 'android' || !fullScreen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setImmersive(false);
      setDismissLandscape(true);
      if (Platform.OS !== 'web') void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
      return true;
    });
    return () => sub.remove();
  }, [fullScreen]);
  useEffect(
    () => () => {
      if (Platform.OS !== 'web') void ScreenOrientation.unlockAsync().catch(() => {});
    },
    [],
  );

  // Hide the status bar in full-screen, and restore it on exit or unmount.
  useEffect(() => {
    StatusBar.setHidden(fullScreen, 'fade');
    return () => StatusBar.setHidden(false, 'fade');
  }, [fullScreen]);

  // Controls hide themselves after a few seconds of playback, and show again on any touch.
  useEffect(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (controlsVisible && isPlaying && scrubFraction === null) {
      hideTimer.current = setTimeout(() => setControlsVisible(false), CONTROLS_AUTO_HIDE_MS);
    }
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [controlsVisible, isPlaying, scrubFraction, interaction]);

  /* ----- timeline dragging ----- */

  const scrubRef = useRef<{ fraction: number } | null>(null);
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const f = fractionAt(e.nativeEvent.locationX, trackWidth.current);
        scrubRef.current = { fraction: f };
        setScrubFraction(f);
        touch();
      },
      onPanResponderMove: (e) => {
        const f = fractionAt(e.nativeEvent.locationX, trackWidth.current);
        scrubRef.current = { fraction: f };
        setScrubFraction(f);
      },
      onPanResponderRelease: () => {
        const f = scrubRef.current?.fraction;
        scrubRef.current = null;
        setScrubFraction(null);
        if (f !== undefined && latest.current.durationMs > 0) seekTo(f * latest.current.durationMs);
      },
      onPanResponderTerminate: () => {
        scrubRef.current = null;
        setScrubFraction(null);
      },
    }),
  ).current;

  /* ----- volume ----- */

  // In full screen, a vertical swipe on the right half of the player changes the volume. Horizontal and short moves are
  // left to the taps, holds, and timeline. In portrait the player sits in a scroll view, so the swipe is not claimed.
  const volumePan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (e, g) =>
        fullRef.current && phaseRef.current !== 'error' && e.nativeEvent.pageX > dimsRef.current.width / 2 && Math.abs(g.dy) > 14 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderGrant: () => {
        volumeStart.current = volumeRef.current;
      },
      onPanResponderMove: (_e, g) => {
        const next = volumeAfterSwipe(volumeStart.current, g.dy, dimsRef.current.height * 0.6);
        volumeRef.current = next;
        setVolume(next);
        showFeedback(`Volume ${Math.round(next * 100)}%`);
      },
      onPanResponderTerminationRequest: () => false,
    }),
  ).current;

  /* ----- render ----- */

  const shownPosition = scrubFraction !== null && durationMs > 0 ? scrubFraction * durationMs : positionMs;
  const progress = durationMs > 0 ? Math.min(1, shownPosition / durationMs) : 0;
  const remaining = durationMs > 0 ? Math.max(0, durationMs - shownPosition) : 0;
  // One resolved state drives every overlay, so loading / playing / paused / error / unavailable can
  // never be shown together and a stall can never present itself as an endless spinner.
  const state = playerState({
    hasSource: !!source,
    loading: phase === 'loading',
    unavailable: unavailableReason !== null,
    failed: stalled || phase === 'error',
    isPlaying,
    isBuffering,
    stalledMs: stalled ? BUFFER_STALL_MS : stalledForMs(Date.now(), lastProgressAt.current, isBuffering),
  });
  const showControls = controlsVisible && state !== 'error' && state !== 'unavailable';

  const stage = (
    <View style={fullScreen ? styles.stageFull : styles.stage}>
      {source && phase !== 'error' ? (
        <Video
          ref={video}
          source={source}
          style={StyleSheet.absoluteFill}
          resizeMode={ResizeMode.CONTAIN}
          useNativeControls={false}
          volume={volume}
          shouldPlay
          progressUpdateIntervalMillis={500}
          onPlaybackStatusUpdate={onStatus}
          onLoad={onLoad}
          onError={handleFailure}
        />
      ) : null}

      {/* Gesture layer. Left and right thirds seek, the centre toggles the controls. Sits under the controls. */}
      {state !== 'error' && state !== 'unavailable' ? (
        <View style={StyleSheet.absoluteFill} {...volumePan.panHandlers}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Skip back 10 seconds, double tap. Hold to seek back."
            style={[styles.zone, { left: 0 }]}
            onPress={() => onZoneTap('left')}
            onLongPress={() => startHold('left')}
            onPressOut={stopHold}
            delayLongPress={350}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Skip forward 10 seconds, double tap. Hold to seek forward."
            style={[styles.zone, { right: 0 }]}
            onPress={() => onZoneTap('right')}
            onLongPress={() => startHold('right')}
            onPressOut={stopHold}
            delayLongPress={350}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showControls ? 'Hide controls' : 'Show controls'}
            style={styles.centreZone}
            onPress={() => {
              touch();
              setControlsVisible((v) => !v);
            }}
          />
        </View>
      ) : null}

      {subtitleText ? (
        <View style={styles.subtitleWrap} pointerEvents="none" accessibilityLiveRegion="polite">
          <Text variant="body" tone="onAccent" align="center" style={styles.subtitleText}>
            {subtitleText}
          </Text>
        </View>
      ) : null}

      {feedback ? (
        <View style={styles.feedback} pointerEvents="none">
          <Text variant="label" tone="onAccent">{feedback}</Text>
        </View>
      ) : null}

      {state === 'loading' || state === 'buffering' ? (
        <View style={styles.center} pointerEvents="none">
          <ActivityIndicator color="#fff" />
          <Text variant="caption" tone="secondary" style={{ marginTop: space.x2 }}>
            {switchingTo ? `Switching to ${switchingTo}…` : state === 'loading' ? 'Loading…' : 'Buffering…'}
          </Text>
        </View>
      ) : null}

      {state === 'error' ? (
        <View style={styles.errorBox}>
          <ErrorState
            kind={stalled ? 'timeout' : 'server'}
            title={stalled ? 'Playback stalled' : 'This stream could not be played'}
            body={stalled ? watchErrorMessage('stalled') : errorMessage ?? undefined}
            onRetry={retry}
          />
          <Pressable onPress={() => router.back()} accessibilityRole="button" style={styles.ghostBtn}>
            <Text variant="body" tone="secondary">Back</Text>
          </Pressable>
        </View>
      ) : null}

      {state === 'unavailable' ? (
        <View style={styles.errorBox} accessibilityRole="alert">
          <Text variant="title" tone="onAccent" align="center">Not available</Text>
          <Text variant="bodySmall" tone="secondary" align="center">{errorMessage ?? watchErrorMessage(unavailableReason)}</Text>
          <Text variant="caption" tone="tertiary" align="center">Trying again will not change this. Pick another title, another episode, or another quality.</Text>
          <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back" style={styles.ghostBtn}>
            <Text variant="body" tone="secondary">Back</Text>
          </Pressable>
        </View>
      ) : null}

      {subsOpen && state !== 'error' && state !== 'unavailable' ? (
        <View style={styles.subsPanel} accessibilityLabel="Subtitle choices">
          <View style={styles.subsHeader}>
            <Text variant="label" tone="onAccent">Subtitles</Text>
            <Pressable onPress={() => setSubsOpen(false)} accessibilityRole="button" accessibilityLabel="Close subtitles" hitSlop={8}>
              <Ionicons name="close" size={22} color="#fff" />
            </Pressable>
          </View>
          <Pressable
            onPress={() => {
              setCues([]);
              setCueLabel(null);
              setSubsOpen(false);
            }}
            accessibilityRole="button"
            style={styles.subsRow}
          >
            <Text variant="bodySmall" tone="onAccent">Off</Text>
          </Pressable>
          {captionChoices.map((c) => (
            <Pressable key={c.url} onPress={() => void chooseCaption(c)} accessibilityRole="button" style={styles.subsRow}>
              <Text variant="bodySmall" tone="onAccent">MovieBox · {c.label}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => void findOnline()} accessibilityRole="button" accessibilityLabel="Find subtitles online" style={styles.subsRow}>
            <Text variant="bodySmall" tone="onAccent">Find subtitles online (OpenSubtitles)</Text>
          </Pressable>
          {osChoices?.map((row) => (
            <Pressable key={row.id} onPress={() => void chooseOnline(row)} accessibilityRole="button" style={styles.subsRow}>
              <Text variant="caption" tone="onAccent" numberOfLines={2}>
                {row.release || row.fileName || 'Subtitle'} · {row.language ?? '?'}
                {row.hearingImpaired ? ' · HI' : ''}
                {row.machineTranslated ? ' · machine translated' : ''}
              </Text>
            </Pressable>
          ))}
          {subsBusy ? <ActivityIndicator color="#fff" /> : null}
          {subsNote ? (
            <Text variant="caption" tone="secondary" accessibilityLiveRegion="polite">
              {subsNote}
            </Text>
          ) : null}
        </View>
      ) : null}

      {locked && state !== 'error' && state !== 'unavailable' ? (
        <View style={styles.overlay} pointerEvents="box-none">
          <Pressable onPress={() => { setLocked(false); touch(); }} accessibilityRole="button" accessibilityLabel="Unlock controls" style={styles.lockBtn} hitSlop={8}>
            <Ionicons name="lock-closed" size={18} color="#fff" />
            <Text variant="caption" tone="onAccent">Unlock</Text>
          </Pressable>
        </View>
      ) : null}
      {showControls && !locked ? (
        <View style={styles.overlay} pointerEvents="box-none">
          <View style={styles.topBar}>
            <Pressable onPress={() => (fullScreen ? exitFullScreen() : router.back())} accessibilityRole="button" accessibilityLabel={fullScreen ? 'Exit full screen' : 'Back'} style={styles.iconBtn} hitSlop={8}>
              <Ionicons name={fullScreen ? 'contract-outline' : 'chevron-back'} size={22} color="#fff" />
            </Pressable>
            <Text variant="label" tone="onAccent" numberOfLines={1} style={{ flex: 1, marginHorizontal: space.x2 }}>
              {ref.title || 'Hallyu TV'}
            </Text>
            <Pressable
              onPress={() => {
                touch();
                setSubsOpen((v) => !v);
              }}
              accessibilityRole="button"
              accessibilityLabel={cues.length > 0 ? `Subtitles on: ${cueLabel ?? ''}. Change subtitles` : 'Subtitles off. Choose subtitles'}
              style={styles.iconBtn}
              hitSlop={8}
            >
              <Ionicons name={cues.length > 0 ? 'text' : 'text-outline'} size={22} color="#fff" />
            </Pressable>
          </View>

          <Pressable onPress={togglePlay} accessibilityRole="button" accessibilityLabel={isPlaying ? 'Pause' : 'Play'} style={styles.playBtn} disabled={phase !== 'ready'}>
            <Ionicons name={isPlaying ? 'pause' : 'play'} size={34} color="#fff" />
          </Pressable>

          <View style={styles.bottom}>
            <View style={styles.timeRow}>
              <Text variant="caption" tone="onAccent">{formatClock(shownPosition)}</Text>
              <Text variant="caption" tone="onAccent">{durationMs > 0 ? `−${formatClock(remaining)}` : '--:--'}</Text>
            </View>
            <View
              style={styles.track}
              onLayout={(e) => {
                trackWidth.current = e.nativeEvent.layout.width;
              }}
              {...pan.panHandlers}
              accessibilityRole="adjustable"
              accessibilityLabel="Seek timeline"
            >
              <View style={[styles.trackFill, { width: `${Math.round(progress * 100)}%` }]} />
              <View style={[styles.thumb, { left: `${Math.round(progress * 100)}%` }]} />
            </View>
            <View style={styles.actionRow}>
              {!isLocal && qualities.length > 0 ? (
                <View style={styles.qualityRow}>
                  {qualities.map((q) => {
                    const selected = q === playingQuality;
                    return (
                      <Pressable key={q} onPress={() => void switchQuality(q)} accessibilityRole="button" accessibilityState={{ selected }} style={[styles.qPill, selected && styles.qPillOn]}>
                        <Text variant="caption" tone={selected ? 'onAccent' : 'secondary'}>{q}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : (
                <Text variant="caption" tone="onAccent">{isLocal ? 'Downloaded' : ''}</Text>
              )}
              <Pressable onPress={() => applyRate(PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(rate) + 1) % PLAYBACK_RATES.length] ?? 1)} accessibilityRole="button" accessibilityLabel={`Playback speed ${rate}x`} style={styles.speedBtn} hitSlop={8}>
                <Text variant="caption" tone="onAccent">{`${rate}×`}</Text>
              </Pressable>
              <Pressable onPress={() => setLocked(true)} accessibilityRole="button" accessibilityLabel="Lock controls" style={styles.iconBtn} hitSlop={8}>
                <Ionicons name="lock-open-outline" size={20} color="#fff" />
              </Pressable>
              <Pressable onPress={() => (fullScreen ? exitFullScreen() : enterFullScreen())} accessibilityRole="button" accessibilityLabel={fullScreen ? 'Exit full screen' : 'Full screen'} style={styles.iconBtn} hitSlop={8}>
                <Ionicons name={fullScreen ? 'contract-outline' : 'expand-outline'} size={20} color="#fff" />
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );

  if (fullScreen) {
    return <View style={styles.fullRoot}>{stage}</View>;
  }

  return (
    <Screen header={<TopBar title={ref.title || 'Hallyu TV'} mode="stack" transparent />}>
      <ScrollScreen contentContainerStyle={{ flexGrow: 1 }} padded={false}>
        {stage}
        <View style={{ padding: space.x4, gap: space.x2 }}>
          {notice ? <Text variant="caption" tone="warm">{notice}</Text> : null}
          <Text variant="caption" tone="tertiary">
            {isLocal ? 'Playing from this device. No network needed.' : playingQuality ? `Streaming ${playingQuality}. Playback needs a connection.` : 'Streaming. Playback needs a connection.'}
          </Text>
          {!isLocal ? <Text variant="caption" tone="tertiary">Tip: turn the phone sideways, or tap the expand button, for full screen.</Text> : null}
        </View>
      </ScrollScreen>
    </Screen>
  );
}

/** Playback speeds offered to the viewer. Applied to the real player with setRateAsync. */
const PLAYBACK_RATES = [1, 1.25, 1.5, 2, 0.75];

const styles = StyleSheet.create({
  speedBtn: { minWidth: 40, height: 36, paddingHorizontal: 8, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.14)' },
  lockBtn: { position: 'absolute', right: 16, top: '45%', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.6)' },
  fullRoot: { flex: 1, backgroundColor: '#000' },
  stage: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000', overflow: 'hidden' },
  stageFull: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  zone: { position: 'absolute', top: 0, bottom: 0, width: '35%' },
  centreZone: { position: 'absolute', top: 0, bottom: 0, left: '35%', right: '35%' },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  feedback: { position: 'absolute', top: '42%', alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: space.x3, paddingVertical: space.x1, borderRadius: radius.md },
  subtitleWrap: { position: 'absolute', left: space.x3, right: space.x3, bottom: 110, alignItems: 'center' },
  subtitleText: { backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: space.x2, paddingVertical: space.x1, borderRadius: radius.sm },
  subsPanel: { position: 'absolute', right: space.x3, top: 56, width: 300, maxHeight: '75%', backgroundColor: 'rgba(12,12,16,0.95)', borderRadius: radius.md, padding: space.x3, gap: space.x2 },
  subsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  subsRow: { paddingVertical: space.x2, paddingHorizontal: space.x2, borderRadius: radius.sm, backgroundColor: 'rgba(255,255,255,0.06)' },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between', backgroundColor: 'rgba(0,0,0,0.35)' },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.x3, paddingTop: space.x3 },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  playBtn: { alignSelf: 'center', width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(225,29,72,0.85)' },
  bottom: { paddingHorizontal: space.x3, paddingBottom: space.x3, gap: space.x2 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between' },
  track: { height: 28, justifyContent: 'center' },
  trackFill: { position: 'absolute', left: 0, height: 3, backgroundColor: colors.accent, borderRadius: 2 },
  thumb: { position: 'absolute', width: 12, height: 12, borderRadius: 6, marginLeft: -6, backgroundColor: colors.accent },
  actionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  qualityRow: { flexDirection: 'row', gap: space.x2, flexWrap: 'wrap', flex: 1 },
  qPill: { paddingHorizontal: space.x2, paddingVertical: 4, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.4)' },
  qPillOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  errorBox: { ...StyleSheet.absoluteFillObject, padding: space.x4, justifyContent: 'center', gap: space.x3, backgroundColor: '#000' },
  ghostBtn: { alignSelf: 'center', paddingVertical: space.x2 },
});
