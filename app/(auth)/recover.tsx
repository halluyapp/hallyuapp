import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { InlineNotice } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { space } from '../../constants/theme';
import { AuthError, useAuth } from '../../lib/auth';

/** Retains a verified Rork session while the application profile is retried; never fabricates one. */
export default function AccountRecovery() {
  const auth = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retry = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await auth.retryProfileProvisioning();
      router.replace('/');
    } catch (e) {
      setError(e instanceof AuthError || e instanceof Error ? e.message : 'Account setup failed — try again.');
      if (e instanceof AuthError && e.code === 'credentials') router.replace('/(auth)/sign-in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen header={<TopBar title="Finish account setup" />}>
      <ScrollScreen column padded>
        <Text variant="display">Your Google sign-in is safe.</Text>
        <Text variant="body" tone="secondary" style={{ marginTop: space.x2, marginBottom: space.x5 }}>
          Hallyu has not created a second identity or marked your account ready. Retry to finish creating or restoring your one application profile.
        </Text>
        {error || auth.provisioningError ? (
          <InlineNotice tone="warning" icon="cloud-offline-outline" text={error ?? auth.provisioningError!} />
        ) : null}
        <Button label="Retry account setup" onPress={retry} loading={busy} block style={{ marginTop: space.x4 }} />
        <Button label="Use a different Google account" variant="ghost" onPress={() => router.replace('/(auth)/sign-in')} block />
        <Button label="Sign out" variant="ghost" onPress={() => void auth.signOut().then(() => router.replace('/(auth)/welcome'))} block />
      </ScrollScreen>
    </Screen>
  );
}
