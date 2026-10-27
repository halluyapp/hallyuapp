import { Ionicons } from '@expo/vector-icons';
import React, { forwardRef, useState } from 'react';
import { Pressable, StyleProp, StyleSheet, TextInput, TextInputProps, View, ViewStyle } from 'react-native';
import { colors, fonts, radius, space } from '../../constants/theme';
import { Text } from './Text';

export interface TextFieldProps extends TextInputProps {
  label?: string;
  hint?: string;
  error?: string | null;
  leading?: keyof typeof Ionicons.glyphMap;
  trailing?: React.ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
  counter?: number; // max length to show n/max
  password?: boolean;
  multilineHeight?: number;
}

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, hint, error, leading, trailing, containerStyle, counter, password, multilineHeight, style, onFocus, onBlur, value, ...rest },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(!!password);
  // A text field's boundary has to be visible before it is touched: at rest the old #1C1C1F border
  // measured 1.13:1 against the surface it sits on, so the field had no edge at all until focus
  // arrived. Rest is now borderStrong (3.13:1) and focus moves to the accent (4.08:1), which also
  // gives keyboard navigation on web something to show.
  const border = error ? colors.danger : focused ? colors.accent : colors.borderStrong;
  const len = value?.length ?? 0;
  const over = counter !== undefined && len > counter;
  return (
    <View style={containerStyle}>
      {label ? (
        <Text variant="label" tone="secondary" style={styles.label}>
          {label}
        </Text>
      ) : null}
      <View style={[styles.box, { borderColor: border }, rest.multiline ? { minHeight: multilineHeight ?? 120, alignItems: 'flex-start' } : null]}>
        {leading ? <Ionicons name={leading} size={18} color={focused ? colors.textPrimary : colors.textTertiary} style={styles.leading} /> : null}
        <TextInput
          ref={ref}
          {...rest}
          value={value}
          secureTextEntry={hidden}
          placeholderTextColor={colors.textTertiary}
          selectionColor={colors.accent}
          cursorColor={colors.accent}
          keyboardAppearance="dark"
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[styles.input, rest.multiline ? { textAlignVertical: 'top', paddingTop: 12, minHeight: multilineHeight ?? 120 } : null, style]}
          accessibilityLabel={rest.accessibilityLabel ?? label}
        />
        {password ? (
          <Pressable onPress={() => setHidden((h) => !h)} hitSlop={10} accessibilityRole="button" accessibilityLabel={hidden ? 'Show password' : 'Hide password'} style={styles.trailing}>
            <Ionicons name={hidden ? 'eye-outline' : 'eye-off-outline'} size={20} color={colors.textSecondary} />
          </Pressable>
        ) : trailing ? (
          <View style={styles.trailing}>{trailing}</View>
        ) : null}
      </View>
      {error || hint || counter !== undefined ? (
        <View style={styles.meta}>
          <Text variant="caption" tone={error ? 'danger' : 'tertiary'} style={{ flex: 1 }} accessibilityLiveRegion={error ? 'polite' : 'none'}>
            {error ?? hint ?? ''}
          </Text>
          {counter !== undefined ? (
            <Text variant="caption" tone={over ? 'danger' : 'tertiary'} numeric>
              {len}/{counter}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  label: { marginBottom: space.x2 },
  box: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface1, borderRadius: radius.md, borderWidth: 1, minHeight: 48, paddingHorizontal: space.x3 },
  leading: { marginRight: space.x2 },
  trailing: { marginLeft: space.x2, alignSelf: 'center' },
  input: { flex: 1, color: colors.textPrimary, fontFamily: fonts.regular, fontSize: 15, lineHeight: 20, paddingVertical: 12 },
  meta: { flexDirection: 'row', marginTop: space.x1 + 2, gap: space.x2 },
});
