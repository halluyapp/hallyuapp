import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { colors, radius, sizes, space } from '../../constants/theme';
import { Fandom, fandomById, isFandomId } from '../../lib/fandoms';
import { compact } from '../../lib/format';
import { useApp } from '../../lib/hooks';
import { Post, User } from '../../lib/model';
import { currentlyWatching, postsByUser } from '../../lib/selectors';
import { getState } from '../../lib/store';
import { adoptBackendState, adoptLocal, adoptProfileByHandle } from '../../lib/sync';
import { CollectionCard } from '../collections/CollectionCard';
import { FollowButton } from '../drama/FollowButton';
import { PostCard } from '../feed/PostCard';
import { FeedAutoplay } from '../media/FeedViewport';
import { ShortTile } from '../feed/ShortCard';
import { Avatar } from '../ui/Avatar';
import { useTabBarMotion } from '../navigation/TabBarMotion';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Backdrop, Poster } from '../ui/Poster';
import { ShareCardModal } from '../share/ShareCardModal';
import { useListPadding } from '../ui/Screen';
import { Segmented } from '../ui/Segmented';
import { Sheet, SheetRow } from '../ui/Sheet';
import { EmptyState } from '../ui/States';
import { Text } from '../ui/Text';
import { useToast } from '../ui/Toast';

type Tab = 'posts' | 'shorts' | 'reviews' | 'collections';

