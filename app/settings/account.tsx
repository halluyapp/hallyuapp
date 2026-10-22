import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { SettingsGroup, SettingsRow } from '../../components/settings/Rows';
import { Button } from '../../components/ui/Button';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { Sheet } from '../../components/ui/Sheet';
import { TextField } from '../../components/ui/TextField';
import { useToast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import { space } from '../../constants/theme';
import { supabase } from '../../lib/api/client';
import { changeMyHandle } from '../../lib/api/features';
import { useAuth } from '../../lib/auth';
import { haptic, useApp } from '../../lib/hooks';
import { SUPPORT_EMAIL } from '../../lib/links';

/** Account — commercial identity management, handle editor, password update & JSON portability. */
export default function AccountSettings() {
  const router = useRouter();
  const auth = useAuth();
  const toast = useToast();
  const { state, dispatch, me } = useApp();

  const [handleSheet, setHandleSheet] = useState(false);
  const [nextHandle, setNextHandle] = useState(me.handle);
  const [savingHandle, setSavingHandle] = useState(false);

  const [passwordSheet, setPasswordSheet] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  const handleSaveHandle = async () => {
    const clean = nextHandle.trim().toLowerCase().replace(/^@/, '');
    if (!clean || savingHandle) return;
    setSavingHandle(true);
    try {
      const updated = await changeMyHandle(clean);
      dispatch({ type: 'profile', patch: { handle: updated } });
      haptic.success();
      toast.show({ message: `Handle updated to @${updated}`, tone: 'success' });
      setHandleSheet(false);
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Could not change handle',
        tone: 'danger',
      });
    } finally {
      setSavingHandle(false);
    }
  };

  const handleSavePassword = async () => {
    if (newPassword.length < 6) {
      toast.show({ message: 'Password must be at least 6 characters', tone: 'danger' });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.show({ message: 'Passwords do not match', tone: 'danger' });
      return;
    }
    if (!supabase) return;
    setSavingPassword(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw new Error(error.message);
      haptic.success();
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSheet(false);
      toast.show({ message: 'Password updated across all devices', tone: 'success' });
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Could not update password',
        tone: 'danger',
      });
    } finally {
      setSavingPassword(false);
    }
  };

  const handleExportData = async () => {
    const payload = JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        account: {
          id: me.id,
          handle: me.handle,
          displayName: me.displayName,
          email: auth.user?.email ?? null,
          fandoms: me.fandoms ?? [],
        },
        watchlist: state.watchlist,
        collections: state.collections,
        follows: state.follows,
        preferences: state.prefs,
      },
      null,
      2,
    );

    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `hallyu-data-${me.handle}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.show({ message: 'Downloaded Hallyu data archive (.json)', tone: 'success' });
      return;
    }

    await Share.share({
      title: `Hallyu Data Export (@${me.handle})`,
      message: payload,
    }).catch(() => {});
  };

  return (
    <Screen header={<TopBar mode="stack" title="Account" />}>
      <ScrollScreen>
        <SettingsGroup title="Identity & Security">
          <SettingsRow
            icon="person-outline"
            label="Edit public profile"
            value={me.displayName}
            onPress={() => router.push('/edit-profile')}
          />
          <SettingsRow
            icon="at-outline"
            label="Username"
            value={`@${me.handle}`}
            detail="Unique handle for mentions, profile URL & DMs"
            onPress={() => {
              setNextHandle(me.handle);
              setHandleSheet(true);
            }}
          />
          <SettingsRow
            icon="mail-outline"
            label="Email address"
            value={auth.user?.email ?? 'Verified member'}
          />
          <SettingsRow
            icon="key-outline"
            label="Change password"
            detail="Update your Hallyu account password"
            onPress={() => setPasswordSheet(true)}
          />
        </SettingsGroup>

        <SettingsGroup
          title="Data & Portability"
          footer={`Your watchlist, collections, and posts sync automatically across Android, iOS, and Web. Need help? Contact ${SUPPORT_EMAIL}.`}
        >
          <SettingsRow
            icon="download-outline"
            label="Export account archive (JSON)"
            detail="Download a full copy of your watchlist, collections & preferences"
            onPress={() => void handleExportData()}
          />
          <SettingsRow
            icon="trash-outline"
            label="Delete account"
            tone="danger"
            onPress={() => router.push('/settings/delete-account')}
          />
        </SettingsGroup>
      </ScrollScreen>

      <Sheet visible={handleSheet} onClose={() => setHandleSheet(false)} title="Change @handle">
        <View style={{ gap: space.x3 }}>
          <TextField
            label="New handle"
            leading="at-outline"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="yourhandle"
            value={nextHandle}
            onChangeText={setNextHandle}
          />
          <Button
            label="Save New Handle"
            block
            loading={savingHandle}
            onPress={() => void handleSaveHandle()}
          />
        </View>
      </Sheet>

      <Sheet visible={passwordSheet} onClose={() => setPasswordSheet(false)} title="Change Password">
        <View style={{ gap: space.x3 }}>
          <TextField
            label="New password"
            secureTextEntry
            placeholder="At least 6 characters"
            value={newPassword}
            onChangeText={setNewPassword}
          />
          <TextField
            label="Confirm new password"
            secureTextEntry
            placeholder="Re-enter new password"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
          />
          <Button
            label="Update Password"
            block
            loading={savingPassword}
            onPress={() => void handleSavePassword()}
          />
        </View>
      </Sheet>
    </Screen>
  );
}
