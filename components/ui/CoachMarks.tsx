import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, motion, radius, space } from '../../constants/theme';
import { haptic, useReduceMotion } from '../../lib/hooks';
import { dispatch, useSlice } from '../../lib/store';
import { Button } from './Button';
import { Text } from './Text';

export interface CoachStep {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  body: string;
}

interface Props {
  /** Stable id, persisted device-locally once dismissed or finished. */
  id: string;
  steps: CoachStep[];
  /** Extra gate (e.g. only once the screen has content). Defaults to true. */
  when?: boolean;
  /** Delay before the first card, so the screen lands first. */
  delay?: number;
  /** Lift above a tab bar or bottom toolbar. */
  bottomOffset?: number;
}

/**
 * First-run guidance as a small sequence of cards — three or four at most, always skippable,
 * shown once per device. Cards sit above the tab bar and never block the screen: the user can
 * keep scrolling and the card simply waits. Reduced motion → plain fades.
 */
export function CoachMarks({ id, steps, when = true, delay = 900, bottomOffset = 0 }: Props) {
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const key = `coach:${id}`;
  // Track only the three facts this decides on. Subscribing to the whole store made every catalog
  // write re-render the coach marks (and restart their entrance animation) for no reason.
  const hydrated = useSlice((s) => s.hydrated);
  const onboarded = useSlice((s) => s.onboarding.done);
  const alreadySeen = useSlice((s) => s.seen[key]);
  const eligible = hydrated && onboarded && !alreadySeen && when && steps.length > 0;
  const [mounted, setMounted] = useState(false);
  const [step, setStep] = useState(0);
  const anim = useRef(new Animated.Value(0)).current;
  const swap = useRef(new Animated.Value(1)).current;
  // `steps` is a fresh array literal on every parent render, so depending on it restarted the
  // entrance animation and re-announced the tip every time the screen re-rendered. Key on content.
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const firstStepKey = steps[0] ? `${steps[0].title} :: ${steps[0].body}` : '';

  useEffect(() => {
    if (!eligible || mounted) return;
    const t = setTimeout(() => setMounted(true), delay);
    return () => clearTimeout(t);
  }, [eligible, mounted, delay]);

  useEffect(() => {
    if (!mounted) return;
    Animated.timing(anim, { toValue: 1, duration: reduce ? motion.short : motion.long, easing: Easing.bezier(0.05, 0.7, 0.1, 1), useNativeDriver: true }).start();
    const s = stepsRef.current[0];
    if (s) AccessibilityInfo.announceForAccessibility?.(`Tip: ${s.title}. ${s.body}`);
  }, [mounted, anim, reduce, firstStepKey]);

  const finish = () => {
    dispatch({ type: 'seen', id: key });
    Animated.timing(anim, { toValue: 0, duration: motion.short, easing: Easing.bezier(0.2, 0, 0, 1), useNativeDriver: true }).start(() => setMounted(false));
  };

  const next = () => {
    if (step >= steps.length - 1) {
      haptic.success();
      finish();
      return;
    }
    haptic.select();
    const go = () => {
      const nextIdx = Math.min(step + 1, Math.max(0, steps.length - 1));
      setStep(nextIdx);
      const nextStep = steps[nextIdx];
      if (nextStep) AccessibilityInfo.announceForAccessibility?.(`Tip: ${nextStep.title}. ${nextStep.body}`);
      Animated.timing(swap, { toValue: 1, duration: reduce ? motion.short : motion.medium, easing: Easing.bezier(0.05, 0.7, 0.1, 1), useNativeDriver: true }).start();
    };
    if (reduce) go();
    else Animated.timing(swap, { toValue: 0, duration: motion.instant + 40, easing: Easing.bezier(0.3, 0, 1, 1), useNativeDriver: true }).start(go);
  };

  if (!mounted || !eligible) return null;
  const s = steps[step] ?? steps[0];
  if (!s) return null;
  const last = step === steps.length - 1;

  return (
    <View pointerEvents="box-none" style={[styles.host, { paddingBottom: Math.max(insets.bottom, space.x3) + bottomOffset }]}>
      <Animated.View
        style={[
          styles.card,
          {
            opacity: anim,
            transform: [{ translateY: reduce ? 0 : anim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
          },
        ]}
        accessibilityViewIsModal={false}
        accessibilityLiveRegion="polite"
      >
        <Animated.View style={{ opacity: swap, transform: [{ translateX: reduce ? 0 : swap.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}>
          <View style={styles.row}>
            <View style={styles.iconWrap}>
              <Ionicons name={s.icon} size={18} color={colors.accentText} />
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall" accessibilityRole="header">
                {s.title}
              </Text>
              <Text variant="bodySmall" tone="secondary" style={{ marginTop: 2 }}>
                {s.body}
              </Text>
            </View>
            <Pressable onPress={finish} hitSlop={12} accessibilityRole="button" accessibilityLabel="Skip tips" style={styles.close}>
              <Ionicons name="close" size={18} color={colors.textTertiary} />
            </Pressable>
          </View>
        </Animated.View>
        <View style={styles.footer}>
          <View style={styles.dots} accessibilityLabel={`Tip ${step + 1} of ${steps.length}`}>
            {steps.map((_, i) => (
              <View key={i} style={[styles.dot, i === step ? styles.dotOn : null]} />
            ))}
          </View>
          <View style={{ flex: 1 }} />
          {!last ? <Button label="Skip" variant="ghost" size="sm" onPress={finish} /> : null}
          <Button label={last ? 'Got it' : 'Next'} size="sm" variant={last ? 'primary' : 'secondary'} onPress={next} />
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', paddingHorizontal: space.margin },
  card: {
    width: '100%',
    maxWidth: 520,
    backgroundColor: colors.surface3,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    padding: space.x4,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  row: { flexDirection: 'row', gap: space.x3, alignItems: 'flex-start' },
  iconWrap: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  close: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', marginTop: -6, marginRight: -6 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: space.x2, marginTop: space.x3 },
  dots: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.borderStrong },
  dotOn: { width: 16, backgroundColor: colors.accent },
});
