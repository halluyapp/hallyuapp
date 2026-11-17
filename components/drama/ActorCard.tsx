import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { FlatList, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { colors, fonts, radius, space } from '../../constants/theme';
import { initials } from '../../lib/format';
import { Actor } from '../../lib/model';
import { Tap } from '../ui/Tap';
import { Text } from '../ui/Text';

/** Actor portrait: circle at rails, square in cast grid. Placeholder = initials in tone. */
export function ActorPortrait({ actor, size = 72, square }: { actor: Actor; size?: number; square?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [actor.photoUrl]);
  const r = square ? radius.md : size / 2;
  const seed = actor.id.length % 7;
  const tones = ['#3B2F4A', '#2F3A2A', '#3A2A2A', '#2A3A3A', '#3F352A', '#2A3340', '#4A2F3A'];
  return (
    <View
      style={{ width: size, height: square ? size * 1.25 : size, borderRadius: r, backgroundColor: tones[seed], overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}
      accessibilityRole="image"
      accessibilityLabel={actor.name}
    >
      {actor.photoUrl && !failed ? (
        <Image source={{ uri: actor.photoUrl }} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={160} cachePolicy="memory-disk" onError={() => setFailed(true)} />
      ) : (
        <Text style={{ fontFamily: fonts.semibold, fontSize: size * 0.3, color: colors.textPrimary }}>{initials(actor.name)}</Text>
      )}
    </View>
  );
}

interface ActorCardProps {
  actor: Actor;
  role?: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
  layout?: 'rail' | 'grid' | 'row';
  right?: React.ReactNode;
}

export function ActorCard({ actor, role, size = 72, style, layout = 'rail', right }: ActorCardProps) {
  const router = useRouter();
  const go = () => router.push(`/actor/${actor.id}`);
  if (layout === 'row') {
    return (
      <View style={[styles.row, style]}>
        <Tap
          onPress={go}
          accessibilityRole="button"
          accessibilityLabel={`${actor.name}${role ? ` as ${role}` : ''}`}
          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.x3 }}
        >
          <ActorPortrait actor={actor} size={48} />
          <View style={{ flex: 1 }}>
            <Text variant="titleSmall" numberOfLines={1}>
              {actor.name}
            </Text>
            <Text variant="caption" tone="secondary" numberOfLines={1}>
              {role ?? actor.koreanName ?? ''}
            </Text>
          </View>
        </Tap>
        {right}
      </View>
    );
  }
  return (
    <Tap
      onPress={go}
      accessibilityRole="button"
      accessibilityLabel={`${actor.name}${role ? ` as ${role}` : ''}`}
      style={[{ width: layout === 'grid' ? size : size, alignItems: layout === 'grid' ? 'flex-start' : 'center' }, style]}
    >
      <ActorPortrait actor={actor} size={size} square={layout === 'grid'} />
      <Text variant="label" numberOfLines={2} align={layout === 'grid' ? 'left' : 'center'} style={{ marginTop: space.x2 }}>
        {actor.name}
      </Text>
      {role ? (
        <Text variant="caption" tone="tertiary" numberOfLines={2} align={layout === 'grid' ? 'left' : 'center'}>
          {role}
        </Text>
      ) : actor.koreanName ? (
        <Text variant="caption" tone="tertiary" numberOfLines={1} align="center">
          {actor.koreanName}
        </Text>
      ) : null}
    </Tap>
  );
}

export function ActorRail({ actors, roles, size = 72 }: { actors: Actor[]; roles?: Record<string, string>; size?: number }) {
  return (
    <FlatList
      horizontal
      data={actors}
      keyExtractor={(a) => a.id}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.x4 }}
      renderItem={({ item }) => <ActorCard actor={item} role={roles?.[item.id]} size={size} />}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.x3, paddingVertical: space.x2 },
});
