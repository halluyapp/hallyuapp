import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { Linking } from 'react-native';
import { TypeVariant } from '../../constants/theme';
import { Text, TextTone } from '../ui/Text';

interface RichTextProps {
  text: string;
  variant?: TypeVariant;
  tone?: TextTone;
  numberOfLines?: number;
}

const TOKEN = /(#[\p{L}\p{N}_]+|@[a-zA-Z0-9_.]+|https?:\/\/\S+)/gu;

/** Body text with tappable #hashtags (→ search), @mentions (→ profile) and links (→ browser). */
export function RichText({ text, variant = 'body', tone, numberOfLines }: RichTextProps) {
  const router = useRouter();
  const safeText = typeof text === 'string' ? text : '';
  const parts = useMemo(() => safeText.split(TOKEN), [safeText]);
  return (
    <Text variant={variant} tone={tone} numberOfLines={numberOfLines}>
      {parts.map((part, i) => {
        if (!part) return null;
        if (part.startsWith('#')) {
          return (
            <Text key={i} variant={variant} tone="accent" onPress={() => router.push({ pathname: '/search', params: { q: part } })} accessibilityRole="link">
              {part}
            </Text>
          );
        }
        if (part.startsWith('@')) {
          return (
            <Text key={i} variant={variant} tone="accent" onPress={() => router.push(`/user/${part.slice(1)}`)} accessibilityRole="link">
              {part}
            </Text>
          );
        }
        if (part.startsWith('http')) {
          return (
            <Text key={i} variant={variant} tone="info" onPress={() => Linking.openURL(part).catch(() => {})} accessibilityRole="link">
              {part.replace(/^https?:\/\//, '')}
            </Text>
          );
        }
        return part;
      })}
    </Text>
  );
}
