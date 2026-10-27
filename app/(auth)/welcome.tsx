import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Linking, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LivingWall } from '../../components/onboarding/LivingWall';
import { Button } from '../../components/ui/Button';
import { Sheet } from '../../components/ui/Sheet';
import { Text } from '../../components/ui/Text';
import { useToast } from '../../components/ui/Toast';
import { Wordmark } from '../../components/ui/TopBar';
import { colors, fonts, motion, radius, space } from '../../constants/theme';
import { useAuth } from '../../lib/auth';
import { catalog } from '../../lib/catalog';
import { adoptDramas } from '../../lib/catalogSync';
import { dramaFandom, FANDOMS } from '../../lib/fandoms';
import { haptic, useLayout, useLoad, useReduceMotion } from '../../lib/hooks';
import {
  ADMIN_CONTACT_EMAIL,
  ANDROID_RELEASE_SHA256,
  getWebAppBaseUrl,
  LATEST_ARM32_APK_CDN_URL,
  LATEST_ARM64_APK_CDN_URL,
  LATEST_UNIVERSAL_APK_CDN_URL,
  LATEST_X86_64_APK_CDN_URL,
  SUPPORT_EMAIL,
} from '../../lib/links';
import { withAlpha } from '../../lib/motion';
import { allDramas, useSlice } from '../../lib/store';

/**
 * Midnight Premiere Welcome (Native Mobile) + Full Premiere Showcase Landing Page (Web).
 *
 * Preserves exact native cold-boot controls ("Create an account", "I already have an account",
 * "Browse as a guest") above the fold for instant mobile auth & emulator verification, while on Web
 * expanding seamlessly into the flagship Hallyu Landing Page complete with:
 *   - Direct Signed Android APK Download (Slim ARM64 + Universal)
 *   - 2-Tap iPhone / iPad Full-Screen Home-Screen Installer + Lock-Screen Push Guide
 *   - Interactive 4-Screen Hallyu App Screenshots Showcase (Social Feed, Watch Party Poll,
 *     Explore Live Rankings, and Lock-Screen Notifications & Top-4 Profile)
 */
