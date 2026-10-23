import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import { colors, motion, space } from '../../constants/theme';
import { haptic } from '../../lib/hooks';
import { Text } from './Text';

export interface SegmentItem<T extends string> {
  key: T;
  label: string;
  count?: number;
  dot?: boolean;
}

interface SegmentedProps<T extends string> {
  items: SegmentItem<T>[];
  value: T;
  onChange: (v: T) => void;
  scrollable?: boolean; // defaults to true when items.length > 3
  style?: StyleProp<ViewStyle>;
  variant?: 'underline' | 'pill';
}

/** Section tabs. Underline variant = text tabs with an animated 2dp indicator (Home, Drama Hub). Pill = segmented control (Watchlist). */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  scrollable,
  style,
  variant = 'underline',
}: SegmentedProps<T>) {
  const isScrollable = scrollable ?? (variant === 'underline' && items.length > 3);
  const [layouts, setLayouts] = useState<Record<string, { x: number; w: number }>>({});
  const x = useRef(new Animated.Value(0)).current;
  const w = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    const l = layouts[value];
    if (!l) return;
    Animated.parallel([
      Animated.timing(x, { toValue: l.x, duration: motion.medium, useNativeDriver: false }),
      Animated.timing(w, { toValue: l.w, duration: motion.medium, useNativeDriver: false }),
    ]).start();
    if (isScrollable) scrollRef.current?.scrollTo({ x: Math.max(0, l.x - 80), animated: true });
  }, [value, layouts, x, w, isScrollable]);

  const onLayout = (key: string) => (e: LayoutChangeEvent) => {
    const { x: lx, width } = e.nativeEvent.layout;
    setLayouts((prev) =>
      prev[key]?.x === lx && prev[key]?.w === width ? prev : { ...prev, [key]: { x: lx, w: width } },
    );
  };

  // IMPORTANT: Never set `{ flex: 1 }` on `content` inside column-flex `styles.wrap` — on Android
  // Yoga that sets `flexBasis: 0` vertically, collapsing `styles.wrap` height to 1dp so the sibling
  // `<ScrollView>` paints directly on top of the tab bar and blocks touch events!
  const content = (
    <View
      style={[
        variant === 'pill' ? styles.pillWrap : styles.row,
        !isScrollable && variant === 'underline' ? { width: '100%' } : null,
      ]}
      accessibilityRole="tablist"
    >
      {items.map((it) => {
        const active = it.key === value;
        return (
          <Pressable
            key={it.key}
            onLayout={onLayout(it.key)}
            onPress={() => {
              if (!active) {
                haptic.select();
                onChange(it.key);
              }
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${it.label}${it.count ? `, ${it.count}` : ''}`}
            style={[
              variant === 'pill' ? [styles.pill, active ? styles.pillActive : null] : styles.tab,
              !isScrollable && variant === 'underline' ? { flex: 1, alignItems: 'center' } : null,
            ]}
          >
            <View style={styles.labelRow}>
              <Text
                variant={variant === 'pill' ? 'label' : 'titleSmall'}
                numberOfLines={1}
                style={{ color: active ? colors.textPrimary : colors.textSecondary }}
              >
                {it.label}
              </Text>
              {it.count !== undefined ? (
                <Text variant="caption" tone={active ? 'secondary' : 'tertiary'} numeric>
                  {it.count}
                </Text>
              ) : null}
              {it.dot ? <View style={styles.dot} /> : null}
            </View>
          </Pressable>
        );
      })}
      {variant === 'underline' ? <Animated.View style={[styles.indicator, { left: x, width: w }]} /> : null}
    </View>
  );

  if (variant === 'pill') return <View style={[styles.pillOuter, style]}>{content}</View>;
  return (
    <View style={[styles.wrap, style]}>
      {isScrollable ? (
        <ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ paddingHorizontal: space.margin - space.x3 }}
        >
          {content}
        </ScrollView>
      ) : (
        content
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexShrink: 0,
    minHeight: 45,
    backgroundColor: colors.canvas,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    zIndex: 2,
  },
  pillOuter: { flexShrink: 0, zIndex: 2 },
  row: { flexDirection: 'row', position: 'relative', minHeight: 44 },
  tab: { paddingHorizontal: space.x3, height: 44, justifyContent: 'center' },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  indicator: { position: 'absolute', bottom: 0, height: 2, backgroundColor: colors.accent, borderRadius: 1 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  pillWrap: { flexDirection: 'row', backgroundColor: colors.surface1, borderRadius: 999, padding: 3, gap: 2 },
  pill: { flex: 1, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 999 },
  pillActive: { backgroundColor: colors.surface3 },
});
