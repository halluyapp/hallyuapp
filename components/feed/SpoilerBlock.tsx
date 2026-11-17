import { Ionicons } from '@expo/vector-icons';
import React, { useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { colors, motion, radius, space } from '../../constants/theme';
import { haptic, useApp, useReduceMotion, useRequireMember } from '../../lib/hooks';
import { Drama, SpoilerLevel } from '../../lib/model';
import { veilCopy } from '../../lib/spoiler';
import { Text } from '../ui/Text';
import { useToast } from '../ui/Toast';
import { track } from '../../lib/analytics';

interface SpoilerBlockProps {
  id: string; // post or comment id (for reveal memory)
  level: SpoilerLevel;
  drama?: Drama;
  season?: number;
  episode?: number;
  veiled: boolean;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  compact?: boolean; // comments
}

/**
 * The veil. Author/context/actions stay visible around it; only the body is covered.
 * Actions: Reveal (remembered on this device) · Reveal & mark watched · Protect me.
 * Veiled content is excluded from the accessibility tree.
 */
export function SpoilerBlock({ id, level, drama, season, episode, veiled, children, style, compact }: SpoilerBlockProps) {
  const { dispatch, watch } = useApp();
  const require = useRequireMember();
  const toast = useToast();
  const item = watch(drama?.id ?? '');
  const copy = veilCopy(level, drama?.title, season, episode, (drama?.seasons.length ?? 1) > 1, item);
  const [showing, setShowing] = useState(!veiled);
  const [dissolving, setDissolving] = useState(false);
  const fade = useRef(new Animated.Value(veiled ? 0 : 1)).current;
  const veilA = useRef(new Animated.Value(1)).current;
  const reduce = useReduceMotion();
  if (!veiled && !showing) setShowing(true);

  const reveal = (markWatched?: boolean) => {
    haptic.light();
    dispatch({ type: 'reveal', id });
    track('spoiler.reveal', { level });
    AccessibilityInfo.announceForAccessibility?.('Spoiler revealed');
    if (markWatched && drama && episode) {
      require('mark episodes watched', () => {
        const rawTotal = drama.seasons.find((s) => s.number === (season ?? 1))?.episodeCount ?? drama.episodeCount;
        const total = rawTotal || (drama.mediaType === 'movie' ? 1 : 16);
        dispatch({ type: 'progress', dramaId: drama.id, season: season ?? 1, episode, total });
        toast.show({ message: `Marked ${drama.title} Ep ${episode} watched`, icon: 'checkmark-circle' });
      });
    }
    if (reduce) {
      fade.setValue(1);
      setShowing(true);
      return;
    }
    // The unveil: the real words rise in beneath the veil while the veil itself dissolves.
    setDissolving(true);
    fade.setValue(0);
    veilA.setValue(1);
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: motion.long, easing: Easing.bezier(0.05, 0.7, 0.1, 1), useNativeDriver: true }),
      Animated.timing(veilA, { toValue: 0, duration: motion.medium, delay: 40, easing: Easing.bezier(0.3, 0, 0.8, 0.15), useNativeDriver: true }),
    ]).start(() => {
      setShowing(true);
      setDissolving(false);
    });
  };

  const veilBox = (
    <View style={[styles.veil, compact ? styles.veilCompact : null]} accessibilityLabel={`${copy}. Use reveal controls below.`}>
      <View style={styles.veilHeader}>
        <Ionicons name="eye-off-outline" size={compact ? 14 : 16} color={colors.textSecondary} />
        <Text variant={compact ? 'caption' : 'label'} tone="secondary" style={{ flex: 1 }} numberOfLines={2}>
          {copy}
        </Text>
      </View>
      <View style={styles.veilActions} importantForAccessibility="no-hide-descendants">
        <Pressable onPress={() => reveal(false)} style={styles.veilBtn} accessibilityRole="button" accessibilityLabel="Reveal">
          <Text variant="label">Reveal</Text>
        </Pressable>
        {level === 'episode' && !!drama && !!episode && watch(drama.id)?.status !== 'completed' ? (
          <Pressable onPress={() => reveal(true)} style={styles.veilBtn} accessibilityRole="button" accessibilityLabel={`Reveal and mark episode ${episode} watched`}>
            <Text variant="label" tone="accent">
              I’ve seen Ep {episode}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );

  if (showing || dissolving) {
    return (
      <View style={style}>
        <Animated.View
          style={{
            opacity: fade,
            transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }, { scale: fade.interpolate({ inputRange: [0, 1], outputRange: [0.985, 1] }) }],
          }}
        >
          {children}
          {veiled ? (
            <Text variant="caption" tone="tertiary" style={{ marginTop: space.x1 }}>
              Revealed · {veilCopy(level, undefined, season, episode, (drama?.seasons.length ?? 1) > 1)}
            </Text>
          ) : null}
        </Animated.View>
        {dissolving ? (
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { opacity: veilA, transform: [{ translateY: veilA.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) }, { scale: veilA.interpolate({ inputRange: [0, 1], outputRange: [1.015, 1] }) }] },
            ]}
          >
            {veilBox}
          </Animated.View>
        ) : null}
      </View>
    );
  }

  return <View style={style}>{veilBox}</View>;
}

/** Small tag shown next to metadata when a post carries a spoiler level (even when unveiled). */
export function SpoilerTag({ level, compact }: { level: SpoilerLevel; compact?: boolean }) {
  if (level === 'none') return null;
  const label = level === 'episode' ? 'Episode spoiler' : level === 'season' ? 'Season spoiler' : 'Ending spoiler';
  return (
    <View style={[styles.tag, compact ? { height: 18 } : null]}>
      <Ionicons name="eye-off-outline" size={compact ? 10 : 12} color={colors.spoiler} />
      <Text variant="caption" style={[{ color: colors.spoiler }, compact ? { fontSize: 10, lineHeight: 12 } : null]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  veil: { backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder, borderLeftWidth: 3, borderLeftColor: colors.spoiler, borderRadius: radius.md, padding: space.x3, gap: space.x3 },
  veilCompact: { padding: space.x2, gap: space.x2 },
  veilHeader: { flexDirection: 'row', alignItems: 'center', gap: space.x2 },
  veilActions: { flexDirection: 'row', gap: space.x2, flexWrap: 'wrap' },
  veilBtn: { height: 40, paddingHorizontal: 16, borderRadius: 20, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder, alignItems: 'center', justifyContent: 'center' },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 22, paddingHorizontal: 8, borderRadius: 11, backgroundColor: 'rgba(245,158,11,0.12)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.25)' },
});
