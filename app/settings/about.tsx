import { Image } from 'expo-image';
import * as Application from 'expo-application';
import React from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { SettingsGroup, SettingsRow } from '../../components/settings/Rows';
import { ScrollScreen, Screen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { Wordmark } from '../../components/ui/TopBar';
import { TopBar } from '../../components/ui/TopBar';
import { colors, radius, space } from '../../constants/theme';
import { ATTRIBUTION, catalog } from '../../lib/catalog';
import { useBackendHealth, useCatalogHealth } from '../../lib/hooks';
import { isBackendConfigured, probeBackend } from '../../lib/api/client';

/** About & credits — includes the TMDB attribution required by its API terms. */
export default function About() {
  const version = Application.nativeApplicationVersion ?? '1.0.0';
  const build = Application.nativeBuildVersion ?? '1';
  const health = useCatalogHealth();
  const backend = useBackendHealth();
  const connected = backend.status === 'connected';
  return (
    <Screen header={<TopBar mode="stack" title="About & credits" />}>
      <ScrollScreen>
        <View style={styles.hero}>
          <Wordmark size={36} />
          <Text variant="caption" tone="secondary" style={{ marginTop: space.x2 }}>
            Your dramas. Your people. Your world.
          </Text>
          <Text variant="caption" tone="tertiary" numeric>
            Version {version} ({build})
          </Text>
        </View>
        <SettingsGroup title="Backend">
          <SettingsRow
            icon={connected ? 'checkmark-circle-outline' : backend.status === 'connecting' ? 'ellipse-outline' : 'cloud-offline-outline'}
            label="Hallyu backend"
            detail={
              !isBackendConfigured()
                ? 'Not configured in this build — local mode'
                : connected
                  ? 'Connected — verified with a live round trip'
                  : backend.status === 'connecting'
                    ? 'Connecting…'
                    : `${backend.status}${backend.message ? ` — ${backend.message}` : ''}`
            }
            onPress={() => {
              void probeBackend();
            }}
          />
          <SettingsRow
            icon="server-outline"
            label="Runtime probe"
            detail="get_bootstrap() when signed in · anonymous handle probe otherwise"
          />
        </SettingsGroup>
        <SettingsGroup title="Catalog data">
          <View style={styles.tmdb}>
            <Image source={require('../../assets/branding/tmdb.png')} style={{ width: 96, height: 12 }} contentFit="contain" accessibilityLabel="The Movie Database" />
            <Text variant="bodySmall" tone="secondary" style={{ flex: 1 }}>
              {ATTRIBUTION}
            </Text>
          </View>
          <SettingsRow
            icon={health.state === 'ok' ? 'checkmark-circle-outline' : health.state === 'error' ? 'alert-circle-outline' : 'ellipse-outline'}
            label="Live catalog"
            detail={
              health.state === 'ok'
                ? `Connected · ${health.latencyMs ?? 0} ms · ${health.at ? new Date(health.at).toLocaleTimeString() : ''}`
                : health.state === 'error'
                  ? (health.message ?? 'Unreachable')
                  : catalog.available
                    ? 'No request yet this session — tap to test'
                    : 'Not configured in this build'
            }
            onPress={() => catalog.trending().catch(() => {})}
          />
          <SettingsRow icon="open-outline" label="themoviedb.org" onPress={() => Linking.openURL('https://www.themoviedb.org/').catch(() => {})} />
        </SettingsGroup>
        <SettingsGroup title="Type & icons">
          <SettingsRow
            icon="text-outline"
            label="Pretendard"
            detail="© Kil Hyung-jin · SIL Open Font License 1.1"
            onPress={() => Linking.openURL('https://github.com/orioncactus/pretendard').catch(() => {})}
          />
          <SettingsRow icon="shapes-outline" label="Ionicons" detail="© Ionic · MIT License" onPress={() => Linking.openURL('https://ionic.io/ionicons').catch(() => {})} />
        </SettingsGroup>
        <SettingsGroup title="Open source">
          <SettingsRow icon="logo-react" label="React Native & Expo" detail="MIT License" onPress={() => Linking.openURL('https://expo.dev').catch(() => {})} />
        </SettingsGroup>
        <SettingsGroup
          title="This build"
          footer={
            isBackendConfigured()
              ? 'Accounts, posts and watchlists sync through the Hallyu backend; the device keeps a local cache for instant launch.'
              : 'Hallyu stores your account, posts and watchlist on this device only.'
          }
        >
          <SettingsRow
            icon="phone-portrait-outline"
            label="Storage"
            detail={isBackendConfigured() ? 'Backend + local cache' : 'On this device'}
          />
        </SettingsGroup>
        <Text variant="caption" tone="tertiary" align="center" style={{ marginBottom: space.x8, paddingHorizontal: space.margin }}>
          Hallyu is an independent fan project and is not affiliated with any broadcaster, streaming service or agency. Drama titles, posters and stills belong to their respective owners.
        </Text>
      </ScrollScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingVertical: space.x8, gap: 2 },
  tmdb: { flexDirection: 'row', alignItems: 'center', gap: space.x3, padding: space.x4, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle, borderRadius: radius.lg },
});
