import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Button } from '../../components/ui/Button';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { InlineNotice } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TextField } from '../../components/ui/TextField';
import { TopBar } from '../../components/ui/TopBar';
import { space } from '../../constants/theme';
import { AuthError, useAuth } from '../../lib/auth';
import { LIMITS } from '../../lib/model';

/**
 * Create an account. Google-only by design: the Google consent screen is the sign-up form, and
 * the database provisions the profile (first ever profile becomes the founder/CEO role). A
 * display name here is optional — it is passed along as the preferred name for the handle.
 */
export default function SignUp() {
  const router = useRouter();
  const auth = useAuth();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthError | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (auth.status === 'recovery') await auth.retryProfileProvisioning();
      else await auth.signInWithGoogle(name.trim() || undefined);
      router.replace('/');
    } catch (e) {
      const err = e instanceof AuthError ? e : new AuthError('unknown', e instanceof Error ? e.message : 'Google sign-in failed — try again.');
      if (err.code !== 'cancelled') setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen header={<TopBar title="Create account" />}>
      <ScrollScreen keyboard column padded>
        <Text variant="display" style={{ marginTop: space.x4 }}>
          Join the conversation.
        </Text>
        <Text variant="body" tone="secondary" style={{ marginTop: space.x2, marginBottom: space.x6 }}>
          Track what you watch, follow the fandoms you love, and talk about every episode without getting spoiled.
        </Text>
        <View style={{ gap: space.x4 }}>
          <TextField label="Display name" value={name} onChangeText={setName} autoComplete="name" textContentType="name" maxLength={LIMITS.displayName} leading="person-outline" hint="Optional — how you’ll appear to others. You can change it later." />
          {auth.provisioningError && !error ? (
            <InlineNotice tone="warning" icon="cloud-offline-outline" text={auth.provisioningError} />
          ) : null}
          {error ? (
            <InlineNotice tone={error.code === 'network' ? 'warning' : 'danger'} icon={error.code === 'network' ? 'cloud-offline-outline' : 'alert-circle-outline'} text={error.message} />
          ) : null}
          <Button label={busy ? 'Please wait…' : auth.status === 'recovery' ? 'Retry account setup' : 'Continue with Google'} size="lg" block loading={busy} onPress={submit} />
        </View>
        <View style={{ marginTop: space.x6, gap: space.x2 }}>
          <Button label="Already have an account? Sign in" variant="ghost" onPress={() => router.replace('/(auth)/sign-in')} />
        </View>
        <Text variant="caption" tone="tertiary" style={{ marginTop: space.x6 }}>
          Sign-up runs through Google — Hallyu never sees or stores a password, so there is no email verification step. By creating an account you agree to the Terms and the Community Guidelines: mark your spoilers, no harassment, no spam. You can delete your account at any time from Settings.
        </Text>
        <View style={{ marginTop: space.x4 }}>
          <Text variant="caption" tone="tertiary">
            The very first account created on a fresh install becomes Hallyu’s founding account.
          </Text>
        </View>
      </ScrollScreen>
    </Screen>
  );
}
