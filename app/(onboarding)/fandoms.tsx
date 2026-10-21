import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { OnboardingFrame } from '../../components/onboarding/OnboardingFrame';
import { Chip, ChipRow } from '../../components/ui/Chip';
import { Text } from '../../components/ui/Text';
import { colors, radius, space } from '../../constants/theme';
import { catalog } from '../../lib/catalog';
import { adoptDramas } from '../../lib/catalogSync';
import { dramaFandom, FANDOMS } from '../../lib/fandoms';
import { haptic, useLoad } from '../../lib/hooks';
import { FandomId, GENRES } from '../../lib/model';
import { withAlpha } from '../../lib/motion';
import { allDramas, useStore } from '../../lib/store';

/**
 * Act 1 — Full-Art 2×2 World Portals + Inline Mood/Genre Selector.
 * Combines world identity + genre taste into one lush visual screen so members reach poster swiping fast.
 */
export default function FandomsStep() {
  const router = useRouter();
  const { state, dispatch } = useStore();
  const [picked, setPicked] = useState<FandomId[]>(() =>
    state.onboarding.fandoms?.length
      ? state.onboarding.fandoms
      : state.profile.fandoms?.length
        ? state.profile.fandoms
        : ['kdrama'],
  );
  const [pickedGenres, setPickedGenres] = useState<string[]>(() =>
    state.onboarding.genres.length ? state.onboarding.genres : state.profile.favoriteGenres,
  );

  const live = useLoad(
    async (signal) => adoptDramas(await catalog.trending(signal)),
    [],
    catalog.available,
  );

  const worldArt = useMemo(() => {
    const pool = [...(live.data ?? []), ...allDramas(state)];
    const out: Partial<Record<FandomId, string>> = {};
    for (const d of pool) {
      const f = dramaFandom(d).id;
      if (!out[f] && (d.backdropUrl || d.posterUrl)) {
        out[f] = d.backdropUrl ?? d.posterUrl;
      }
    }
    return out;
  }, [live.data, state]);

  const toggleWorld = (id: FandomId) => {
    haptic.select();
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  const toggleGenre = (genre: string) => {
    haptic.select();
    setPickedGenres((g) => (g.includes(genre) ? g.filter((x) => x !== genre) : [...g, genre]));
  };

  const selectAllWorlds = () => {
    haptic.success();
    setPicked(FANDOMS.map((f) => f.id));
  };

  return (
    <OnboardingFrame
      step={1}
      eyebrow="ACT I · YOUR WORLDS"
      title="Step into your worlds."
      subtitle="Pick one, two, or all four — your feed blends them seamlessly and badges your profile."
      skippable={false}
      continueLabel={
        picked.length
          ? `Next: Swipe your Watch DNA (${picked.length} world${picked.length === 1 ? '' : 's'})`
          : 'Pick at least 1 world'
      }
      continueDisabled={!picked.length}
      helper={
        pickedGenres.length
          ? `${picked.length} world${picked.length === 1 ? '' : 's'} · ${pickedGenres.length} mood${pickedGenres.length === 1 ? '' : 's'} tuned`
          : 'Optional: tap a few favorite moods below to sharpen your deck'
      }
      onContinue={() => {
        dispatch({
          type: 'profile',
          patch: {
            fandoms: picked,
            ...(pickedGenres.length ? { favoriteGenres: pickedGenres } : {}),
          },
        });
        dispatch({
          type: 'onboarding',
          patch: {
            fandoms: picked,
            ...(pickedGenres.length ? { genres: pickedGenres } : {}),
            step: 2,
          },
        });
        router.push('/(onboarding)/dramas');
      }}
    >
      {/* 2×2 Cinema Portal Grid */}
      <View style={styles.grid}>
        {FANDOMS.map((f) => {
          const on = picked.includes(f.id);
          const art = worldArt[f.id];
          return (
            <Pressable
              key={f.id}
              onPress={() => toggleWorld(f.id)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${f.label}. ${f.tagline}`}
              style={({ pressed }) => [
                styles.portalCard,
                on
                  ? { borderColor: f.tint, borderWidth: 1.5 }
                  : { borderColor: colors.borderSubtle, borderWidth: 1 },
                pressed ? { transform: [{ scale: 0.97 }] } : null,
              ]}
            >
              {art ? (
                <Image
                  source={{ uri: art }}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  transition={300}
                />
              ) : null}
              <LinearGradient
                colors={[
                  withAlpha(f.tint, on ? 0.36 : 0.14),
                  'rgba(10,10,12,0.72)',
                  'rgba(10,10,12,0.96)',
                ]}
                style={StyleSheet.absoluteFill}
              />

              <View style={styles.portalTop}>
                <View style={[styles.flagPill, { backgroundColor: withAlpha(f.tint, 0.22) }]}>
                  <Text style={{ fontSize: 16 }}>{f.flag}</Text>
                </View>
                <Ionicons
                  name={on ? 'checkmark-circle' : 'add-circle-outline'}
                  size={22}
                  color={on ? f.tint : colors.textSecondary}
                />
              </View>

              <View style={{ marginTop: 'auto' }}>
                <Text variant="titleSmall" style={on ? { color: '#FFFFFF' } : undefined}>
                  {f.label}
                </Text>
                <Text variant="caption" tone="secondary" numberOfLines={2} style={{ marginTop: 2 }}>
                  {f.tagline}
                </Text>
                <Text
                  variant="overline"
                  style={{ marginTop: space.x2, color: on ? f.tint : colors.textTertiary }}
                  numberOfLines={1}
                >
                  {f.hints.slice(0, 2).join(' · ')}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      {picked.length < FANDOMS.length ? (
        <Pressable onPress={selectAllWorlds} style={styles.allWorldsBtn} accessibilityRole="button">
          <Ionicons name="planet-outline" size={15} color={colors.accentText} />
          <Text variant="caption" tone="accent">
            I watch across all 4 worlds — select them all
          </Text>
        </Pressable>
      ) : null}

      {/* Inline Mood & Genre Tuning */}
      <View style={{ marginTop: space.x5 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: space.x2 }}>
          <Text variant="overline" tone="secondary">
            FAVORITE MOODS & GENRES
          </Text>
          {pickedGenres.length > 0 ? (
            <Text variant="caption" tone="accent">
              {pickedGenres.length} selected
            </Text>
          ) : null}
        </View>
        <ChipRow>
          {GENRES.map((g) => (
            <Chip
              key={g}
              label={g}
              size="sm"
              selected={pickedGenres.includes(g)}
              onPress={() => toggleGenre(g)}
            />
          ))}
        </ChipRow>
      </View>
    </OnboardingFrame>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.gutter,
  },
  portalCard: {
    width: '47.5%',
    flexGrow: 1,
    minHeight: 164,
    borderRadius: radius.lg,
    padding: space.x3,
    overflow: 'hidden',
    backgroundColor: colors.surface1,
  },
  portalTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  flagPill: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  allWorldsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: space.x3,
    paddingVertical: space.x2,
  },
});
