import NetInfo from '@react-native-community/netinfo';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { type BackendHealth, getBackendHealth, subscribeBackendHealth } from './api/client';
import { CatalogHealth, getCatalogHealth, subscribeCatalogHealth } from './catalog';
import { AccessibilityInfo, Platform, useWindowDimensions } from 'react-native';
import { marginFor, motion, windowClass, WindowClass } from '../constants/theme';
import { useAuth } from './auth';
import * as sel from './selectors';
import { AppState, clearPersisted, dispatch, reset, useHallyu, useSlice } from './store';

/**
 * Tracked store access. Getters called during render register the exact values they read, and the
 * component re-renders only when one of those values changes. Reading `state` subscribes to everything
 * (screens that rank feeds need that); list items should stick to getters.
 */
function useTracked() {
  const deps = useRef<{ sel: (s: AppState) => unknown; last: unknown }[]>([]);
  const rendering = useRef(true);
  const [, force] = useReducer((x: number) => x + 1, 0);
  rendering.current = true;
  deps.current = [];
  useEffect(() => {
    rendering.current = false;
  });
  useEffect(() => {
    const check = (s: AppState) => {
      for (const d of deps.current) {
        if (!Object.is(d.sel(s), d.last)) {
          force();
          return;
        }
      }
    };
    const unsub = useHallyu.subscribe(check);
    check(useHallyu.getState());
    return unsub;
  }, []);
  const snapshot = useHallyu.getState();
  return function track<T>(sel: (s: AppState) => T): T {
    if (!rendering.current) return sel(useHallyu.getState());
    const v = sel(snapshot);
    deps.current.push({ sel, last: v });
    return v;
  };
}

/**
 * Store + selectors bound to the current state (tracked: see `useTracked`).
 *
 * The returned getters MUST be referentially stable for the lifetime of the component. Screens
 * legitimately put them in `useMemo`/`useCallback` dependency arrays (`getDrama` is how Home maps a
 * post to its world, how Watchlist resolves a card, how the create pickers label a title). A fresh
 * closure per render invalidates every one of those memos on every render; when the memo's result
 * feeds a `useEffect` that writes state, that becomes an unbounded render loop. So `track` is read
 * through a ref (it changes every render by design — it closes over this render's snapshot) and
 * every getter is a `useCallback` that never changes.
 */
export function useApp() {
  const track = useTracked();
  const trackRef = useRef(track);
  trackRef.current = track;
  // Stable indirection: reads the *current* render's tracker, but never changes identity.
  const t = useCallback(<V,>(selector: (s: AppState) => V): V => trackRef.current(selector), []);

  const getUser = useCallback((id: string) => t((s) => sel.getUser(s, id)), [t]);
  const getUserByHandle = useCallback((h: string) => t((s) => sel.getUserByHandle(s, h)), [t]);
  const getDrama = useCallback((id?: string) => t((s) => sel.getDrama(s, id)), [t]);
  const getActor = useCallback((id?: string) => t((s) => sel.getActor(s, id)), [t]);
  const getPost = useCallback((id?: string) => t((s) => sel.getPost(s, id)), [t]);
  const getCollection = useCallback((id?: string) => t((s) => sel.getCollection(s, id)), [t]);
  const isPostVeiled = useCallback((p: Parameters<typeof sel.isPostVeiled>[1]) => t((s) => sel.isPostVeiled(s, p)), [t]);
  const isCommentVeiled = useCallback((c: Parameters<typeof sel.isCommentVeiled>[1], p?: Parameters<typeof sel.isCommentVeiled>[2]) => t((s) => sel.isCommentVeiled(s, c, p)), [t]);
  const isFollowing = useCallback((kind: keyof AppState['follows'], id: string) => t((s) => s.follows[kind].includes(id)), [t]);
  const watch = useCallback((dramaId: string) => t((s) => s.watchlist[dramaId]), [t]);
  const myReaction = useCallback((id: string) => t((s) => s.reactions[id]), [t]);
  const isSaved = useCallback((id: string) => t((s) => s.saves.includes(id)), [t]);

  return useMemo(
    () => ({
      get state() {
        return t((s) => s);
      },
      dispatch,
      reset,
      clearPersisted,
      get me() {
        return t((s) => s.profile);
      },
      getUser,
      getUserByHandle,
      getDrama,
      getActor,
      getPost,
      getCollection,
      isPostVeiled,
      isCommentVeiled,
      isFollowing,
      watch,
      myReaction,
      isSaved,
      get unread() {
        return t(sel.unreadCount);
      },
    }),
    [t, getUser, getUserByHandle, getDrama, getActor, getPost, getCollection, isPostVeiled, isCommentVeiled, isFollowing, watch, myReaction, isSaved],
  );
}

