import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { DramaCard } from '../../components/drama/DramaCard';
import { OnboardingFrame } from '../../components/onboarding/OnboardingFrame';
import { SearchField } from '../../components/search/SearchField';
import { Button } from '../../components/ui/Button';
import { Chip, ChipRow } from '../../components/ui/Chip';
import { Poster } from '../../components/ui/Poster';
import { Segmented } from '../../components/ui/Segmented';
import { Skeleton } from '../../components/ui/Skeleton';
import { InlineNotice } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { useToast } from '../../components/ui/Toast';
import { colors, radius, sizes, space } from '../../constants/theme';
import { catalog, friendlyCatalogCopy } from '../../lib/catalog';
import { adoptDramas } from '../../lib/catalogSync';
import { dramaFandom, inWorlds } from '../../lib/fandoms';
import { haptic, useCatalogHealth, useDebounced, useLayout, useLoad } from '../../lib/hooks';
import { Drama, WatchStatus } from '../../lib/model';
import { springs, withAlpha } from '../../lib/motion';
import { allDramas, useStore } from '../../lib/store';

/**
 * Act 2 — 3D Tactile Poster Swipe Deck + Quick Grid Toggle (`hybrid_a_c`).
 * - Swipe Right: Watched ✓ (`completed`)
 * - Swipe Up: Watching Now ▶ + Spoiler Shield ON (`watching` + `follow`)
 * - Swipe Left: Skip
 * - Tap ★ Star: Pin directly into your Profile Top 4 All-Time Favorites!
 */
