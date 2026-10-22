import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Button } from '../../components/ui/Button';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { InlineNotice } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TextField } from '../../components/ui/TextField';
import { useToast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import { space } from '../../constants/theme';
import { AuthError, useAuth } from '../../lib/auth';
import { SUPPORT_EMAIL } from '../../lib/links';
import { useStore } from '../../lib/store';

/** Delete account — explicit, typed confirmation; permanently deletes cloud & local account data. */
export default function DeleteAccount() {
  const router = useRouter();
  const auth = useAuth();
  const toast = useToast();
  const { clearPersisted } = useStore();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = typed.trim().toUpperCase() === 'DELETE';

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await auth.deleteAccount();
      await clearPersisted();
      toast.show({ message: 'Account permanently deleted.' });
      router.replace('/');
    } catch (e) {
      setError((e as AuthError).message ?? 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen header={<TopBar mode="stack" title="Delete Account" />}>
      <ScrollScreen keyboard column padded>
        <Text variant="titleLarge" style={{ marginTop: space.x2 }}>
          Permanent account deletion.
        </Text>
        <Text variant="body" tone="secondary" style={{ marginTop: space.x2 }}>
          Your profile, posts, comments, reactions, watchlist, collections, direct messages, and
          follows are permanently deleted from Hallyu across all devices. This cannot be undone.
        </Text>
        <View style={{ marginTop: space.x5, gap: space.x4 }}>
          <InlineNotice
            tone="warning"
            icon="warning-outline"
            text="Prefer a break? Sign out instead — your watchlist and posts stay safe until you return."
          />
          <TextField
            label="Type DELETE to confirm"
            value={typed}
            onChangeText={setTyped}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          {error ? <InlineNotice tone="danger" icon="alert-circle-outline" text={error} /> : null}
          <Button
            label="Delete my account"
            variant="danger"
            size="lg"
            block
            disabled={!ready}
            loading={busy}
            onPress={run}
          />
          <Text variant="caption" tone="tertiary">
            Need assistance or a copy of your data first? Export your archive in Account Settings or
            contact {SUPPORT_EMAIL}.
          </Text>
        </View>
      </ScrollScreen>
    </Screen>
  );
}