export default function Welcome() {
  const router = useRouter();
  const auth = useAuth();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { width } = useLayout();
  const reduce = useReduceMotion();
  const rise = useRef(new Animated.Value(24)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const kenBurns = useRef(new Animated.Value(1)).current;
  const [spotIdx, setSpotIdx] = useState(0);
  const [iosGuideOpen, setIosGuideOpen] = useState(false);

  useEffect(() => {
    if (reduce) {
      rise.setValue(0);
      fade.setValue(1);
      return;
    }
    Animated.parallel([
      Animated.timing(rise, { toValue: 0, duration: motion.slow, useNativeDriver: true }),
      Animated.timing(fade, { toValue: 1, duration: motion.slow, useNativeDriver: true }),
    ]).start();
  }, [rise, fade, reduce]);

  const importedDramas = useSlice((s) => s.importedDramas);
  const cols = width >= 840 ? 6 : width >= 600 ? 5 : 4;
  const posterW = Math.max(88, Math.floor((width - space.margin * 2 - space.x2 * (cols - 1)) / cols));

  const live = useLoad(
    async (signal) => {
      const [kd, cd, an, hw] = await Promise.all([
        catalog.byFandom('kdrama', 'trending', 1, signal).catch(() => [] as typeof importedDramas),
        catalog.byFandom('cdrama', 'trending', 1, signal).catch(() => [] as typeof importedDramas),
        catalog.byFandom('anime', 'trending', 1, signal).catch(() => [] as typeof importedDramas),
        catalog.byFandom('hollywood', 'trending', 1, signal).catch(() => [] as typeof importedDramas),
      ]);
      const interleaved: typeof importedDramas = [];
      const maxLen = Math.max(kd.length, cd.length, an.length, hw.length);
      for (let i = 0; i < maxLen; i++) {
        if (kd[i]) interleaved.push(kd[i]!);
        if (cd[i]) interleaved.push(cd[i]!);
        if (an[i]) interleaved.push(an[i]!);
        if (hw[i]) interleaved.push(hw[i]!);
      }
      return adoptDramas(interleaved);
    },
    [],
    catalog.available,
  );

  const mosaic = useMemo(() => {
    const trending = (live.data ?? []).filter((d) => d.posterUrl || d.backdropUrl);
    const all = allDramas({ importedDramas });
    const withArt = all.filter((d) => d.posterUrl || d.backdropUrl || d.posterLocal);
    const seen = new Set(trending.map((d) => d.id));
    return [...trending, ...withArt.filter((d) => !seen.has(d.id))];
  }, [importedDramas, live.data]);

  const spotlights = useMemo(
    () => mosaic.filter((d) => d.backdropUrl || d.posterUrl).slice(0, 6),
    [mosaic],
  );

  useEffect(() => {
    if (reduce || spotlights.length <= 1) return;
    kenBurns.setValue(1);
    const drift = Animated.timing(kenBurns, {
      toValue: 1.07,
      duration: 5600,
      useNativeDriver: true,
    });
    drift.start();
    const timer = setInterval(() => {
      setSpotIdx((prev) => (prev + 1) % spotlights.length);
    }, 5600);
    return () => {
      drift.stop();
      clearInterval(timer);
    };
  }, [spotIdx, spotlights.length, kenBurns, reduce]);

  const activeDrama = spotlights[spotIdx];
  const activeWorld = activeDrama ? dramaFandom(activeDrama) : FANDOMS[0]!;
  const heroArt = activeDrama?.backdropUrl ?? activeDrama?.posterUrl;
  const tiles = cols * 2;

  // Native mobile: clean single-viewport Midnight Premiere door
  if (Platform.OS !== 'web') {
    return (
      <View style={styles.root}>
        <View style={styles.heroBackdrop} pointerEvents="none">
          {heroArt ? (
            <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ scale: kenBurns }] }]}>
              <Image
                source={{ uri: heroArt }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={650}
              />
            </Animated.View>
          ) : (
            <LivingWall key={tiles} dramas={mosaic} tiles={tiles} tileWidth={posterW} height="100%" />
          )}
          <LinearGradient
            colors={['rgba(0,0,0,0.46)', 'rgba(0,0,0,0.28)', 'rgba(0,0,0,0.84)', colors.canvas]}
            locations={[0, 0.32, 0.72, 1]}
            style={StyleSheet.absoluteFill}
          />
        </View>

        <View style={[styles.topBar, { paddingTop: insets.top + space.x3 }]}>
          <Wordmark size={34} />
          <View style={styles.worldPills}>
            {FANDOMS.map((w) => {
              const on = w.id === activeWorld.id;
              return (
                <View
                  key={w.id}
                  style={[
                    styles.worldMiniPill,
                    on ? { borderColor: w.tint, backgroundColor: withAlpha(w.tint, 0.22) } : null,
                  ]}
                >
                  <Text style={{ fontSize: 11 }}>{w.flag}</Text>
                  {on ? (
                    <Text variant="caption" style={{ color: w.tint, fontWeight: '700' }}>
                      {w.short}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        </View>

        <Animated.View
          style={[
            styles.content,
            {
              paddingBottom: insets.bottom + space.x5,
              opacity: fade,
              transform: [{ translateY: rise }],
            },
          ]}
        >
          {activeDrama ? (
            <Pressable
              onPress={() => {
                haptic.select();
                setSpotIdx((i) => (i + 1) % Math.max(1, spotlights.length));
              }}
              style={[styles.nowShowingPill, { borderColor: withAlpha(activeWorld.tint, 0.5) }]}
              accessibilityRole="button"
              accessibilityLabel={`Featured tonight: ${activeDrama.title}`}
            >
              <View style={[styles.liveDot, { backgroundColor: activeWorld.tint }]} />
              <Text variant="caption" style={{ color: activeWorld.tint, fontWeight: '700' }}>
                {activeWorld.short.toUpperCase()}
              </Text>
              <Text variant="caption" tone="secondary" numberOfLines={1} style={{ flexShrink: 1 }}>
                {activeDrama.title}
                {activeDrama.rating ? ` · ★ ${activeDrama.rating.toFixed(1)}` : ''}
              </Text>
            </Pressable>
          ) : null}

          <Text variant="displayLarge" style={{ marginTop: space.x3 }}>
            Every episode night.{'\n'}Together.
          </Text>
          <Text variant="bodyLarge" tone="secondary" style={{ marginTop: space.x3 }}>
            Social reactions, synchronized Watch Parties, DMs, and spoiler-safe threads across
            K-Drama, C-Drama, Anime & Cinema.
          </Text>

          <View style={{ gap: space.x3, marginTop: space.x6 }}>
            <Button
              label="Create an account"
              icon="sparkles"
              size="lg"
              block
              onPress={() => router.push('/(auth)/sign-up')}
            />
            <Button
              label="I already have an account"
              variant="secondary"
              size="lg"
              block
              onPress={() => router.push('/(auth)/sign-in')}
            />
          </View>

          <View style={styles.guestRow}>
            <Button
              label="Browse as a guest"
              variant="ghost"
              size="sm"
              iconRight="arrow-forward"
              onPress={() => {
                auth.continueAsGuest();
                router.replace('/(tabs)');
              }}
            />
          </View>

          <View style={styles.footerMeta}>
            <Ionicons name="shield-checkmark-outline" size={12} color={colors.textTertiary} />
            <Text variant="caption" tone="tertiary">
              Real-time Social · Spoiler-Shielded · Powered by Hallyu Cloud
            </Text>
          </View>
        </Animated.View>
      </View>
    );
  }

  // ============================================================================
  // WEB FLAGSHIP PREMIERE LANDING PAGE + INTERACTIVE APP SCREENSHOTS SHOWCASE
  // ============================================================================
  const previewDramas = mosaic.slice(0, 4);

  return (
    <View style={styles.root}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: space.x12 }}
        showsVerticalScrollIndicator={false}
      >
        {/* HERO SECTION */}
        <View style={styles.webHero}>
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {heroArt ? (
              <Image
                source={{ uri: heroArt }}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
                transition={650}
              />
            ) : (
              <LivingWall key={tiles} dramas={mosaic} tiles={tiles} tileWidth={posterW} height="100%" />
            )}
            <LinearGradient
              colors={['rgba(0,0,0,0.62)', 'rgba(0,0,0,0.45)', 'rgba(0,0,0,0.92)', '#000000']}
              locations={[0, 0.35, 0.78, 1]}
              style={StyleSheet.absoluteFill}
            />
          </View>

          {/* Top Navigation Bar */}
          <View style={[styles.webNav, { paddingTop: Math.max(insets.top, 18) }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Wordmark size={34} />
              <View style={styles.webBetaBadge}>
                <Text variant="overline" style={{ color: colors.accent }}>
                  ANDROID · iOS · WEB
                </Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Button
                label="Watch Parties"
                variant="ghost"
                size="sm"
                icon="flame-outline"
                onPress={() => {
                  auth.continueAsGuest();
                  router.push('/events');
                }}
              />
              <Button
                label="Sign in"
                variant="secondary"
                size="sm"
                onPress={() => router.push('/(auth)/sign-in')}
              />
              <Button
                label="Open Web App"
                size="sm"
                iconRight="arrow-forward"
                onPress={() => {
                  auth.continueAsGuest();
                  router.replace('/(tabs)');
                }}
              />
            </View>
          </View>

          {/* Hero Centerpiece */}
          <View style={styles.webHeroBody}>
            <View style={styles.heroLiveBadge}>
              <View style={[styles.liveDot, { backgroundColor: colors.accent }]} />
              <Text variant="overline" style={{ color: '#FFFFFF' }}>
                LIVE WATCH ROOMS · ZERO SPOILERS · K-DRAMA · C-DRAMA · ANIME · CINEMA
              </Text>
            </View>

            <Text variant="displayLarge" align="center" style={{ marginTop: space.x4, maxWidth: 780 }}>
              Every episode night. Together.
            </Text>
            <Text
              variant="bodyLarge"
              tone="secondary"
              align="center"
              style={{ marginTop: space.x3, maxWidth: 650 }}
            >
              React in real time with friends, join synchronized finale Watch Parties, lock in
              predictions before plot twists drop, and track every show with automatic spoiler shields.
            </Text>

            {/* Primary Multi-Platform Install & Launch Buttons */}
            <View style={styles.webCtaRow}>
              <Button
                label="Download Android APK"
                icon="logo-android"
                size="lg"
                onPress={() => void Linking.openURL(LATEST_UNIVERSAL_APK_CDN_URL)}
              />
              <Button
                label="Install on iPhone / iPad"
                variant="secondary"
                icon="logo-apple"
                size="lg"
                onPress={() => setIosGuideOpen(true)}
              />
              <Button
                label="Launch Web App Now"
                variant="ghost"
                icon="globe-outline"
                size="lg"
                onPress={() => {
                  auth.continueAsGuest();
                  router.replace('/(tabs)');
                }}
              />
            </View>

            <View style={styles.webAuthInline}>
              <Button
                label="Create an account"
                variant="ghost"
                size="sm"
                icon="sparkles"
                onPress={() => router.push('/(auth)/sign-up')}
              />
              <Text variant="caption" tone="tertiary">
                •
              </Text>
              <Button
                label="I already have an account"
                variant="ghost"
                size="sm"
                onPress={() => router.push('/(auth)/sign-in')}
              />
              <Text variant="caption" tone="tertiary">
                •
              </Text>
              <Pressable onPress={() => void Linking.openURL(LATEST_UNIVERSAL_APK_CDN_URL)}>
                <Text variant="caption" tone="secondary" style={{ textDecorationLine: 'underline' }}>
                  32-bit Legacy Android APK
                </Text>
              </Pressable>
            </View>
          </View>
        </View>

        {/* ================================================================ */}
        {/* INTERACTIVE APP SCREENSHOTS SHOWCASE (4 REAL DEVICE MOCKUPS)     */}
        {/* ================================================================ */}
        <View style={styles.sectionContainer}>
          <Text variant="overline" align="center" style={{ color: colors.accent }}>
            INSIDE HALLYU · APP SCREENSHOTS PREVIEW
          </Text>
          <Text variant="display" align="center" style={{ marginTop: 8 }}>
            Designed for pure True Black cinema nights.
          </Text>
          <Text
            variant="body"
            tone="secondary"
            align="center"
            style={{ marginTop: 8, maxWidth: 620, alignSelf: 'center' }}
          >
            Identical experience across Native Android, iPhone Full-Screen Home App, and Desktop Web —
            synced to the millisecond.
          </Text>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.phonesRow}
          >
            {/* SCREENSHOT 1: SOCIAL-FIRST HOME FEED */}
            <Pressable
              onPress={() => {
                auth.continueAsGuest();
                router.replace('/(tabs)');
              }}
              style={styles.phoneFrame}
            >
              <View style={styles.phoneNotch} />
              <View style={styles.phoneHeader}>
                <Text style={styles.phoneWordmark}>HALLYU</Text>
                <View style={styles.phoneLiveChip}>
                  <View style={[styles.liveDot, { backgroundColor: colors.accent }]} />
                  <Text style={styles.phoneLiveText}>4 LIVE</Text>
                </View>
              </View>

              {/* Live Watch Party Strip */}
              <View style={styles.mockLiveBanner}>
                <Ionicons name="flame" size={14} color={colors.accent} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.mockCardTitle} numberOfLines={1}>
                    Doctor X: Mafia in White Finale
                  </Text>
                  <Text style={styles.mockSub}>48 watching live · Join room →</Text>
                </View>
              </View>

              {/* Social Post #1 */}
              <View style={styles.mockPost}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={styles.mockAvatar}>
                    <Text style={{ color: '#FFF', fontSize: 11, fontWeight: '700' }}>CEO</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.mockCardTitle}>Hallyu Official · @ceohallyu</Text>
                    <Text style={styles.mockSub}>2m · K-Drama · S1 E12</Text>
                  </View>
                </View>
                <Text style={styles.mockPostBody}>
                   THAT ROOFTOP OPERATING ROOM TWIST IN EPISODE 12?! Nobody breathe — get inside the
                  synchronized Watch Room right now!! 🔥🎬
                </Text>
                <View style={styles.mockSpoilerShield}>
                  <Ionicons name="eye-off-outline" size={12} color={colors.accent} />
                  <Text style={{ color: colors.textSecondary, fontSize: 10.5 }}>
                    Auto-shielded for fans below Episode 12
                  </Text>
                </View>
                <View style={styles.mockMetrics}>
                  <Text style={styles.mockSub}>♥ 342</Text>
                  <Text style={styles.mockSub}>💬 89 replies</Text>
                  <Text style={styles.mockSub}>↻ Share</Text>
                </View>
              </View>

              {/* Social Post #2 */}
              <View style={styles.mockPost}>
                <Text style={styles.mockCardTitle}>@minjiwatches · Anime</Text>
                <Text style={styles.mockPostBody}>
                  Dragon Ball Super: Beerus animation frames tonight broke the internet 😭✨ 10/10!
                </Text>
              </View>

              <View style={styles.phoneCaptionBar}>
                <Text variant="label" style={{ color: colors.accent }}>
                  01 · Social-First Timeline
                </Text>
                <Text variant="caption" tone="secondary">
                  Posts, polls, Shorts & spoiler-safe threads right at #1
                </Text>
              </View>
            </Pressable>

            {/* SCREENSHOT 2: LIVE WATCH PARTY & PREDICTION POLL */}
            <Pressable
              onPress={() => {
                auth.continueAsGuest();
                router.push('/events');
              }}
              style={styles.phoneFrame}
            >
              <View style={styles.phoneNotch} />
              <View style={styles.phoneHeader}>
                <Text style={styles.mockCardTitle}>Live Events Hub</Text>
                <View style={[styles.phoneLiveChip, { backgroundColor: colors.accent }]}>
                  <Text style={[styles.phoneLiveText, { color: '#FFF' }]}>LIVE NOW</Text>
                </View>
              </View>

              {previewDramas[0]?.backdropUrl || previewDramas[0]?.posterUrl ? (
                <Image
                  source={{ uri: previewDramas[0]?.backdropUrl ?? previewDramas[0]?.posterUrl }}
                  style={{ width: '100%', height: 112, borderRadius: 12 }}
                  contentFit="cover"
                />
              ) : null}

              <View style={[styles.mockPost, { marginTop: 10 }]}>
                <Text style={{ color: colors.warm, fontSize: 10, fontWeight: '700' }}>
                  ⚡ LIVE PREDICTION POLL
                </Text>
                <Text style={styles.mockCardTitle}>
                  Who exposes the hospital director first?
                </Text>
                <View style={styles.mockPollRowActive}>
                  <Text style={{ color: '#FFF', fontSize: 11.5, fontWeight: '600' }}>
                    ✓ Dr. Baek turns the tape over
                  </Text>
                  <Text style={{ color: colors.accent, fontSize: 11.5, fontWeight: '700' }}>
                    68%
                  </Text>
                </View>
                <View style={styles.mockPollRow}>
                  <Text style={{ color: colors.textSecondary, fontSize: 11.5 }}>
                    Secret witness arrives at trial
                  </Text>
                  <Text style={{ color: colors.textTertiary, fontSize: 11.5 }}>32%</Text>
                </View>
              </View>

              <View style={styles.mockCtaBar}>
                <Text style={{ color: '#FFF', fontSize: 12, fontWeight: '700' }}>
                  Enter S1E12 Live Room →
                </Text>
              </View>

              <View style={styles.phoneCaptionBar}>
                <Text variant="label" style={{ color: colors.warm }}>
                  02 · Watch Parties & Polls
                </Text>
                <Text variant="caption" tone="secondary">
                  Local-time countdowns, RSVPs & synchronized rooms
                </Text>
              </View>
            </Pressable>

            {/* SCREENSHOT 3: EXPLORE 4 WORLDS (LIVE POSTERS) */}
            <Pressable
              onPress={() => {
                auth.continueAsGuest();
                router.push('/(tabs)/explore');
              }}
              style={styles.phoneFrame}
            >
              <View style={styles.phoneNotch} />
              <View style={styles.phoneHeader}>
                <Text style={styles.phoneWordmark}>Explore</Text>
                <Text style={styles.mockSub}>🇰🇷 🇨🇳 🇯🇵 🎬</Text>
              </View>

              <View style={styles.mockGrid}>
                {(previewDramas.length > 0
                  ? previewDramas
                  : [
                      { id: '1', title: 'Doctor X: Mafia in White', rating: 9.4, posterUrl: undefined },
                      { id: '2', title: 'Dragon Ball Super: Beerus', rating: 9.7, posterUrl: undefined },
                      { id: '3', title: 'Where the Mask Ends', rating: 8.6, posterUrl: undefined },
                      { id: '4', title: 'MobLand', rating: 8.5, posterUrl: undefined },
                    ]
                ).map((item, idx) => (
                  <View key={item.id} style={styles.mockPosterTile}>
                    {item.posterUrl ? (
                      <Image
                        source={{ uri: item.posterUrl }}
                        style={styles.mockPosterImg}
                        contentFit="cover"
                      />
                    ) : (
                      <View style={[styles.mockPosterImg, { backgroundColor: colors.surface3 }]} />
                    )}
                    <Text style={styles.mockPosterRank}>#{idx + 1}</Text>
                    <Text style={styles.mockPosterTitle} numberOfLines={1}>
                      {item.title}
                    </Text>
                  </View>
                ))}
              </View>

              <View style={styles.phoneCaptionBar}>
                <Text variant="label" style={{ color: '#10B981' }}>
                  03 · Pure Live Rankings
                </Text>
                <Text variant="caption" tone="secondary">
                  Verified 2025/2026 airing K-Dramas, Anime, C-Dramas & Films
                </Text>
              </View>
            </Pressable>

            {/* SCREENSHOT 4: LOCK-SCREEN PUSH + PROFILE TOP 4 */}
            <Pressable onPress={() => setIosGuideOpen(true)} style={styles.phoneFrame}>
              <View style={styles.phoneNotch} />
              <View style={styles.phoneHeader}>
                <Text style={styles.mockCardTitle}>Lock-Screen Alerts</Text>
                <Ionicons name="notifications" size={15} color={colors.accent} />
              </View>

              <View style={styles.mockPushCard}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: colors.accent, fontSize: 10.5, fontWeight: '700' }}>
                    HALLYU · NOW
                  </Text>
                  <Text style={styles.mockSub}>Lock Screen</Text>
                </View>
                <Text style={[styles.mockCardTitle, { marginTop: 4 }]}>
                  🔴 Watch Party Live Now!
                </Text>
                <Text style={styles.mockSub}>
                  @ceohallyu opened Episode 12 Finale Room + sent you a clip in DMs.
                </Text>
              </View>

              <View style={[styles.mockPushCard, { borderColor: 'rgba(16,185,129,0.35)' }]}>
                <Text style={{ color: '#10B981', fontSize: 10.5, fontWeight: '700' }}>
                  LIVE PULSE SHADE BANNER
                </Text>
                <Text style={styles.mockSub}>
                  Silent zero-buzz companion bar pinned cleanly in your Android shade.
                </Text>
              </View>

              <View style={styles.mockPost}>
                <Text style={styles.mockCardTitle}>Share Profile Anywhere</Text>
                <Text style={styles.mockSub}>
                  hallyu /u/@handle cards open rich previews across TikTok, Instagram, X & WhatsApp.
                </Text>
              </View>

              <View style={styles.phoneCaptionBar}>
                <Text variant="label" style={{ color: '#8B5CF6' }}>
                  04 · 24/7 Live Push & Profiles
                </Text>
                <Text variant="caption" tone="secondary">
                  Android FCM + Apple iOS Lock-Screen Web Push
                </Text>
              </View>
            </Pressable>
          </ScrollView>
        </View>

        {/* COMMERCIAL TRUST & FOOTER */}
        <View style={styles.webFooter}>
          <Wordmark size={28} />
          <Text variant="bodySmall" tone="secondary" align="center" style={{ maxWidth: 580 }}>
            Signed with Hallyu’s permanent 4096-bit release key ({ANDROID_RELEASE_SHA256.slice(0, 23)}…)
            for seamless one-tap in-place Android upgrades across all 64-bit & 32-bit phones and instant iOS Home-Screen Web Push.
          </Text>
          <View style={styles.webAuthInline}>
            <Pressable onPress={() => void Linking.openURL(LATEST_UNIVERSAL_APK_CDN_URL)}>
              <Text variant="caption" style={{ color: colors.accent, fontFamily: fonts.medium }}>
                Universal APK (All Phones)
              </Text>
            </Pressable>
            <Text variant="caption" tone="tertiary">·</Text>
            <Pressable onPress={() => void Linking.openURL(LATEST_ARM64_APK_CDN_URL)}>
              <Text variant="caption" tone="secondary">Slim ARM64</Text>
            </Pressable>
            <Text variant="caption" tone="tertiary">·</Text>
            <Pressable onPress={() => void Linking.openURL(LATEST_ARM32_APK_CDN_URL)}>
              <Text variant="caption" tone="secondary">Slim ARM32</Text>
            </Pressable>
            <Text variant="caption" tone="tertiary">·</Text>
            <Pressable onPress={() => void Linking.openURL(LATEST_X86_64_APK_CDN_URL)}>
              <Text variant="caption" tone="secondary">x86_64</Text>
            </Pressable>
          </View>
          <Text variant="caption" tone="tertiary" align="center">
            Support: {SUPPORT_EMAIL} · Admin & Creators: {ADMIN_CONTACT_EMAIL} · Metadata via TMDB
          </Text>
        </View>
      </ScrollView>

      {/* 2-TAP iOS SAFARI INSTALL GUIDE SHEET */}
      <Sheet
        visible={iosGuideOpen}
        onClose={() => setIosGuideOpen(false)}
        title="Install Hallyu on iPhone / iPad"
      >
        <View style={{ gap: space.x4 }}>
          <Text variant="bodySmall" tone="secondary">
            Install Hallyu directly to your iPhone Home Screen in 10 seconds for True Black
            full-screen cinema mode and real Apple Lock-Screen Push Notifications:
          </Text>
          <View style={styles.iosStep}>
            <Text style={styles.iosStepNum}>1</Text>
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall">Open this page in Safari & tap Share (↑)</Text>
              <Text variant="caption" tone="secondary">
                Tap the Share icon at the bottom center of Safari.
              </Text>
            </View>
          </View>
          <View style={styles.iosStep}>
            <Text style={styles.iosStepNum}>2</Text>
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall">Tap “Add to Home Screen”</Text>
              <Text variant="caption" tone="secondary">
                Launch Hallyu from your Home Screen and tap Enable Lock-Screen Alerts!
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: space.x2 }}>
            <Button
              label="Copy Link for Safari"
              variant="secondary"
              style={{ flex: 1 }}
              onPress={async () => {
                await Clipboard.setStringAsync(getWebAppBaseUrl());
                toast.show({ message: 'Copied link! Open Safari and paste.', tone: 'success' });
              }}
            />
            <Button
              label="Open Web App"
              style={{ flex: 1 }}
              onPress={() => {
                setIosGuideOpen(false);
                auth.continueAsGuest();
                router.replace('/(tabs)');
              }}
            />
          </View>
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  heroBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '66%',
    overflow: 'hidden',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.x5,
    zIndex: 2,
  },
  worldPills: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  worldMiniPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(15,15,18,0.72)',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  content: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: space.x6,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  nowShowingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: 'rgba(15,15,18,0.82)',
    borderWidth: 1,
    maxWidth: '100%',
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  guestRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: space.x2,
  },
  footerMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: space.x3,
  },
  // Web Landing styles
  webHero: {
    minHeight: 620,
    justifyContent: 'space-between',
    paddingBottom: space.x10,
  },
  webNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.x6,
    maxWidth: 1180,
    width: '100%',
    alignSelf: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  webBetaBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: 'rgba(225,29,72,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(225,29,72,0.35)',
  },
  webHeroBody: {
    alignItems: 'center',
    paddingHorizontal: space.x5,
    marginTop: space.x8,
  },
  heroLiveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: 'rgba(15,15,18,0.8)',
    borderWidth: 1,
    borderColor: 'rgba(225,29,72,0.4)',
  },
  webCtaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: space.x3,
    marginTop: space.x6,
  },
  webAuthInline: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: space.x4,
  },
  sectionContainer: {
    maxWidth: 1220,
    width: '100%',
    alignSelf: 'center',
    paddingTop: space.x8,
    paddingHorizontal: space.x4,
  },
  phonesRow: {
    paddingVertical: space.x6,
    paddingHorizontal: space.x2,
    gap: 20,
  },
  phoneFrame: {
    width: 282,
    backgroundColor: '#07070A',
    borderRadius: 34,
    padding: 14,
    borderWidth: 2,
    borderColor: '#24242C',
    justifyContent: 'space-between',
    gap: 10,
  },
  phoneNotch: {
    width: 76,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#15151B',
    alignSelf: 'center',
  },
  phoneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  phoneWordmark: {
    color: '#FFFFFF',
    fontFamily: fonts.extrabold,
    fontSize: 15,
    letterSpacing: 1,
  },
  phoneLiveChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(225,29,72,0.16)',
  },
  phoneLiveText: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '700',
  },
  mockLiveBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: 12,
    backgroundColor: '#121217',
    borderWidth: 1,
    borderColor: 'rgba(225,29,72,0.35)',
  },
  mockPost: {
    padding: 10,
    borderRadius: 14,
    backgroundColor: '#111116',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    gap: 6,
  },
  mockAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mockCardTitle: {
    color: '#F5F5F7',
    fontSize: 12,
    fontWeight: '700',
  },
  mockSub: {
    color: '#9A9AA6',
    fontSize: 10.5,
  },
  mockPostBody: {
    color: '#ECECF2',
    fontSize: 11.5,
    lineHeight: 16,
  },
  mockSpoilerShield: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: 'rgba(225,29,72,0.1)',
  },
  mockMetrics: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  mockPollRowActive: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(225,29,72,0.16)',
    borderWidth: 1,
    borderColor: colors.accent,
  },
  mockPollRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#181820',
  },
  mockCtaBar: {
    backgroundColor: colors.accent,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: 'center',
  },
  mockGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  mockPosterTile: {
    width: '48%',
    gap: 4,
  },
  mockPosterImg: {
    width: '100%',
    height: 138,
    borderRadius: 10,
  },
  mockPosterRank: {
    position: 'absolute',
    top: 6,
    left: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.78)',
    color: '#FFF',
    fontSize: 10,
    fontWeight: '800',
  },
  mockPosterTitle: {
    color: '#F5F5F7',
    fontSize: 11,
    fontWeight: '600',
  },
  mockPushCard: {
    padding: 12,
    borderRadius: 14,
    backgroundColor: '#14141B',
    borderWidth: 1,
    borderColor: 'rgba(225,29,72,0.35)',
    gap: 4,
  },
  phoneCaptionBar: {
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
    gap: 2,
  },
  webFooter: {
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: space.x5,
    paddingTop: space.x8,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    marginTop: space.x6,
  },
  iosStep: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  iosStepNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.accent,
    color: '#FFF',
    textAlign: 'center',
    lineHeight: 26,
    fontWeight: '700',
  },
});
