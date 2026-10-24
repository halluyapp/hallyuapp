import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { CREATE_TYPES } from '../components/create/CreateSheet';
import { Dialog } from '../components/ui/Dialog';
import { IconButton } from '../components/ui/IconButton';
import { Poster } from '../components/ui/Poster';
import { Screen, useListPadding } from '../components/ui/Screen';
import { EmptyState } from '../components/ui/States';
import { Text } from '../components/ui/Text';
import { TopBar } from '../components/ui/TopBar';
import { colors, radius, space } from '../constants/theme';
import { timeAgo } from '../lib/format';
import { useApp } from '../lib/hooks';

/** Drafts — device-local, newest first. Tap resumes in the composer. */
export default function Drafts() {
  const router = useRouter();
  const { state, dispatch, getDrama } = useApp();
  const padding = useListPadding(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const drafts = [...state.drafts].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return (
    <Screen header={<TopBar mode="stack" title="Drafts" subtitle={drafts.length ? `${drafts.length} on this device` : undefined} />}>
      <FlatList
        data={drafts}
        keyExtractor={(d) => d.id}
        contentContainerStyle={[padding, drafts.length ? null : { flex: 1 }]}
        renderItem={({ item: d }) => {
          // A draft saved by an older build can carry a type this build no longer has. Show it with the
          // generic entry instead of crashing the whole list.
          const meta = CREATE_TYPES.find((t) => t.type === d.type) ?? CREATE_TYPES[0]!;
          const drama = getDrama(d.context.dramaId);
          const preview = d.title || d.verdict || d.body || (d.images.length ? `${d.images.length} image${d.images.length > 1 ? 's' : ''}` : 'Empty draft');
          return (
            <Pressable onPress={() => router.push({ pathname: '/create/[type]', params: { type: d.type, draftId: d.id } })} style={({ pressed }) => [styles.row, pressed ? { backgroundColor: colors.surface2 } : null]} accessibilityRole="button" accessibilityLabel={`${meta.label} draft: ${preview}`}>
              {drama ? <Poster drama={drama} width={40} rounded={4} /> : <View style={styles.icon}><Ionicons name={meta.icon} size={18} color={colors.textSecondary} /></View>}
              <View style={{ flex: 1 }}>
                <Text variant="caption" tone="secondary">
                  {meta.label}
                  {drama ? ` · ${drama.title}` : ''}
                  {d.context.episode ? ` · Ep ${d.context.episode}` : ''} · {timeAgo(d.updatedAt)}
                </Text>
                <Text variant="body" numberOfLines={2}>
                  {preview}
                </Text>
              </View>
              <IconButton icon="trash-outline" label="Delete draft" onPress={() => setConfirm(d.id)} />
            </Pressable>
          );
        }}
        ListEmptyComponent={<EmptyState icon="document-text-outline" title="No drafts" body="Leave the composer with something written and we’ll keep it here." actionLabel="Start a post" onAction={() => router.replace('/create/post')} />}
      />
      <Dialog visible={!!confirm} title="Delete this draft?" body="This can’t be undone." confirmLabel="Delete" confirmVariant="danger" onConfirm={() => { if (confirm) dispatch({ type: 'deleteDraft', id: confirm }); setConfirm(null); }} onCancel={() => setConfirm(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.x3, paddingHorizontal: space.margin, paddingVertical: space.x3, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  icon: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
});
