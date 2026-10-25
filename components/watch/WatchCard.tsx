import { Image } from 'expo-image';
import React from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { colors, radius, space } from '../../constants/theme';
import { Text } from '../ui/Text';

export function WatchCard({
  title,
  cover,
  meta,
  width = 132,
  onPress,
  progress,
}: {
  title: string;
  cover: string | null;
  meta?: string | null;
  width?: number;
  onPress: () => void;
  progress?: number;
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title} style={({ pressed }) => [{ width, opacity: pressed ? 0.85 : 1 }]}>
      <View style={[styles.poster, { width, height: width * 1.5 }]}>
        {cover ? <Image source={{ uri: cover }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} /> : null}
        {progress !== undefined ? (
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` }]} />
          </View>
        ) : null}
      </View>
      <Text variant="caption" numberOfLines={2} style={styles.title}>
        {title}
      </Text>
      {meta ? (
        <Text variant="caption" tone="tertiary" numberOfLines={1}>
          {meta}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function WatchRail<T extends { key: string }>({
  label,
  data,
  render,
}: {
  label: string;
  data: T[];
  render: (item: T) => React.ReactNode;
}) {
  return (
    <View style={styles.rail}>
      <Text variant="title" style={styles.railTitle}>
        {label}
      </Text>
      <FlatList
        horizontal
        data={data}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => <>{render(item)}</>}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: space.x4, gap: space.x3 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  poster: { borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.surface1 },
  barTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.25)' },
  barFill: { height: 3, backgroundColor: colors.accent },
  title: { marginTop: space.x2 },
  rail: { marginTop: space.x5, gap: space.x3 },
  railTitle: { paddingHorizontal: space.x4 },
});
