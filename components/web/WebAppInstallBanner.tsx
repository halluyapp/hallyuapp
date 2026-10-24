import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useMemo, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import { colors, fonts, radius, space } from '../../constants/theme';
import { isStandaloneWebApp, registerDevicePushToken } from '../../lib/api/pushToken';
import { getWebAppBaseUrl, LATEST_SLIM_APK_CDN_URL } from '../../lib/links';
import { Button } from '../ui/Button';
import { Sheet } from '../ui/Sheet';
import { Text } from '../ui/Text';
import { useToast } from '../ui/Toast';

function detectWebEnvironment(): {
  kind: 'android' | 'ios_safari' | 'ios_inapp' | 'desktop';
  standalone: boolean;
} {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') {
    return { kind: 'desktop', standalone: false };
  }
  const standalone = isStandaloneWebApp();
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return { kind: 'android', standalone };
  if (/iPhone|iPad|iPod/i.test(ua)) {
    const isCriOSOrFxiOSOrInApp =
      /CriOS|FxiOS|EdgiOS|OPiOS|Instagram|FBAN|FBAV|TikTok|Line|KAKAOTALK|Twitter|MicroMessenger/i.test(
        ua,
      );
    const hasSafari = /Safari/i.test(ua) && !isCriOSOrInAppFallback(ua);
    return {
      kind: !isCriOSOrFxiOSOrInApp && hasSafari ? 'ios_safari' : 'ios_inapp',
      standalone,
    };
  }
  return { kind: 'desktop', standalone };
}

function isCriOSOrInAppFallback(ua: string): boolean {
  return /CriOS|FxiOS|EdgiOS|Instagram|FBAN|FBAV|TikTok|Twitter/i.test(ua);
}

/**
 * Smart non-intrusive install & web-push banner for Web visitors:
 *  - Hidden inside the Native Android APK (`Platform.OS !== 'web'`).
 *  - When opened on iPhone/iPad inside Home-Screen standalone mode: offers 1-tap Lock-Screen Notifications if not enabled yet.
 *  - When opened in Mobile/Desktop Browser: offers instant Android APK download + 2-tap iPhone Home-Screen guide.
 */
