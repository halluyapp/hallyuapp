import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { FlatList, Share, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { colors, radius, sizes, space } from '../../constants/theme';
import { compact } from '../../lib/format';
import { haptic, useApp, useRequireMember } from '../../lib/hooks';
import { Drama } from '../../lib/model';
import { AddToCollectionSheet } from '../collections/AddToCollectionSheet';
import { Poster } from '../ui/Poster';
import { ProgressBar, WatchRing } from '../ui/Section';
import { Sheet, SheetRow } from '../ui/Sheet';
import { Tap } from '../ui/Tap';
import { Text } from '../ui/Text';
import { useToast } from '../ui/Toast';
import { STATUS_LABEL, WatchStatusSheet } from './WatchStatus';

export type DramaCardSize = 's' | 'm' | 'l' | 'xl';

interface DramaCardProps {
  drama: Drama;
  size?: DramaCardSize;
  reason?: string; // "Because you follow…"
  meta?: string; // override meta line
  showProgress?: boolean;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  selected?: boolean;
  badge?: string;
  /**
   * Exact card width, for grids whose columns are as wide as the screen allows. The `size` presets
   * are fixed poster widths, so a two-column grid built from them leaves whatever is left of the
   * row empty — the card is told the column width instead.
   */
  width?: number;
}

/** Poster card. Tap → Drama Hub. Long-press → quick actions sheet. */
function DramaCardBase({ drama, size = 'm', reason, meta, showProgress = true, style, onPress, selected, badge, width: fixedWidth }: DramaCardProps) {
  const router = useRouter();
  const { watch } = useApp();
  const width = fixedWidth ?? sizes.poster[size];
  const [menu, setMenu] = useState(false);
  const item = watch(drama.id);
  const rawTotal = item ? drama.seasons.find((s) => s.number === item.season)?.episodeCount ?? drama.episodeCount : 0;
  const total = item ? rawTotal || (drama.mediaType === 'movie' ? 1 : 16) : 0;
  const line = meta ?? [drama.year, drama.genres[0]].filter(Boolean).join(' · ');
  return (
    <>
      <Tap
        onPress={onPress ?? (() => router.push(`/drama/${drama.id}`))}
        onLongPress={() => {
          haptic.medium();
          setMenu(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${drama.title}, ${line}${drama.status === 'airing' ? ', airing now' : ''}${item ? `, ${STATUS_LABEL[item.status]}${item.status === 'watching' ? ` episode ${item.currentEpisode}` : ''}` : ''}${selected ? ', selected' : ''}`}
        accessibilityHint="Opens the drama hub. Long press for quick actions."
        accessibilityState={{ selected: !!selected }}
        style={[{ width }, style]}
      >
        <Poster drama={drama} width={width} rounded={radius.md} style={selected ? styles.selected : null}>
          {drama.status === 'airing' ? (
            <View style={styles.tag}>
              <View style={styles.dot} />
              <Text variant="overline" style={{ color: colors.textPrimary, fontSize: 9, lineHeight: 11 }}>
                Airing
              </Text>
            </View>
          ) : badge ? (
            <View style={[styles.tag, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
              <Text variant="overline" style={{ color: colors.textPrimary, fontSize: 9, lineHeight: 11 }}>
                {badge}
              </Text>
            </View>
          ) : null}
          {selected ? (
            <View style={styles.check}>
              <Ionicons name="checkmark" size={14} color={colors.onAccent} />
            </View>
          ) : null}
          {showProgress && item?.status === 'watching' && total > 0 ? (
            <>
              <View style={styles.ring}>
                <WatchRing progress={item.currentEpisode / total} />
              </View>
              <ProgressBar value={item.currentEpisode} max={total} style={styles.progress} />
            </>
          ) : null}
        </Poster>
        <Text variant={size === 's' ? 'caption' : 'title'} numberOfLines={1} style={{ marginTop: space.x2, color: colors.textPrimary }}>
          {drama.title}
        </Text>
        {size !== 's' ? (
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            {reason ?? line}
          </Text>
        ) : null}
      </Tap>
      <DramaQuickActions drama={drama} visible={menu} onClose={() => setMenu(false)} />
    </>
  );
}

/** Long-press sheet: Follow · Watch status · Add to collection · Share. */
export function DramaQuickActions({ drama, visible, onClose }: { drama: Drama; visible: boolean; onClose: () => void }) {
  const { isFollowing, dispatch, watch } = useApp();
  const require = useRequireMember();
  const toast = useToast();
  const [status, setStatus] = useState(false);
  const [collect, setCollect] = useState(false);
  const following = isFollowing('dramas', drama.id);
  const item = watch(drama.id);
  return (
    <>
      <Sheet visible={visible} onClose={onClose} title={drama.title} subtitle={`${drama.year} · ${drama.genres.join(', ')} · ${compact(drama.followerCount)} fans`}>
        <SheetRow icon={following ? 'checkmark-circle' : 'add-circle-outline'} label={following ? 'Following' : 'Follow'} onPress={() => require('follow this drama', () => { dispatch({ type: 'follow', kind: 'dramas', id: drama.id }); onClose(); })} />
        <SheetRow icon="tv-outline" label={item ? STATUS_LABEL[item.status] : 'Add to watchlist'} detail={item ? 'Change status or progress' : undefined} onPress={() => require('track this drama', () => { onClose(); setTimeout(() => setStatus(true), 200); })} />
        <SheetRow icon="albums-outline" label="Add to collection" onPress={() => require('save to a collection', () => { onClose(); setTimeout(() => setCollect(true), 200); })} />
        <SheetRow icon="share-outline" label="Share" onPress={() => { onClose(); Share.share({ message: `${drama.title} on Hallyu — https://hallyu.app/d/${drama.id}` }).catch(() => toast.show('Could not open share sheet')); }} />
      </Sheet>
      <WatchStatusSheet drama={drama} visible={status} onClose={() => setStatus(false)} />
      <AddToCollectionSheet dramaId={drama.id} visible={collect} onClose={() => setCollect(false)} />
    </>
  );
}

/** Horizontal rail of drama cards. */
export function DramaRail({ dramas, size = 'm', reasons, style, onPressItem, badges }: { dramas: Drama[]; size?: DramaCardSize; reasons?: Record<string, string>; style?: StyleProp<ViewStyle>; onPressItem?: (d: Drama) => void; badges?: Record<string, string> }) {
  return (
    <FlatList
      horizontal
      data={dramas}
      keyExtractor={(d) => d.id}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[{ paddingHorizontal: space.margin, gap: space.gutter }, style]}
      renderItem={({ item }) => <DramaCard drama={item} size={size} reason={reasons?.[item.id]} onPress={onPressItem ? () => onPressItem(item) : undefined} badge={badges?.[item.id]} />}
      initialNumToRender={5}
      windowSize={5}
    />
  );
}

/** List row variant (search results, watchlist) */
export function DramaListRow({ drama, right, subtitle, onPress, onLongPress, style, title, badge, accessibilityHint }: { drama: Drama; right?: React.ReactNode; subtitle?: string; onPress?: () => void; onLongPress?: () => void; style?: StyleProp<ViewStyle>; title?: string; badge?: string; accessibilityHint?: string }) {
  const router = useRouter();
  return (
    <Tap
      onPress={onPress ?? (() => router.push(`/drama/${drama.id}`))}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${title ?? drama.title}${drama.year ? `, ${drama.year}` : ''}${subtitle ? `, ${subtitle}` : ''}${badge ? `, ${badge}` : ''}`}
      accessibilityHint={accessibilityHint}
      style={[styles.row, style]}
    >
      <Poster drama={drama} width={56} rounded={radius.xs} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text variant="titleSmall" numberOfLines={1} style={{ flexShrink: 1 }}>
            {title ?? drama.title}
          </Text>
          {badge ? (
            <View style={styles.rowBadge}>
              <Text variant="overline" tone="secondary">
                {badge}
              </Text>
            </View>
          ) : null}
        </View>
        <Text variant="caption" tone="secondary" numberOfLines={1}>
          {subtitle ?? `${drama.year} · ${drama.genres.slice(0, 2).join(', ')}${drama.network ? ` · ${drama.network}` : ''}`}
        </Text>
      </View>
      {right}
    </Tap>
  );
}

const styles = StyleSheet.create({
  rowBadge: { paddingHorizontal: 6, height: 18, borderRadius: 4, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  tag: { position: 'absolute', top: 6, left: 6, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(10,10,10,0.7)', paddingHorizontal: 6, height: 18, borderRadius: 9 },
  ring: { position: 'absolute', top: 6, right: 6 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.live },
  progress: { position: 'absolute', left: 0, right: 0, bottom: 0, borderRadius: 0 },
  selected: { borderWidth: 2, borderColor: colors.accent },
  check: { position: 'absolute', top: 6, right: 6, width: 22, height: 22, borderRadius: 11, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.x3, paddingVertical: space.x2 },
});

/** Memoised: with tracked store getters, a card re-renders only when its own data changes. */
export const DramaCard = React.memo(DramaCardBase);
