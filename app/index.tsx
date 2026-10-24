import { usePathname, useRouter, useRootNavigationState } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '../components/ui/Text';
import { colors, motion } from '../constants/theme';
import { lastCrash } from '../lib/crash';
import { bootTrail, markBoot } from '../lib/boot';
import { useAuth } from '../lib/auth';
import { isBackendConfigured, probeBackend, type ConnectionStatus } from '../lib/api/client';
import { useNetwork } from '../lib/hooks';
import { GUEST_ID, useStore } from '../lib/store';

/**
 * Splash → route gate.
 * Splash is the mark on canvas, no text, ≤ 1.2s when cached. It ends when auth + store + the
 * backend connection gate are ready. The gate is the honest one (connection contract §7): when the
 * build has a backend, cold start proves the Rork-hosted path with a real RPC round trip
 * (get_bootstrap for a member, the anonymous probe otherwise) and says the result on screen —
 * it never claims "connected" while serving device data.
 *
 * The important half is what happens when that probe FAILS. A configured build does not fall
 * through into device-local behaviour: "unavailable" and "misconfigured" used to be printed as
 * "continuing offline / in local mode" and then routed into the app anyway, so a misconfigured
 * release looked identical to a working one and silently showed local data. Now a configured build
 * only routes once a real RPC has answered. Anything else stops here, names what failed, and
 * offers Retry — the connection is a precondition, not a suggestion. Only a build with no backend
 * at all (local development) takes the local-mode path, because there is nothing to be honest
 * about there.
 *
 * If readiness never arrives, the failsafe guarantees a way forward (never a dead splash): after
 * 6s the tap switches from "continue" to "diagnostics" — the boot trail and the last crash are
 * shown on screen, so a stalled release build reports exactly where it stopped.
 */
const AUTO_BAILOUT_MS = 6000;
/** The gate probe must settle inside the bailout window so it can never fight the failsafe. */
const GATE_PROBE_MS = 5000;

/** The one honest line the splash shows about the backend connection. */
function gateLine(conn: ConnectionStatus | null): string {
  if (!isBackendConfigured()) return 'Local mode — no backend configured';
  switch (conn) {
    case null:
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return '';
    case 'offline':
      return 'You’re offline — Hallyu needs the backend to load your account';
    case 'unavailable':
      return 'Hallyu’s backend could not be reached';
    case 'misconfigured':
      return 'Hallyu’s backend is not configured correctly';
  }
}

/** The long form shown on the blocked screen, so the failure is actionable rather than decorative. */
function gateDetail(conn: ConnectionStatus | null): string {
  switch (conn) {
    case 'offline':
      return 'This device has no network connection. Hallyu needs the backend to load your account, so it will not open with local data instead. Turn on a network and retry.';
    case 'unavailable':
      return 'The backend did not answer the connection check. This is usually a network or server problem. Nothing has been changed and no local data will be shown — retry in a moment.';
    case 'misconfigured':
      return 'The backend rejected the connection: the URL or key is missing or wrong, the database schema is not served, or access was denied. This is a build configuration problem, not something to work around.';
    default:
      return '';
  }
}

