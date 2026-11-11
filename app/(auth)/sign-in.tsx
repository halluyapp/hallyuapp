import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Button } from '../../components/ui/Button';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { InlineNotice } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { space } from '../../constants/theme';
import { AuthError, useAuth } from '../../lib/auth';

/**
 * Welcome back. One door: Google, through Rork Auth — no app passwords anywhere in Hallyu.
 * "Continue as guest" keeps the browse-only mode the gate expects.
 */
export default function SignIn() {
  const router = useRouter();
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthError | null>(null);

  const signIn = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (auth.status === 'recovery') await auth.retryProfileProvisioning();
      else await auth.signInWithGoogle();
      router.replace('/');
    } catch (e) {
      const err = e instanceof AuthError ? e : new AuthError('unknown', e instanceof Error ? e.message : 'Google sign-in failed — try again.');
      if (err.code !== 'cancelled') setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen header={<TopBar title="Sign in" />}>
      <ScrollScreen keyboard column padded>
        <View style={styles.halo}>
          <Ionicons name="chatbubbles-outline" size={30} color="#FFFFFF" />
        </View>
        <Text variant="display" style={{ marginTop: space.x3 }}>
          Welcome back.
        </Text>
        <Text variant="body" tone="secondary" style={{ marginTop: space.x2, marginBottom: space.x6 }}>
          Your episodes, follows and collections are waiting exactly where you left them.
        </Text>
        <View style={{ gap: space.x4 }}>
          {auth.provisioningError && !error ? (
            <InlineNotice tone="warning" icon="cloud-offline-outline" text={auth.provisioningError} />
          ) : null}
          {error ? (
            <InlineNotice tone={error.code === 'network' ? 'warning' : 'danger'} icon={error.code === 'network' ? 'cloud-offline-outline' : 'alert-circle-outline'} text={error.message} />
          ) : null}
          <Button label={busy ? 'Finishing sign-in…' : auth.status === 'recovery' ? 'Retry account setup' : 'Continue with Google'} size="lg" block loading={busy} onPress={signIn} />
          <Button label="Continue as guest" variant="ghost" onPress={() => { auth.continueAsGuest(); router.replace('/(tabs)'); }} />
        </View>
        <Text variant="label" tone="secondary" style={{ marginTop: space.x6 }}>
          New here?{' '}
          <Text variant="label" tone="accent" onPress={() => router.replace('/(auth)/sign-up')}>
            Create an account
          </Text>
        </Text>
        <Text variant="caption" tone="tertiary" style={{ marginTop: space.x3 }}>
          Sign-in runs through Google — Hallyu never sees or stores a password.
        </Text>
      </ScrollScreen>
    </Screen>
  );
}

const styles = {
  halo: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginTop: space.x6,
  },
};
