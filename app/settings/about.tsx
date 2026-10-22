import * as Application from 'expo-application';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { SettingsGroup, SettingsRow } from '../../components/settings/Rows';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { TopBar, Wordmark } from '../../components/ui/TopBar';
import { colors, radius, space } from '../../constants/theme';
import { probeBackend } from '../../lib/api/client';
import { ATTRIBUTION, catalog } from '../../lib/catalog';
import { useBackendHealth, useCatalogHealth } from '../../lib/hooks';
import { ADMIN_CONTACT_EMAIL, getWebAppBaseUrl, SUPPORT_EMAIL } from '../../lib/links';

/** About & credits — commercial release info, live service health & required TMDB attribution. */
export default function About() {
  const router = useRouter();
  const version = Application.nativeApplicationVersion ?? '1.0.0';
  const build = Application.nativeBuildVersion ?? '1';
  const health = useCatalogHealth();
  const backend = useBackendHealth();
  const connected = backend.status === 'connected';

  return (
    <Screen header={<TopBar mode="stack" title="About Hallyu" />}>
      <ScrollScreen>
        <View style={styles.hero}>
          <Wordmark size={38} />
          <Text variant="caption" tone="secondary" style={{ marginTop: space.x2 }}>
            Your dramas. Your people. Your world.
          </Text>
          <Text variant="caption" tone="tertiary" numeric>
            Release v{version} (Build {build})
          </Text>
        </View>

        <SettingsGroup title="Service Status & Updates">
          <SettingsRow
            icon={connected ? 'checkmark-circle-outline' : 'sync-outline'}
            label="Hallyu Cloud Network"
            value={connected ? 'Online' : 'Syncing'}
            detail="Real-time social feed, Watch Parties, Communities & DMs"
            onPress={() => void probeBackend()}
          />
          <SettingsRow
            icon="rocket-outline"
            label="App Updates & Downloads"
            value={`v${version}`}
            detail="Check for new signed builds or download Android APK"
            onPress={() => router.push('/settings/updates')}
          />
          <SettingsRow
            icon="globe-outline"
            label="Hallyu on Web & iOS"
            detail={getWebAppBaseUrl()}
            onPress={() => Linking.openURL(getWebAppBaseUrl()).catch(() => {})}
          />
        </SettingsGroup>

        <SettingsGroup title="Catalog & Metadata">
          <View style={styles.tmdb}>
            <Image
              source={require('../../assets/branding/tmdb.png')}
              style={{ width: 96, height: 12 }}
              contentFit="contain"
              accessibilityLabel="The Movie Database"
            />
            <Text variant="bodySmall" tone="secondary" style={{ flex: 1 }}>
              {ATTRIBUTION}
            </Text>
          </View>
          <SettingsRow
            icon={health.state === 'ok' ? 'checkmark-circle-outline' : 'film-outline'}
            label="Global Show & Film Index"
            value={health.state === 'ok' ? `${health.latencyMs ?? 0} ms` : 'Ready'}
            detail="K-Drama · C-Drama · Anime · Global Cinema"
            onPress={() => catalog.trending().catch(() => {})}
          />
          <SettingsRow
            icon="open-outline"
            label="themoviedb.org"
            onPress={() => Linking.openURL('https://www.themoviedb.org/').catch(() => {})}
          />
        </SettingsGroup>

        <SettingsGroup title="Official Contact">
          <SettingsRow
            icon="mail-outline"
            label="Support & Bug Reports"
            value={SUPPORT_EMAIL}
            onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`).catch(() => {})}
          />
          <SettingsRow
            icon="shield-outline"
            label="Admin & Creator Desk"
            value={ADMIN_CONTACT_EMAIL}
            onPress={() => Linking.openURL(`mailto:${ADMIN_CONTACT_EMAIL}`).catch(() => {})}
          />
        </SettingsGroup>

        <SettingsGroup title="Typography & Open Source">
          <SettingsRow
            icon="text-outline"
            label="Pretendard Typeface"
            detail="© Kil Hyung-jin · SIL Open Font License 1.1"
            onPress={() =>
              Linking.openURL('https://github.com/orioncactus/pretendard').catch(() => {})
            }
          />
          <SettingsRow
            icon="shapes-outline"
            label="Ionicons"
            detail="© Ionic · MIT License"
            onPress={() => Linking.openURL('https://ionic.io/ionicons').catch(() => {})}
          />
          <SettingsRow
            icon="logo-react"
            label="React Native & Expo"
            detail="MIT License"
            onPress={() => Linking.openURL('https://expo.dev').catch(() => {})}
          />
        </SettingsGroup>

        <Text
          variant="caption"
          tone="tertiary"
          align="center"
          style={{ marginBottom: space.x8, paddingHorizontal: space.margin }}
        >
          Hallyu is an independent social community platform and is not affiliated with any
          broadcaster, studio, or streaming network. All show titles, posters, and stills belong to
          their respective rights holders.
        </Text>
      </ScrollScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingVertical: space.x8, gap: 2 },
  tmdb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    padding: space.x4,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    borderRadius: radius.lg,
  },
});
