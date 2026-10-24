import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, motion, radius, shadows, sizes, space } from '../../constants/theme';
import { haptic, useApp, useLayout, useReduceMotion, useRequireMember } from '../../lib/hooks';
import { springs } from '../../lib/motion';
import { emitTabReTap, getActiveComposerContext, type TabRouteName } from '../../lib/tabEvents';
import { Avatar } from '../ui/Avatar';
import { Text } from '../ui/Text';
import { CreateSheet } from '../create/CreateSheet';
import { useTabBarMotion } from './TabBarMotion';

type TabKey = 'index' | 'explore' | 'create' | 'activity' | 'you';

const TABS: { key: TabKey; label: string; icon: keyof typeof Ionicons.glyphMap; active: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'index', label: 'Home', icon: 'home-outline', active: 'home' },
  { key: 'explore', label: 'Explore', icon: 'compass-outline', active: 'compass' },
  { key: 'create', label: 'Create', icon: 'add', active: 'add' },
  { key: 'activity', label: 'Activity', icon: 'notifications-outline', active: 'notifications' },
  { key: 'you', label: 'You', icon: 'person-circle-outline', active: 'person-circle' },
];

/**
 * Floating frosted pill (spec 3.1): hovering 16px above the safe area, frosted dark glass fill + border,
 * shadow-2. Single-tap on Create opens the contextual CreateSheet immediately; long-press jumps straight
 * to quick post. Re-tapping an active tab smooth-scrolls its screen back to the top.
 */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { unread, me } = useApp();
  const { wc } = useLayout();
  const require = useRequireMember();
  const [create, setCreate] = useState(false);
  const [flash, setFlash] = useState<TabKey | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();
  const rail = wc !== 'compact';
  const currentKey = state.routes[state.index]?.name as TabKey;
  const { hidden, reveal } = useTabBarMotion();
  const translateY = hidden.interpolate({ inputRange: [0, 1], outputRange: [0, 96] });

  const go = (key: TabKey) => {
    reveal();
    setFlash(key);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1500);
    if (key === 'create') {
      haptic.light();
      require('create a post', () => setCreate(true));
      return;
    }
    const route = state.routes.find((r) => r.name === key);
    if (!route) return;
    const focused = currentKey === key;
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (!focused && !event.defaultPrevented) {
      haptic.select();
      navigation.navigate(key);
    } else if (focused) {
      haptic.select();
      emitTabReTap(key as TabRouteName);
    }
  };

  const items = TABS.map((t) => {
    const focused = currentKey === t.key;
    if (t.key === 'create') {
      return (
        <CreateTab
          key={t.key}
          rail={rail}
          onPress={() => go(t.key)}
          onLongPress={() => {
            haptic.medium();
            require('create a post', () => router.push('/create/post'));
          }}
        />
      );
    }
    return (
      <TabItem
        key={t.key}
        label={t.label}
        icon={focused ? t.active : t.icon}
        focused={focused}
        flashed={flash === t.key}
        rail={rail}
        unread={t.key === 'activity' ? unread : 0}
        avatar={t.key === 'you' && me.displayName ? { uri: me.avatarUrl, name: me.displayName } : undefined}
        onPress={() => go(t.key)}
      />
    );
  });

  return (
    <>
      {rail ? (
        <View style={[styles.rail, { paddingTop: insets.top + space.x4, paddingBottom: insets.bottom + space.x4 }]} accessibilityRole="tablist">
          <Pressable onPress={() => go('index')} accessibilityRole="button" accessibilityLabel="Hallyu, go Home" style={styles.railMark}>
            <Text style={styles.railMarkText}>H</Text>
            <View style={styles.railMarkDot} />
          </Pressable>
          <View style={styles.railItems}>{items}</View>
        </View>
      ) : (
        <Animated.View
          pointerEvents="box-none"
          style={[styles.bar, { bottom: insets.bottom + space.x4, height: sizes.tabBar, transform: [{ translateY }] }]}
          accessibilityRole="tablist"
        >
          {items}
        </Animated.View>
      )}
      <CreateSheet visible={create} onClose={() => setCreate(false)} context={getActiveComposerContext()} />
    </>
  );
}

