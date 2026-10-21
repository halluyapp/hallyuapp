import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LivingWall } from '../../components/onboarding/LivingWall';
import { Button } from '../../components/ui/Button';
import { Text } from '../../components/ui/Text';
import { Wordmark } from '../../components/ui/TopBar';
import { colors, motion, radius, space } from '../../constants/theme';
import { isBackendConfigured } from '../../lib/api/client';
import { useAuth } from '../../lib/auth';
import { catalog } from '../../lib/catalog';
import { adoptDramas } from '../../lib/catalogSync';
import { dramaFandom, FANDOMS } from '../../lib/fandoms';
import { haptic, useLayout, useLoad, useReduceMotion } from '../../lib/hooks';
import { withAlpha } from '../../lib/motion';
import { allDramas, useSlice } from '../../lib/store';

/**
 * Midnight Premiere Welcome — full-bleed cross-fading cinema showcase across all 4 Hallyu worlds
 * (K-Drama, C-Drama, Anime, Hollywood) with Ken Burns slow drift, spotlight title pill, and
 * clean 1-tap doors for Sign Up, Sign In, and Guest Exploration.
 */
export default function Welcome() {
  const router = useRouter();
  const auth = useAuth();
  const insets = useSafeAreaInsets();
  const { width } = useLayout();
  const reduce = useReduceMotion();
  const rise = useRef(new Animated.Value(24)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const kenBurns = useRef(new Animated.Value(1)).current;
  const [spotIdx, setSpotIdx] = useState(0);

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

  return (
    <View style={styles.root}>
      {/* Full-bleed Midnight Premiere Backdrop with LivingWall fallback */}
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
          colors={[
            'rgba(0,0,0,0.46)',
            'rgba(0,0,0,0.28)',
            'rgba(0,0,0,0.84)',
            colors.canvas,
          ]}
          locations={[0, 0.32, 0.72, 1]}
          style={StyleSheet.absoluteFill}
        />
      </View>

      {/* Top Premiere World Bar */}
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

      {/* Foreground Copy & Primary Doors */}
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
          Live watch rooms, spoiler-shielded threads, and your Top 4 across K-Dramas, C-Dramas, Anime & Hollywood.
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
            {isBackendConfigured()
              ? 'Synced live · Spoiler-protected · Catalog via TMDB'
              : 'On-device mode · Spoiler-protected · Catalog via TMDB'}
          </Text>
        </View>
      </Animated.View>
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
});