/** Requires a member; guests get sent to the auth gate with a reason + return route. */
export function useRequireMember() {
  const auth = useAuth();
  const router = useRouter();
  return useCallback(
    (reason: string, run: () => void) => {
      // Session restoration is not a guest decision. Do not redirect a signed-in
      // member to signup while their persisted session is still hydrating.
      if (auth.status === 'loading') return;
      if (auth.status === 'signedIn') run();
      else router.push({ pathname: '/(auth)/gate', params: { reason } });
    },
    [auth.status, router],
  );
}

/** Device connectivity (NetInfo; on web the browser's own view). */
export function useNetwork() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sub = NetInfo.addEventListener((st) => {
      // On web NetInfo probes reachability with a cross-origin HEAD that browsers often block (CORS),
      // which reports "unreachable" on a perfectly good connection — trust navigator.onLine there.
      const reachable = Platform.OS === 'web' ? true : st.isInternetReachable !== false;
      setOnline(st.isConnected !== false && reachable);
    });
    return () => sub();
  }, []);
  return online;
}

export function useLayout(): { width: number; height: number; wc: WindowClass; margin: number; isLandscape: boolean; columns: number } {
  const { width, height } = useWindowDimensions();
  const wc = windowClass(width);
  return { width, height, wc, margin: marginFor(width), isLandscape: width > height, columns: wc === 'compact' ? 3 : wc === 'medium' ? 4 : 6 };
}

export function useReduceMotion(pref?: boolean) {
  const [sys, setSys] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then(setSys)
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setSys);
    return () => sub.remove();
  }, []);
  return sys || !!pref;
}

export const haptic = {
  light: () => Platform.OS !== 'web' && Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}),
  medium: () => Platform.OS !== 'web' && Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}),
  select: () => Platform.OS !== 'web' && Haptics.selectionAsync().catch(() => {}),
  success: () => Platform.OS !== 'web' && Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}),
  error: () => Platform.OS !== 'web' && Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {}),
};

export interface Loadable<T> {
  data: T | null;
  loading: boolean;
  /** true only after the skeleton delay elapsed while still loading */
  showSkeleton: boolean;
  error: Error | null;
  reload: () => void;
}

/**
 * Async loader with the 150ms skeleton rule and abort on unmount/deps change.
 *
 * Two guarantees callers depend on:
 *  - the returned object is referentially stable, so `useLoad(...)` results can sit in a
 *    dependency array without re-rendering their consumer on every poll;
 *  - `enabled: false` clears `data`/`error`, so a screen can never be left showing (or waiting on)
 *    the result of a load it has switched off — the classic "stuck spinner" trap.
 */
export function useLoad<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[], enabled = true): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!enabled) {
      ctrl.current?.abort();
      ctrl.current = null;
      setLoading(false);
      setShowSkeleton(false);
      setData(null);
      setError(null);
      return;
    }
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    setError(null);
    const t = setTimeout(() => !c.signal.aborted && setShowSkeleton(true), motion.skeletonDelay);
    fn(c.signal)
      .then((d) => {
        if (c.signal.aborted) return;
        setData(d);
      })
      .catch((e: unknown) => {
        if (c.signal.aborted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        clearTimeout(t);
        if (c.signal.aborted) return;
        setLoading(false);
        setShowSkeleton(false);
      });
    return () => {
      clearTimeout(t);
      c.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled]);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  return useMemo(() => ({ data, loading, showSkeleton, error, reload }), [data, loading, showSkeleton, error, reload]);
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Coarse connection type for data-sensitive choices (autoplay on Wi-Fi only). Web has no signal → 'unknown'. */
export function useConnectionType(): 'wifi' | 'cellular' | 'unknown' {
  const [kind, setKind] = useState<'wifi' | 'cellular' | 'unknown'>('unknown');
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = NetInfo.addEventListener((st) => setKind(st.type === 'wifi' || st.type === 'ethernet' ? 'wifi' : st.type === 'cellular' ? 'cellular' : 'unknown'));
    return () => sub();
  }, []);
  return kind;
}

/**
 * Should videos start on their own in feeds? Settings → Content: Always / Wi-Fi only (default) /
 * Never; reduced motion (system or app) always wins and turns autoplay off.
 */
export function useAutoplayAllowed(): boolean {
  const pref = useSlice((s) => s.prefs.autoplay);
  const reducePref = useSlice((s) => s.prefs.reduceMotion);
  const reduce = useReduceMotion(reducePref);
  const conn = useConnectionType();
  if (reduce || pref === 'never') return false;
  if (pref === 'always') return true;
  return conn !== 'cellular'; // 'wifi' — unknown (web/desktop) counts as unmetered
}

/** Live catalog status (last TMDB request): lets screens say exactly why artwork isn't loading. */
export function useCatalogHealth(): CatalogHealth {
  return useSyncExternalStore(subscribeCatalogHealth, getCatalogHealth, getCatalogHealth);
}

/** Live backend connection state (the five gate states) — mirrors useCatalogHealth's pattern. */
export function useBackendHealth(): BackendHealth {
  return useSyncExternalStore(subscribeBackendHealth, getBackendHealth, getBackendHealth);
}
