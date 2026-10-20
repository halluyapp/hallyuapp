// Must be the first import in the app. lib/textEncoding installs the TextEncoder/TextDecoder
// globals Hermes lacks — the previous watermark chain (fast-png → iobuffer, now removed) constructed
// them at module scope and killed cold boot with "Cannot read property 'ErrorBoundary' of
// undefined". lib/crash then installs the global error trap before any other module can evaluate,
// so a release-mode JS exception can never silently kill the process. See lib/crash.ts.
import '../lib/textEncoding';
import '../lib/crash';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFonts } from 'expo-font';
import { Stack, useRootNavigationState, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef, useState } from 'react';
import { AppState as RNAppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '../components/ui/ErrorBoundary';
import { MilestoneWatcher } from '../components/moments/MilestoneWatcher';
import { ToastProvider, toast } from '../components/ui/Toast';
import { colors } from '../constants/theme';
import { reportError } from '../lib/analytics';
import { installBackendAnalyticsSink } from '../lib/api/analyticsSink';
import { installPushTokenRotationListener, registerDevicePushToken } from '../lib/api/pushToken';
import { AuthProvider, useAuth } from '../lib/auth';
import { markBoot } from '../lib/boot';
import { ensureAndroidNotificationChannels, installNotificationHandler, reminderUrl, remindersSupported, syncEpisodeReminders } from '../lib/reminders';
import { setDownloadScope } from '../lib/media';
import { freshMemberState, getState, GUEST_ID, guestState, StoreProvider, useHallyu, useSlice, useStore } from '../lib/store';
import {
  adoptBackendState,
  adoptLocal,
  adoptPublicState,
  getSyncFailures,
  subscribeBackendRealtime,
  subscribeSyncFailures,
  type SyncFailure,
} from '../lib/sync';

SplashScreen.preventAutoHideAsync().catch(() => {});

export const unstable_settings = { initialRouteName: 'index' };

/**
 * Hard ceiling on the font gate. Fonts normally resolve in well under a second from the APK's
 * bundled assets, but a wedged font load must never hold the whole tree hostage behind an empty
 * View (that is the release-only "splash forever" symptom: Index — the only splash-hider — never
 * mounts). After this timeout we proceed on system fonts and drop the native splash ourselves.
 */
const FONT_GATE_MS = 1200;

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    'Pretendard-Regular': require('../assets/fonts/Pretendard-Regular.otf'),
    'Pretendard-Medium': require('../assets/fonts/Pretendard-Medium.otf'),
    'Pretendard-SemiBold': require('../assets/fonts/Pretendard-SemiBold.otf'),
    'Pretendard-Bold': require('../assets/fonts/Pretendard-Bold.otf'),
    'Pretendard-ExtraBold': require('../assets/fonts/Pretendard-ExtraBold.otf'),
  });

  const [gateTimedOut, setGateTimedOut] = useState(false);
  const fontsSettled = fontsLoaded || !!fontError;

  useEffect(() => {
    const t = setTimeout(() => setGateTimedOut(true), FONT_GATE_MS);
    return () => clearTimeout(t);
  }, []);

  // markBoot for the font phase is fired from the splash effect below.

  // Backend analytics: forwards track() to the record_event RPC once a backend is configured;
  // a no-op in device-local builds (the in-memory buffer behaves exactly as before).
  useEffect(() => {
    installBackendAnalyticsSink();
  }, []);

  // Hide the native splash as soon as fonts settle OR the gate times out — whichever comes first.
  // Index keeps its own hideAsync call as a safety net, but we no longer depend on Index mounting.
  useEffect(() => {
    if (fontsSettled || gateTimedOut) {
      markBoot(gateTimedOut && !fontsSettled ? 'layout:font-gate-timeout' : 'layout:fonts-settled');
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsSettled, gateTimedOut]);

  // CRITICAL: the navigator (Stack) must render on the FIRST render — never swap it out for a
  // placeholder View while fonts load. expo-router hard-requires the root layout to mount its
  // navigator immediately; returning a View first made every early router.replace/push (splash
  // redirect, recovery deep link, notification tap) throw "Attempted to navigate before mounting
  // the Root Layout component" — a guaranteed cold-boot crash in release builds. The font gate is
  // now only a splash-hiding policy: Index (the branded splash screen) renders behind the native
  // splash and takes over visually, so nothing regresses while fonts finish loading.
  return (
    <SafeAreaProvider>
      <StoreProvider>
        <AuthProvider>
          <ToastProvider>
            {/*
              Crash isolation. The root boundary sits high enough to protect the whole application
              tree (the Stack and every screen). The non-visual startup components each get their own
              `silent` boundary, so an exception in AccountSync / ReminderSync / MilestoneWatcher is
              logged and swallowed instead of taking the app down. Startup components also catch
              their own async failures (see reportError).
            */}
            <ErrorBoundary scope="Hallyu">
              <StatusBar style="light" backgroundColor={colors.canvas} />
              <ErrorBoundary scope="AccountSync" silent>
                <AccountSync />
                <SyncFailureToasts />
              </ErrorBoundary>
              <ErrorBoundary scope="ReminderSync" silent>
                <ReminderSync />
              </ErrorBoundary>
              <ErrorBoundary scope="MilestoneWatcher" silent>
                <MilestoneWatcher />
              </ErrorBoundary>
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: colors.canvas },
                  animation: 'slide_from_right',
                  animationDuration: 260,
                }}
              >
                <Stack.Screen name="index" options={{ animation: 'fade' }} />
                <Stack.Screen name="(auth)" options={{ animation: 'fade' }} />
                <Stack.Screen name="(onboarding)" options={{ animation: 'fade' }} />
                <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
                <Stack.Screen name="messages/index" />
                <Stack.Screen name="messages/[handle]" />
                <Stack.Screen
                  name="create/[type]"
                  options={{
                    presentation: 'modal',
                    animation: 'slide_from_bottom',
                  }}
                />
                <Stack.Screen
                  name="shorts"
                  options={{
                    presentation: 'fullScreenModal',
                    animation: 'fade',
                  }}
                />
                <Stack.Screen
                  name="media"
                  options={{
                    presentation: 'transparentModal',
                    animation: 'fade',
                  }}
                />
                <Stack.Screen
                  name="report"
                  options={{
                    presentation: 'modal',
                    animation: 'slide_from_bottom',
                  }}
                />
                <Stack.Screen
                  name="collection/new"
                  options={{
                    presentation: 'modal',
                    animation: 'slide_from_bottom',
                  }}
                />
                <Stack.Screen
                  name="edit-profile"
                  options={{
                    presentation: 'modal',
                    animation: 'slide_from_bottom',
                  }}
                />
              </Stack>
            </ErrorBoundary>
          </ToastProvider>
        </AuthProvider>
      </StoreProvider>
    </SafeAreaProvider>
  );
}

