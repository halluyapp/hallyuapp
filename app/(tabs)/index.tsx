import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, FlatList, NativeScrollEvent, NativeSyntheticEvent, Pressable, StyleSheet, View } from 'react-native';
import { FeedViewportProvider, useViewabilityTracker } from '../../components/media/FeedViewport';
import { DramaCard, DramaRail } from '../../components/drama/DramaCard';
import { WorldTile } from '../../components/fandom/WorldTile';
import { PostCard } from '../../components/feed/PostCard';
import { useTabBarMotion } from '../../components/navigation/TabBarMotion';

import { ShortsRail } from '../../components/feed/ShortCard';
import { episodeState } from '../../components/drama/EpisodeCard';
import { TonightRail } from '../../components/home/TonightRail';
import { UpNextRail } from '../../components/home/UpNextRail';
import { ForYouDeck } from '../../components/home/ForYouDeck';
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
import { TopBar, LiveIndicator, Wordmark } from '../../components/ui/TopBar';
import { colors, radius, sizes, space } from '../../constants/theme';
import { useAuth } from '../../lib/auth';
import { haptic, useApp, useBackendHealth, useLayout, useLoad, useReduceMotion } from '../../lib/hooks';
import { Episode, FandomId, Post } from '../../lib/model';
import { activeWorlds, airingEpisodes, anchorDrama, crossWorldLocal, forYou, following, recommendedDramas, recommendedPeople, shorts, trendingDiscussions, upNext, worldCounts } from '../../lib/selectors';
import { FANDOMS, formatFandomOf } from '../../lib/fandoms';
import { getState } from '../../lib/store';
import { catalog } from '../../lib/catalog';
import { adoptDramas } from '../../lib/catalogSync';
import { fetchHomeDiscovery } from '../../lib/api/homeDiscovery';
import { useInteractionGate } from '../../lib/interactive';

type Row =
  | { key: string; kind: 'post'; post: Post; reason?: string }
  | { key: string; kind: 'worlds' }
  | { key: string; kind: 'cross' }
  | { key: string; kind: 'shorts' }
  | { key: string; kind: 'deck' }
  | { key: string; kind: 'people' }
  | { key: string; kind: 'discussions' }
  | { key: string; kind: 'guest' };

interface FeedItem {
  post: Post;
  reason?: string;
}

/**
 * Are two ranked feeds the same feed? Identity is the wrong question: `forYou()` builds a fresh
 * array on every pass, so an identity comparison would report "changed" forever. The feed only
 * needs to be re-adopted when its *membership or ordering* actually changes — reactions, edits and
 * deletions inside the shown rows are adopted silently through the posts themselves.
 */
function feedEqual(a: FeedItem[], b: FeedItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]!.post.id !== b[i]!.post.id || a[i]!.reason !== b[i]!.reason) return false;
  return true;
}

/** Spec 3.4 — universe hues: a whisper of colour per world, a 4% wash over the canvas. */
const UNIVERSE_TINT: Partial<Record<FandomId, string>> = { cdrama: '#10B981', anime: '#8B5CF6', hollywood: '#F59E0B' };

/**
 * Home — editorial, not a firehose. For You interleaves modules between posts;
 * Following is chronological from people/dramas/actors you follow.
 */
