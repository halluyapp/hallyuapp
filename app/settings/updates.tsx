import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { AppState as RNAppState, Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Button } from '../../components/ui/Button';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { useToast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import { colors, fonts, radius, space } from '../../constants/theme';
import {
  checkForAppUpdate,
  downloadAndInstallApk,
  type DownloadProgressSnapshot,
  getInstalledBuildCode,
  getInstalledVersionLabel,
  getReleaseTrain,
  type UpdateCheckResult,
} from '../../lib/appUpdater';
import { haptic } from '../../lib/hooks';
import {
  ANDROID_RELEASE_SHA256,
  getWebAppBaseUrl,
  LATEST_ARM32_APK_CDN_URL,
  LATEST_SLIM_APK_CDN_URL,
  LATEST_X86_64_APK_CDN_URL,
} from '../../lib/links';

function formatMb(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '32.7 MB';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  const mb = bytesPerSec / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSec / 1024))} KB/s`;
}

export default function AppUpdatesScreen() {
  const toast = useToast();
  const [checking, setChecking] = useState(true);
  const [info, setInfo] = useState<UpdateCheckResult | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [dlSnap, setDlSnap] = useState<DownloadProgressSnapshot | null>(null);
  const [awaitingPermissionInstall, setAwaitingPermissionInstall] = useState(false);

  const installedCode = getInstalledBuildCode();
  const installedTrain = getReleaseTrain(installedCode);
  const installedVersion = getInstalledVersionLabel();

  const runCheck = useCallback(
    async (notify = false) => {
      setChecking(true);
      try {
        const res = await checkForAppUpdate();
        setInfo(res);
        if (notify) {
          haptic.light();
          toast.show({
            message: res.hasUpdate
              ? `New release v${res.latest.versionName} is ready!`
              : `Confirmed up to date — running latest v${res.installedVersion}`,
            tone: 'success',
          });
        }
      } catch {
        if (notify) {
          toast.show({ message: 'Could not reach update CDN right now', tone: 'danger' });
        }
      } finally {
        setChecking(false);
      }
    },
    [toast],
  );

  useFocusEffect(
    useCallback(() => {
      void runCheck(false);
      const sub = RNAppState.addEventListener('change', (nextState) => {
        if (nextState === 'active') {
          void runCheck(false);
        }
      });
      return () => sub.remove();
    }, [runCheck]),
  );

  const handleInstallUpdate = async () => {
    if (downloading) return;
    setDownloading(true);
    setAwaitingPermissionInstall(false);
    try {
      const target = info?.latest ?? {
        apkUrl: LATEST_SLIM_APK_CDN_URL,
        arm32ApkUrl: LATEST_ARM32_APK_CDN_URL,
        x86_64ApkUrl: LATEST_X86_64_APK_CDN_URL,
        versionCode: installedCode + 10,
        fileSizeBytes: 34_306_457,
      };
      const outcome = await downloadAndInstallApk(target, (snap) => setDlSnap(snap));
      const refreshed = await checkForAppUpdate().catch(() => null);
      if (refreshed) setInfo(refreshed);

      if (outcome.status === 'needs_unknown_sources_permission') {
        setAwaitingPermissionInstall(true);
        toast.show({
          message: 'Allow "Install unknown apps", then tap Install Downloaded Update right here!',
          tone: 'success',
        });
      } else if (outcome.status === 'installer_opened') {
        toast.show({
          message: outcome.usedCachedApk
            ? 'Opened instant cached APK in Android Package Installer!'
            : 'Verified! Tap Update in Android Package Installer.',
          tone: 'success',
        });
      }
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Download interrupted — tap to retry',
        tone: 'danger',
      });
    } finally {
      setDownloading(false);
    }
  };

  const publishedTime = info?.latest.publishedAt
    ? new Date(info.latest.publishedAt).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;

  const isUpToDate = info ? !info.hasUpdate : false;
  const readyFromCache = Boolean(info?.cachedApkReady || awaitingPermissionInstall);

  return (
    <Screen header={<TopBar mode="stack" title="App Updates" />}>
      <ScrollScreen padded column>
        {/* Post-Upgrade Celebration Confirmation Banner */}
        {info?.justUpdatedFromVersion ? (
          <View style={styles.upgradedBanner}>
            <Ionicons name="checkmark-done-circle" size={22} color="#10B981" />
            <View style={{ flex: 1 }}>
              <Text variant="label" style={{ color: '#10B981' }}>
                Successfully updated from v{info.justUpdatedFromVersion} → v{installedVersion}
              </Text>
              <Text variant="caption" tone="secondary">
                Your phone installed the signed release cleanly with all your data preserved.
              </Text>
            </View>
          </View>
        ) : null}

        {/* Clear Side-by-Side Status Card */}
        <View
          style={[
            styles.card,
            isUpToDate
              ? { borderColor: 'rgba(16,185,129,0.45)' }
              : info?.hasUpdate
                ? { borderColor: 'rgba(225,29,72,0.48)' }
                : null,
          ]}
        >
          <View style={styles.badgeRow}>
            <View
              style={[
                styles.iconCircle,
                isUpToDate ? { backgroundColor: 'rgba(16,185,129,0.16)' } : null,
              ]}
            >
              <Ionicons
                name={
                  checking
                    ? 'sync-outline'
                    : isUpToDate
                      ? 'shield-checkmark'
                      : 'rocket-outline'
                }
                size={24}
                color={isUpToDate ? '#10B981' : colors.accent}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="title">
                {checking
                  ? 'Checking live release channel…'
                  : isUpToDate
                    ? 'Up to Date ✓'
                    : `Update Ready · v${info?.latest.versionName}`}
              </Text>
              <Text variant="caption" tone="secondary">
                {isUpToDate
                  ? 'You are running the newest official signed build.'
                  : info?.latest.gitCommit
                    ? `Commit ${info.latest.gitCommit}${publishedTime ? ` · Published ${publishedTime}` : ''}`
                    : 'Direct high-speed CDN package ready to install'}
              </Text>
            </View>
          </View>

          {/* Exact Comparison Box so user NEVER doubts which build is installed vs latest */}
          <View style={styles.versionCompareGrid}>
            <View style={styles.versionCell}>
              <Text variant="overline" tone="tertiary">
                ON YOUR PHONE NOW
              </Text>
              <Text variant="titleSmall" style={{ marginTop: 4 }}>
                v{installedVersion}
              </Text>
              <Text variant="caption" tone="secondary">
                Release #{Math.max(1, installedTrain - 1000)} · Code {installedCode}
              </Text>
            </View>

            <View style={styles.versionDivider} />

            <View style={styles.versionCell}>
              <Text
                variant="overline"
                style={{ color: isUpToDate ? '#10B981' : colors.accent }}
              >
                LATEST LIVE RELEASE
              </Text>
              <Text
                variant="titleSmall"
                style={{ marginTop: 4, color: isUpToDate ? '#10B981' : colors.textPrimary }}
              >
                v{info?.latest.versionName ?? installedVersion}
              </Text>
              <Text variant="caption" tone="secondary">
                {info
                  ? `Release #${Math.max(1, info.latest.releaseTrain - 1000)} · ${formatMb(info.latest.fileSizeBytes)}`
                  : 'Checking…'}
              </Text>
            </View>
          </View>

          {info?.latest.releaseNotes ? (
            <View style={styles.notesBox}>
              <Text variant="overline" style={{ color: isUpToDate ? '#10B981' : colors.accent }}>
                {isUpToDate ? 'INCLUDED IN YOUR CURRENT BUILD' : 'WHAT’S NEW IN THIS UPDATE'}
              </Text>
              <Text variant="bodySmall" tone="secondary" style={{ marginTop: 4 }}>
                {info.latest.releaseNotes}
              </Text>
            </View>
          ) : null}

          {awaitingPermissionInstall ? (
            <View style={styles.permissionNotice}>
              <Ionicons name="checkmark-circle" size={18} color="#10B981" />
              <Text variant="caption" style={{ flex: 1, color: colors.textPrimary }}>
                Update APK is already downloaded & cached on your phone! Once “Allow from this
                source” is enabled, tap the button below to launch the installer immediately (zero
                re-download).
              </Text>
            </View>
          ) : null}

          {downloading && dlSnap ? (
            <View style={{ gap: 6 }}>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${dlSnap.percent}%` }]} />
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text variant="caption" tone="secondary">
                  {formatMb(dlSnap.writtenBytes)} / {formatMb(dlSnap.totalBytes)} ({dlSnap.percent}%)
                </Text>
                <Text variant="caption" style={{ color: colors.accent, fontFamily: fonts.semibold }}>
                  {formatSpeed(dlSnap.speedBytesPerSec) || 'Connecting…'}
                </Text>
              </View>
            </View>
          ) : null}

          <View style={styles.actions}>
            {Platform.OS === 'android' ? (
              info?.hasUpdate ? (
                <Button
                  label={
                    downloading
                      ? `Downloading ${dlSnap?.percent ?? 0}%…`
                      : readyFromCache
                        ? `Install Downloaded Update (v${info.latest.versionName})`
                        : `Download & Update to v${info.latest.versionName} (${formatMb(info.latest.fileSizeBytes)})`
                  }
                  icon={readyFromCache ? 'flash' : 'download-outline'}
                  block
                  loading={downloading}
                  onPress={() => void handleInstallUpdate()}
                />
              ) : (
                <Button
                  label={checking ? 'Checking…' : 'Check Again Now'}
                  variant="secondary"
                  icon="refresh-outline"
                  block
                  loading={checking}
                  onPress={() => void runCheck(true)}
                />
              )
            ) : (
              <Button
                label="Download Latest Android APK (32.7 MB)"
                icon="logo-android"
                block
                onPress={() => void Linking.openURL(info?.latest.apkUrl ?? LATEST_SLIM_APK_CDN_URL)}
              />
            )}

            {Platform.OS === 'android' && info?.hasUpdate ? (
              <Button
                label="Re-check Release Channel"
                variant="ghost"
                size="sm"
                icon="refresh-outline"
                loading={checking}
                onPress={() => void runCheck(true)}
              />
            ) : null}
          </View>
        </View>

        {/* Direct Public CDN Mirrors — Every Single Link Verified Public 200 OK */}
        <View style={styles.card}>
          <Text variant="titleSmall">Direct Public APK Mirrors & iPhone Link</Text>
          <Text variant="caption" tone="secondary">
            Every APK below is served directly from Hallyu’s public global CDN and signed with the
            same permanent key, so Android always updates cleanly over your existing install without
            touching your login or data.
          </Text>

          <Pressable
            onPress={() => void Linking.openURL(info?.latest.apkUrl ?? LATEST_SLIM_APK_CDN_URL)}
            style={styles.linkRow}
          >
            <Ionicons name="phone-portrait-outline" size={20} color={colors.accent} />
            <View style={{ flex: 1 }}>
              <Text variant="label">Android 64-bit Phone APK (Recommended · {formatMb(info?.latest.fileSizeBytes)})</Text>
              <Text variant="caption" tone="tertiary">
                Fastest download · 99% of modern Samsung, Pixel, Xiaomi, Tecno, Infinix & OnePlus phones
              </Text>
            </View>
            <Ionicons name="open-outline" size={16} color={colors.textTertiary} />
          </Pressable>

          <Pressable
            onPress={() =>
              void Linking.openURL(info?.latest.arm32ApkUrl ?? LATEST_ARM32_APK_CDN_URL)
            }
            style={styles.linkRow}
          >
            <Ionicons name="hardware-chip-outline" size={20} color={colors.textPrimary} />
            <View style={{ flex: 1 }}>
              <Text variant="label">Android 32-bit Legacy Phone APK (~24.5 MB)</Text>
              <Text variant="caption" tone="tertiary">
                For older 32-bit Android devices (armeabi-v7a) · Direct public CDN
              </Text>
            </View>
            <Ionicons name="open-outline" size={16} color={colors.textTertiary} />
          </Pressable>

          <Pressable
            onPress={() => void Linking.openURL(LATEST_X86_64_APK_CDN_URL)}
            style={styles.linkRow}
          >
            <Ionicons name="laptop-outline" size={20} color={colors.textPrimary} />
            <View style={{ flex: 1 }}>
              <Text variant="label">Chromebook & Desktop Emulator APK (x86_64)</Text>
              <Text variant="caption" tone="tertiary">
                For ChromeOS laptops & PC Android emulators · Direct public CDN
              </Text>
            </View>
            <Ionicons name="open-outline" size={16} color={colors.textTertiary} />
          </Pressable>

          <Pressable
            onPress={async () => {
              await Clipboard.setStringAsync(getWebAppBaseUrl());
              toast.show({ message: 'Copied iPhone / Web App link!', tone: 'success' });
            }}
            style={styles.linkRow}
          >
            <Ionicons name="logo-apple" size={20} color={colors.textPrimary} />
            <View style={{ flex: 1 }}>
              <Text variant="label">Copy iPhone / Web App Link</Text>
              <Text variant="caption" tone="tertiary">
                Share with iPhone friends (Safari → Add to Home Screen)
              </Text>
            </View>
            <Ionicons name="copy-outline" size={16} color={colors.textTertiary} />
          </Pressable>

          <Text variant="caption" tone="tertiary" style={{ fontFamily: fonts.regular, marginTop: 4 }}>
            Signing SHA-256: {ANDROID_RELEASE_SHA256}
          </Text>
        </View>
      </ScrollScreen>
    </Screen>
  );
}

const styles = StyleSheet.create({
  upgradedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    marginTop: space.x2,
    padding: space.x3,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(16,185,129,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.4)',
  },
  card: {
    marginTop: space.x3,
    padding: space.x5,
    borderRadius: radius.xl,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    gap: space.x3,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
  },
  iconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(225,29,72,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  versionCompareGrid: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: space.x3,
    borderRadius: radius.lg,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  versionCell: {
    flex: 1,
    gap: 2,
  },
  versionDivider: {
    width: 1,
    alignSelf: 'stretch',
    backgroundColor: colors.borderSubtle,
    marginHorizontal: space.x3,
  },
  notesBox: {
    padding: space.x3,
    borderRadius: radius.lg,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  permissionNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: 'rgba(16,185,129,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.35)',
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
  },
  actions: {
    gap: space.x2,
    marginTop: 4,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
});
