import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { FeedViewportProvider, useViewabilityTracker } from '../../components/media/FeedViewport';
import { PostCard } from '../../components/feed/PostCard';
import { ShortsRail } from '../../components/feed/ShortCard';
import { useTabBarMotion } from '../../components/navigation/TabBarMotion';
import { UserCard } from '../../components/people/UserRow';
import { Button } from '../../components/ui/Button';
import { Chip } from '../../components/ui/Chip';
import { CoachMarks } from '../../components/ui/CoachMarks';
import { IconButton } from '../../components/ui/IconButton';
import { useRefresh } from '../../components/ui/Refresh';
import { Screen, useColumn, useListPadding } from '../../components/ui/Screen';
import { SectionHeader } from '../../components/ui/Section';
import { Segmented } from '../../components/ui/Segmented';
import { PostSkeleton } from '../../components/ui/Skeleton';
import { EmptyState } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { LiveIndicator, TopBar, Wordmark } from '../../components/ui/TopBar';
import { WebAppInstallBanner } from '../../components/web/WebAppInstallBanner';
import { colors, fonts, radius, sizes, space } from '../../constants/theme';
import { fetchConversations, fetchHallyuEvents, type HallyuLiveEvent, subscribeDirectMessages } from '../../lib/api/features';
import { fetchHomeDiscovery } from '../../lib/api/homeDiscovery';
import { useAuth } from '../../lib/auth';
import { catalog } from '../../lib/catalog';
import { FANDOMS, formatFandomOf } from '../../lib/fandoms';
import { haptic, useApp, useBackendHealth, useLoad, useReduceMotion } from '../../lib/hooks';
import { useI18n } from '../../lib/i18n';
import { useInteractionGate } from '../../lib/interactive';
import { FandomId, Post } from '../../lib/model';
import {
  airingEpisodes,
  anchorDrama,
  following,
  forYou,
  recommendedPeople,
  shorts,
  trendingDiscussions,
} from '../../lib/selectors';
import { getState } from '../../lib/store';
import { onTabReTap } from '../../lib/tabEvents';

type Row =
  | { key: string; kind: 'post'; post: Post; reason?: string }
  | { key: string; kind: 'shorts' }
  | { key: string; kind: 'people' }
  | { key: string; kind: 'discussions' }
  | { key: string; kind: 'guest' };

interface FeedItem {
  post: Post;
  reason?: string;
}

/**
 * Compares two ranked feeds by membership & ordering rather than array reference identity so Home's
 * feed adoption always converges in a single pass without triggering unbounded re-renders.
 */
function feedEqual(a: FeedItem[], b: FeedItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.post.id !== b[i]!.post.id || a[i]!.reason !== b[i]!.reason) return false;
  }
  return true;
}

const UNIVERSE_TINT: Partial<Record<FandomId, string>> = {
  kdrama: '#FF2D55',
  cdrama: '#10B981',
  anime: '#8B5CF6',
  hollywood: '#F59E0B',
};

/**
 * Home — Pure Social-First Timeline.
 * Member posts, thoughts, reviews, clips, polls, and live episode conversations lead immediately at
 * position #1 above the fold. Catalog discovery lives cleanly on Explore (`/explore`).
 */
export default function HomeScreen() {
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  return (
    <FeedViewportProvider paused={!focused}>
      <Home />
    </FeedViewportProvider>
  );
}

