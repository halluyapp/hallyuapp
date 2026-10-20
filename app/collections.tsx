import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList } from 'react-native';
import { CollectionCard } from '../components/collections/CollectionCard';
import { Button } from '../components/ui/Button';
import { Screen, useListPadding } from '../components/ui/Screen';
import { Segmented } from '../components/ui/Segmented';
import { EmptyState } from '../components/ui/States';
import { TopBar } from '../components/ui/TopBar';
import { space } from '../constants/theme';
import { useAuth } from '../lib/auth';
import { useApp, useLayout } from '../lib/hooks';
import { myCollections, publicCollections } from '../lib/selectors';
import { getState } from '../lib/store';
import { adoptLocal, adoptPublicCollections } from '../lib/sync';

/** Collections index — Community shelves, yours, and the ones you follow. */
export default function Collections() {
  const router = useRouter();
  const auth = useAuth();
  const { state } = useApp();
  const { wc } = useLayout();
  const padding = useListPadding(false);
  const [tab, setTab] = useState<'community' | 'mine' | 'following'>('community');

  useEffect(() => {
    void adoptPublicCollections({
      getState,
      apply: (patch) => adoptLocal({ type: 'hydrate', state: patch }),
    });
  }, []);

  const data = useMemo(() => (tab === 'community' ? publicCollections(state) : tab === 'mine' ? myCollections(state) : state.collections.filter((c) => state.follows.collections.includes(c.id))), [state, tab]);
  const cols = wc === 'compact' ? 2 : 3;
  return (
    <Screen header={<TopBar mode="stack" title="Collections" right={auth.status === 'signedIn' ? <Button label="New" size="sm" icon="add" variant="secondary" onPress={() => router.push('/collection/new')} /> : null} />}>
      <Segmented items={[{ key: 'community', label: 'Community' }, { key: 'mine', label: 'Yours', count: myCollections(state).length || undefined }, { key: 'following', label: 'Following', count: state.follows.collections.length || undefined }]} value={tab} onChange={setTab} />
      <FlatList key={cols} data={data} numColumns={cols} keyExtractor={(c) => c.id} columnWrapperStyle={{ gap: space.gutter, paddingHorizontal: space.margin }} contentContainerStyle={[padding, { gap: space.x4, paddingTop: space.x4 }]} renderItem={({ item }) => <CollectionCard collection={item} style={{ flex: 1 }} />} ListEmptyComponent={<EmptyState icon="albums-outline" title={tab === 'mine' ? 'No collections yet' : tab === 'following' ? 'Not following any shelves' : 'No public collections'} body={tab === 'mine' ? 'Group dramas your way and share the shelf.' : tab === 'following' ? 'Follow a collection to get notified when its owner adds to it.' : 'Be the first to publish one.'} actionLabel={tab !== 'following' ? 'New collection' : 'Browse community'} onAction={() => (tab !== 'following' ? router.push('/collection/new') : setTab('community'))} />} />
    </Screen>
  );
}