function TabItem({
  label,
  icon,
  focused,
  flashed,
  rail,
  unread,
  avatar,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  focused: boolean;
  flashed: boolean;
  rail: boolean;
  unread: number;
  avatar?: { uri?: string; name: string };
  onPress: () => void;
}) {
  const reduce = useReduceMotion();
  const pop = useRef(new Animated.Value(1)).current;
  const glow = useRef(new Animated.Value(focused ? 1 : 0)).current;
  const flashA = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) {
      glow.setValue(focused ? 1 : 0);
      flashA.setValue(flashed ? 1 : 0);
      return;
    }
    Animated.timing(glow, { toValue: focused ? 1 : 0, duration: motion.short, useNativeDriver: true }).start();
    Animated.timing(flashA, { toValue: flashed ? 1 : 0, duration: motion.instant, useNativeDriver: true }).start();
    if (focused) {
      pop.setValue(0.82);
      Animated.spring(pop, { toValue: 1, ...springs.snappy }).start();
    }
  }, [focused, flashed, reduce, pop, glow, flashA]);
  const tint = focused || flashed ? colors.accent : colors.textSecondary;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={`${label}${unread ? `, ${unread} unread` : ''}`}
      style={[styles.item, rail ? styles.railItem : null]}
    >
      {!rail ? (
        <Animated.View pointerEvents="none" style={[styles.flashPill, { opacity: Animated.multiply(flashA, 0.16) }]} />
      ) : (
        <Animated.View style={[styles.railIndicator, { opacity: glow, transform: [{ scaleX: glow }] }]} />
      )}
      <Animated.View style={{ transform: [{ scale: pop }] }}>
        {avatar ? (
          <View style={[styles.avatarRing, focused ? styles.avatarRingOn : null]}>
            <Avatar uri={avatar.uri} name={avatar.name} size={24} />
          </View>
        ) : (
          <Ionicons name={icon} size={24} color={tint} />
        )}
        {unread > 0 ? (
          <View style={styles.unreadBadge}>
            <Text style={styles.unreadText}>{unread > 99 ? '99+' : String(unread)}</Text>
          </View>
        ) : null}
      </Animated.View>
      {rail ? null : (
        <Text variant="tabLabel" style={{ color: tint }} maxFontSizeMultiplier={1.4} numberOfLines={1}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

function CreateTab({ rail, onPress, onLongPress }: { rail: boolean; onPress: () => void; onLongPress: () => void }) {
  const reduce = useReduceMotion();
  const press = useRef(new Animated.Value(1)).current;
  const to = (v: number) => (reduce ? press.setValue(1) : Animated.spring(press, { toValue: v, ...springs.snappy }).start());
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => to(0.9)}
      onPressOut={() => to(1)}
      delayLongPress={280}
      accessibilityRole="button"
      accessibilityLabel="Create"
      accessibilityHint="Tap to choose what to post. Hold for a quick post."
      style={[styles.item, rail ? styles.railItem : null]}
    >
      <Animated.View style={[styles.createLift, rail ? null : { transform: [{ translateY: -12 }, { scale: press }] }]}>
        <LinearGradient colors={[colors.accentGlow, colors.accent]} start={{ x: 0.3, y: 0 }} end={{ x: 0.7, y: 1 }} style={styles.create}>
          <Ionicons name="add" size={26} color={colors.onAccent} />
        </LinearGradient>
      </Animated.View>
      {rail ? (
        <Text variant="tabLabel" tone="secondary">
          Create
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: space.x4,
    right: space.x4,
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: radius.full,
    backgroundColor: 'rgba(15, 15, 19, 0.92)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.11)',
    overflow: 'visible',
    ...shadows.float,
  },
  rail: { position: 'absolute', left: 0, top: 0, bottom: 0, width: sizes.rail, backgroundColor: colors.canvas, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.borderSubtle, alignItems: 'center' },
  railMark: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', marginBottom: space.x6 },
  railMarkText: { fontFamily: 'Pretendard-ExtraBold', fontSize: 24, lineHeight: 28, color: colors.textPrimary, letterSpacing: -0.5 },
  railMarkDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent, marginLeft: 1, marginTop: 10 },
  railItems: { alignItems: 'center', gap: space.x3 },
  railIndicator: { position: 'absolute', top: 2, width: 56, height: 32, borderRadius: radius.full, backgroundColor: colors.surface2 },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 },
  railItem: { flex: 0, width: 64, height: 60, borderRadius: radius.md, justifyContent: 'flex-start', paddingVertical: 6 },
  flashPill: { ...StyleSheet.absoluteFillObject, borderRadius: radius.full, backgroundColor: colors.accent },
  avatarRing: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  avatarRingOn: { borderColor: colors.accent },
  createLift: { alignItems: 'center', justifyContent: 'center' },
  create: {
    width: sizes.createButton,
    height: sizes.createButton,
    borderRadius: sizes.createButton / 2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.accent,
    shadowOpacity: 0.42,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  unreadBadge: {
    position: 'absolute',
    top: -5,
    right: -10,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: colors.accent,
    borderWidth: 1.5,
    borderColor: colors.canvas,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadText: {
    fontFamily: fonts.bold,
    fontSize: 9.5,
    lineHeight: 11,
    color: colors.onAccent,
  },
});