/** Profile body shared by You and /user/[handle]. Owns the header, shelves, tabs and the private/blocked states. */
export function ProfileView({ user, isMe, headerExtra }: { user: User; isMe: boolean; headerExtra?: React.ReactNode }) {
  const tabBar = useTabBarMotion();
  const router = useRouter();
  const toast = useToast();
  const { state, dispatch, getDrama, watch } = useApp();
  const [tab, setTab] = useState<Tab>('posts');
  const [menu, setMenu] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const padding = useListPadding();
  const blocked = state.blockedUsers.includes(user.id);
  const followingThem = state.follows.users.includes(user.id);
  const isPrivate = !!user.isPrivate && !isMe && !followingThem;

  const syncProfile = useCallback(async () => {
    const syncCb = {
      getState,
      apply: (patch: Parameters<typeof adoptBackendState>[0]['apply'] extends (p: infer P) => void ? P : never) =>
        adoptLocal({ type: 'hydrate', state: patch }),
      addPosts: (incoming: Post[]) => {
        for (const post of incoming) adoptLocal({ type: 'addPost', post });
      },
    };
    if (isMe) {
      await Promise.all([
        adoptBackendState(syncCb).catch(() => {}),
        user.handle && user.handle !== 'you' && user.handle !== 'guest'
          ? adoptProfileByHandle(user.handle, syncCb).catch(() => {})
          : Promise.resolve(),
      ]);
    } else if (user.handle && user.handle !== 'guest') {
      await adoptProfileByHandle(user.handle, syncCb).catch(() => {});
    }
  }, [isMe, user.handle]);

  useEffect(() => {
    void syncProfile();
  }, [syncProfile]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void syncProfile().finally(() => setRefreshing(false));
  }, [syncProfile]);

  const posts = useMemo(() => postsByUser(state, user.id), [state, user.id]);
  const byTab = useMemo<Post[]>(
    () => (tab === 'posts' ? posts.filter((p) => p.type !== 'short') : tab === 'shorts' ? posts.filter((p) => p.type === 'short') : tab === 'reviews' ? posts.filter((p) => p.type === 'review') : []),
    [posts, tab],
  );
  const collections = useMemo(
    () => state.collections.filter((c) => c.ownerId === user.id && (isMe || c.visibility === 'public')).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [state.collections, user.id, isMe],
  );
  const watching = useMemo(() => currentlyWatching(state, user.id).map((drama) => ({ drama })), [state, user.id]);
  const favorites = (isMe ? state.profile.favoriteDramaIds : user.favoriteDramaIds).map((id) => getDrama(id)).filter(Boolean);
  const myWorlds: Fandom[] = ((isMe ? state.profile.fandoms : user.fandoms) ?? []).filter(isFandomId).map(fandomById);
  const heroDrama = favorites[0] ?? watching[0]?.drama;
  const coverUri = (isMe ? state.profile.bannerUrl : user.bannerUrl) ?? heroDrama?.backdropUrl ?? heroDrama?.posterUrl;
  const coverTone = heroDrama?.tone ?? myWorlds[0]?.tint ?? '#1B1D26';

  const watchDna = useMemo(() => {
    const items = isMe ? Object.values(state.watchlist) : [];
    let episodesWatched = 0;
    let minutesWatched = 0;
    const worldTally: Record<string, number> = { kdrama: 0, cdrama: 0, anime: 0, hollywood: 0 };

    for (const w of items) {
      const d = getDrama(w.dramaId);
      const eps = Math.max(0, w.currentEpisode ?? 0);
      episodesWatched += eps;
      minutesWatched += eps * (d?.runtime ?? 55);
      const fmt = d?.format;
      if (fmt === 'kdrama' || fmt === 'cdrama' || fmt === 'anime') worldTally[fmt] += Math.max(1, eps);
      else if (fmt) worldTally.hollywood += Math.max(1, eps);
    }
    for (const fav of favorites) {
      if (!fav) continue;
      const fmt = fav.format;
      if (fmt === 'kdrama' || fmt === 'cdrama' || fmt === 'anime') worldTally[fmt] += 3;
      else worldTally.hollywood += 3;
    }
    for (const w of myWorlds) {
      worldTally[w.id] = (worldTally[w.id] ?? 0) + 2;
    }
    const totalWeight = Math.max(1, Object.values(worldTally).reduce((s, n) => s + n, 0));
    const segments = (['kdrama', 'cdrama', 'anime', 'hollywood'] as const)
      .map((id) => ({
        world: fandomById(id),
        pct: Math.round(((worldTally[id] ?? 0) / totalWeight) * 100),
      }))
      .filter((seg) => seg.pct > 0);
    return {
      episodesWatched,
      hoursWatched: Math.round(minutesWatched / 60),
      completedCount: isMe
        ? items.filter((w) => w.status === 'completed').length
        : user.favoriteDramaIds.length,
      segments,
    };
  }, [isMe, state.watchlist, getDrama, favorites, myWorlds, user.favoriteDramaIds.length]);

  const share = () => setShareOpen(true);

  const header = (
    <View>
      {/* Cinema Cover Backdrop Hero */}
      <Backdrop
        uri={coverUri}
        fallbackColor={coverTone}
        width="100%"
        height={138}
        cinemaGradient
        accentGlow={coverTone}
        label={`${user.displayName} cover backdrop`}
      />

      <View style={[styles.head, { marginTop: -34 }]}>
        <View style={styles.avatarHeroRing}>
          <Avatar uri={user.avatarUrl} avatarPath={user.avatarPath} name={user.displayName} size={sizes.avatar.xl} />
        </View>
        <View style={{ flex: 1, paddingTop: 28 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text variant="titleLarge" numberOfLines={1} style={{ flexShrink: 1 }}>
              {user.displayName}
            </Text>
            {user.verified ? <Ionicons name="checkmark-circle" size={18} color={colors.accentText} /> : null}
            {user.isPrivate ? <Ionicons name="lock-closed" size={14} color={colors.textTertiary} /> : null}
          </View>
          <Text variant="bodySmall" tone="secondary">
            @{user.handle}
          </Text>
          <View style={styles.stats}>
            <Stat
              n={user.followers}
              label="followers"
              onPress={() => router.push({ pathname: '/user/[handle]/connections', params: { handle: user.handle, tab: 'followers' } })}
            />
            <Stat
              n={user.following}
              label="following"
              onPress={() => router.push({ pathname: '/user/[handle]/connections', params: { handle: user.handle, tab: 'following' } })}
            />
            <Stat
              n={watchDna.completedCount}
              label={isMe ? 'completed' : 'favorites'}
              onPress={() => (isMe ? router.push({ pathname: '/watchlist', params: { status: 'completed' } }) : undefined)}
            />
          </View>
        </View>
      </View>
      {user.bio ? (
        <Text variant="body" style={styles.bio}>
          {user.bio}
        </Text>
      ) : isMe ? (
        <Pressable onPress={() => router.push('/edit-profile')} style={styles.bio}>
          <Text variant="body" tone="tertiary">
            Add a bio — what you watch, what you love.
          </Text>
        </Pressable>
      ) : null}
      {/* My Fandoms — the identity line: which of the four worlds this member belongs to. */}
      {myWorlds.length ? (
        <View style={styles.worlds}>
          {myWorlds.map((f) => (
            <Pressable key={f.id} onPress={() => router.push(`/world/${f.id}`)} style={[styles.worldChip, { borderColor: f.tint }]} accessibilityRole="button" accessibilityLabel={`${f.label} world`}>
              <Text variant="caption" accessibilityElementsHidden>
                {f.flag}
              </Text>
              <Text variant="caption" style={{ color: f.tint }}>
                {f.short}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {(isMe ? state.profile.favoriteGenres : user.favoriteGenres).length ? (
        <Text variant="caption" tone="secondary" style={{ paddingHorizontal: space.margin, marginTop: space.x2 }}>
          {(isMe ? state.profile.favoriteGenres : user.favoriteGenres).slice(0, 4).join(' · ')}
        </Text>
      ) : null}
      <View style={styles.actions}>
        {isMe ? (
          <>
            <Button label="Edit profile" variant="secondary" size="sm" icon="create-outline" onPress={() => router.push('/edit-profile')} />
            <Button label="Messages" variant="secondary" size="sm" icon="chatbubble-ellipses-outline" onPress={() => router.push('/messages')} />
            <Button label="Share card" variant="secondary" size="sm" icon="share-social-outline" onPress={share} />
          </>
        ) : blocked ? (
          <Button
            label="Unblock"
            variant="secondary"
            size="sm"
            onPress={() => {
              dispatch({ type: 'block', userId: user.id, on: false });
              toast.show({ message: `Unblocked @${user.handle}` });
            }}
          />
        ) : (
          <>
            <FollowButton kind="users" id={user.id} name={user.displayName} style={{ flex: 1 }} />
            <Button
              label="Message"
              variant="secondary"
              size="sm"
              icon="chatbubble-ellipses-outline"
              onPress={() => router.push(`/messages/${user.handle}`)}
            />
            <IconButton icon="share-social-outline" label="Share profile" onPress={share} filled />
            <IconButton icon="ellipsis-horizontal" label="More" onPress={() => setMenu(true)} filled />
          </>
        )}
      </View>
      {headerExtra}

      {!isPrivate && !blocked ? (
        <>
          {/* Watch DNA Identity Card */}
          {(isMe || watchDna.segments.length > 0) ? (
            <View style={styles.dnaCard}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text variant="overline" tone="accent">
                  WATCH DNA
                </Text>
                {isMe ? (
                  <Pressable onPress={() => router.push('/watchlist')} hitSlop={8} accessibilityRole="button">
                    <Text variant="caption" tone="accent">
                      Watchlist →
                    </Text>
                  </Pressable>
                ) : null}
              </View>
              {isMe ? (
                <View style={{ flexDirection: 'row', gap: space.x5, marginTop: space.x2 }}>
                  <View>
                    <Text variant="title" numeric>
                      {compact(watchDna.episodesWatched)}
                    </Text>
                    <Text variant="caption" tone="secondary">
                      episodes logged
                    </Text>
                  </View>
                  <View>
                    <Text variant="title" numeric>
                      {compact(watchDna.hoursWatched)}h
                    </Text>
                    <Text variant="caption" tone="secondary">
                      screen time
                    </Text>
                  </View>
                  <View>
                    <Text variant="title" numeric>
                      {watchDna.completedCount}
                    </Text>
                    <Text variant="caption" tone="secondary">
                      completed
                    </Text>
                  </View>
                </View>
              ) : null}
              {watchDna.segments.length > 0 ? (
                <View style={{ marginTop: space.x3, gap: 6 }}>
                  <View style={styles.dnaBar}>
                    {watchDna.segments.map((seg) => (
                      <View
                        key={seg.world.id}
                        style={{
                          flex: Math.max(1, seg.pct),
                          height: 6,
                          backgroundColor: seg.world.tint,
                        }}
                      />
                    ))}
                  </View>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.x3 }}>
                    {watchDna.segments.map((seg) => (
                      <Text key={seg.world.id} variant="caption" tone="secondary">
                        <Text variant="caption" style={{ color: seg.world.tint }}>
                          ●{' '}
                        </Text>
                        {seg.world.short} {seg.pct}%
                      </Text>
                    ))}
                  </View>
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Top 4 All-Time Favorites Showcase right near top (Letterboxd style) */}
          {favorites.length || isMe ? (
            <Shelf title="Top 4 All-Time" onSeeAll={isMe ? () => router.push('/edit-profile') : undefined} actionLabel={isMe ? 'Pin Top 4' : undefined}>
              <View style={{ flexDirection: 'row', gap: space.gutter, paddingHorizontal: space.margin }}>
                {favorites.map((d, idx) => (
                  <Pressable key={d!.id} onPress={() => router.push(`/drama/${d!.id}`)} accessibilityRole="button" accessibilityLabel={`#${idx + 1} favourite: ${d!.title}`}>
                    <Poster drama={d!} width={sizes.poster.s}>
                      <View style={styles.favRankBadge}>
                        <Text style={{ fontSize: 10, fontWeight: '700', color: colors.onMedia }}>#{idx + 1}</Text>
                      </View>
                    </Poster>
                  </Pressable>
                ))}
                {isMe
                  ? Array.from({ length: Math.max(0, 4 - favorites.length) }).map((_, i) => (
                      <Pressable key={`slot${i}`} onPress={() => router.push('/edit-profile')} style={styles.slot} accessibilityRole="button" accessibilityLabel="Add a favourite drama">
                        <Ionicons name="add" size={20} color={colors.textTertiary} />
                      </Pressable>
                    ))
                  : null}
              </View>
            </Shelf>
          ) : null}
          {watching.length ? (
            <Shelf
              title={isMe ? 'Currently watching' : `${(user.displayName || user.handle || 'Member').split(' ')[0]} is watching`}
              onSeeAll={isMe ? () => router.push({ pathname: '/watchlist', params: { status: 'watching' } }) : undefined}
            >
              <FlatList
                horizontal
                data={watching}
                keyExtractor={(w) => w.drama.id}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.gutter }}
                renderItem={({ item: w }) => {
                  const it = isMe ? watch(w.drama.id) : undefined;
                  const rawTotal = w.drama.seasons.find((s) => s.number === (it?.season ?? 1))?.episodeCount ?? w.drama.episodeCount;
                  const total = rawTotal || (w.drama.mediaType === 'movie' ? 1 : 16);
                  return (
                    <Pressable onPress={() => router.push(`/drama/${w.drama.id}`)} style={{ width: sizes.poster.s }} accessibilityRole="button" accessibilityLabel={w.drama.title}>
                      <Poster drama={w.drama} width={sizes.poster.s} />
                      {it ? (
                        <View style={styles.progress}>
                          <View style={[styles.progressFill, { width: `${Math.min(100, ((it.currentEpisode ?? 0) / Math.max(1, total)) * 100)}%` }]} />
                        </View>
                      ) : null}
                      <Text variant="caption" numberOfLines={1} style={{ marginTop: 6 }}>
                        {w.drama.title}
                      </Text>
                      {it ? (
                        <Text variant="caption" tone="secondary">
                          Ep {it.currentEpisode ?? 0}/{total}
                        </Text>
                      ) : null}
                    </Pressable>
                  );
                }}
              />
            </Shelf>
          ) : isMe ? (
            <Pressable onPress={() => router.push('/(tabs)/explore')} style={styles.hint} accessibilityRole="button">
              <Ionicons name="play-circle-outline" size={20} color={colors.textSecondary} />
              <Text variant="bodySmall" tone="secondary" style={{ flex: 1 }}>
                Mark a drama as Watching and it appears here with your episode progress.
              </Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
            </Pressable>
          ) : null}
          <Segmented
            items={[
              { key: 'posts', label: 'Posts', count: posts.filter((p) => p.type !== 'short').length },
              { key: 'shorts', label: 'Shorts', count: posts.filter((p) => p.type === 'short').length },
              { key: 'reviews', label: 'Reviews', count: posts.filter((p) => p.type === 'review').length },
              { key: 'collections', label: 'Collections', count: collections.length },
            ]}
            value={tab}
            onChange={setTab}
            scrollable
            style={{ marginTop: space.x4 }}
          />
        </>
      ) : null}
    </View>
  );

  if (blocked) {
    return (
      <FlatList
        data={[]}
        renderItem={null}
        ListHeaderComponent={header}
        contentContainerStyle={padding}
        ListEmptyComponent={<EmptyState icon="ban-outline" title={`You blocked @${user.handle}`} body="They can’t see your posts or follow you, and you won’t see theirs. Unblock any time." />}
      />
    );
  }
  if (isPrivate) {
    return (
      <FlatList
        data={[]}
        renderItem={null}
        ListHeaderComponent={header}
        contentContainerStyle={padding}
        ListEmptyComponent={
          <EmptyState icon="lock-closed-outline" title="This profile is private" body={`Follow @${user.handle} to request access. Their posts and shelves stay hidden until they accept.`} />
        }
      />
    );
  }

  const emptyCopy: Record<Tab, { title: string; body: string; action?: string; go?: () => void }> = {
    posts: isMe
      ? { title: 'Say something', body: 'Your posts, reactions and discussions show up here.', action: 'Create a post', go: () => router.push('/create/post') }
      : { title: 'No posts yet', body: `${user.displayName} hasn’t posted. Follow to catch their first one.` },
    shorts: isMe
      ? { title: 'No shorts yet', body: 'Sixty seconds, vertical. Your best scene reactions live here.', action: 'Make a short', go: () => router.push('/create/short') }
      : { title: 'No shorts', body: 'Nothing vertical from them yet.' },
    reviews: isMe
      ? { title: 'No reviews yet', body: 'Rate a drama 1–10 with a one-line verdict. Finished ones are waiting in your watchlist.', action: 'Write a review', go: () => router.push('/create/review') }
      : { title: 'No reviews', body: 'They haven’t rated anything publicly.' },
    collections: isMe
      ? { title: 'Start a shelf', body: 'Group dramas your way — “Rainy day comfort”, “Best endings”, “Second-lead syndrome”.', action: 'New collection', go: () => router.push('/collection/new') }
      : { title: 'No public collections', body: 'Their shelves are private or empty.' },
  };

  const refreshControl = (
    <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />
  );

  return (
    <>
      {tab === 'collections' ? (
        <FlatList
          onScroll={tabBar.onScroll}
          scrollEventThrottle={16}
          refreshControl={refreshControl}
          data={collections}
          key="collections"
          numColumns={2}
          keyExtractor={(c) => c.id}
          ListHeaderComponent={header}
          columnWrapperStyle={{ gap: space.gutter, paddingHorizontal: space.margin }}
          contentContainerStyle={[padding, { gap: space.x4 }]}
          renderItem={({ item }) => <CollectionCard collection={item} style={{ flex: 1 }} />}
          ListEmptyComponent={
            <EmptyState icon="albums-outline" title={emptyCopy.collections.title} body={emptyCopy.collections.body} actionLabel={emptyCopy.collections.action} onAction={emptyCopy.collections.go} />
          }
        />
      ) : tab === 'shorts' ? (
        <FlatList
          onScroll={tabBar.onScroll}
          scrollEventThrottle={16}
          refreshControl={refreshControl}
          data={byTab}
          key="shorts"
          numColumns={3}
          keyExtractor={(p) => p.id}
          ListHeaderComponent={header}
          columnWrapperStyle={{ gap: 2 }}
          contentContainerStyle={[padding, { gap: 2 }]}
          renderItem={({ item }) => <ShortTile post={item} />}
          ListEmptyComponent={<EmptyState icon="videocam-outline" title={emptyCopy.shorts.title} body={emptyCopy.shorts.body} actionLabel={emptyCopy.shorts.action} onAction={emptyCopy.shorts.go} />}
        />
      ) : (
        <FeedAutoplay<Post> getVideoId={(p) => (p.video ? p.id : null)}>
          {(vp) => (
            <FlatList
              onScroll={tabBar.onScroll}
              scrollEventThrottle={16}
              refreshControl={refreshControl}
              data={byTab}
              key={tab}
              keyExtractor={(p) => p.id}
              onViewableItemsChanged={vp.onViewableItemsChanged}
              viewabilityConfig={vp.viewabilityConfig}
              ListHeaderComponent={header}
              contentContainerStyle={padding}
              renderItem={({ item }) => <PostCard post={item} />}
              ListEmptyComponent={
                <EmptyState
                  icon={tab === 'reviews' ? 'star-outline' : 'chatbubble-outline'}
                  title={emptyCopy[tab].title}
                  body={emptyCopy[tab].body}
                  actionLabel={emptyCopy[tab].action}
                  onAction={emptyCopy[tab].go}
                />
              }
            />
          )}
        </FeedAutoplay>
      )}
      <Sheet visible={menu} onClose={() => setMenu(false)} title={`@${user.handle}`}>
        <SheetRow
          icon="share-social-outline"
          label="Share profile"
          onPress={() => {
            setMenu(false);
            share();
          }}
        />
        <SheetRow
          icon="copy-outline"
          label="Copy link"
          onPress={async () => {
            setMenu(false);
            await Clipboard.setStringAsync(`https://hallyu.app/u/${user.handle}`).catch(() => {});
            toast.show({ message: 'Link copied' });
          }}
        />
        <SheetRow
          icon="volume-mute-outline"
          label={state.mutedUsers.includes(user.id) ? 'Unmute' : 'Mute'}
          onPress={() => {
            setMenu(false);
            dispatch({ type: 'muteUser', userId: user.id, on: !state.mutedUsers.includes(user.id) });
            toast.show({ message: state.mutedUsers.includes(user.id) ? `Unmuted @${user.handle}` : `Muted @${user.handle}. You won’t see their posts.` });
          }}
        />
        <SheetRow
          icon="ban-outline"
          label="Block"
          tone="danger"
          onPress={() => {
            setMenu(false);
            dispatch({ type: 'block', userId: user.id, on: true });
            toast.show({ message: `Blocked @${user.handle}`, actionLabel: 'Undo', onAction: () => dispatch({ type: 'block', userId: user.id, on: false }) });
          }}
        />
        <SheetRow
          icon="flag-outline"
          label="Report"
          tone="danger"
          onPress={() => {
            setMenu(false);
            router.push({ pathname: '/report', params: { targetId: user.id, kind: 'user' } });
          }}
        />
      </Sheet>
      <ShareCardModal visible={shareOpen} onClose={() => setShareOpen(false)} profileUser={user} drama={heroDrama} />
    </>
  );
}

function Stat({ n, label, onPress }: { n: number; label: string; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${n} ${label}`} style={{ flexDirection: 'row', gap: 4, alignItems: 'baseline' }}>
      <Text variant="label" numeric>
        {compact(n)}
      </Text>
      <Text variant="caption" tone="secondary">
        {label}
      </Text>
    </Pressable>
  );
}

function Shelf({ title, children, onSeeAll, actionLabel = 'See all' }: { title: string; children: React.ReactNode; onSeeAll?: () => void; actionLabel?: string }) {
  return (
    <View style={{ marginTop: space.x6 }}>
      <View style={styles.shelfHead}>
        <Text variant="titleSmall">{title}</Text>
        {onSeeAll ? (
          <Pressable onPress={onSeeAll} accessibilityRole="button" hitSlop={8}>
            <Text variant="label" tone="accent">
              {actionLabel}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', gap: space.x4, paddingHorizontal: space.margin, paddingTop: space.x4, alignItems: 'center' },
  avatarHeroRing: {
    borderRadius: sizes.avatar.xl / 2 + 4,
    padding: 3,
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  dnaCard: {
    marginHorizontal: space.margin,
    marginTop: space.x5,
    padding: space.x4,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  dnaBar: {
    flexDirection: 'row',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: colors.surface3,
    gap: 2,
  },
  favRankBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  worlds: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x2, paddingHorizontal: space.margin, marginTop: space.x3 },
  worldChip: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 10, borderRadius: radius.full, borderWidth: 1, backgroundColor: colors.surface1 },
  stats: { flexDirection: 'row', gap: space.x4, marginTop: space.x2 },
  bio: { paddingHorizontal: space.margin, marginTop: space.x4 },
  actions: { flexDirection: 'row', gap: space.x2, paddingHorizontal: space.margin, marginTop: space.x4, alignItems: 'center' },
  shelfHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: space.margin, marginBottom: space.x3 },
  progress: { height: 3, backgroundColor: colors.surface3, borderRadius: 2, marginTop: 6, overflow: 'hidden' },
  progressFill: { height: 3, backgroundColor: colors.accent },
  slot: { width: sizes.poster.s, aspectRatio: 2 / 3, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.borderSubtle, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' },
  hint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    marginHorizontal: space.margin,
    marginTop: space.x5,
    padding: space.x3,
    backgroundColor: colors.surface1,
    borderRadius: radius.md,
  },
});
