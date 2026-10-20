import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { colors, radius, space } from '../../constants/theme';
import { haptic, useApp } from '../../lib/hooks';
import { PostType } from '../../lib/model';
import { Sheet } from '../ui/Sheet';
import { Text } from '../ui/Text';

export const CREATE_TYPES: { type: PostType; label: string; hint: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { type: 'reaction', label: 'Reaction', hint: 'A quick feeling, 140 characters. Tied to a drama or episode.', icon: 'flash-outline' },
  { type: 'post', label: 'Post', hint: 'Text, up to 4 photos, or an interactive poll.', icon: 'create-outline' },
  { type: 'discussion', label: 'Discussion', hint: 'A titled thread: theory, ending, character, scene, question.', icon: 'chatbubbles-outline' },
  { type: 'review', label: 'Review', hint: 'Rate 1–10, one-line verdict, then the long version.', icon: 'star-outline' },
  { type: 'recommendation', label: 'Recommendation', hint: '“If you liked X, watch Y.” Paired dual posters.', icon: 'gift-outline' },
  { type: 'short', label: 'Short', hint: 'A 3–60 second vertical video with a drama attached.', icon: 'videocam-outline' },
];

export interface CreateSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Pre-attach context (from a drama/episode/actor/community screen). */
  context?: { dramaId?: string; season?: number; episode?: number; actorId?: string; actorIds?: string[]; communityId?: string };
}

/** Create hub: six clear doors + instant Poll banner + Drafts. */
export function CreateSheet({ visible, onClose, context }: CreateSheetProps) {
  const router = useRouter();
  const { state, getDrama } = useApp();
  const drama = getDrama(context?.dramaId);
  const resolvedActorId = context?.actorId ?? context?.actorIds?.[0];

  const open = (type: PostType, extra?: Record<string, string>) => {
    haptic.light();
    onClose();
    setTimeout(
      () =>
        router.push({
          pathname: '/create/[type]',
          params: {
            type,
            ...(context?.dramaId ? { dramaId: context.dramaId } : {}),
            ...(context?.season ? { season: String(context.season) } : {}),
            ...(context?.episode ? { episode: String(context.episode) } : {}),
            ...(resolvedActorId ? { actorId: resolvedActorId } : {}),
            ...(context?.communityId ? { communityId: context.communityId } : {}),
            ...(extra ?? {}),
          },
        }),
      160,
    );
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Create" subtitle={drama ? `About ${drama.title}${context?.episode ? ` · Ep ${context.episode}` : ''}` : 'What kind of post is this?'}>
      <Pressable
        onPress={() => open('post', { poll: '1' })}
        style={({ pressed }) => [styles.pollBanner, pressed ? { opacity: 0.85 } : null]}
        accessibilityRole="button"
        accessibilityLabel="Create interactive community poll"
      >
        <View style={styles.pollIcon}>
          <Ionicons name="stats-chart" size={19} color={colors.accent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="titleSmall">Interactive Poll</Text>
          <Text variant="caption" tone="secondary">
            Let the fandom vote live on endings, characters, or tonight’s pick
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.accent} />
      </Pressable>

      <View style={styles.grid}>
        {CREATE_TYPES.map((t) => (
          <Pressable key={t.type} onPress={() => open(t.type)} style={({ pressed }) => [styles.tile, pressed ? { backgroundColor: colors.surface3 } : null]} accessibilityRole="button" accessibilityLabel={t.label} accessibilityHint={t.hint}>
            <View style={styles.icon}>
              <Ionicons name={t.icon} size={22} color={colors.textPrimary} />
            </View>
            <Text variant="titleSmall">{t.label}</Text>
            <Text variant="caption" tone="secondary" numberOfLines={3}>
              {t.hint}
            </Text>
          </Pressable>
        ))}
      </View>

      {state.drafts.length ? (
        <Pressable onPress={() => { onClose(); setTimeout(() => router.push('/drafts'), 160); }} style={styles.drafts} accessibilityRole="button" accessibilityLabel={`${state.drafts.length} drafts`}>
          <Ionicons name="document-text-outline" size={18} color={colors.textSecondary} />
          <Text variant="label" tone="secondary" style={{ flex: 1 }}>
            {state.drafts.length} {state.drafts.length === 1 ? 'draft' : 'drafts'} waiting
          </Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
        </Pressable>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  pollBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    padding: space.x3,
    marginBottom: space.x2,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
  },
  pollIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x2 },
  tile: { width: '48%', flexGrow: 1, backgroundColor: colors.surface1, borderRadius: radius.md, padding: space.x3, gap: 6, minHeight: 120 },
  icon: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.surface3, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  drafts: { flexDirection: 'row', alignItems: 'center', gap: space.x2, marginTop: space.x3, padding: space.x3, backgroundColor: colors.surface1, borderRadius: radius.md },
});
