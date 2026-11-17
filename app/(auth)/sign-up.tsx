import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button } from '../../components/ui/Button';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { InlineNotice } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TextField } from '../../components/ui/TextField';
import { TopBar } from '../../components/ui/TopBar';
import { colors, space } from '../../constants/theme';
import { AuthError, useAuth } from '../../lib/auth';
import { LIMITS } from '../../lib/model';

/**
 * Create an account via Email & Password or Google OAuth. Both flow cleanly into `register_profile`
 * (first account on a fresh install becomes Hallyu's founding profile).
 */
export default function SignUp() {
  const router = useRouter();
  const auth = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busyMode, setBusyMode] = useState<'email' | 'google' | null>(null);
  const [error, setError] = useState<AuthError | null>(null);

  const emailOk = /.+@.+\..+/.test(email.trim());
  const passwordMismatch = confirmPassword.length > 0 && password !== confirmPassword;
  const canEmailSubmit =
    emailOk && password.length >= 6 && password === confirmPassword && busyMode === null;

  const submitEmail = async () => {
    if (busyMode !== null) return;
    if (auth.status === 'recovery') {
      setBusyMode('email');
      setError(null);
      try {
        await auth.retryProfileProvisioning();
        router.replace('/');
      } catch (e) {
        setError(e instanceof AuthError ? e : new AuthError('unknown', 'Could not finish account setup.'));
      } finally {
        setBusyMode(null);
      }
      return;
    }

    if (password !== confirmPassword) {
      setError(new AuthError('credentials', 'Passwords do not match.'));
      return;
    }

    setBusyMode('email');
    setError(null);
    try {
      await auth.signUp(email, password, name.trim());
      router.replace('/');
    } catch (e) {
      const err = e instanceof AuthError ? e : new AuthError('unknown', e instanceof Error ? e.message : 'Sign-up failed — try again.');
      setError(err);
    } finally {
      setBusyMode(null);
    }
  };

  const submitGoogle = async () => {
    if (busyMode !== null) return;
    setBusyMode('google');
    setError(null);
    try {
      if (auth.status === 'recovery') await auth.retryProfileProvisioning();
      else await auth.signInWithGoogle(name.trim() || undefined);
      router.replace('/');
    } catch (e) {
      const rawMsg = e instanceof Error ? e.message : 'Google sign-up failed.';
      const msg = /try gmail login/i.test(rawMsg)
        ? rawMsg
        : `${rawMsg} Try Gmail login or sign up with your email above.`;
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
    <Screen header={<TopBar title="Create account" />}>
      <ScrollScreen keyboard column padded>
        <Text variant="display" style={{ marginTop: space.x4 }}>
          Join the conversation.
        </Text>
        <Text variant="body" tone="secondary" style={{ marginTop: space.x2, marginBottom: space.x5 }}>
          Track what you watch, follow the fandoms you love, and talk about every episode without getting spoiled.
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
            label="Display name"
            value={name}
            onChangeText={setName}
            autoComplete="name"
            textContentType="name"
            maxLength={LIMITS.displayName}
            leading="person-outline"
            hint="Optional — how you’ll appear to others. You can change it later."
          />
          <TextField
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            textContentType="emailAddress"
            leading="mail-outline"
          />
          <TextField
            label="Password"
            value={password}
            onChangeText={setPassword}
            password
            autoComplete="new-password"
            textContentType="newPassword"
            leading="lock-closed-outline"
            hint="At least 6 characters"
          />
          <TextField
            label="Confirm password"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            password
            leading="lock-closed-outline"
            error={passwordMismatch ? 'Passwords do not match.' : null}
            returnKeyType="go"
            onSubmitEditing={() => {
              if (canEmailSubmit) void submitEmail();
            }}
          />

          <Button
            label={
              busyMode === 'email'
                ? 'Creating your account…'
                : auth.status === 'recovery'
                  ? 'Retry account setup'
                  : 'Create account with email'
            }
            size="lg"
            block
            loading={busyMode === 'email'}
            disabled={busyMode !== null || (auth.status !== 'recovery' && (!emailOk || password.length < 6 || password !== confirmPassword))}
            onPress={() => void submitEmail()}
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
            onPress={() => void submitGoogle()}
          />
        </View>

        <View style={{ marginTop: space.x5, gap: space.x2 }}>
          <Button
            label="Already have an account? Sign in"
            variant="ghost"
            onPress={() => router.replace('/(auth)/sign-in')}
          />
        </View>

        <Text variant="caption" tone="tertiary" style={{ marginTop: space.x4 }}>
          By creating an account you agree to the Terms and Community Guidelines: mark your spoilers, no harassment, no spam. You can delete your account at any time from Settings. The very first account created on a fresh install becomes Hallyu’s founding account.
        </Text>
      </ScrollScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    marginVertical: space.x1,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.borderSubtle,
  },
});
