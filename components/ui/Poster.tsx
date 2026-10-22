import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useState } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { aspect, colors, fonts, radius } from '../../constants/theme';
import { Drama } from '../../lib/model';
import { useSlice } from '../../lib/store';
import { Text } from './Text';

function applyDataSaverUrl(url: string | undefined, targetWidth: 'w300' | 'w500'): string | undefined {
  if (!url) return url;
  return url.replace(/\/t\/p\/(original|w1280|w780|w500)\//, `/t/p/${targetWidth}/`);
}

interface PosterProps {
  drama: Pick<Drama, 'title' | 'posterUrl' | 'posterLocal' | 'tone' | 'year' | 'originalTitle'>;
  width: number;
  style?: StyleProp<ViewStyle>;
  rounded?: number;
  children?: React.ReactNode;
}

/**
 * 2:3 poster. Never distorted (cover). When there is no artwork we render a typographic
 * placeholder in the drama's tone — a designed state, not a broken image.
 */
export function Poster({ drama, width, style, rounded = radius.sm, children }: PosterProps) {
  const height = Math.round(width / aspect.poster);
  const dataSaver = useSlice((s) => s.prefs.dataSaver);
  const [failed, setFailed] = useState(false);
  const resolvedPosterUrl = dataSaver ? applyDataSaverUrl(drama.posterUrl, 'w300') : drama.posterUrl;
  const source = resolvedPosterUrl ? { uri: resolvedPosterUrl } : (drama.posterLocal ?? null);
  useEffect(() => setFailed(false), [resolvedPosterUrl]);
  const titleSize = Math.max(11, Math.min(18, width / 7));
  return (
    <View
      style={[{ width, height, borderRadius: rounded, backgroundColor: drama.tone, overflow: 'hidden' }, width >= 56 ? styles.edge : null, style]}
      accessibilityRole="image"
      accessibilityLabel={`${drama.title}${drama.year ? `, ${drama.year}` : ''} poster`}
    >
      {source && !failed ? (
        <Image
          source={source}
          style={{ width, height }}
          contentFit="cover"
          transition={200}
          cachePolicy="memory-disk"
          onError={() => setFailed(true)}
          recyclingKey={drama.title}
        />
      ) : (
        <LinearGradient
          colors={[drama.tone || colors.surface2, '#0B0B10']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.fallback}
        >
          <View style={styles.rule} />
          <Text style={{ fontFamily: fonts.bold, fontSize: titleSize, lineHeight: titleSize * 1.15, color: colors.textPrimary, letterSpacing: -0.2 }} numberOfLines={4}>
            {drama.title}
          </Text>
          {drama.originalTitle && width >= 100 ? (
            <Text style={{ fontFamily: fonts.regular, fontSize: Math.max(10, titleSize * 0.7), lineHeight: titleSize, color: colors.textSecondary, marginTop: 4 }} numberOfLines={2}>
              {drama.originalTitle}
            </Text>
          ) : null}
          <Text style={{ fontFamily: fonts.medium, fontSize: Math.max(9, titleSize * 0.65), color: colors.textTertiary, position: 'absolute', left: 10, bottom: 10 }}>{drama.year}</Text>
        </LinearGradient>
      )}
      {children}
    </View>
  );
}

/** 16:9 backdrop / cinema hero with smooth multi-stop LinearGradient melt into the OLED canvas. */
export function Backdrop({
  uri,
  fallbackColor,
  width,
  height,
  children,
  style,
  label,
  cinemaGradient = false,
  accentGlow,
}: {
  uri?: string | number;
  fallbackColor: string;
  width: number | `${number}%`;
  height: number;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  label?: string;
  cinemaGradient?: boolean;
  accentGlow?: string;
}) {
  const [failed, setFailed] = useState(false);
  const dataSaver = useSlice((s) => s.prefs.dataSaver);
  const resolvedUri =
    typeof uri === 'string' && dataSaver ? applyDataSaverUrl(uri, 'w500') : uri;
  const source = typeof resolvedUri === 'number' ? resolvedUri : resolvedUri ? { uri: resolvedUri } : null;
  useEffect(() => setFailed(false), [resolvedUri]);
  return (
    <View style={[{ width, height, backgroundColor: fallbackColor, overflow: 'hidden' }, style]} accessibilityLabel={label}>
      {source && !failed ? (
        <Image
          source={source}
          style={{ width: '100%', height }}
          contentFit="cover"
          transition={240}
          cachePolicy="memory-disk"
          onError={() => setFailed(true)}
        />
      ) : accentGlow ? (
        <LinearGradient
          colors={[accentGlow, fallbackColor, colors.canvas]}
          start={{ x: 0.15, y: 0 }}
          end={{ x: 0.85, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {cinemaGradient ? (
        <>
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(0,0,0,0.68)', 'rgba(0,0,0,0.08)', 'rgba(0,0,0,0)']}
            locations={[0, 0.32, 0.55]}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            pointerEvents="none"
            colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.48)', 'rgba(0,0,0,0.88)', colors.canvas]}
            locations={[0.22, 0.58, 0.84, 1]}
            style={StyleSheet.absoluteFill}
          />
        </>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: { flex: 1, padding: 10, paddingTop: 14, justifyContent: 'flex-start' },
  rule: { width: 18, height: 2, backgroundColor: colors.accent, marginBottom: 8, borderRadius: 1 },
  edge: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
});
