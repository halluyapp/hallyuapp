import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { SettingsGroup, SettingsRow, SettingsToggle } from '../../components/settings/Rows';
import { Avatar } from '../../components/ui/Avatar';
import { Dialog } from '../../components/ui/Dialog';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { useToast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import { VideoAccessSheet } from '../../components/video/VideoAccessSheet';
import { VerificationApplySheet } from '../../components/recognition/VerificationApplyModal';
import { VerificationSeal } from '../../components/recognition/VerificationSeal';
import { space } from '../../constants/theme';
import { getInstalledVersionLabel } from '../../lib/appUpdater';
import { useAuth } from '../../lib/auth';
import { useApp } from '../../lib/hooks';
import { APP_LANGUAGES, useI18n } from '../../lib/i18n';

const PROTECTION_LABEL = { strict: 'Strict', balanced: 'Balanced', off: 'Off' } as const;

/** Settings hub — commercial-grade zero-placeholder controls. */
export default function Settings() {
  const router = useRouter();
  const auth = useAuth();
  const toast = useToast();
  const { t } = useI18n();
  const { state, dispatch, me } = useApp();
  const [confirmOut, setConfirmOut] = useState(false);
  const [creatorSheet, setCreatorSheet] = useState(false);
  const [verifSheet, setVerifSheet] = useState(false);
  const signedIn = auth.status === 'signedIn';
  const isStaff = me.role === 'admin' || me.role === 'moderator';
  const version = getInstalledVersionLabel();
  const activeLanguage =
    APP_LANGUAGES.find((l) => l.key === state.prefs.language)?.nativeLabel ?? 'English';

  return (
    <Screen header={<TopBar mode="stack" title={t('settings.title')} />}>
      <ScrollScreen>
        {signedIn ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.x3,
              paddingHorizontal: space.margin,
              paddingVertical: space.x4,
            }}
          >
            <Avatar uri={me.avatarUrl} name={me.displayName} size="lg" />
            <View style={{ flex: 1, gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <Text variant="titleSmall">{me.displayName}</Text>
                <VerificationSeal tier={me.verificationTier} verified={me.verified} size={16} showPill />
              </View>
              <Text variant="caption" tone="secondary">
                @{me.handle} · Synced across Android, iOS & Web
              </Text>
            </View>
          </View>
        ) : (
          <View style={{ paddingHorizontal: space.margin, paddingVertical: space.x4 }}>
            <Text variant="titleSmall">Browsing as a guest</Text>
            <Text variant="caption" tone="secondary">
              Sign in to sync your watchlist, communities, and DMs across all your devices.
            </Text>
          </View>
        )}

        {signedIn ? (
          <SettingsGroup title={isStaff ? 'Executive & Staff Platform' : 'Community & Creators'}>
            {isStaff ? (
              <SettingsRow
                icon="grid-outline"
                label="Commercial Admin Console"
                detail="Users, Launch & Founding Ten, Badges, Verification, Reports & Audit Log"
                onPress={() => router.push('/admin')}
              />
            ) : null}
            {isStaff ? (
              <SettingsRow
                icon="shield-half-outline"
                label="Admin & Creator Studio"
                detail="CEO Megaphone, bug inbox, creator approvals & room moderation"
                onPress={() => router.push('/settings/moderation')}
              />
            ) : null}
            <SettingsRow
              icon="checkmark-done-circle-outline"
              label="Account Verification"
              detail={
                me.verificationTier && me.verificationTier !== 'none'
                  ? `Active ${me.verificationTier.toUpperCase()} Verification · View record`
                  : 'Apply for Blue Authentic Identity verification'
              }
              onPress={() => setVerifSheet(true)}
            />
            <SettingsRow
              icon="flame-outline"
              label="Live Events & Watch Parties"
              detail="Synchronized finale rooms, countdowns & prediction polls"
              onPress={() => router.push('/events')}
            />
            <SettingsRow
              icon="videocam-outline"
              label="Video Creator Pass"
              detail={
                isStaff
                  ? 'Active · 10 GB/mo creator allowance'
                  : 'Publish vertical Shorts & HD clips to the social feed'
              }
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

        <SettingsGroup title={t('settings.account')}>
          {signedIn ? (
            <SettingsRow
              icon="person-outline"
              label={t('settings.account')}
              detail="Change @handle, password, email & data export"
              onPress={() => router.push('/settings/account')}
            />
          ) : (
            <SettingsRow
              icon="log-in-outline"
              label="Sign in or create account"
              onPress={() => router.push('/(auth)/welcome')}
            />
          )}
          <SettingsRow
            icon="notifications-outline"
            label={t('settings.notifications')}
            detail="Live push alerts, Android Live Pulse banner & quiet hours"
            onPress={() => router.push('/settings/notifications')}
          />
          <SettingsRow
            icon="eye-off-outline"
            label={t('settings.content')}
            value={PROTECTION_LABEL[state.prefs.protection]}
            onPress={() => router.push('/settings/content')}
          />
          <SettingsRow
            icon="shield-checkmark-outline"
            label={t('settings.privacy')}
            onPress={() => router.push('/settings/privacy')}
          />
          <SettingsRow
            icon="ban-outline"
            label="Blocked & muted"
            value={
              state.blockedUsers.length + state.mutedUsers.length
                ? `${state.blockedUsers.length + state.mutedUsers.length}`
                : undefined
            }
            onPress={() => router.push('/settings/blocked')}
          />
        </SettingsGroup>

        <SettingsGroup title={t('settings.app')}>
          <SettingsToggle
            icon="contrast-outline"
            label="True Black OLED Canvas"
            detail={
              state.prefs.trueBlack
                ? 'Pure #000000 cinema black active'
                : 'Cinema Charcoal (#111116) surface active'
            }
            value={state.prefs.trueBlack}
            onChange={(v) => dispatch({ type: 'prefs', patch: { trueBlack: v } })}
          />
          <SettingsRow
            icon="language-outline"
            label={t('settings.language')}
            value={activeLanguage}
            onPress={() => router.push('/settings/language')}
          />
          <SettingsRow
            icon="cellular-outline"
            label={t('settings.data')}
            detail="Autoplay, data saver & image cache"
            onPress={() => router.push('/settings/data')}
          />
          <SettingsRow
            icon="rocket-outline"
            label={t('settings.updates')}
            value={`v${version}`}
            detail="Check for updates & direct signed Android APK"
            onPress={() => router.push('/settings/updates')}
          />
        </SettingsGroup>

        <SettingsGroup title={t('settings.support')}>
          <SettingsRow
            icon="bug-outline"
            label={t('settings.bugReport')}
            detail="Report a glitch, request a missing show, or suggest a feature"
            onPress={() => router.push('/settings/bug-report')}
          />
          <SettingsRow
            icon="help-circle-outline"
            label={t('settings.help')}
            onPress={() => router.push('/settings/help')}
          />
          <SettingsRow
            icon="document-text-outline"
            label="Community guidelines"
            onPress={() => router.push('/settings/guidelines')}
          />
          <SettingsRow
            icon="information-circle-outline"
            label={t('settings.about')}
            value={`v${version}`}
            onPress={() => router.push('/settings/about')}
          />
        </SettingsGroup>

        {signedIn ? (
          <SettingsGroup>
            <SettingsRow
              icon="log-out-outline"
              label={t('settings.signOut')}
              onPress={() => setConfirmOut(true)}
              chevron={false}
            />
            <SettingsRow
              icon="trash-outline"
              label="Delete account"
              tone="danger"
              onPress={() => router.push('/settings/delete-account')}
            />
          </SettingsGroup>
        ) : null}

        <Text variant="caption" tone="tertiary" align="center" style={{ marginBottom: space.x8 }}>
          Hallyu v{version} · Global Social Home for Asian & Cinema Worlds
        </Text>
      </ScrollScreen>

      <VideoAccessSheet visible={creatorSheet} onClose={() => setCreatorSheet(false)} />
      <VerificationApplySheet open={verifSheet} onClose={() => setVerifSheet(false)} />
      <Dialog
        visible={confirmOut}
        title="Sign out?"
        body="Your watchlist, collections, and posts stay safely synced with your Hallyu account."
        confirmLabel="Sign out"
        onConfirm={async () => {
          setConfirmOut(false);
          await auth.signOut();
          toast.show({ message: 'Signed out' });
          router.replace('/');
        }}
        onCancel={() => setConfirmOut(false)}
      />
    </Screen>
  );
}