function Home() {
  const router = useRouter();
  const tabBar = useTabBarMotion();
  const auth = useAuth();
  const { t } = useI18n();
  const [unreadDmCount, setUnreadDmCount] = useState(0);
  const [featuredEvent, setFeaturedEvent] = useState<HallyuLiveEvent | null>(null);
  const { state, getDrama } = useApp();
  const [tab, setTab] = useState<'forYou' | 'following'>('forYou');
  const [universe, setUniverse] = useState<FandomId | 'all'>('all');
  const listRef = useRef<FlatList<Row>>(null);
  const viewport = useViewabilityTracker<Row>((r) =>
    r.kind === 'post' && r.post.video ? r.post.id : null,
  );
  const { control: refreshControl, onRefresh: pull } = useRefresh('home');
  const reduceMotion = useReduceMotion(state.prefs.reduceMotion);
  const padding = useListPadding();
  const column = useColumn(FEED_MAX);
  const guest = auth.status !== 'signedIn';

  // Interaction gate defers background catalog/event enrichment so cold boot stays instant.
  const { ready: deferred, capture } = useInteractionGate();
  const anchor = useMemo(() => anchorDrama(state), [state]);
  const catalogReady = useMemo(() => !!anchor && !guest && catalog.available && deferred, [anchor, guest, deferred]);

  useLoad(
    async () => {
      const list = await fetchHallyuEvents(universe);
      if (list.length > 0) setFeaturedEvent(list[0]!);
      return list;
    },
    [universe],
    deferred || catalogReady || guest,
  );

  const backend = useBackendHealth();
  useEffect(() => {
    if (guest || backend.status !== 'connected') return;
    const controller = new AbortController();
    void fetchHomeDiscovery(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [guest, backend.status]);

  const tonightCount = useMemo(
    () =>
      airingEpisodes(state, -30, 36).filter(
        ({ drama }) => state.follows.dramas.includes(drama.id) || drama.status === 'airing',
      ).length,
    [state],
  );

  const liveFeed = useMemo(() => {
    const base = tab === 'forYou' ? forYou(state) : following(state);
    if (universe === 'all' || tab !== 'forYou') return base;
    return base.filter((r) => {
      const id = r.post.context?.dramaId;
      const d = id ? getDrama(id) : undefined;
      return !!d && formatFandomOf(d) === universe;
    });
  }, [state, tab, universe, getDrama]);

  const [feed, setFeed] = useState(liveFeed);
  const atTop = useRef(true);
  const shownHead = useRef<string | undefined>(liveFeed[0]?.post.id);
  const newCount = useMemo(() => {
    const shown = new Set(feed.map((r) => r.post.id));
    return liveFeed.filter((r) => !shown.has(r.post.id)).length;
  }, [liveFeed, feed]);

  const adoptFeed = useCallback((next: FeedItem[]) => setFeed((prev) => (feedEqual(prev, next) ? prev : next)), []);

  useEffect(() => {
    if (newCount === 0 || atTop.current) {
      adoptFeed(liveFeed);
      shownHead.current = liveFeed[0]?.post.id;
    }
  }, [liveFeed, newCount, adoptFeed]);

  useEffect(() => {
    atTop.current = true;
    adoptFeed(liveFeed);
    setUniverse('all');
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    atTop.current = true;
    adoptFeed(liveFeed);
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [universe]);

  const showNew = () => {
    adoptFeed(liveFeed);
    setPage(1);
    listRef.current?.scrollToOffset({ offset: 0, animated: !reduceMotion });
    haptic.select();
  };

  useEffect(() => {
    return onTabReTap('index', () => {
      adoptFeed(liveFeed);
      setPage(1);
      listRef.current?.scrollToOffset({ offset: 0, animated: !reduceMotion });
    });
  }, [adoptFeed, liveFeed, reduceMotion]);

  useEffect(() => {
    if (guest) {
      setUnreadDmCount(0);
      return;
    }
    let alive = true;
    const syncUnread = () => {
      fetchConversations()
        .then((list) => {
          if (alive) {
            setUnreadDmCount(list.reduce((sum, c) => sum + c.unreadCount, 0));
          }
        })
        .catch(() => {});
    };
    syncUnread();
    const unsub = subscribeDirectMessages(state.profile.id, () => syncUnread());
    return () => {
      alive = false;
      unsub();
    };
  }, [guest, state.profile.id]);

  const PAGE = 12;
  const [page, setPage] = useState(1);
  const [paging, setPaging] = useState(false);
  const hasMore = feed.length > page * PAGE;
  const loadMore = useCallback(() => {
    if (!hasMore || paging) return;
    setPaging(true);
    setTimeout(() => {
      setPage((p) => p + 1);
      setPaging(false);
    }, 350);
  }, [hasMore, paging]);

  const pillY = useRef(new Animated.Value(-60)).current;
  useEffect(() => {
    Animated.spring(pillY, {
      toValue: newCount > 0 && !atTop.current ? 0 : -60,
      useNativeDriver: true,
      damping: 18,
      stiffness: 220,
    }).start();
  }, [newCount, pillY]);

  const shortList = useMemo(() => shorts(state), [state]);
  const people = useMemo(() => recommendedPeople(state, 8), [state]);
  const discussions = useMemo(() => trendingDiscussions(state, 4), [state]);

  // Strictly Social-First Timeline: posts always lead right at index 0.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (guest) out.push({ key: 'guest', kind: 'guest' });
    const modules = tab === 'forYou' && universe === 'all';
    feed.slice(0, page * PAGE).forEach((r, i) => {
      out.push({ key: r.post.id, kind: 'post', post: r.post, reason: r.reason });
      if (modules) {
        if (i === 3 && shortList.length) out.push({ key: 'shorts', kind: 'shorts' });
        if (i === 7 && people.length) out.push({ key: 'people', kind: 'people' });
        if (i === 11 && discussions.length) out.push({ key: 'discussions', kind: 'discussions' });
      }
    });
    if (modules && feed.length > 0 && feed.length <= 3 && people.length) {
      out.push({ key: 'people', kind: 'people' });
    }
    return out;
  }, [feed, page, guest, tab, universe, shortList.length, people.length, discussions.length]);

  const onRefresh = useCallback(async () => {
    await pull();
    const list = await fetchHallyuEvents(universe).catch(() => []);
    if (list.length > 0) setFeaturedEvent(list[0]!);
    const fresh = getState();
    adoptFeed(tab === 'forYou' ? forYou(fresh) : following(fresh));
    setPage(1);
  }, [pull, tab, adoptFeed, universe]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      tabBar.onScroll(e);
      const top = e.nativeEvent.contentOffset.y < 80;
      if (top !== atTop.current) {
        atTop.current = top;
        if (top && newCount) showNew();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabBar.onScroll, newCount],
  );

  const renderItem = useCallback(
    ({ item }: { item: Row }) => {
      switch (item.kind) {
        case 'post':
          return <PostCard post={item.post} reason={item.reason} />;
        case 'guest':
          return (
            <View style={styles.guest}>
              <Text variant="titleSmall">Watch & react with the community</Text>
              <Text variant="bodySmall" tone="secondary" style={{ marginTop: 2 }}>
                Sign in to post reviews, join live watch parties, DM friends, and hide spoilers automatically.
              </Text>
              <Button
                label="Join Hallyu"
                size="sm"
                style={{ marginTop: space.x3 }}
                onPress={() => router.push('/(auth)/welcome')}
              />
            </View>
          );
        case 'shorts':
          return (
            <View style={styles.socialInsertCard}>
              <SectionHeader
                weight="quiet"
                title="Community Shorts"
                eyebrow="60-second reactions & edits"
                onAction={() => router.push('/shorts')}
                actionLabel="Watch all"
              />
              <ShortsRail posts={shortList} />
            </View>
          );
        case 'people':
          return (
            <View style={styles.socialInsertCard}>
              <SectionHeader
                weight="quiet"
                eyebrow="Social"
                title="Voices in your worlds"
                onAction={() => router.push('/people')}
                actionLabel="See all"
              />
              <FlatList
                horizontal
                data={people}
                keyExtractor={(p) => p.user.id}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.gutter }}
                renderItem={({ item: p }) => <UserCard user={p.user} reason={p.reason} />}
              />
            </View>
          );
        case 'discussions':
          return (
            <View style={styles.socialInsertCard}>
              <SectionHeader
                weight="quiet"
                title="Active threads right now"
                eyebrow="Live talk"
                onAction={() => router.push('/trending')}
              />
              {discussions.map((p) => (
                <PostCard key={p.id} post={p} />
              ))}
            </View>
          );
      }
    },
    [router, shortList, people, discussions],
  );

  const header = (
    <View style={{ paddingBottom: space.x2 }}>
      <WebAppInstallBanner />
      <Pressable
        onPress={() => router.push('/events')}
        style={({ pressed }) => [styles.liveStrip, pressed && { opacity: 0.85 }]}
        accessibilityRole="button"
        accessibilityLabel="Open Live Events and Watch Parties"
      >
        <View style={styles.liveDotWrap}>
          <View style={styles.liveDot} />
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="caption" style={{ color: colors.textPrimary, fontFamily: fonts.semibold }} numberOfLines={1}>
            {featuredEvent
              ? `${featuredEvent.title}`
              : 'Live Watch Parties & Episode Predictions'}
          </Text>
          <Text variant="caption" tone="secondary" numberOfLines={1} style={{ fontSize: 11.5 }}>
            {featuredEvent
              ? `${featuredEvent.rsvpCount} fans in room · Tap to RSVP or vote`
              : `${t('home.liveEvents')} ·Communities & synchronized finale rooms`}
          </Text>
        </View>
        <View style={styles.liveJoinPill}>
          <Text variant="caption" style={{ color: colors.accent, fontFamily: fonts.bold, fontSize: 11.5 }}>
            Join
          </Text>
          <Ionicons name="chevron-forward" size={13} color={colors.accent} />
        </View>
      </Pressable>
    </View>
  );

  const universes = useMemo(
    () => [
      { id: 'all' as const, label: 'All' },
      ...FANDOMS.map((f) => ({ id: f.id, label: f.short })),
    ],
    [],
  );

  const empty =
    tab === 'following' ? (
      guest ? (
        <EmptyState
          icon="people-outline"
          title="Following is yours to build"
          body="Sign in and follow members, creators, and shows. Their posts land here immediately, newest first."
          actionLabel="Join Hallyu"
          onAction={() => router.push('/(auth)/welcome')}
        />
      ) : (
        <EmptyState
          icon="people-outline"
          title="Follow members & creators"
          body="Follow voices you enjoy and their reviews, clips, and episode reactions appear right here in real time."
          actionLabel="Find people"
          onAction={() => router.push('/people')}
          secondaryLabel="Explore shows"
          onSecondary={() => router.push('/(tabs)/explore')}
        />
      )
    ) : state.hydrated ? (
      <EmptyState
        icon="chatbubbles-outline"
        title="Start the conversation"
        body="Share your latest watch thought, review, or clip — or browse live shows on Explore."
        actionLabel="Explore shows"
        onAction={() => router.push('/(tabs)/explore')}
      />
    ) : (
      <View accessibilityLabel="Loading your feed">
        <PostSkeleton />
        <PostSkeleton />
      </View>
    );

  return (
    <Screen
      onStartShouldSetResponderCapture={capture}
      header={
        <View>
          <TopBar
            mode="root"
            center={<Wordmark />}
            right={
              <>
                <IconButton icon="search-outline" label="Search" onPress={() => router.push('/search')} />
                <IconButton icon="flame-outline" label={t('home.liveEvents')} onPress={() => router.push('/events')} />
                {!guest ? (
                  <View style={{ position: 'relative' }}>
                    <IconButton
                      icon="chatbubble-ellipses-outline"
                      label="Direct messages"
                      onPress={() => router.push('/messages')}
                    />
                    {unreadDmCount > 0 ? (
                      <View
                        pointerEvents="none"
                        style={{
                          position: 'absolute',
                          top: 6,
                          right: 6,
                          minWidth: 16,
                          height: 16,
                          paddingHorizontal: 4,
                          borderRadius: 8,
                          backgroundColor: colors.accent,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Text style={{ fontSize: 9.5, lineHeight: 11, color: colors.onAccent, fontWeight: '700' }}>
                          {unreadDmCount > 9 ? '9+' : String(unreadDmCount)}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                ) : null}
                <LiveIndicator count={tonightCount} onPress={() => router.push('/events')} />
                {guest ? (
                  <IconButton
                    icon="person-circle-outline"
                    label="Sign in"
                    onPress={() => router.push('/(auth)/welcome')}
                  />
                ) : null}
              </>
            }
          />
          {tab === 'forYou' ? (
            <FlatList
              horizontal
              data={universes}
              keyExtractor={(u) => u.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: space.margin, paddingBottom: space.x2, gap: space.x2 }}
              renderItem={({ item: u }) => (
                <Chip
                  label={u.label}
                  selected={universe === u.id}
                  size="sm"
                  onPress={() => {
                    haptic.select();
                    setUniverse(u.id);
                    setPage(1);
                    listRef.current?.scrollToOffset({ offset: 0, animated: false });
                  }}
                />
              )}
            />
          ) : null}
        </View>
      }
    >
      {universe !== 'all' && UNIVERSE_TINT[universe] ? (
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFillObject,
            {
              backgroundColor: UNIVERSE_TINT[universe],
              opacity: 0.045,
              zIndex: 0,
            },
          ]}
        />
      ) : null}
      <Segmented
        items={[
          { key: 'forYou', label: t('home.forYou') },
          {
            key: 'following',
            label: t('home.following'),
            dot:
              tab !== 'following' &&
              following(state).some((r) => new Date(r.post.createdAt) > new Date(state.lastSeenActivity)) &&
              !guest,
          },
        ]}
        value={tab}
        onChange={(nextTab) => {
          setTab(nextTab);
          listRef.current?.scrollToOffset({ offset: 0, animated: false });
        }}
      />
      <FlatList
        ref={listRef}
        onScroll={onScroll}
        scrollEventThrottle={16}
        data={rows}
        keyExtractor={(r) => r.key}
        renderItem={renderItem}
        onViewableItemsChanged={viewport.onViewableItemsChanged}
        viewabilityConfig={viewport.viewabilityConfig}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        contentContainerStyle={[padding, { paddingTop: space.x2 }, column]}
        refreshControl={React.cloneElement(refreshControl, { onRefresh })}
        onEndReached={loadMore}
        onEndReachedThreshold={0.6}
        initialNumToRender={6}
        windowSize={7}
        removeClippedSubviews
        ListFooterComponent={
          hasMore || paging ? (
            <View style={styles.footer} accessibilityLabel="Loading more posts">
              <ActivityIndicator color={colors.textTertiary} />
            </View>
          ) : rows.length ? (
            <View style={styles.footer}>
              <Ionicons name="checkmark-done-outline" size={18} color={colors.textTertiary} />
              <Text variant="caption" tone="tertiary">
                You’re caught up on the social timeline.
              </Text>
              <View style={{ flexDirection: 'row', gap: space.x2 }}>
                <Button
                  label="Live Watch Parties"
                  variant="secondary"
                  size="sm"
                  onPress={() => router.push('/events')}
                />
                <Button
                  label="Browse Shows"
                  variant="ghost"
                  size="sm"
                  onPress={() => router.push('/(tabs)/explore')}
                />
              </View>
            </View>
          ) : null
        }
      />
      {universe !== 'all' && UNIVERSE_TINT[universe] ? (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: UNIVERSE_TINT[universe], opacity: 0.04 }]}
        />
      ) : null}
      <CoachMarks
        id="home"
        when={rows.length > 0 && tab === 'forYou'}
        bottomOffset={space.x2}
        steps={[
          {
            icon: 'chatbubbles-outline',
            title: 'Your social feed comes first',
            body: 'Reviews, live episode reactions, polls, and member clips appear right at the top.',
          },
          {
            icon: 'flame-outline',
            title: 'Live Watch Parties & Events',
            body: 'Tap the Live strip anytime to RSVP, vote on predictions, and enter synchronized episode rooms.',
          },
          {
            icon: 'compass-outline',
            title: 'Shows & rankings live in Explore',
            body: 'Explore tracks airing K-Dramas, Anime, C-Dramas, and Cinema with spoiler-safe progress.',
          },
        ]}
      />
      <Animated.View
        pointerEvents={newCount > 0 ? 'auto' : 'none'}
        style={[styles.pillHost, { transform: [{ translateY: pillY }] }]}
      >
        <Pressable
          onPress={showNew}
          style={styles.pill}
          accessibilityRole="button"
          accessibilityLabel={`${newCount} new posts, scroll to top`}
        >
          <Ionicons name="arrow-up" size={14} color={colors.onAccent} />
          <Text variant="label" tone="onAccent">
            {newCount === 1 ? '1 new post' : `${newCount} new posts`}
          </Text>
        </Pressable>
      </Animated.View>
    </Screen>
  );
}

const FEED_MAX = sizes.readingColumn + space.x8;

const styles = StyleSheet.create({
  guest: {
    margin: space.margin,
    marginTop: 0,
    padding: space.x4,
    backgroundColor: colors.surface1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  liveStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: space.margin,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.lg,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: 'rgba(225,29,72,0.28)',
  },
  liveDotWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(225,29,72,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  liveJoinPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
    backgroundColor: 'rgba(225,29,72,0.12)',
  },
  socialInsertCard: {
    marginVertical: space.x2,
    paddingVertical: space.x4,
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.borderSubtle,
  },
  footer: {
    alignItems: 'center',
    gap: space.x3,
    paddingVertical: space.x8,
  },
  pillHost: { position: 'absolute', top: 108, left: 0, right: 0, alignItems: 'center' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: colors.accent,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
});
