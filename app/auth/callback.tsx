import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';
import { Button } from '../../components/ui/Button';
import { Screen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { colors, space } from '../../constants/theme';
import { track } from '../../lib/analytics';
import { markBoot } from '../../lib/boot';
import { consumeAuthCallback } from '../../lib/api/authCallback';

type Phase = 'working' | 'failed';

/**
 * Where a completed verification lands: a recovery link means the member has to choose a new
 * password before anything else, everything else means a normal sign-in that continues into
 * onboarding (or straight home for an existing member).
 */
const RECOVERY_PATH = '/(auth)/reset-password';

/**
 * The landing route for `hallyu://auth/callback` — the link Supabase emails after sign-up and for
 * password recovery.
 *
 * This used to redirect home immediately, which threw away the tokens in the URL: with
 * `detectSessionInUrl: false` nothing else consumed them, so verifying an email opened Hallyu with
 * no session at all. It now consumes the link itself.
 *
 * Both starts are covered by doing the work here rather than in a listener: on a cold start
 * expo-router mounts this route with the URL already in its params, and on a warm start it pushes
 * the route when the link arrives. Same code path either way, so neither can silently regress.
 */
export default function AuthCallback() {
  const router = useRouter();
  // Supabase sends the tokens either in `?code=` (PKCE) or in `#access_token=…` (implicit). The
  // fragment is not part of the route params, so it is read off the initial URL as well.
  const params = useLocalSearchParams<{ code?: string; access_token?: string; refresh_token?: string; error?: string; error_description?: string }>();
  const [phase, setPhase] = useState<Phase>('working');
  const [message, setMessage] = useState('Completing sign-in…');
  const [url, setUrl] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    // The fragment survives in the initial URL even though the params do not carry it.
    void linkingInitialUrl().then((initial) => {
      const webHref = typeof window !== 'undefined' && window.location?.href ? window.location.href : null;
      const fromParams = buildFromParams(params);
      const candidate =
        webHref && /[?#](code|access_token|error)=/i.test(webHref)
          ? webHref
          : initial && /^(hallyu|exp|https?):\/\//i.test(initial) && /[?#](code|access_token|error)=/i.test(initial)
            ? initial
            : fromParams;
      setUrl(candidate);
    });
  }, [params]);

  const run = useCallback(
    async (target: string | null) => {
      setPhase('working');
      setMessage('Completing sign-in…');
      markBoot('auth:callback');
      const result = await consumeAuthCallback(target ?? '');
      if (!result.ok) {
        markBoot('auth:callback-failed');
        track('auth.signin', { via: 'callback', ok: false });
        setMessage(result.message);
        setPhase('failed');
        return;
      }
      markBoot('auth:callback-session');
      track('auth.signin', { via: 'callback', ok: true, recovery: result.recovery });
      // The gate at app/index.tsx reads the auth state and routes onward; replace removes this
      // callback from the history so Back does not re-run it.
      router.replace(result.recovery ? RECOVERY_PATH : '/');
    },
    [router],
  );

  useEffect(() => {
    if (ran.current || url === null) return;
    ran.current = true;
    void run(url);
  }, [run, url]);

  if (phase === 'working') {
    return (
      <Screen>
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
          <Text variant="body" tone="primary">
            {message}
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.center}>
        <Text variant="title" tone="primary">
          That link didn’t work
        </Text>
        <Text variant="body" tone="secondary" style={styles.detail}>
          {message}
        </Text>
        <View style={styles.actions}>
          <Button label="Try again" onPress={() => void run(url)} accessibilityLabel="Retry completing sign-in" />
          <Button label="Go to sign in" variant="secondary" onPress={() => router.replace('/(auth)/welcome')} accessibilityLabel="Back to sign in" />
        </View>
      </View>
    </Screen>
  );
}

/** Rebuild the callback URL from route params when the initial URL is unavailable. */
function buildFromParams(params: Record<string, string | undefined>): string | null {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (typeof v === 'string' && v) q.set(k, v);
  const s = q.toString();
  return s ? `hallyu://auth/callback?${s}` : null;
}

async function linkingInitialUrl(): Promise<string | null> {
  try {
    return await Linking.getInitialURL();
  } catch {
    return null;
  }
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.x4, padding: space.x6 },
  detail: { textAlign: 'center' },
  actions: { gap: space.x2, alignSelf: 'stretch', marginTop: space.x5 },
});