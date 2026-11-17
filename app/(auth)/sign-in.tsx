import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Button } from '../../components/ui/Button';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { InlineNotice } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TextField } from '../../components/ui/TextField';
import { TopBar } from '../../components/ui/TopBar';
import { colors, space } from '../../constants/theme';
import { AuthError, useAuth } from '../../lib/auth';

/**
 * Welcome back. Supports both Email & Password sign-in (with Forgot Password) and Google OAuth,
 * with explicit "Try Gmail login" guidance + instant email fallback whenever Google auth fails.
 */
export default function SignIn() {
  const router = useRouter();
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busyMode, setBusyMode] = useState<'email' | 'google' | null>(null);
  const [error, setError] = useState<AuthError | null>(null);

  const emailOk = /.+@.+\..+/.test(email.trim());
  const canEmailSubmit = emailOk && password.length >= 6 && busyMode === null;

  const signInWithEmail = async () => {
    if (busyMode !== null) return;
    setBusyMode('email');
    setError(null);
    try {
      if (auth.status === 'recovery') {
        await auth.retryProfileProvisioning();
      } else {
        await auth.signIn(email, password);
      }
      router.replace('/');
    } catch (e) {
      const err = e instanceof AuthError ? e : new AuthError('unknown', e instanceof Error ? e.message : 'Sign-in failed — try again.');
      setError(err);
    } finally {
      setBusyMode(null);
    }
  };

  const signInWithGoogle = async () => {
    if (busyMode !== null) return;
    setBusyMode('google');
    setError(null);
    try {
      if (auth.status === 'recovery') await auth.retryProfileProvisioning();
      else await auth.signInWithGoogle();
      router.replace('/');
    } catch (e) {
      const rawMsg = e instanceof Error ? e.message : 'Google sign-in failed.';
      const msg = /try gmail login/i.test(rawMsg)
        ? rawMsg
        : `${rawMsg} Try Gmail login or sign in with your email below.`;
      const err = e instanceof AuthError
        ? e.code === 'cancelled'
          ? e
          : new AuthError(e.code, msg)
        : new AuthError('unknown', msg);
      if (err.code !== 'cancelled') setError(err);
    } finally {
      setBusyMode(null);
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
        <Text variant="body" tone="secondary" style={{ marginTop: space.x2, marginBottom: space.x5 }}>
          Sign in with your email or Google account. Your episodes, follows, and collections sync right where you left them.
        </Text>

        <View style={{ gap: space.x4 }}>
          {auth.provisioningError && !error ? (
            <InlineNotice tone="warning" icon="cloud-offline-outline" text={auth.provisioningError} />
          ) : null}
          {error ? (
            <InlineNotice
              tone={error.code === 'network' ? 'warning' : 'danger'}
              icon={error.code === 'network' ? 'cloud-offline-outline' : 'alert-circle-outline'}
              text={error.message}
            />
          ) : null}

          <TextField
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            textContentType="emailAddress"
            leading="mail-outline"
            returnKeyType="next"
          />
          <TextField
            label="Password"
            value={password}
            onChangeText={setPassword}
            password
            autoComplete="password"
            textContentType="password"
            leading="lock-closed-outline"
            returnKeyType="go"
            onSubmitEditing={() => {
              if (canEmailSubmit) void signInWithEmail();
            }}
          />

          <View style={{ alignItems: 'flex-end', marginTop: -space.x2 }}>
            <Text
              variant="label"
              tone="accent"
              onPress={() =>
                router.push({
                  pathname: '/(auth)/forgot',
                  params: email.trim() ? { email: email.trim() } : undefined,
                })
              }
            >
              Forgot password?
            </Text>
          </View>

          <Button
            label={
              busyMode === 'email'
                ? 'Signing in…'
                : auth.status === 'recovery'
                  ? 'Retry account setup'
                  : 'Sign in with email'
            }
            size="lg"
            block
            loading={busyMode === 'email'}
            disabled={busyMode !== null || (auth.status !== 'recovery' && (!emailOk || password.length < 6))}
            onPress={() => void signInWithEmail()}
          />

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text variant="caption" tone="tertiary">
              OR
            </Text>
            <View style={styles.dividerLine} />
          </View>

          <Button
            label={
              busyMode === 'google'
                ? 'Connecting Google…'
                : auth.status === 'recovery'
                  ? 'Retry Google account setup'
                  : 'Continue with Google'
            }
            variant="secondary"
            icon="logo-google"
            size="lg"
            block
            loading={busyMode === 'google'}
            disabled={busyMode !== null}
            onPress={() => void signInWithGoogle()}
          />

          <Button
            label="Continue as guest"
            variant="ghost"
            onPress={() => {
              auth.continueAsGuest();
              router.replace('/(tabs)');
            }}
          />
        </View>

        <Text variant="label" tone="secondary" style={{ marginTop: space.x6 }}>
          New here?{' '}
          <Text variant="label" tone="accent" onPress={() => router.replace('/(auth)/sign-up')}>
            Create an account
          </Text>
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
    marginTop: space.x4,
  },
  dividerRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: space.x3,
    marginVertical: space.x1,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.borderSubtle,
  },
};
