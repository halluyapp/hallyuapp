import React from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, ScrollViewProps, StyleProp, StyleSheet, View, ViewProps, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, sizes, space } from '../../constants/theme';
import { useLayout } from '../../lib/hooks';
import { useSlice } from '../../lib/store';
import { OfflineBanner } from './States';

export const CINEMA_CHARCOAL_CANVAS = '#111116';

export function useCanvasColor(): string {
  const trueBlack = useSlice((s) => s.prefs.trueBlack);
  return trueBlack ? colors.canvas : CINEMA_CHARCOAL_CANVAS;
}

interface ScreenProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** add bottom padding for the tab bar */
  tabbed?: boolean;
  /** show offline banner under the header */
  offlineBanner?: boolean;
  header?: React.ReactNode;
  /**
   * Responder-capture hook on the screen root. Returning `false` from it observes the touch without
   * claiming it, so screens can open an interaction gate (see `useInteractionGate`) without adding
   * a wrapper view or swallowing a single press.
   */
  onStartShouldSetResponderCapture?: ViewProps['onStartShouldSetResponderCapture'];
}

/** Canvas container. Handles background + optional header slot + offline banner. */
export function Screen({ children, style, header, offlineBanner = true, onStartShouldSetResponderCapture }: ScreenProps) {
  const canvasColor = useCanvasColor();
  return (
    <View style={[styles.root, { backgroundColor: canvasColor }, style]} onStartShouldSetResponderCapture={onStartShouldSetResponderCapture}>
      {header}
      {offlineBanner ? <OfflineBanner /> : null}
      {children}
    </View>
  );
}

interface ScrollScreenProps extends ScrollViewProps {
  children: React.ReactNode;
  tabbed?: boolean;
  /** constrain to the reading column on wide screens */
  column?: boolean;
  keyboard?: boolean;
  padded?: boolean;
}

export function ScrollScreen({ children, tabbed, column, keyboard, padded, contentContainerStyle, ...rest }: ScrollScreenProps) {
  const insets = useSafeAreaInsets();
  const { margin } = useLayout();
  const body = (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentInsetAdjustmentBehavior="never"
      {...rest}
      contentContainerStyle={[{ paddingBottom: (tabbed ? sizes.tabBar : 0) + insets.bottom + space.x6 }, column ? styles.column : null, padded ? { paddingHorizontal: margin } : null, contentContainerStyle]}
    >
      {children}
    </ScrollView>
  );
  if (!keyboard) return body;
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {body}
    </KeyboardAvoidingView>
  );
}

export function useListPadding(tabbed = true) {
  const insets = useSafeAreaInsets();
  return { paddingBottom: (tabbed ? sizes.tabBar : 0) + insets.bottom + space.x6 };
}

/**
 * Reading column for medium/expanded widths: content stays a comfortable measure and sits centred
 * instead of stretching edge to edge. A no-op on compact phones. Spread it into a list's
 * `contentContainerStyle` or a wrapper's style.
 */
export function useColumn(max: number = sizes.readingColumn): ViewStyle {
  const { wc } = useLayout();
  return wc === 'compact' ? {} : { width: '100%', maxWidth: max, alignSelf: 'center' };
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  column: { width: '100%', maxWidth: sizes.readingColumn, alignSelf: 'center' },
});
