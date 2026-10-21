import { useRouter } from 'expo-router';
import * as Application from 'expo-application';
import React, { useState } from 'react';
import { View } from 'react-native';
import { SettingsGroup, SettingsRow } from '../../components/settings/Rows';
import { Avatar } from '../../components/ui/Avatar';
import { Dialog } from '../../components/ui/Dialog';
import { ScrollScreen, Screen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { useToast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import { VideoAccessSheet } from '../../components/video/VideoAccessSheet';
import { space } from '../../constants/theme';
import { useAuth } from '../../lib/auth';
import { useApp } from '../../lib/hooks';

const PROTECTION_LABEL = { strict: 'Strict', balanced: 'Balanced', off: 'Off' } as const;

/** Settings hub. */
export default function Settings() {
  const router = useRouter();
  const auth = useAuth();
  const toast = useToast();
  const { state, me } = useApp();
  const [confirmOut, setConfirmOut] = useState(false);
  const [creatorSheet, setCreatorSheet] = useState(false);
  const signedIn = auth.status === 'signedIn';
  const isStaff = me.role === 'admin' || me.role === 'moderator';
  const version = Application.nativeApplicationVersion ?? '1.0.0';
  return (
    <Screen header={<TopBar mode="stack" title="Settings" />}>
      <ScrollScreen>
        {signedIn ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x3, paddingHorizontal: space.margin, paddingVertical: space.x4 }}>
            <Avatar uri={me.avatarUrl} name={me.displayName} size="lg" />
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall">{me.displayName}</Text>
              <Text variant="caption" tone="secondary">
                @{me.handle} · on this device
              </Text>
            </View>
          </View>
        ) : (
          <View style={{ paddingHorizontal: space.margin, paddingVertical: space.x4 }}>
            <Text variant="titleSmall">Browsing as a guest</Text>
            <Text variant="caption" tone="secondary">
              Sign in to keep your watchlist and posts with your account.
            </Text>
          </View>
        )}
        {signedIn ? (
          <SettingsGroup title={isStaff ? 'Creator & Staff Studio' : 'Creator Tools'}>
            {isStaff ? (
              <SettingsRow
                icon="shield-half-outline"
                label="Admin & Creator Studio"
                detail="Approve video creators, review reports & manage rooms"
                onPress={() => router.push('/settings/moderation')}
              />
            ) : null}
            <SettingsRow
              icon="videocam-outline"
              label="Video Creator Pass"
              detail={isStaff ? 'Active · 10 GB/mo creator allowance' : 'Upload vertical Shorts & HD post clips'}
              onPress={() => setCreatorSheet(true)}
            />
            <SettingsRow
              icon="people-circle-outline"
              label="Fandom Rooms"
              detail="Browse & join community rooms across all 4 worlds"
              onPress={() => router.push('/communities')}
            />
          </SettingsGroup>
        ) : null}
        <SettingsGroup title="Account">
          {signedIn ? <SettingsRow icon="person-outline" label="Account" detail="Sign-in method, email, data" onPress={() => router.push('/settings/account')} /> : <SettingsRow icon="log-in-outline" label="Sign in or create account" onPress={() => router.push('/(auth)/welcome')} />}
          <SettingsRow icon="notifications-outline" label="Notifications" detail="Episodes, social, highlights, quiet hours" onPress={() => router.push('/settings/notifications')} />
          <SettingsRow icon="eye-off-outline" label="Content & spoilers" value={PROTECTION_LABEL[state.prefs.protection]} onPress={() => router.push('/settings/content')} />
          <SettingsRow icon="shield-checkmark-outline" label="Privacy & safety" onPress={() => router.push('/settings/privacy')} />
          <SettingsRow icon="ban-outline" label="Blocked & muted" value={state.blockedUsers.length + state.mutedUsers.length ? `${state.blockedUsers.length + state.mutedUsers.length}` : undefined} onPress={() => router.push('/settings/blocked')} />
        </SettingsGroup>
        <SettingsGroup title="App">
          <SettingsRow icon="moon-outline" label="Appearance" value="Dark" detail="Hallyu is dark by design — a light theme isn’t planned." />
          <SettingsRow icon="language-outline" label="Language" value={state.prefs.language === 'ko' ? '한국어' : 'English'} onPress={() => router.push('/settings/language')} />
          <SettingsRow icon="cellular-outline" label="Data & storage" detail="Autoplay, data saver, cache" onPress={() => router.push('/settings/data')} />
        </SettingsGroup>
        <SettingsGroup title="Support">
          <SettingsRow icon="help-circle-outline" label="Help & feedback" onPress={() => router.push('/settings/help')} />
          <SettingsRow icon="document-text-outline" label="Community guidelines" onPress={() => router.push('/settings/guidelines')} />
          <SettingsRow icon="information-circle-outline" label="About & credits" value={`v${version}`} onPress={() => router.push('/settings/about')} />
        </SettingsGroup>
        {signedIn ? (
          <SettingsGroup>
            <SettingsRow icon="log-out-outline" label="Sign out" onPress={() => setConfirmOut(true)} chevron={false} />
            <SettingsRow icon="trash-outline" label="Delete account" tone="danger" onPress={() => router.push('/settings/delete-account')} />
          </SettingsGroup>
        ) : null}
        <Text variant="caption" tone="tertiary" align="center" style={{ marginBottom: space.x8 }}>
          Hallyu {version} · Made for drama people
        </Text>
      </ScrollScreen>
      <VideoAccessSheet visible={creatorSheet} onClose={() => setCreatorSheet(false)} />
      <Dialog visible={confirmOut} title="Sign out?" body="Your watchlist and posts stay on your account. Guest browsing keeps working." confirmLabel="Sign out" onConfirm={async () => { setConfirmOut(false); await auth.signOut(); toast.show({ message: 'Signed out' }); router.replace('/'); }} onCancel={() => setConfirmOut(false)} />
    </Screen>
  );
}
