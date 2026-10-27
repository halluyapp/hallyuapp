import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { colors, radius, space } from '../../constants/theme';
import { Text } from '../ui/Text';

type WatchSection = 'browse' | 'downloads';

/** Hallyu TV's internal Browse/Downloads switch. It does not add a global app tab. */
export function WatchNav({ active }: { active: WatchSection }) {
  const router = useRouter();
  return (
    <View accessibilityRole="tablist" style={styles.wrap}>
      {([
        ['browse', 'Browse', '/watch'],
        ['downloads', 'Downloads', '/watch/downloads'],
      ] as const).map(([key, label, route]) => {
        const selected = active === key;
        return (
          <Pressable
            key={key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => { if (!selected) router.replace(route); }}
            style={[styles.tab, selected && styles.selected]}
          >
            <Text variant="caption" tone={selected ? 'onAccent' : 'secondary'}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignSelf: 'flex-start', marginHorizontal: space.x4, marginTop: space.x3, padding: 3, gap: 3, borderRadius: radius.md, backgroundColor: colors.surface1 },
  tab: { minHeight: 34, minWidth: 84, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.x3, borderRadius: radius.sm },
  selected: { backgroundColor: colors.accent },
});