export default function HomeScreen() {
  // Pause inline video while another tab or a modal is on top.
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
  const { state, getDrama } = useApp();
  const [tab, setTab] = useState<'forYou' | 'following'>('forYou');
  // Universe selector (spec 3.3): For You + one chip per fandom world; narrows the feed.
  const [universe, setUniverse] = useState<FandomId | 'all'>('all');
  const listRef = useRef<FlatList<Row>>(null);
  const viewport = useViewabilityTracker<Row>((r) => (r.kind === 'post' && r.post.video ? r.post.id : null));
  const { control: refreshControl, onRefresh: pull } = useRefresh('home');
  const reduceMotion = useReduceMotion(state.prefs.reduceMotion);
  const padding = useListPadding();
  // On a phone the feed is the screen. Past that it is a column: the tab layout already insets the
  // navigation rail, and without a cap the posts would run the full width of a desktop window with
  // 16px gutters and 1400px lines. `panel` is the width that column actually has, which is what the
  // two-column discovery grid at the tail divides into cells.
  const { wc, width: windowWidth } = useLayout();
  const panel = Math.min(windowWidth - (wc === 'compact' ? 0 : sizes.rail), FEED_MAX);
  const tailCell = Math.max(96, Math.floor((panel - space.margin * 2 - space.gutter) / 2));
  const column = useColumn(FEED_MAX);
  const guest = auth.status !== 'signedIn';
  // Home must be usable the instant it appears: the live catalog work below waits for the first
  // touch (or an idle ceiling), and everything on screen is already complete without it.
  const { ready: deferred, capture } = useInteractionGate();
  // §6 — Home hydrates from the backend's own ranking: one get_home_discovery() round trip adopts
  // the server-ranked rails (tonight/trending/upcoming/recent/continue) into the store as soon as
  // the connection gate reports a real backend. Signed-in members only; guests keep guest rails.
  // Backend errors belong to the gate's copy — Home stays editorial either way.
  const backend = useBackendHealth();
  useEffect(() => {
    if (guest || backend.status !== 'connected') return;
    const controller = new AbortController();
    void fetchHomeDiscovery(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [guest, backend.status]);


  const tonight = useMemo(() => {
    // Lead with what matters now: live rooms, then the soonest upcoming, then last night's, newest first.
    const rank = (e: Episode) => (episodeState(e) === 'live' ? 0 : episodeState(e) === 'upcoming' ? 1 : 2);
    return airingEpisodes(state, -30, 36)
      .filter(({ drama }) => state.follows.dramas.includes(drama.id) || drama.status === 'airing')
      .sort((a, b) => rank(a.episode) - rank(b.episode) || (rank(a.episode) === 2 ? b.episode.airDate!.localeCompare(a.episode.airDate!) : a.episode.airDate!.localeCompare(b.episode.airDate!)))
      .slice(0, 8);
  }, [state]);
  const upNextItems = useMemo(() => {
    if (guest) return [];
    const inTonight = new Set(tonight.map((t) => t.episode.id));
    return upNext(state)
      .filter((x) => x.airedAgo && !inTonight.has(x.episode.id))
      .slice(0, 6);
  }, [state, guest, tonight]);
  const liveFeed = useMemo(() => {
    const base = tab === 'forYou' ? forYou(state) : following(state);
    if (universe === 'all' || tab !== 'forYou') return base;
    return base.filter((r) => {
      const id = r.post.context?.dramaId;
      const d = id ? getDrama(id) : undefined;
      return !!d && formatFandomOf(d) === universe;
    });
  }, [state, tab, universe, getDrama]);

  // Feed stability: the list you are reading never reshuffles under your thumb. New posts that
  // arrive while you're scrolled down surface as a "New posts" pill; pulling down or tapping it
  // re-syncs the visible feed with the live ranking.
  const [feed, setFeed] = useState(liveFeed);
  const atTop = useRef(true);
  const shownHead = useRef<string | undefined>(liveFeed[0]?.post.id);
  const newCount = useMemo(() => {
    const shown = new Set(feed.map((r) => r.post.id));
    return liveFeed.filter((r) => !shown.has(r.post.id)).length;
  }, [liveFeed, feed]);
  /**
   * Adopt the live feed through a functional update that is a no-op when nothing actually changed.
   * `liveFeed` is a freshly built array every time its inputs change, so `setFeed(liveFeed)` would
   * always be a new reference and always schedule another render — an effect that re-sets the state
   * it depends on, forever. Comparing membership/order makes this effect convergent by construction.
   */
  const adoptFeed = useCallback((next: FeedItem[]) => setFeed((prev) => (feedEqual(prev, next) ? prev : next)), []);
  useEffect(() => {
    // Same membership (edits, reactions, deletions) → adopt live data silently. New posts while at top → adopt too.
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

  // Pagination: render 12 posts at a time; the footer spinner appears while the next page mounts.
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
    Animated.spring(pillY, { toValue: newCount > 0 && !atTop.current ? 0 : -60, useNativeDriver: true, damping: 18, stiffness: 220 }).start();
  }, [newCount, pillY]);
  const shortList = useMemo(() => shorts(state), [state]);
  const recs = useMemo(() => recommendedDramas(state, 10), [state]);
  // Live "because you watched" from the catalog, anchored on the title you touched most recently.
  // Deferred until the screen has taken a touch (or gone idle): the rail below already renders a
  // complete on-device recommendation set, so the network answer is an upgrade, never a gate.
  const anchor = useMemo(() => anchorDrama(state), [state]);
  const catalogReady = useMemo(() => !!anchor && !guest && catalog.available && deferred, [anchor, guest, deferred]);
  const liveRecs = useLoad(
    async (signal) => {
      if (!anchor?.provider) return [];
      const tracked = new Set(Object.keys(state.watchlist));
      return adoptDramas(await catalog.recommendations(anchor.provider.id, anchor.mediaType ?? 'tv', signal)).filter((d) => !tracked.has(d.id));
    },
    [anchor?.id],
    catalogReady,
  );
  const recRail = useMemo(() => {
    if (liveRecs.data?.length && anchor)
      return {
        dramas: liveRecs.data,
        reasons: Object.fromEntries(liveRecs.data.map((d) => [d.id, `Because you watched ${anchor.title}`])),
        title: 'Your next obsession',
        eyebrow: `Because you watched ${anchor.title}`,
      };
    return { dramas: recs.map((r) => r.drama), reasons: Object.fromEntries(recs.map((r) => [r.drama.id, r.reason])), title: 'Your next obsession', eyebrow: 'For you' };
  }, [liveRecs.data, anchor, recs]);
  // Spec 4.5E — the swipeable For You deck consumes the top recommendations in place of the rail.
  const deckItems = useMemo(() => (tab === 'forYou' && !guest ? recRail.dramas.slice(0, 6).map((d) => ({ drama: d, reason: recRail.reasons[d.id] })) : []), [tab, guest, recRail]);
  const people = useMemo(() => recommendedPeople(state, 6), [state]);
  const discussions = useMemo(() => trendingDiscussions(state, 4), [state]);
  // Your worlds: the fandoms you belong to, each a door into everything that world holds.
  const worlds = useMemo(() => activeWorlds(state), [state]);
  const counts = useMemo(() => worldCounts(state), [state]);
  // Cross-fandom discovery — the reason Hallyu is one app and not four. Prefer the live answer (a
  // real title from another world that shares this one's genres); fall back to what's on the device.
  const crossLocal = useMemo(() => crossWorldLocal(state, 9), [state]);
  const crossLive = useLoad(
    async (signal) => (anchor ? catalog.crossFandom({ fandom: formatFandomOf(anchor), genres: anchor.genres }, signal) : []),
    [anchor?.id],
    catalogReady,
  );
  const cross = useMemo(() => {
    const tracked = new Set(Object.keys(state.watchlist));
    const picks = (crossLive.data?.length ? crossLive.data : crossLocal).filter((p) => !tracked.has(p.drama.id));
    return {
      items: picks.map((p) => p.drama).slice(0, 9),
      reasons: Object.fromEntries(picks.map((p) => [p.drama.id, p.shared.length ? `Also ${p.shared[0].toLowerCase()}` : `Try ${p.world.short}`])),
    };
  }, [crossLive.data, crossLocal, state.watchlist]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (guest) out.push({ key: 'guest', kind: 'guest' });
    // Inside a universe the feed stays pure posts — no interleaved modules.
    const modules = tab === 'forYou' && universe === 'all';
    // Your fandoms sit above the feed: the app should say what it is before it shows you anything.
    if (modules && deckItems.length) out.push({ key: 'deck', kind: 'deck' });
    if (modules && worlds.length) out.push({ key: 'worlds', kind: 'worlds' });
    feed.slice(0, page * PAGE).forEach((r, i) => {
      out.push({ key: r.post.id, kind: 'post', post: r.post, reason: r.reason });
      if (modules) {
        if (i === 2 && shortList.length) out.push({ key: 'shorts', kind: 'shorts' });
        if (i === 8 && people.length) out.push({ key: 'people', kind: 'people' });
        if (i === 9 && cross.items.length) out.push({ key: 'cross', kind: 'cross' });
        if (i === 11 && discussions.length) out.push({ key: 'discussions', kind: 'discussions' });
      }
    });
    if (modules && feed.length && feed.length <= 5) {
      if (cross.items.length) out.push({ key: 'cross', kind: 'cross' });
    }
    return out;
  }, [feed, page, guest, tab, universe, worlds.length, cross.items.length, shortList.length, people.length, discussions.length, deckItems.length]);

  const onRefresh = useCallback(async () => {
    await pull();
    const fresh = getState();
    adoptFeed(tab === 'forYou' ? forYou(fresh) : following(fresh));
    setPage(1);
  }, [pull, tab, adoptFeed]);

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
              <Text variant="titleSmall">You’re browsing as a guest</Text>
              <Text variant="bodySmall" tone="secondary" style={{ marginTop: 2 }}>
                Join to follow dramas, track episodes and keep spoilers away from you.
              </Text>
              <Button label="Join Hallyu" size="sm" style={{ marginTop: space.x3 }} onPress={() => router.push('/(auth)/welcome')} />
            </View>
          );
        case 'worlds':
          return (
            <View style={styles.module}>
              <SectionHeader eyebrow="Your fandoms" title="Your worlds" onAction={() => router.push('/(tabs)/explore')} actionLabel="All worlds" />
              <FlatList
                horizontal
                data={worlds}
                keyExtractor={(f) => f.id}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.gutter }}
                renderItem={({ item: f }) => <WorldTile world={f} count={counts[f.id] ?? 0} onPress={() => router.push(`/world/${f.id}`)} />}
              />
            </View>
          );
        case 'deck':
          return (
            <View style={styles.module}>
              <SectionHeader eyebrow={recRail.eyebrow} title={recRail.title} onAction={() => router.push('/(tabs)/explore')} actionLabel="Explore" />
              <ForYouDeck items={deckItems} />
            </View>
          );
        case 'cross':
          return (
            <View style={styles.module}>
              <SectionHeader eyebrow={anchor ? `Because you like ${anchor.title}` : 'Across fandoms'} title="A world away" onAction={() => router.push('/(tabs)/explore')} actionLabel="Explore" />
              <DramaRail dramas={cross.items} reasons={cross.reasons} />
            </View>
          );
        case 'shorts':
          return (
            <View style={styles.module}>
              <SectionHeader weight="quiet" title="Watch in a minute" eyebrow="Shorts" onAction={() => router.push('/shorts')} />
              <ShortsRail posts={shortList} />
            </View>
          );
        case 'people':
          return (
            <View style={styles.module}>
              <SectionHeader weight="quiet" title="People with your taste" />
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
            <View style={styles.module}>
              <SectionHeader weight="quiet" title="Conversations right now" eyebrow="Trending" onAction={() => router.push('/trending')} />
              {discussions.map((p) => (
                <PostCard key={p.id} post={p} />
              ))}
            </View>
          );
      }
    },
    [router, shortList, recRail, people, discussions, worlds, counts, cross, anchor, deckItems],
  );

  const header = (
    <View>
      {tab === 'forYou' ? <TonightRail items={tonight} eyebrow="Airing today" onSeeAll={() => router.push('/schedule')} /> : null}
      {tab === 'forYou' ? <UpNextRail items={upNextItems} onSeeAll={() => router.push('/watchlist')} /> : null}
    </View>
  );

  /** Sticky universe rail (spec 3.3): For You + the four fandom worlds. */
  const universes = useMemo(() => [{ id: 'all' as const, label: 'For You' }, ...FANDOMS.map((f) => ({ id: f.id, label: f.short }))], []);

  const empty =
    tab === 'following' ? (
      guest ? (
        <EmptyState
          icon="people-outline"
          title="Following is yours to build"
          body="Sign in and follow dramas, actors and people. Their posts land here, newest first."
          actionLabel="Join Hallyu"
          onAction={() => router.push('/(auth)/welcome')}
        />
      ) : (
        <EmptyState
          icon="people-outline"
          title="Track a drama to build your world"
          body="Follow three dramas and this feed fills with their episodes, theories and reactions — newest first."
          actionLabel="Explore shows"
          onAction={() => router.push('/(tabs)/explore')}
          secondaryLabel="People with your taste"
          onSecondary={() => router.push('/people')}
        />
      )
    ) : state.hydrated ? (
      <EmptyState
        icon="sparkles-outline"
        title="Quiet in here"
        body="Nothing matches your filters right now. Explore what’s airing tonight and the room will fill up."
        actionLabel="Open Explore"
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
                <LiveIndicator count={tonight.length} onPress={() => router.push('/schedule')} />
                {guest ? <IconButton icon="person-circle-outline" label="Sign in" onPress={() => router.push('/(auth)/welcome')} /> : null}
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
      <Segmented
        items={[
          { key: 'forYou', label: 'For You' },
          { key: 'following', label: 'Following', dot: tab !== 'following' && following(state).some((r) => new Date(r.post.createdAt) > new Date(state.lastSeenActivity)) && !guest },
        ]}
        value={tab}
        onChange={(t) => {
          setTab(t);
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
        contentContainerStyle={[padding, { paddingTop: space.x4 }, column]}
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
            <>
              <View style={styles.footer}>
                <Ionicons name="checkmark-done-outline" size={18} color={colors.textTertiary} />
                <Text variant="caption" tone="tertiary">
                  You’re caught up. Explore has more.
                </Text>
                <Button label="Open Explore" variant="ghost" size="sm" onPress={() => router.push('/(tabs)/explore')} />
              </View>
              {/* Spec 4.5H — infinite discovery tail: a two-column poster grid that never ends. */}
              {recRail.dramas.length ? (
                <View>
                  <SectionHeader eyebrow="Discover" title="Keep exploring" style={{ paddingHorizontal: space.margin }} />
                  <FlatList
                    data={[...recRail.dramas, ...cross.items].slice(0, 10)}
                    keyExtractor={(d) => d.id}
                    numColumns={2}
                    scrollEnabled={false}
                    columnWrapperStyle={styles.tailCol}
                    renderItem={({ item: d }) => <DramaCard drama={d} size="l" width={tailCell} />}
                  />
                </View>
              ) : null}
            </>
          ) : null
        }
      />
      {/* Spec 3.4 — the universe tint: felt, not seen. */}
      {universe !== 'all' && UNIVERSE_TINT[universe] ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: UNIVERSE_TINT[universe], opacity: 0.04 }]} /> : null}
      <CoachMarks
        id="home"
        when={rows.length > 0 && tab === 'forYou'}
        bottomOffset={space.x2}
        steps={[
          { icon: 'moon-outline', title: 'Tonight lives at the top', body: 'Dramas you follow that air today show up here with a countdown and the room where everyone’s talking.' },
          { icon: 'film-outline', title: 'Every poster opens a hub', body: 'Synopsis, episodes, cast and community in one place — spoilers stay veiled until you’ve caught up.' },
          { icon: 'add-circle-outline', title: 'Say something', body: 'The + button posts, reacts, reviews and recommends. Attach a drama and your words land in its room.' },
        ]}
      />
      {/* New posts pill */}
      <Animated.View pointerEvents={newCount > 0 ? 'auto' : 'none'} style={[styles.pillHost, { transform: [{ translateY: pillY }] }]}>
        <Pressable onPress={showNew} style={styles.pill} accessibilityRole="button" accessibilityLabel={`${newCount} new posts, scroll to top`}>
          <Ionicons name="arrow-up" size={14} color={colors.onAccent} />
          <Text variant="label" tone="onAccent">
            {newCount === 1 ? '1 new post' : `${newCount} new posts`}
          </Text>
        </Pressable>
      </Animated.View>
    </Screen>
  );
}

/** Widest the feed column ever gets, rail excluded. */
const FEED_MAX = sizes.readingColumn + space.x8;

const styles = StyleSheet.create({
  guest: { margin: space.margin, marginTop: 0, padding: space.x4, backgroundColor: colors.surface1, borderRadius: radius.lg },
  module: { paddingVertical: space.x5, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  footer: { alignItems: 'center', gap: space.x2, paddingVertical: space.x8 },
  tailCol: { paddingHorizontal: space.margin, gap: space.gutter, marginBottom: space.x4 },
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