export default function Index() {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { state } = useStore();
  // expo-router requires the root navigator to be registered before ANY router.replace/push —
  // navigating earlier throws "Attempted to navigate before mounting the Root Layout component".
  const navReady = useRootNavigationState()?.key != null;
  const online = useNetwork();
  const configured = isBackendConfigured();
  const [syncTimedOut, setSyncTimedOut] = useState(false);

  useEffect(() => {
    setSyncTimedOut(false);
    if (auth.status !== 'signedIn' || !configured) return;
    if (state.backendSyncedUserId === auth.user?.id) return;
    const t = setTimeout(() => setSyncTimedOut(true), 3500);
    return () => clearTimeout(t);
  }, [auth.status, auth.user?.id, configured, state.backendSyncedUserId]);

  const accountAligned =
    auth.status === 'signedIn'
      ? state.profile.id === auth.user?.id && (!configured || state.backendSyncedUserId === auth.user?.id || syncTimedOut)
      : auth.status === 'guest'
        ? state.profile.id === GUEST_ID
        : true;
  const coreReady = auth.status !== 'loading' && state.hydrated && accountAligned;
  // The connection gate: with a backend configured, cold start waits for the bounded probe —
  // never longer than the bailout window — and publishes the true state via BackendHealth.
  const [conn, setConn] = useState<ConnectionStatus | null>(configured ? null : 'misconfigured');
  // A configured build opens the app only on a proven RPC. An unconfigured build has no backend to
  // prove, so it resolves immediately to the local-mode path.
  const gateSatisfied = configured ? conn === 'connected' : conn !== null;
  const ready = coreReady && gateSatisfied;
  // A configured build that could not connect is blocked on screen, not routed into the app.
  const blocked = configured && coreReady && conn !== null && conn !== 'connected';
  const fade = useRef(new Animated.Value(0)).current;
  const hasNavigated = useRef(false);
  const [stuck, setStuck] = useState(false);
  // Bumped by Retry; the probe effect keys off it so retrying is a plain state change.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!coreReady || !isBackendConfigured()) return;
    let cancelled = false;
    markBoot('gate:probe');
    void probeBackend(GATE_PROBE_MS, online).then((s) => {
      if (cancelled) return;
      setConn(s);
      markBoot(`gate:${s}`);
    });
    return () => {
      cancelled = true;
    };
  }, [coreReady, online, attempt]);

  const retry = () => {
    markBoot('gate:retry');
    setStuck(false);
    setConn('connecting');
    setAttempt((n) => n + 1);
  };

  useEffect(() => {
    markBoot('index:mounted');
    SplashScreen.hideAsync().catch(() => {});
    Animated.timing(fade, { toValue: 1, duration: motion.long, useNativeDriver: true }).start();
  }, [fade]);

  // Navigate reliably once ready (and only once the root navigator is actually registered)
  useEffect(() => {
    if (!ready || !navReady || hasNavigated.current) return;
    hasNavigated.current = true;

    // Preserve cold-start App Links, custom scheme deep links, and push notification taps when
    // Expo Router mounts `index` underneath the requested target screen on cold start.
    if (pathname && pathname !== '/' && auth.status === 'signedIn' && state.onboarding.done) {
      markBoot(`index:deep-link ${pathname}`);
      return;
    }

    const dest = auth.status === 'signedOut' ? '/(auth)/welcome' : auth.status === 'signedIn' && !state.onboarding.done ? '/(onboarding)/fandoms' : '/(tabs)';
    markBoot(`index:redirect${auth.status === 'signedOut' || (auth.status === 'signedIn' && !state.onboarding.done) ? '' : ':tabs'} ${dest}`);
    router.replace(dest as never);
  }, [ready, navReady, pathname, auth.status, state.onboarding.done, router]);

  // Auto-bailout failsafe: if readiness never arrives, force navigation to welcome.
  //
  // This is a LOCAL-MODE-ONLY escape hatch. A configured build must never reach it: bailing out
  // signs the member out and drops them into the signed-out path, which is precisely the
  // "backend failed → carry on with local data" behaviour this gate exists to prevent. A stuck
  // configured build shows Retry and diagnostics instead, and says so.
  useEffect(() => {
    if (configured) return;
    if (ready || !navReady || hasNavigated.current) return;
    const t = setTimeout(() => {
      if (!hasNavigated.current) {
        hasNavigated.current = true;
        markBoot('index:auto-bailout');
        void auth.signOut().catch(() => {});
        router.replace('/(auth)/welcome');
      }
    }, AUTO_BAILOUT_MS);
    return () => clearTimeout(t);
  }, [ready, navReady, auth, router, configured]);

  // The tap stays a simple "continue" for normal slow starts; once stuck, it opens diagnostics.
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => setStuck(true), AUTO_BAILOUT_MS);
    return () => clearTimeout(t);
  }, [ready]);

  const bailOut = () => {
    if (hasNavigated.current || !navReady) return;
    if (configured) {
      // A configured build has no "continue anyway into local mode" path — the only ways out are
      // a successful connection or leaving the connection state visible.
      retry();
      return;
    }
    hasNavigated.current = true;
    void auth.signOut().catch(() => {});
    router.replace('/(auth)/welcome');
  };

  // Diagnostics: show the boot trail and the last uncaught error on screen — this is how a
  // release-only stall becomes reportable without adb or a dev build.
  const showDiagnostics = () => {
    void (async () => {
      const [trail, crash] = await Promise.all([bootTrail(), lastCrash()]);
      const detail = [`BOOT TRAIL:\n${trail}`, crash ? `LAST ERROR:\n${crash.name}: ${crash.message}\n${(crash.stack ?? '').slice(0, 400)}` : 'LAST ERROR: none recorded'].join('\n\n');
      Alert.alert('Startup diagnostics', detail.slice(0, 1800), [
        ...(configured ? [{ text: 'Retry connection', onPress: retry }] : [{ text: 'Continue anyway', onPress: bailOut }]),
        { text: 'Close', style: 'cancel' },
      ]);
    })();
  };

  return (
    <View style={styles.root} accessibilityLabel="Hallyu is starting">
      <Animated.View style={{ opacity: fade, alignItems: 'center' }}>
        <Image source={require('../assets/branding/splash-mark.png')} style={{ width: 160, height: 160 }} contentFit="contain" />
      </Animated.View>
      {gateLine(conn) ? (
        <Text variant="caption" tone="secondary" style={styles.gate}>
          {gateLine(conn)}
        </Text>
      ) : null}
      {/* The blocked state is a real screen, not a caption: the app will not open until the
          connection is proven, so the member gets the reason and a way to fix it. */}
      {blocked ? (
        <View style={styles.blocked} accessibilityLiveRegion="polite">
          <Text variant="body" tone="primary" style={styles.blockedTitle}>
            {conn === 'offline' ? 'No connection' : conn === 'misconfigured' ? 'Backend not configured' : 'Cannot reach Hallyu'}
          </Text>
          <Text variant="caption" tone="secondary" style={styles.blockedBody}>
            {gateDetail(conn)}
          </Text>
          <Pressable onPress={retry} style={styles.retry} accessibilityRole="button" accessibilityLabel="Retry connection">
            <Text variant="label" tone="primary">
              Retry
            </Text>
          </Pressable>
        </View>
      ) : null}
      <Pressable
        onPress={() => (stuck || blocked ? showDiagnostics() : bailOut())}
        hitSlop={16}
        style={styles.stuck}
        accessibilityRole="button"
        accessibilityLabel={stuck || blocked ? 'Show startup diagnostics' : 'Continue'}
      >
        <Text variant="caption" tone="secondary">
          {blocked ? 'Tap for diagnostics' : stuck ? 'Taking longer than usual — tap for diagnostics' : 'Tap if not redirected automatically'}
        </Text>
      </Pressable>
      <Text variant="caption" tone="tertiary" style={styles.foot}>
        Your dramas. Your people. Your world.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas, alignItems: 'center', justifyContent: 'center' },
  gate: { position: 'absolute', bottom: 120, paddingHorizontal: 32, textAlign: 'center' },
  stuck: { position: 'absolute', bottom: 84 },
  foot: { position: 'absolute', bottom: 48 },
  blocked: { position: 'absolute', left: 32, right: 32, bottom: 150, alignItems: 'center', gap: 12 },
  blockedTitle: { textAlign: 'center' },
  blockedBody: { textAlign: 'center' },
  retry: {
    marginTop: 4,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
});
