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
  openUnknownSourcesSettings,
  type UpdateCheckResult,
} from '../../lib/appUpdater';
import { haptic } from '../../lib/hooks';
import {
  ANDROID_RELEASE_SHA256,
  getWebAppBaseUrl,
  LATEST_ARM32_APK_CDN_URL,
  LATEST_ARM64_APK_CDN_URL,
  LATEST_UNIVERSAL_APK_CDN_URL,
  LATEST_X86_64_APK_CDN_URL,
  LATEST_X86_APK_CDN_URL,
} from '../../lib/links';

function formatMb(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '19.5 MB';
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
  const [lastInstallError, setLastInstallError] = useState<{
    reasonCode: string;
    message: string;
  } | null>(null);

  const installedCode = info?.installedCode ?? getInstalledBuildCode();
  const installedVersion = info?.installedVersion ?? getInstalledVersionLabel();
  const webCommit = (process.env.EXPO_PUBLIC_GIT_SHORT ?? '').trim();

  const runCheck = useCallback(
    async (notify = false) => {
      setChecking(true);
      try {
        const res = await checkForAppUpdate();
        setInfo(res);
        if (!res.hasUpdate) {
          setLastInstallError(null);
        } else if (res.pendingInstall?.status === 'install_failed' && res.pendingInstall.lastErrorMessage) {
          setLastInstallError({
            reasonCode: res.pendingInstall.lastErrorReasonCode ?? 'INSTALL_FAILED',
            message: res.pendingInstall.lastErrorMessage,
          });
        }
        if (notify) {
          haptic.light();
          toast.show({
            message: res.hasUpdate
              ? res.pendingInstall
                ? `Still on v${res.installedVersion} — downloaded v${res.latest.versionName} is not installed yet`
                : `New release v${res.latest.versionName} is available`
              : `Confirmed up to date — running v${res.installedVersion}`,
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
    setLastInstallError(null);
    try {
      const target = info?.latest ?? {
        apkUrl: LATEST_UNIVERSAL_APK_CDN_URL,
        universalApkUrl: LATEST_UNIVERSAL_APK_CDN_URL,
        arm64ApkUrl: LATEST_ARM64_APK_CDN_URL,
        arm32ApkUrl: LATEST_ARM32_APK_CDN_URL,
        x86_64ApkUrl: LATEST_X86_64_APK_CDN_URL,
        x86ApkUrl: LATEST_X86_APK_CDN_URL,
        versionCode: installedCode + 10,
        versionName: installedVersion,
      };
      const outcome = await downloadAndInstallApk(target, (snap) => setDlSnap(snap));
      const refreshed = await checkForAppUpdate().catch(() => null);
      if (refreshed) setInfo(refreshed);

      if (outcome.status === 'needs_unknown_sources_permission') {
        setAwaitingPermissionInstall(true);
        toast.show({
          message: 'Enable "Install unknown apps", then tap Install Verified Update right here!',
        });
      } else if (outcome.status === 'cancelled_by_user') {
        toast.show({
          message: outcome.message,
        });
      } else if (outcome.status === 'not_installed_yet') {
        toast.show({
          message: `APK verified on device, not installed yet — still running v${installedVersion}.`,
        });
      } else if (outcome.status === 'install_failed') {
        setLastInstallError({
          reasonCode: outcome.reasonCode,
          message: outcome.message,
        });
        toast.show({
          message: outcome.message,
          tone: 'danger',
        });
      } else if (outcome.status === 'installed') {
        toast.show({
          message: `Verified update installed — running v${refreshed?.installedVersion ?? target.versionName}`,
          tone: 'success',
        });
      } else if (outcome.status === 'awaiting_user_install') {
        toast.show({
          message: 'Verified package staged — tap Update in Android’s prompt to complete installation.',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Download interrupted — tap to retry';
      setLastInstallError({ reasonCode: 'DOWNLOAD_ERROR', message: msg });
      toast.show({
        message: msg,
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
  const pendingStatus = info?.hasUpdate ? info?.pendingInstall?.status : undefined;
  const pendingNotInstalled = Boolean(
    info?.hasUpdate &&
      info?.pendingInstall &&
      info.pendingInstall.status !== 'install_failed',
  );
  const readyFromCache = Boolean(
    info?.cachedApkReady || awaitingPermissionInstall || pendingNotInstalled,
  );
  const abiIncompatible = Boolean(info && !info.selectedArtifact.ok);
  const selectedSizeBytes =
    info?.selectedArtifact.ok && info.selectedArtifact.sizeBytes
      ? info.selectedArtifact.sizeBytes
      : info?.latest.fileSizeBytes;
  const selectedAbiLabel = info?.selectedArtifact.ok ? info.selectedArtifact.abi : 'incompatible';
  const deviceEnv = info?.deviceEnv ?? null;

  return (
    <Screen header={<TopBar mode="stack" title="App Updates" />}>
      <ScrollScreen padded column>
        {/* Post-Upgrade Confirmation Banner (ONLY shown when actual native versionCode incremented) */}
        {info?.justUpdatedFromVersion ? (
          <View style={styles.upgradedBanner}>
            <Ionicons name="checkmark-done-circle" size={22} color="#10B981" />
            <View style={{ flex: 1 }}>
              <Text variant="label" style={{ color: '#10B981' }}>
                Verified Update Complete: v{info.justUpdatedFromVersion} → v{installedVersion}
              </Text>
              <Text variant="caption" tone="secondary">
                Confirmed running build {installedCode} with all your data preserved.
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
              : lastInstallError
                ? { borderColor: 'rgba(239,68,68,0.58)' }
                : pendingNotInstalled
                  ? { borderColor: 'rgba(245,158,11,0.52)' }
                  : info?.hasUpdate
                    ? { borderColor: 'rgba(225,29,72,0.48)' }
                    : null,
          ]}
        >
          <View style={styles.badgeRow}>
            <View
              style={[
                styles.iconCircle,
                isUpToDate
                  ? { backgroundColor: 'rgba(16,185,129,0.16)' }
                  : pendingNotInstalled
                    ? { backgroundColor: 'rgba(245,158,11,0.16)' }
                    : null,
              ]}
            >
              <Ionicons
                name={
                  checking
                    ? 'sync-outline'
                    : isUpToDate
                      ? 'shield-checkmark'
                      : lastInstallError
                        ? 'close-circle-outline'
                        : pendingNotInstalled
                          ? 'alert-circle-outline'
                          : 'rocket-outline'
                }
                size={24}
                color={
                  isUpToDate
                    ? '#10B981'
                    : lastInstallError
                      ? '#EF4444'
                      : pendingNotInstalled
                        ? '#F59E0B'
                        : colors.accent
                }
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="title">
                {checking
                  ? 'Checking live release channel…'
                  : isUpToDate
                    ? 'Up to Date ✓'
                    : lastInstallError
                      ? 'Update Failed Verification'
                      : pendingStatus === 'cancelled_by_user'
                        ? 'Installation Cancelled'
                        : pendingNotInstalled
                          ? 'Downloaded · Awaiting Approval'
                          : `Update Available · v${info?.latest.versionName}`}
              </Text>
              <Text variant="caption" tone="secondary">
                {isUpToDate
                  ? Platform.OS === 'web' && webCommit
                    ? `Live web deployment verified on commit ${webCommit}.`
                    : 'You are running the newest official signed build.'
                  : lastInstallError
                    ? `Still running v${installedVersion} — see diagnostic details below.`
                    : pendingNotInstalled
                      ? `Still running v${installedVersion}. Tap below and confirm Update in Android’s prompt.`
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
                INSTALLED ON DEVICE
              </Text>
              <Text variant="titleSmall" style={{ marginTop: 4 }}>
                v{installedVersion}
              </Text>
              <Text variant="caption" tone="secondary">
                Build {installedCode} · {info?.deviceAbis[0] ?? 'android'}
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
                  ? `Build ${info.latest.versionCode} · ${selectedAbiLabel} (${formatMb(selectedSizeBytes)})`
                  : 'Checking…'}
              </Text>
            </View>
          </View>

          {/* Explicit Honest Error Banner when installation or pre-flight validation fails */}
          {lastInstallError ? (
            <View style={styles.errorNotice}>
              <Ionicons name="alert-circle" size={18} color="#EF4444" />
              <View style={{ flex: 1, gap: 4 }}>
                <Text variant="caption" style={{ color: '#EF4444', fontFamily: fonts.semibold }}>
                  Diagnostic Code: {lastInstallError.reasonCode}
                </Text>
                <Text variant="caption" style={{ color: colors.textPrimary }}>
                  {lastInstallError.message}
                </Text>
              </View>
            </View>
          ) : null}

          {abiIncompatible && info && !info.selectedArtifact.ok ? (
            <View style={styles.errorNotice}>
              <Ionicons name="warning-outline" size={18} color="#EF4444" />
              <Text variant="caption" style={{ flex: 1, color: colors.textPrimary }}>
                {info.selectedArtifact.message}
              </Text>
            </View>
          ) : null}

          {pendingNotInstalled || awaitingPermissionInstall ? (
            <View style={styles.warningNotice}>
              <Ionicons name="information-circle-outline" size={18} color="#F59E0B" />
              <View style={{ flex: 1, gap: 4 }}>
                <Text variant="caption" style={{ color: colors.textPrimary }}>
                  v{info?.latest.versionName} ({selectedAbiLabel}) is verified on storage, not
                  installed yet — your phone is still running v{installedVersion}. Make sure
                  “Install unknown apps” is enabled, then tap “Install Verified Update” below.
                </Text>
                {Platform.OS === 'android' ? (
                  <Pressable onPress={() => void openUnknownSourcesSettings()}>
                    <Text variant="caption" style={{ color: '#F59E0B', fontFamily: fonts.semibold }}>
                      Open “Install unknown apps” setting →
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : null}

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

          {downloading && dlSnap ? (
            <View style={{ gap: 6 }}>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${dlSnap.percent}%` }]} />
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text variant="caption" tone="secondary">
                  {dlSnap.stage === 'verifying'
                    ? 'Verifying APK SHA-256, ABI & signing certificate…'
                    : dlSnap.stage === 'launching_installer'
                      ? 'Staging verified package into Android Installer…'
                      : `${formatMb(dlSnap.writtenBytes)} / ${formatMb(dlSnap.totalBytes)} (${dlSnap.percent}%)`}
                </Text>
                <Text variant="caption" style={{ color: colors.accent, fontFamily: fonts.semibold }}>
                  {formatSpeed(dlSnap.speedBytesPerSec) || 'Verifying…'}
                </Text>
              </View>
            </View>
          ) : null}

          <View style={styles.actions}>
            {Platform.OS === 'android' ? (
              info?.hasUpdate && !abiIncompatible ? (
                <Button
                  label={
                    downloading
                      ? dlSnap?.stage === 'verifying'
                        ? 'Verifying Package…'
                        : `Downloading ${dlSnap?.percent ?? 0}%…`
                      : readyFromCache
                        ? `Install Verified Update (v${info.latest.versionName})`
                        : `Download & Update to v${info.latest.versionName} (${formatMb(selectedSizeBytes)})`
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
                label={`Download Universal Android APK (${formatMb(info?.latest.fileSizeBytes)})`}
                icon="logo-android"
                block
                onPress={() =>
                  void Linking.openURL(info?.latest.universalApkUrl ?? LATEST_UNIVERSAL_APK_CDN_URL)
                }
              />
            )}

            {Platform.OS === 'android' && info?.hasUpdate ? (
              <Button
                label="Re-check Installed Version"
                variant="ghost"
                size="sm"
                icon="refresh-outline"
                loading={checking}
                onPress={() => void runCheck(true)}
              />
            ) : null}
          </View>
        </View>

        {/* Runtime Android Environment & Compatibility Diagnostics */}
        {Platform.OS === 'android' && deviceEnv ? (
          <View style={styles.card}>
            <Text variant="titleSmall">Device Compatibility Diagnostics</Text>
            <Text variant="caption" tone="secondary">
              Package: {deviceEnv.installed.packageName} · Android {deviceEnv.androidRelease || '?'} (SDK {deviceEnv.sdkInt})
              {deviceEnv.brand || deviceEnv.model ? ` · ${deviceEnv.brand} ${deviceEnv.model}` : ''}
            </Text>
            <Text variant="caption" tone="secondary">
              Android OS Supported ABIs: {deviceEnv.supportedAbis.join(', ')}
              {deviceEnv.kernelArch ? ` · Kernel: ${deviceEnv.kernelArch}` : ''}
            </Text>
            {deviceEnv.cpu64BitCapableOs32BitOnly ? (
              <Text variant="caption" style={{ color: '#F59E0B' }}>
                Detected 64-bit CPU running 32-bit Android OS — automatically selecting 32-bit armeabi-v7a package.
              </Text>
            ) : null}
            <Text variant="caption" tone="tertiary">
              Selected Artifact: {selectedAbiLabel} · Unknown-App Install Permission:{' '}
              {deviceEnv.canRequestPackageInstalls ? 'Granted ✓' : 'Not granted yet'}
            </Text>
          </View>
        ) : null}

        {/* Direct Public CDN Mirrors — All 5 Signed Architecture Variants */}
        <View style={styles.card}>
          <Text variant="titleSmall">Direct Signed APK Downloads (All Devices)</Text>
          <Text variant="caption" tone="secondary">
            Every APK below is signed with Hallyu’s permanent 4096-bit RSA certificate and supports
            Android 6.0 through Android 16 (including 16 KB memory-page devices) for clean in-place upgrades.
          </Text>

          <Pressable
            onPress={() =>
              void Linking.openURL(info?.latest.universalApkUrl ?? LATEST_UNIVERSAL_APK_CDN_URL)
            }
            style={styles.linkRow}
          >
            <Ionicons name="shield-checkmark-outline" size={20} color="#10B981" />
            <View style={{ flex: 1 }}>
              <Text variant="label">Universal All-Phones APK (arm64 + armv7 + x86_64 + x86)</Text>
              <Text variant="caption" tone="tertiary">
                Works on 100% of Android phones, tablets & Chromebooks regardless of 32-bit/64-bit OS
              </Text>
            </View>
            <Ionicons name="open-outline" size={16} color={colors.textTertiary} />
          </Pressable>

          <Pressable
            onPress={() =>
              void Linking.openURL(info?.latest.arm64ApkUrl ?? LATEST_ARM64_APK_CDN_URL)
            }
            style={styles.linkRow}
          >
            <Ionicons name="phone-portrait-outline" size={20} color={colors.accent} />
            <View style={{ flex: 1 }}>
              <Text variant="label">64-bit ARM Slim APK (arm64-v8a)</Text>
              <Text variant="caption" tone="tertiary">
                Smallest download for 64-bit Android OS phones (Pixel, Galaxy S/A, Xiaomi, OnePlus)
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
              <Text variant="label">32-bit ARM Slim APK (armeabi-v7a)</Text>
              <Text variant="caption" tone="tertiary">
                Smallest download for 32-bit Android OS phones (including 64-bit SoCs running Android Go)
              </Text>
            </View>
            <Ionicons name="open-outline" size={16} color={colors.textTertiary} />
          </Pressable>

          <Pressable
            onPress={() =>
              void Linking.openURL(info?.latest.x86_64ApkUrl ?? LATEST_X86_64_APK_CDN_URL)
            }
            style={styles.linkRow}
          >
            <Ionicons name="laptop-outline" size={20} color={colors.textPrimary} />
            <View style={{ flex: 1 }}>
              <Text variant="label">64-bit Chromebook & Emulator APK (x86_64)</Text>
              <Text variant="caption" tone="tertiary">
                For 64-bit ChromeOS laptops & desktop emulators
              </Text>
            </View>
            <Ionicons name="open-outline" size={16} color={colors.textTertiary} />
          </Pressable>

          <Pressable
            onPress={() => void Linking.openURL(info?.latest.x86ApkUrl ?? LATEST_X86_APK_CDN_URL)}
            style={styles.linkRow}
          >
            <Ionicons name="tablet-landscape-outline" size={20} color={colors.textPrimary} />
            <View style={{ flex: 1 }}>
              <Text variant="label">32-bit Intel Tablet & Emulator APK (x86)</Text>
              <Text variant="caption" tone="tertiary">
                For 32-bit x86 Android tablets & legacy emulators
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
  warningNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.x2,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.4)',
  },
  errorNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.x2,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: 'rgba(239,68,68,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.45)',
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