export default function DramasStep() {
  const router = useRouter();
  const toast = useToast();
  const { state, dispatch } = useStore();
  const { width, margin } = useLayout();
  const [mode, setMode] = useState<'deck' | 'grid'>('deck');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const [picked, setPicked] = useState<Record<string, WatchStatus>>(() =>
    Object.fromEntries(Object.values(state.watchlist).map((w) => [w.dramaId, w.status])),
  );
  const [topFour, setTopFour] = useState<string[]>(() =>
    state.profile.favoriteDramaIds.slice(0, 4),
  );
  const [deckIndex, setDeckIndex] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [pendingGridId, setPendingGridId] = useState<string | null>(null);

  const pan = useRef(new Animated.ValueXY()).current;
  const swipingRef = useRef(false);

  const genres = useMemo(() => new Set(state.onboarding.genres), [state.onboarding.genres]);
  const health = useCatalogHealth();

  const wall = useLoad<Drama[]>(
    async (signal) => {
      const [trending, p1, p2, top] = await Promise.all([
        catalog.trending(signal).catch(() => [] as Drama[]),
        catalog.popular(1, signal).catch(() => [] as Drama[]),
        catalog.popular(2, signal).catch(() => [] as Drama[]),
        catalog.topRated(1, signal).catch(() => [] as Drama[]),
      ]);
      const merged = [...trending, ...p1, ...top, ...p2];
      if (!merged.length) throw new Error('network');
      const adopted = adoptDramas(merged);
      const seen = new Set<string>();
      return adopted.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
    },
    [],
    catalog.available,
  );

  const found = useLoad<Drama[]>(
    async (signal) => adoptDramas(await catalog.searchDramas(dq, signal)),
    [dq],
    catalog.available && dq.length >= 2,
  );

  const worlds = state.onboarding.fandoms;
  const list = useMemo(() => {
    const live = wall.data ?? [];
    const base = live.length ? live : allDramas(state);
    const seenBase = new Set<string>();
    const deduped = base.filter((d) => (seenBase.has(d.id) ? false : (seenBase.add(d.id), true)));
    const rank = (d: Drama) =>
      (inWorlds(d, worlds) ? 3 : 0) + Number(d.genres.some((g) => genres.has(g)));
    const ranked = [...deduped].sort((a, b) => rank(b) - rank(a));
    if (!dq) return ranked;
    const needle = dq.toLowerCase();
    const local = ranked.filter(
      (d) => d.title.toLowerCase().includes(needle) || d.originalTitle?.includes(dq),
    );
    const remote = found.data ?? [];
    const seen = new Set(local.map((d) => d.id));
    return [...local, ...remote.filter((d) => !seen.has(d.id))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wall.data, found.data, dq, genres, worlds, state.importedDramas]);

  const currentCard = list[deckIndex];
  const nextCard = list[deckIndex + 1];
  const count = Object.keys(picked).length;

  const toggleTopFour = (id: string) => {
    haptic.success();
    setTopFour((prev) => {
      const exists = prev.includes(id);
      if (exists) {
        const next = prev.filter((x) => x !== id);
        dispatch({ type: 'profile', patch: { favoriteDramaIds: next } });
        return next;
      }
      if (prev.length >= 4) {
        toast.show({ message: 'Top 4 full — tap an existing ★ favorite to swap.' });
        return prev;
      }
      const next = [...prev, id];
      dispatch({ type: 'profile', patch: { favoriteDramaIds: next } });
      if (!picked[id]) {
        setPicked((p) => ({ ...p, [id]: 'completed' }));
        dispatch({ type: 'watch', dramaId: id, status: 'completed' });
      }
      toast.show({ message: `Pinned to your Top 4 (${next.length}/4)`, icon: 'star', tone: 'success' });
      return next;
    });
  };

  const commitCardAction = (drama: Drama | undefined, action: 'completed' | 'watching' | 'want' | 'skip') => {
    if (!drama || swipingRef.current) return;
    swipingRef.current = true;

    const targetX = action === 'completed' ? width * 1.25 : action === 'skip' ? -width * 1.25 : 0;
    const targetY = action === 'watching' || action === 'want' ? -420 : 20;

    if (action !== 'skip') {
      haptic.select();
      setPicked((p) => ({ ...p, [drama.id]: action }));
      dispatch({ type: 'watch', dramaId: drama.id, status: action });
      if (action === 'watching') {
        dispatch({ type: 'follow', kind: 'dramas', id: drama.id, on: true });
      }
    } else {
      haptic.light();
    }

    Animated.timing(pan, {
      toValue: { x: targetX, y: targetY },
      duration: 210,
      useNativeDriver: true,
    }).start(() => {
      pan.setValue({ x: 0, y: 0 });
      setHistory((h) => [...h, drama.id]);
      setDeckIndex((i) => i + 1);
      swipingRef.current = false;
    });
  };

  const commitRef = useRef(commitCardAction);
  commitRef.current = commitCardAction;
  const currentRef = useRef(currentCard);
  currentRef.current = currentCard;

  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8,
        onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], {
          useNativeDriver: false,
        }),
        onPanResponderRelease: (_, g) => {
          const card = currentRef.current;
          if (!card) {
            Animated.spring(pan, { toValue: { x: 0, y: 0 }, ...springs.snappy }).start();
            return;
          }
          if (g.dx > 95 || g.vx > 0.85) {
            commitRef.current(card, 'completed');
          } else if (g.dx < -95 || g.vx < -0.85) {
            commitRef.current(card, 'skip');
          } else if (g.dy < -95 || g.vy < -0.85) {
            commitRef.current(card, 'watching');
          } else {
            Animated.spring(pan, { toValue: { x: 0, y: 0 }, ...springs.snappy }).start();
          }
        },
      }),
    [pan],
  );

  const undoLast = () => {
    if (!history.length || deckIndex <= 0) return;
    haptic.select();
    setHistory((h) => h.slice(0, -1));
    setDeckIndex((i) => Math.max(0, i - 1));
  };

  const cardW = Math.min(286, width - margin * 2 - 24);
  const cardH = Math.round(cardW * 1.42);
  const rotate = pan.x.interpolate({
    inputRange: [-width, 0, width],
    outputRange: ['-14deg', '0deg', '14deg'],
  });
  const watchedOpacity = pan.x.interpolate({
    inputRange: [20, 100],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const skipOpacity = pan.x.interpolate({
    inputRange: [-100, -20],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const watchingOpacity = pan.y.interpolate({
    inputRange: [-100, -24],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const nextScale = pan.x.interpolate({
    inputRange: [-140, 0, 140],
    outputRange: [1, 0.94, 1],
    extrapolate: 'clamp',
  });

  const cols = Math.max(3, Math.floor((width - margin * 2 + space.gutter) / (sizes.poster.m + space.gutter)));
  const tileW = (width - margin * 2 - space.gutter * (cols - 1)) / cols;
  const showSkeleton = wall.loading && !wall.data && list.length === 0;
  const pendingDrama = pendingGridId ? list.find((d) => d.id === pendingGridId) : undefined;

  return (
    <OnboardingFrame
      step={3}
      eyebrow="ACT II · SPOILER SHIELD & WATCH DNA"
      title="Swipe what you’ve seen."
      subtitle="Right = Watched · Up = Watching + Spoiler Shield · ★ pins your Top 4."
      skippable={false}
      continueLabel={count ? `Continue (${count} tracked)` : 'Continue'}
      helper={`🛡️ ${count} shielded · ★ ${topFour.length}/4 Top Favorites`}
      onContinue={() => {
        dispatch({ type: 'onboarding', patch: { step: 3 } });
        router.push('/(onboarding)/people');
      }}
      scroll={false}
    >
      {/* Mode Switcher: Swipe Deck vs Quick Search Grid */}
      <View style={{ marginBottom: space.x2 }}>
        <Segmented
          items={[
            { key: 'deck', label: 'Poster Deck' },
            { key: 'grid', label: 'Search & Grid' },
          ]}
          value={mode}
          onChange={(v) => {
            setMode(v);
            if (v === 'deck' && q) setQ('');
          }}
        />
      </View>

      {wall.error && !wall.data ? (
        <Pressable onPress={wall.reload} style={{ marginBottom: space.x3 }}>
          <InlineNotice
            tone="warning"
            icon="cloud-offline-outline"
            text={`${friendlyCatalogCopy(health).title}. ${friendlyCatalogCopy(health).body}`}
          />
        </Pressable>
      ) : null}

      {showSkeleton ? (
        <View style={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}>
          <Skeleton width={cardW} height={cardH} radius={20} />
        </View>
      ) : mode === 'deck' ? (
        <View style={styles.deckStage}>
          {currentCard ? (
            <>
              <View style={[styles.stackBox, { width: cardW, height: cardH }]}>
                {/* Underneath Next Card */}
                {nextCard ? (
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      styles.cardShell,
                      {
                        width: cardW,
                        height: cardH,
                        opacity: 0.72,
                        transform: [{ scale: nextScale }, { translateY: 10 }],
                      },
                    ]}
                  >
                    <Poster drama={nextCard} width={cardW} rounded={radius.lg} />
                  </Animated.View>
                ) : null}

                {/* Interactive Top Poster Card */}
                <Animated.View
                  {...responder.panHandlers}
                  style={[
                    styles.cardShell,
                    {
                      width: cardW,
                      height: cardH,
                      borderColor: withAlpha(dramaFandom(currentCard).tint, 0.55),
                      transform: [
                        { translateX: pan.x },
                        { translateY: pan.y },
                        { rotate },
                      ],
                    },
                  ]}
                >
                  <Poster drama={currentCard} width={cardW} rounded={radius.lg} />
                  <LinearGradient
                    colors={['rgba(0,0,0,0.32)', 'transparent', 'rgba(0,0,0,0.92)']}
                    locations={[0, 0.44, 1]}
                    style={StyleSheet.absoluteFill}
                    pointerEvents="none"
                  />

                  {/* Top World + Star Top 4 Pin */}
                  <View style={styles.cardTopRow}>
                    <View
                      style={[
                        styles.worldTag,
                        { backgroundColor: withAlpha(dramaFandom(currentCard).tint, 0.25) },
                      ]}
                    >
                      <Text style={{ fontSize: 12 }}>{dramaFandom(currentCard).flag}</Text>
                      <Text
                        variant="caption"
                        style={{ color: dramaFandom(currentCard).tint, fontWeight: '700' }}
                      >
                        {dramaFandom(currentCard).short}
                      </Text>
                    </View>

                    <Pressable
                      onPress={() => toggleTopFour(currentCard.id)}
                      hitSlop={10}
                      style={[
                        styles.starBtn,
                        topFour.includes(currentCard.id)
                          ? { backgroundColor: colors.warm, borderColor: colors.warm }
                          : null,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel="Pin to Top 4 favorites"
                    >
                      <Ionicons
                        name={topFour.includes(currentCard.id) ? 'star' : 'star-outline'}
                        size={16}
                        color={topFour.includes(currentCard.id) ? '#000' : '#FFF'}
                      />
                    </Pressable>
                  </View>

                  {/* Dynamic Gesture Stamps */}
                  <Animated.View style={[styles.stamp, styles.stampRight, { opacity: watchedOpacity }]}>
                    <Text variant="label" style={{ color: colors.success }}>
                      ✓ WATCHED
                    </Text>
                  </Animated.View>
                  <Animated.View style={[styles.stamp, styles.stampLeft, { opacity: skipOpacity }]}>
                    <Text variant="label" style={{ color: colors.textSecondary }}>
                      SKIP
                    </Text>
                  </Animated.View>
                  <Animated.View style={[styles.stamp, styles.stampUp, { opacity: watchingOpacity }]}>
                    <Text variant="label" style={{ color: colors.accentText }}>
                      🛡️ WATCHING
                    </Text>
                  </Animated.View>

                  {/* Bottom Poster Metadata */}
                  <View style={styles.cardBottomMeta} pointerEvents="none">
                    <Text variant="headline" numberOfLines={2} style={{ color: '#FFF' }}>
                      {currentCard.title}
                    </Text>
                    <Text variant="caption" style={{ color: 'rgba(255,255,255,0.78)', marginTop: 2 }}>
                      {currentCard.year}
                      {currentCard.rating ? ` · ★ ${currentCard.rating.toFixed(1)}` : ''}
                      {currentCard.genres.length ? ` · ${currentCard.genres.slice(0, 2).join(' · ')}` : ''}
                    </Text>
                  </View>
                </Animated.View>
              </View>

              {/* Tactile Action Bar Under Card */}
              <View style={styles.deckControls}>
                <Pressable
                  onPress={undoLast}
                  disabled={!history.length}
                  style={[styles.roundBtn, styles.roundBtnSm, !history.length ? { opacity: 0.35 } : null]}
                  accessibilityRole="button"
                  accessibilityLabel="Undo previous poster"
                >
                  <Ionicons name="arrow-undo" size={18} color={colors.textSecondary} />
                </Pressable>
                <Pressable
                  onPress={() => commitCardAction(currentCard, 'skip')}
                  style={styles.roundBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Haven't seen yet, skip"
                >
                  <Ionicons name="close" size={24} color={colors.textSecondary} />
                </Pressable>
                <Pressable
                  onPress={() => commitCardAction(currentCard, 'watching')}
                  style={[styles.roundBtn, { borderColor: colors.accent, backgroundColor: withAlpha(colors.accent, 0.16) }]}
                  accessibilityRole="button"
                  accessibilityLabel="Currently watching — turn on Spoiler Shield"
                >
                  <Ionicons name="shield-checkmark" size={22} color={colors.accentText} />
                </Pressable>
                <Pressable
                  onPress={() => commitCardAction(currentCard, 'completed')}
                  style={[styles.roundBtn, { borderColor: colors.success, backgroundColor: withAlpha(colors.success, 0.16) }]}
                  accessibilityRole="button"
                  accessibilityLabel="Watched"
                >
                  <Ionicons name="checkmark" size={24} color={colors.success} />
                </Pressable>
              </View>
            </>
          ) : (
            <View style={{ alignItems: 'center', padding: space.x6, gap: space.x3 }}>
              <Ionicons name="sparkles" size={32} color={colors.accent} />
              <Text variant="title">Deck complete!</Text>
              <Text variant="bodySmall" tone="secondary" align="center">
                You shielded {count} title{count === 1 ? '' : 's'} and pinned {topFour.length} Top Favorite{topFour.length === 1 ? '' : 's'}. Search any extra title in Grid mode or head forward.
              </Text>
              <Button label="Search more titles" variant="secondary" size="sm" onPress={() => setMode('grid')} />
            </View>
          )}
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <SearchField
            value={q}
            onChangeText={setQ}
            placeholder="Search any K-Drama, Anime, C-Drama or film"
            style={{ marginBottom: space.x3 }}
          />
          {pendingGridId && pendingDrama ? (
            <View style={{ marginBottom: space.x3 }}>
              <Text variant="label" style={{ marginBottom: space.x2 }}>
                {pendingDrama.title}
              </Text>
              <ChipRow>
                <Chip
                  label="✓ Watched"
                  onPress={() => {
                    haptic.select();
                    setPicked((p) => ({ ...p, [pendingGridId]: 'completed' }));
                    dispatch({ type: 'watch', dramaId: pendingGridId, status: 'completed' });
                    setPendingGridId(null);
                  }}
                />
                <Chip
                  label="🛡️ Watching"
                  onPress={() => {
                    haptic.select();
                    setPicked((p) => ({ ...p, [pendingGridId]: 'watching' }));
                    dispatch({ type: 'watch', dramaId: pendingGridId, status: 'watching' });
                    dispatch({ type: 'follow', kind: 'dramas', id: pendingGridId, on: true });
                    setPendingGridId(null);
                  }}
                />
                <Chip label="Want to watch" onPress={() => {
                  haptic.select();
                  setPicked((p) => ({ ...p, [pendingGridId]: 'want' }));
                  dispatch({ type: 'watch', dramaId: pendingGridId, status: 'want' });
                  setPendingGridId(null);
                }} />
                <Chip
                  label={topFour.includes(pendingGridId) ? '★ In Top 4' : '★ Pin Top 4'}
                  onPress={() => {
                    toggleTopFour(pendingGridId);
                    setPendingGridId(null);
                  }}
                />
              </ChipRow>
            </View>
          ) : null}

          <FlatList
            data={list}
            key={cols}
            numColumns={cols}
            keyExtractor={(d) => d.id}
            columnWrapperStyle={{ gap: space.gutter }}
            contentContainerStyle={{ gap: space.x4, paddingBottom: space.x6 }}
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) => (
              <DramaCard
                drama={item}
                width={tileW}
                onPress={() => setPendingGridId(item.id)}
              />
            )}
          />
        </View>
      )}
    </OnboardingFrame>
  );
}

const styles = StyleSheet.create({
  deckStage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.x4,
  },
  stackBox: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardShell: {
    position: 'absolute',
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.surface2,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
  },
  cardTopRow: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  worldTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  starBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(10,10,12,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stamp: {
    position: 'absolute',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 2,
    backgroundColor: 'rgba(10,10,12,0.84)',
  },
  stampRight: {
    top: 62,
    left: 16,
    borderColor: colors.success,
    transform: [{ rotate: '-12deg' }],
  },
  stampLeft: {
    top: 62,
    right: 16,
    borderColor: colors.borderStrong,
    transform: [{ rotate: '12deg' }],
  },
  stampUp: {
    bottom: 92,
    alignSelf: 'center',
    borderColor: colors.accent,
  },
  cardBottomMeta: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    right: 16,
  },
  deckControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.x3,
  },
  roundBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundBtnSm: {
    width: 42,
    height: 42,
    borderRadius: 21,
  },
});
