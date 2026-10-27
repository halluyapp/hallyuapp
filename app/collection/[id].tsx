import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, Share, StyleSheet, View } from 'react-native';
import { DramaListRow } from '../../components/drama/DramaCard';
import { FollowButton } from '../../components/drama/FollowButton';
import { Avatar } from '../../components/ui/Avatar';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { IconButton } from '../../components/ui/IconButton';
import { Poster } from '../../components/ui/Poster';
import { Screen, useListPadding } from '../../components/ui/Screen';
import { Sheet, SheetRow } from '../../components/ui/Sheet';
import { EmptyState, ErrorState } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TextField } from '../../components/ui/TextField';
import { useToast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import { colors, radius, space } from '../../constants/theme';
import { supabase } from '../../lib/api/client';
import { compact, timeAgo } from '../../lib/format';
import { useApp } from '../../lib/hooks';
import { LIMITS } from '../../lib/model';
import { getState } from '../../lib/store';
import { adoptLocal, adoptPublicCollections } from '../../lib/sync';

/** Collection detail — a shelf. Owner edits inline; visitors follow. Private shelves 404 politely. */
export default function CollectionDetail() {
  const router = useRouter();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { dispatch, getCollection, getUser, getDrama, me, watch } = useApp();
  const padding = useListPadding(false);
  const col = getCollection(id);
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState('');

  React.useEffect(() => {
    if (!id || col || !supabase) return;
    void adoptPublicCollections({
      getState,
      apply: (patch) => adoptLocal({ type: 'hydrate', state: patch }),
    });
  }, [id, col]);
  const isMine = col?.ownerId === me.id;
  const owner = col ? (isMine ? me : getUser(col.ownerId)) : undefined;
  const items = useMemo(() => (col ? col.items.map((i) => ({ item: i, drama: getDrama(i.dramaId) })).filter((x) => x.drama) : []), [col, getDrama]);

  if (!col || (col.visibility === 'private' && !isMine)) {
    return (
      <Screen header={<TopBar mode="stack" title="Collection" />}>
        <ErrorState kind={col ? 'forbidden' : 'notFound'} title={col ? 'This collection is private' : 'Collection not found'} body={col ? 'Only its owner can see it.' : 'It may have been deleted.'} onRetry={() => (router.canGoBack() ? router.back() : router.replace('/collections'))} />
      </Screen>
    );
  }

  const share = () => Share.share({ message: `${col.title} — a Hallyu collection: https://hallyu.app/c/${col.id}` });
  const seen = items.filter((x) => watch(x.drama!.id)?.status === 'completed').length;

  const header = (
    <View>
      <View style={styles.stack}>
        {items.slice(0, 4).map((x, i) => (
          <Poster key={x.drama!.id} drama={x.drama!} width={72} style={{ marginLeft: i ? -28 : 0, transform: [{ rotate: `${(i - 1.5) * 4}deg` }], zIndex: 4 - i }} />
        ))}
        {!items.length ? <View style={styles.emptyStack}><Ionicons name="albums-outline" size={28} color={colors.textTertiary} /></View> : null}
      </View>
      <View style={{ paddingHorizontal: space.margin, alignItems: 'center' }}>
        <Text variant="headline" align="center">
          {col.title}
        </Text>
        {col.description ? (
          <Text variant="body" tone="secondary" align="center" style={{ marginTop: space.x2 }}>
            {col.description}
          </Text>
        ) : null}
        <Pressable onPress={() => owner && router.push(`/user/${owner.handle}`)} style={styles.owner} accessibilityRole="link">
          <Avatar uri={owner?.avatarUrl} name={owner?.displayName ?? '?'} size="xs" />
          <Text variant="caption" tone="secondary">
            {owner?.displayName} · {items.length} {items.length === 1 ? 'drama' : 'dramas'} · {compact(col.followerCount)} followers · {col.visibility === 'private' ? 'Private' : 'Public'} · updated {timeAgo(col.updatedAt)}
          </Text>
        </Pressable>
        {seen && !isMine ? (
          <Text variant="caption" tone="success" style={{ marginTop: 4 }}>
            You’ve seen {seen} of {items.length}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', gap: space.x2, marginTop: space.x4 }}>
          {isMine ? (
            <>
              <Button label="Add dramas" size="sm" icon="add" onPress={() => router.push({ pathname: '/collection/add', params: { id: col.id } })} />
              <Button label="Edit" size="sm" variant="secondary" icon="create-outline" onPress={() => router.push({ pathname: '/collection/new', params: { id: col.id } })} />
            </>
          ) : (
            <FollowButton kind="collections" id={col.id} name={col.title} />
          )}
          <IconButton icon="share-social-outline" label="Share" filled onPress={share} />
        </View>
      </View>
    </View>
  );

  return (
    <Screen header={<TopBar mode="stack" title={col.title} right={<IconButton icon="ellipsis-horizontal" label="More" onPress={() => setMenu(true)} />} />}>
      <FlatList
        data={items}
        keyExtractor={(x) => x.drama!.id}
        ListHeaderComponent={header}
        contentContainerStyle={[padding, { paddingTop: space.x4 }]}
        renderItem={({ item: x, index }) => (
          <DramaListRow
            drama={x.drama!}
            subtitle={x.item.note ?? `${x.drama!.year} · ${x.drama!.genres.slice(0, 2).join(', ')}`}
            right={
              isMine ? (
                <View style={{ flexDirection: 'row' }}>
                  <IconButton icon="chatbox-ellipses-outline" label="Edit note" size={20} onPress={() => { setNoteFor(x.drama!.id); setNote(x.item.note ?? ''); }} />
                  <IconButton icon="remove-circle-outline" label="Remove" size={20} onPress={() => { dispatch({ type: 'collectionItem', collectionId: col.id, dramaId: x.drama!.id, on: false }); toast.show({ message: `Removed ${x.drama!.title}`, actionLabel: 'Undo', onAction: () => dispatch({ type: 'collectionItem', collectionId: col.id, dramaId: x.drama!.id, on: true, note: x.item.note }) }); }} />
                </View>
              ) : (
                <Text variant="caption" tone="tertiary" numeric>
                  {index + 1}
                </Text>
              )
            }
          />
        )}
        ListEmptyComponent={<EmptyState compact icon="albums-outline" title={isMine ? 'An empty shelf' : 'Nothing here yet'} body={isMine ? 'Add dramas from any drama page or right here.' : `${owner?.displayName} hasn’t added anything yet.`} actionLabel={isMine ? 'Add dramas' : undefined} onAction={() => router.push({ pathname: '/collection/add', params: { id: col.id } })} />}
      />
      <Sheet visible={menu} onClose={() => setMenu(false)} title={col.title}>
        <SheetRow icon="share-social-outline" label="Share" onPress={() => { setMenu(false); share(); }} />
        {isMine ? (
          <>
            <SheetRow icon={col.visibility === 'private' ? 'globe-outline' : 'lock-closed-outline'} label={col.visibility === 'private' ? 'Make public' : 'Make private'} onPress={() => { setMenu(false); dispatch({ type: 'upsertCollection', collection: { ...col, visibility: col.visibility === 'private' ? 'public' : 'private', updatedAt: new Date().toISOString() } }); }} />
            <SheetRow icon="trash-outline" label="Delete collection" tone="danger" onPress={() => { setMenu(false); setConfirmDelete(true); }} />
          </>
        ) : (
          <SheetRow icon="flag-outline" label="Report" tone="danger" onPress={() => { setMenu(false); router.push({ pathname: '/report', params: { targetId: col.id, kind: 'collection' } }); }} />
        )}
      </Sheet>
      <Dialog visible={confirmDelete} title={`Delete “${col.title}”?`} body={`${items.length} ${items.length === 1 ? 'drama' : 'dramas'} and ${compact(col.followerCount)} followers. This can’t be undone.`} confirmLabel="Delete" confirmVariant="danger" onConfirm={() => { dispatch({ type: 'deleteCollection', id: col.id }); setConfirmDelete(false); if (router.canGoBack()) router.back(); else router.replace('/collections'); toast.show({ message: 'Collection deleted' }); }} onCancel={() => setConfirmDelete(false)} />
      <Sheet visible={!!noteFor} onClose={() => setNoteFor(null)} title="Why is it on this shelf?" subtitle="Shown under the title, public if the collection is.">
        <View style={{ padding: space.x4, gap: space.x3 }}>
          <TextField value={note} onChangeText={setNote} counter={LIMITS.note} maxLength={LIMITS.note} multiline multilineHeight={80} autoFocus placeholder="One line…" />
          <Button label="Save note" onPress={() => { if (noteFor) dispatch({ type: 'collectionItem', collectionId: col.id, dramaId: noteFor, on: true, note: note.trim() || undefined }); setNoteFor(null); }} />
        </View>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { flexDirection: 'row', alignSelf: 'center', alignItems: 'center', marginBottom: space.x4, height: 120, paddingTop: 8 },
  emptyStack: { width: 72, height: 108, borderRadius: radius.sm, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  owner: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.x3, flexWrap: 'wrap', justifyContent: 'center' },
});
