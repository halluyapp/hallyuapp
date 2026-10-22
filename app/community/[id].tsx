import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { PostCard } from '../../components/feed/PostCard';
import { FeedAutoplay } from '../../components/media/FeedViewport';
import { Button } from '../../components/ui/Button';
import { Screen } from '../../components/ui/Screen';
import { Segmented } from '../../components/ui/Segmented';
import { EmptyState } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { colors, radius, space } from '../../constants/theme';
import { fetchCommunityDetail, type LiveCommunityDetail } from '../../lib/api/features';
import { fetchFeed, fetchProfiles } from '../../lib/api/feed';
import { fandomById } from '../../lib/fandoms';
import { compact } from '../../lib/format';
import { haptic, useApp, useRequireMember } from '../../lib/hooks';
import { withAlpha } from '../../lib/motion';
import { getState } from '../../lib/store';
import { adoptLocal } from '../../lib/sync';

export default function CommunityRoomScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const requireMember = useRequireMember();
  const { state, dispatch } = useApp();
  const [detail, setDetail] = useState<LiveCommunityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'latest' | 'media'>('latest');

  const localCommunity = useMemo(
    () => state.communities.find((c) => c.id === id),
    [state.communities, id],
  );

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [roomInfo, bundle] = await Promise.all([
        fetchCommunityDetail(id),
        fetchFeed('latest', { communityId: id, limit: 30 }).catch(() => null),
      ]);
      if (roomInfo) setDetail(roomInfo);
      if (bundle?.items.length) {
        for (const p of bundle.items) adoptLocal({ type: 'addPost', post: p });
        const authorIds = [...new Set(bundle.items.map((p) => p.authorId))];
        const profiles = await fetchProfiles(authorIds).catch(() => []);
        if (profiles.length) {
          const users = { ...getState().users };
          for (const u of profiles) users[u.id] = { ...users[u.id], ...u };
          adoptLocal({ type: 'hydrate', state: { users } });
        }
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const joined = id ? state.joinedCommunities.includes(id) || Boolean(detail?.isMember) : false;
  const world = fandomById(detail?.fandom ?? localCommunity?.fandom ?? 'kdrama');
  const title = detail?.name ?? localCommunity?.name ?? 'Community Room';
  const desc = detail?.description ?? localCommunity?.description ?? '';

  const posts = useMemo(() => {
    const roomPosts = state.posts
      .filter((p) => p.state !== 'deleted' && p.context.communityId === id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (tab === 'media') {
      return roomPosts.filter((p) => (p.images && p.images.length > 0) || Boolean(p.video));
    }
    return roomPosts;
  }, [state.posts, id, tab]);

  return (
    <Screen
      header={
        <TopBar
          mode="stack"
          title={title}
          right={
            <Button
              label="Post"
              size="sm"
              icon="create-outline"
              onPress={() =>
                requireMember('post in this room', () =>
                  router.push({ pathname: '/create/[type]', params: { type: 'post', communityId: id } }),
                )
              }
            />
          }
        />
      }
    >
      <FeedAutoplay getVideoId={(it) => ((it as { video?: unknown; id: string })?.video ? (it as { id: string }).id : null)}>
        {({ onViewableItemsChanged, viewabilityConfig }) => (
          <FlatList
            data={posts}
            keyExtractor={(p) => p.id}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={viewabilityConfig}
            refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={world.tint} />}
            ListHeaderComponent={
              <View>
                <LinearGradient
                  colors={[withAlpha(detail?.coverTone ?? world.tint, 0.34), colors.canvas]}
                  style={styles.hero}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x3 }}>
                    <View style={[styles.worldBadge, { borderColor: world.tint, backgroundColor: withAlpha(world.tint, 0.16) }]}>
                      <Text style={{ fontSize: 24 }}>{world.flag}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text variant="overline" style={{ color: world.tint }}>
                        {world.label.toUpperCase()} ROOM
                      </Text>
                      <Text variant="headline" style={{ marginTop: 2 }}>
                        {title}
                      </Text>
                      <Text variant="caption" tone="secondary" style={{ marginTop: 2 }}>
                        {compact(Math.max(detail?.memberCount ?? localCommunity?.memberCount ?? 0, joined ? 1 : 0))} members · {posts.length} posts
                      </Text>
                    </View>
                  </View>
                  {desc ? (
                    <Text variant="bodySmall" tone="secondary" style={{ marginTop: space.x3 }}>
                      {desc}
                    </Text>
                  ) : null}
                  <View style={styles.heroActions}>
                    <Button
                      label={joined ? 'Joined' : 'Join Room'}
                      variant={joined ? 'secondary' : 'primary'}
                      size="sm"
                      icon={joined ? 'checkmark-circle-outline' : 'person-add-outline'}
                      onPress={() =>
                        requireMember('join this community room', () => {
                          if (!id) return;
                          haptic.select();
                          dispatch({ type: 'joinCommunity', id, on: !joined });
                          setDetail((prev) => (prev ? { ...prev, isMember: !joined } : prev));
                        })
                      }
                      style={{ flex: 1 }}
                    />
                    <Button
                      label="Start a post"
                      variant="secondary"
                      size="sm"
                      icon="chatbubble-ellipses-outline"
                      onPress={() =>
                        requireMember('post in this room', () =>
                          router.push({ pathname: '/create/[type]', params: { type: 'post', communityId: id } }),
                        )
                      }
                      style={{ flex: 1 }}
                    />
                  </View>
                </LinearGradient>
                <Segmented
                  items={[
                    { key: 'latest', label: 'Latest' },
                    { key: 'media', label: 'Media' },
                  ]}
                  value={tab}
                  onChange={setTab}
                />
              </View>
            }
            ListEmptyComponent={
              !loading ? (
                <EmptyState
                  icon="sparkles-outline"
                  title="Kick off the conversation"
                  body={`Be the first to share a scene reaction, theory, or recommendation in ${title}.`}
                  actionLabel="Write first post"
                  onAction={() =>
                    requireMember('post in this room', () =>
                      router.push({ pathname: '/create/[type]', params: { type: 'post', communityId: id } }),
                    )
                  }
                />
              ) : null
            }
            renderItem={({ item }) => <PostCard post={item} />}
          />
        )}
      </FeedAutoplay>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    paddingHorizontal: space.margin,
    paddingTop: space.x4,
    paddingBottom: space.x4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  worldBadge: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroActions: {
    flexDirection: 'row',
    gap: space.x2,
    marginTop: space.x4,
  },
});