export function WebAppInstallBanner() {
  const toast = useToast();
  const [dismissed, setDismissed] = useState(false);
  const [iosGuideOpen, setIosGuideOpen] = useState(false);
  const env = useMemo(() => detectWebEnvironment(), []);

  if (Platform.OS !== 'web' || dismissed) return null;

  // Inside installed iOS / Desktop standalone Home-Screen Web App: offer 1-tap Push activation only if default permission
  if (env.standalone) {
    const canAskPush =
      typeof Notification !== 'undefined' && Notification.permission === 'default';
    if (!canAskPush) return null;
    return (
      <View style={styles.host}>
        <LinearGradient
          colors={['rgba(225,29,72,0.18)', colors.surface1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.banner}
        >
          <View style={styles.iconCircle}>
            <Ionicons name="notifications" size={18} color={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="label">Turn on Lock-Screen Alerts</Text>
            <Text variant="caption" tone="secondary" numberOfLines={2}>
              Get instant episode drops, replies & DMs right on your iPhone lock screen.
            </Text>
          </View>
          <Pressable
            onPress={async () => {
              const ok = await registerDevicePushToken(true);
              if (ok) {
                toast.show({
                  message: 'Lock-screen push notifications enabled!',
                  tone: 'success',
                });
                setDismissed(true);
              } else {
                toast.show({
                  message: 'Allow notifications in prompt to receive live alerts',
                });
              }
            }}
            style={styles.ctaPill}
          >
            <Text variant="label" tone="onAccent">
              Enable
            </Text>
          </Pressable>
          <Pressable onPress={() => setDismissed(true)} hitSlop={10}>
            <Ionicons name="close" size={16} color={colors.textTertiary} />
          </Pressable>
        </LinearGradient>
      </View>
    );
  }

  const isIos = env.kind === 'ios_safari' || env.kind === 'ios_inapp';

  return (
    <>
      <View style={styles.host}>
        <LinearGradient
          colors={['rgba(225,29,72,0.2)', colors.surface1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.banner}
        >
          <View style={styles.iconCircle}>
            <Ionicons
              name={isIos ? 'phone-portrait-outline' : 'logo-android'}
              size={18}
              color={colors.accent}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="label">
              {isIos ? 'Install Hallyu on iPhone' : 'Get the Hallyu App'}
            </Text>
            <Text variant="caption" tone="secondary" numberOfLines={1}>
              {isIos
                ? 'Full-screen cinema mode + Apple lock-screen notifications'
                : 'Native Android APK · Instant updates · Live watch rooms'}
            </Text>
          </View>
          {isIos ? (
            <Pressable onPress={() => setIosGuideOpen(true)} style={styles.ctaPill}>
              <Text variant="label" tone="onAccent">
                Install
              </Text>
            </Pressable>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Pressable
                onPress={() => void Linking.openURL(LATEST_SLIM_APK_CDN_URL)}
                style={styles.ctaPill}
              >
                <Text variant="label" tone="onAccent">
                  Android APK
                </Text>
              </Pressable>
              {env.kind === 'desktop' ? (
                <Pressable onPress={() => setIosGuideOpen(true)} style={styles.secondaryPill}>
                  <Text variant="caption" style={{ color: colors.textPrimary, fontFamily: fonts.semibold }}>
                    iOS
                  </Text>
                </Pressable>
              ) : null}
            </View>
          )}
          <Pressable onPress={() => setDismissed(true)} hitSlop={10}>
            <Ionicons name="close" size={16} color={colors.textTertiary} />
          </Pressable>
        </LinearGradient>
      </View>

      <Sheet
        visible={iosGuideOpen}
        onClose={() => setIosGuideOpen(false)}
        title="Install Hallyu on iPhone / iPad"
      >
        <View style={{ gap: space.x4 }}>
          <Text variant="bodySmall" tone="secondary">
            Hallyu runs as a full-screen native-feel iOS app with real Apple lock-screen push
            notifications — no App Store required.
          </Text>

          {env.kind === 'ios_inapp' ? (
            <View style={styles.warnBox}>
              <Ionicons name="compass-outline" size={20} color={colors.warm} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text variant="label" style={{ color: colors.warm }}>
                  Open in Safari first
                </Text>
                <Text variant="caption" tone="secondary">
                  You opened this link inside an in-app browser. Copy the link below and paste it
                  into Safari so Apple shows “Add to Home Screen”.
                </Text>
                <Button
                  label="Copy Hallyu Web Link"
                  size="sm"
                  style={{ marginTop: 6, alignSelf: 'flex-start' }}
                  onPress={async () => {
                    await Clipboard.setStringAsync(getWebAppBaseUrl());
                    toast.show({ message: 'Copied! Paste into Safari to install.', tone: 'success' });
                  }}
                />
              </View>
            </View>
          ) : null}

          <View style={styles.stepCard}>
            <View style={styles.stepBadge}>
              <Text variant="label" tone="onAccent">
                1
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall">Tap the Share button in Safari</Text>
              <Text variant="caption" tone="secondary">
                Look for the square icon with an upward arrow (↑) at the bottom of Safari.
              </Text>
            </View>
            <Ionicons name="share-outline" size={22} color={colors.accent} />
          </View>

          <View style={styles.stepCard}>
            <View style={styles.stepBadge}>
              <Text variant="label" tone="onAccent">
                2
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall">Tap “Add to Home Screen”</Text>
              <Text variant="caption" tone="secondary">
                Tap Add in the top-right corner, then open Hallyu from your Home Screen to enable
                instant notifications.
              </Text>
            </View>
            <Ionicons name="add-circle-outline" size={22} color={colors.live} />
          </View>

          <Button label="Got it" block onPress={() => setIosGuideOpen(false)} />
        </View>
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  host: {
    paddingHorizontal: space.margin,
    paddingBottom: space.x2,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    paddingHorizontal: space.x3,
    paddingVertical: 10,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(225,29,72,0.32)',
  },
  iconCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(225,29,72,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaPill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  secondaryPill: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.full,
    backgroundColor: colors.surface3,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  warnBox: {
    flexDirection: 'row',
    gap: space.x3,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.warmSoft,
    borderWidth: 1,
    borderColor: 'rgba(242,184,75,0.35)',
  },
  stepCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  stepBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