/**
 * Keeps the local store in step with the signed-in account:
 *  - a real account starts from a fresh member state — a new account is genuinely empty
 *  - guests/signed-out visitors get the empty guest state; device-only prefs are carried over
 */
function AccountSync() {
  const auth = useAuth();
  const { state, reset, dispatch } = useStore();
  // `applied` = the account whose sync has COMPLETED (not merely started). `inFlight` = the account
  // currently syncing (prevents re-entrancy while the first sync is still running). `gen` is bumped on
  // every identity change (sign-in, sign-out, account switch) so any in-flight continuation from a
  // previous account can detect it is stale and bail before touching the store.
  const applied = useRef<string | null>(null);
  const inFlight = useRef<string | null>(null);
  const gen = useRef(0);

  // Save per-account state snapshot so signing out and back in (or reloading) never loses
  // onboarding completion, watchlist progress, follows, saves, posts, or profile edits.
  useEffect(() => {
    if (!state.hydrated || !state.profile.id || state.profile.id === GUEST_ID) return;
    const id = state.profile.id;
    const t = setTimeout(() => {
      AsyncStorage.setItem(`hallyu.account.v4.${id}`, JSON.stringify(state)).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [state]);

  // Guests and signed-out visitors browse the public world with no personal layer. Device-only
  // prefs (reduceMotion / trueBlack) are the viewer's, not the account's — carry them over.
  useEffect(() => {
    if (!state.hydrated) return;

    // Any non-signed-in state invalidates pending account work: a late response from the previous
    // account must never be applied after a sign-out (or while the app is at the guest gate).
    if (auth.status !== 'signedIn' || !auth.user) {
      gen.current++;
      inFlight.current = null;
      applied.current = null;
      if ((auth.status === 'guest' || auth.status === 'signedOut') && state.profile.id !== GUEST_ID) {
        const prevId = state.profile.id;
        if (prevId) {
          AsyncStorage.setItem(`hallyu.account.v4.${prevId}`, JSON.stringify(getState())).catch(() => {});
        }
        const device = { reduceMotion: state.prefs.reduceMotion, trueBlack: state.prefs.trueBlack };
        setDownloadScope(null);
        reset(guestState());
        dispatch({ type: 'prefs', patch: device });
      }
      if (auth.status === 'guest' || auth.status === 'signedOut') {
        void adoptPublicState({
          getState,
          apply: (patch) => adoptLocal({ type: 'hydrate', state: patch }),
          addPosts: (posts) => {
            for (const post of posts) adoptLocal({ type: 'addPost', post });
          },
        });
      }
      return;
    }

    const u = auth.user;
    // Already fully synced for this account and the store holds it.
    if (applied.current === u.id && state.profile.id === u.id) return;
    // A sync for this account is already running — don't start a second one.
    if (inFlight.current === u.id) return;

    inFlight.current = u.id;
    const myGen = ++gen.current;
    // A continuation is stale if a newer identity change happened, or the signed-in account is no
    // longer this one. Checked before every store write below.
    const stale = () => myGen !== gen.current || auth.user?.id !== u.id || auth.status !== 'signedIn';
    setDownloadScope(u.id);
    const device = { reduceMotion: state.prefs.reduceMotion, trueBlack: state.prefs.trueBlack };
    const key = `hallyu.account.${u.id}`;
    const snapKey = `hallyu.account.v4.${u.id}`;
    const alreadyHoldingAccount = state.profile.id === u.id;

    void (async () => {
      try {
        const [seen, rawSnap] = await Promise.all([AsyncStorage.getItem(key), alreadyHoldingAccount ? Promise.resolve(null) : AsyncStorage.getItem(snapKey)]);
        if (stale()) return;
        if (!seen) AsyncStorage.setItem(key, '1').catch((e) => reportError('AccountSync.markSeen', e));
        if (!alreadyHoldingAccount) {
          let restored = false;
          if (rawSnap) {
            try {
              const parsed = JSON.parse(rawSnap);
              if (parsed && parsed.profile?.id === u.id) {
                reset({ ...parsed, hydrated: true });
                restored = true;
              }
            } catch {
              /* ignore corrupt snapshot */
            }
          }
          if (!restored) {
            reset(
              freshMemberState({
                id: u.id,
                handle: u.handle,
                displayName: u.displayName,
                avatarUrl: u.avatarUrl,
                favoriteGenres: [],
                favoriteDramaIds: [],
                followers: 0,
                following: 0,
                joinedAt: new Date().toISOString(),
              }),
            );
          }
          dispatch({ type: 'prefs', patch: device });
        }
        if (stale()) return;
        applied.current = u.id; // mark COMPLETE once the local snapshot is in
        // Server-side push registration so episode alerts can reach this device (local reminders
        // stay in addition — §6.4 of the connection contract). Silent no-op on any failure.
        void registerDevicePushToken();
        // Adopt the member's real backend state (profile, prefs, follows, saves, watchlist, the
        // latest feed page, the notification inbox) into the cache. No-op without a session.
        void adoptBackendState({
          getState,
          apply: (patch) => {
            if (!stale()) adoptLocal({ type: 'hydrate', state: patch });
          },
          addPosts: (posts) => {
            if (stale()) return;
            for (const post of posts) adoptLocal({ type: 'addPost', post });
          },
          isStale: stale,
        });
      } catch (e) {
        // Expected async failures: log diagnostics, keep the app usable.
        reportError('AccountSync.sync', e, { account: u.id });
      } finally {
        if (myGen === gen.current) inFlight.current = null;
      }
    })();
  }, [auth.status, auth.user, state.hydrated, state.profile.id, reset, state.prefs.reduceMotion, state.prefs.trueBlack, dispatch]);

  useEffect(() => {
    if (!state.hydrated) return;
    return subscribeBackendRealtime(
      {
        getState,
        apply: (patch) => adoptLocal({ type: 'hydrate', state: patch }),
        addPosts: (posts) => {
          for (const post of posts) adoptLocal({ type: 'addPost', post });
        },
      },
      auth.status === 'signedIn' ? auth.user?.id : null,
    );
  }, [state.hydrated, auth.status, auth.user?.id]);

  useEffect(() => {
    if (auth.status !== 'signedIn' || !auth.user) return;
    const detachRotation = installPushTokenRotationListener();
    const fg = RNAppState.addEventListener('change', (st) => {
      if (st === 'active') void registerDevicePushToken();
    });
    return () => {
      detachRotation();
      fg.remove();
    };
  }, [auth.status, auth.user]);

  return null;
}

/**
 * Turns a rejected backend write into something the member can see.
 *
 * lib/sync.ts rolls the optimistic cache back when the server refuses a mutation; without this the
 * rollback would be invisible and the app would look like it had simply ignored the tap. Every
 * failure therefore raises one toast that names what did not save and says the change was undone,
 * so a "successful" UI can never outlive a failed backend write.
 */
function SyncFailureToasts() {
  const seen = useRef(new Set<SyncFailure>());
  useEffect(() => {
    const flush = () => {
      for (const failure of getSyncFailures()) {
        if (seen.current.has(failure)) continue;
        seen.current.add(failure);
        toast.show({ message: `${failure.message}. It was not saved and has been undone.`, tone: 'danger', icon: 'alert-circle' });
      }
    };
    // A toast raised before the provider mounted would be dropped, so replay on mount too.
    flush();
    return subscribeSyncFailures(flush);
  }, []);
  return null;
}

/**
 * Keeps the OS notification queue in step with follows + per-drama alerts, and opens the episode
 * room when a reminder is tapped (warm or cold start).
 */
function ReminderSync() {
  const hydrated = useSlice((s) => s.hydrated);
  const router = useRouter();
  const navReady = useRootNavigationState()?.key != null;
  const navReadyRef = useRef(navReady);
  const pendingUrlRef = useRef<string | undefined>(undefined);
  const handledResponseIds = useRef(new Set<string>());
  navReadyRef.current = navReady;

  useEffect(() => {
    if (navReady && pendingUrlRef.current) {
      const target = pendingUrlRef.current;
      pendingUrlRef.current = undefined;
      setTimeout(() => router.push(target as never), 250);
    }
  }, [navReady, router]);

  useEffect(() => {
    if (!hydrated || !remindersSupported) return;
    installNotificationHandler();
    void ensureAndroidNotificationChannels();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay = 1500) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void syncEpisodeReminders(getState()).catch((e) => reportError('ReminderSync.schedule', e));
      }, delay);
    };
    schedule(2500);
    const unsub = useHallyu.subscribe((s, prev) => {
      if (s.follows.dramas !== prev.follows.dramas || s.dramaNotify !== prev.dramaNotify || s.prefs.notifications !== prev.prefs.notifications || s.importedDramas !== prev.importedDramas) schedule();
    });
    const fg = RNAppState.addEventListener('change', (st) => st === 'active' && schedule(800));
    const openResponse = (r: Notifications.NotificationResponse | null | undefined) => {
      if (!r) return;
      const responseId = r.notification.request.identifier;
      if (responseId && handledResponseIds.current.has(responseId)) return;
      const url = reminderUrl(r);
      if (!url) return;
      if (responseId) handledResponseIds.current.add(responseId);
      if (!navReadyRef.current) {
        pendingUrlRef.current = url;
        return;
      }
      setTimeout(() => router.push(url as never), 300);
    };
    const tapped = Notifications.addNotificationResponseReceivedListener(openResponse);
    Notifications.getLastNotificationResponseAsync()
      .then(openResponse)
      .catch((e) => reportError('ReminderSync.lastResponse', e));
    return () => {
      clearTimeout(timer);
      unsub();
      fg.remove();
      tapped.remove();
    };
  }, [hydrated, router]);
  return null;
}

