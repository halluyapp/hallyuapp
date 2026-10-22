import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, StyleSheet, View } from 'react-native';
import { Button } from '../../components/ui/Button';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { useToast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import { colors, fonts, radius, space } from '../../constants/theme';
import {
  checkForAppUpdate,
  downloadAndInstallApk,
  getInstalledAppBuild,
  type UpdateCheckResult,
} from '../../lib/appUpdater';
import {
  ANDROID_RELEASE_SHA256,
  getWebAppBaseUrl,
  LATEST_SLIM_APK_CDN_URL,
  LATEST_UNIVERSAL_APK_CDN_URL,
} from '../../lib/links';

export default function AppUpdatesScreen() {
  const toast = useToast();
  const [checking, setChecking] = useState(true);
  const [info, setInfo] = useState<UpdateCheckResult | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const installed = getInstalledAppBuild();

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const res = await checkForAppUpdate();
      setInfo(res);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  const handleInstall = async () => {
    const release = info?.latest ?? {
      version_code: installed.versionCode,
      version_name: installed.versionName,
      apk_url: LATEST_SLIM_APK_CDN_URL,
      universal_apk_url: LATEST_UNIVERSAL_APK_CDN_URL,
      release_notes: 'Latest signed Hallyu Android release.',
      is_mandatory: false,
      min_supported_version: 1,
    };
    setDownloading(true);
    setProgress(0);
    try {
      await downloadAndInstallApk(release, (pct) => {
        setProgress(pct);
      });
      toast.show({
        message:
          Platform.OS === 'android'
            ? 'Download complete! Confirm update in Android Package Installer.'
            : 'APK download started!',
        tone: 'success',
      });
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Download error — opening direct mirror',
        tone: 'danger',
      });
      await Linking.openURL(LATEST_SLIM_APK_CDN_URL).catch(() => {});
    } finally {
      setDownloading(false);
    }
  };

  const sizeLabel = info?.latest.file_size_bytes
    ? `${(info.latest.file_size_bytes / (1024 * 1024)).toFixed(1)} MB`
    : 'Fast ARM64';

  return (
    <Screen header={<TopBar mode="stack" title="App Updates & Downloads" />}>
      <ScrollScreen padded column>
        <View style={styles.heroCard}>
          <View style={styles.iconCircle}>
            <Ionicons
              name={info?.hasUpdate ? 'rocket' : 'shield-checkmark-outline'}
              size={26}
              color={info?.hasUpdate ? colors.accent : colors.success}
            />
          </View>
          <Text variant="title" align="center" style={{ marginTop: space.x3 }}>
            {checking
              ? 'Checking Hallyu Release Channel…'
              : Platform.OS === 'web'
                ? 'Hallyu Direct Release Channel'
                : info?.hasUpdate
                  ? `Update Available · v${info.latest.version_name}`
                  : 'You’re on the Latest Release'}
          </Text>
          <Text variant="bodySmall" tone="secondary" align="center" style={{ marginTop: 4 }}>
            Installed build: v{installed.versionName}
            {Platform.OS === 'android' ? ` (Build #${installed.versionCode})` : ' · Instant Web Sync'}
            {info?.latest ? ` · Latest build #${info.latest.version_code}` : ''}
          </Text>

          {checking ? (
            <ActivityIndicator color={colors.accent} style={{ marginTop: space.x4 }} />
          ) : (
            <View style={{ width: '100%', gap: space.x3, marginTop: space.x4 }}>
              {downloading ? (
                <View style={styles.progressWrap}>
                  <View style={styles.progressTrack}>
                    <View
                      style={[
                        styles.progressFill,
                        { width: `${Math.max(5, Math.round(progress * 100))}%` },
                      ]}
                    />
                  </View>
                  <Text variant="caption" tone="secondary" align="center">
                    Downloading signed release… {Math.round(progress * 100)}%
                  </Text>
                </View>
              ) : null}

              <Button
                label={
                  Platform.OS === 'android'
                    ? info?.hasUpdate
                      ? `Update Now (${sizeLabel})`
                      : 'Re-download Latest Slim Android APK'
                    : 'Download Android APK (Fast ARM64)'
                }
                icon="download-outline"
                block
                loading={downloading}
                onPress={() => void handleInstall()}
              />

              <Button
                label="Universal Android APK (All CPUs / Emulators)"
                variant="secondary"
                size="sm"
                block
                onPress={() =>
                  void Linking.openURL(
                    info?.latest.universal_apk_url || LATEST_UNIVERSAL_APK_CDN_URL,
                  )
                }
              />

              <Button
                label="Check Again"
                variant="ghost"
                size="sm"
                onPress={() => void runCheck()}
              />
            </View>
          )}
        </View>

        {info?.latest.release_notes ? (
          <View style={styles.notesCard}>
            <Text variant="overline" tone="secondary">
              WHAT’S NEW
            </Text>
            <Text variant="bodySmall" tone="secondary" style={{ marginTop: 6 }}>
              {info.latest.release_notes}
            </Text>
          </View>
        ) : null}

        <View style={styles.securityCard}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Ionicons name="shield-checkmark" size={18} color={colors.success} />
            <Text variant="titleSmall">Seamless In-Place Upgrades</Text>
          </View>
          <Text variant="bodySmall" tone="secondary" style={{ marginTop: 6 }}>
            Every official Hallyu release is signed with our permanent 4096-bit RSA certificate so
            Android upgrades cleanly in place without ever uninstalling or losing your session.
          </Text>
          <Text
            variant="caption"
            tone="tertiary"
            style={{ marginTop: 8, fontFamily: fonts.medium, fontSize: 10.5 }}
          >
            SHA-256: {ANDROID_RELEASE_SHA256}
          </Text>
          <Text variant="caption" tone="tertiary" style={{ marginTop: 4 }}>
            iPhone & Web App: {getWebAppBaseUrl()}
          </Text>
        </View>
      </ScrollScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  heroCard: {
    alignItems: 'center',
    marginTop: space.x3,
    padding: space.x5,
    borderRadius: radius.xl,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressWrap: {
    gap: 6,
  },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surface3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.accent,
    borderRadius: 4,
  },
  notesCard: {
    marginTop: space.x4,
    padding: space.x4,
    borderRadius: radius.lg,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  securityCard: {
    marginTop: space.x4,
    padding: space.x4,
    borderRadius: radius.lg,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
});
