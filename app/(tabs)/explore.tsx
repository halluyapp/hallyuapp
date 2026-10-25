import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { CollectionCard } from '../../components/collections/CollectionCard';
import { ActorRail } from '../../components/drama/ActorCard';
import { DramaCard, DramaRail } from '../../components/drama/DramaCard';
import { PostCard } from '../../components/feed/PostCard';
import { ShortsRail } from '../../components/feed/ShortCard';
import { useTabBarMotion } from '../../components/navigation/TabBarMotion';
import { SearchField } from '../../components/search/SearchField';
import { Chip } from '../../components/ui/Chip';
import { Backdrop, Poster } from '../../components/ui/Poster';
import { useRefresh } from '../../components/ui/Refresh';
import { ScrollScreen, Screen } from '../../components/ui/Screen';
import { SectionHeader } from '../../components/ui/Section';
import { PosterRowSkeleton, Skeleton } from '../../components/ui/Skeleton';
import { InlineNotice } from '../../components/ui/States';
import { Tap } from '../../components/ui/Tap';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { WorldTile } from '../../components/fandom/WorldTile';
import { colors, radius, space } from '../../constants/theme';
import { catalog, invalidateCatalogLists, friendlyCatalogCopy } from '../../lib/catalog';
import { adoptActors, adoptDramas } from '../../lib/catalogSync';
import { buildExploreRails } from '../../lib/exploreRails';
import { discoverCatalogTitles } from '../../lib/api/features';
import { exploreWatchLinks } from '../../lib/whereToWatch';
import { Linking } from 'react-native';
import { FANDOMS, fandomById } from '../../lib/fandoms';
import { haptic, Loadable, useApp, useCatalogHealth, useLayout, useLoad, useNetwork } from '../../lib/hooks';
import { useToast } from '../../components/ui/Toast';
import { Actor, Drama, FandomId, GENRES } from '../../lib/model';
import { publicCollections, shorts, trendingDiscussions, trendingHashtags, worldCounts } from '../../lib/selectors';
import { getState } from '../../lib/store';
import { adoptLocal, adoptPublicState } from '../../lib/sync';

const NETFLIX = 8; // TMDB watch-provider id

/** Live catalog list → app records (adopted into the store so every poster opens a full Drama Hub). */
function useDramas(run: (signal: AbortSignal) => Promise<Drama[]>, deps: unknown[] = []): Loadable<Drama[]> {
  return useLoad(async (signal) => adoptDramas(await run(signal)), deps, catalog.available);
}

/**
 * Explore — authoritative discovery across all four Hallyu worlds:
 * K-Dramas, C-Dramas, Anime, and Hollywood.
 */
export default function Explore() {
  const router = useRouter();
  const tabBar = useTabBarMotion();
  const refresh = useRefresh('explore');
  const online = useNetwork();
  const health = useCatalogHealth();
  const toast = useToast();
  const { state } = useApp();
  const { width } = useLayout();
  const [spinningPick, setSpinningPick] = useState(false);

  const surpriseTonight = async () => {
    if (spinningPick) return;
    setSpinningPick(true);
    haptic.medium();
    try {
      const picks = await discoverCatalogTitles(
        { sort: 'random', minRating: 7.2, limit: 1 },
        state.importedDramas,
      );
      if (picks[0]) {
        const [adopted] = adoptDramas([picks[0]]);
        const chosen = adopted ?? picks[0];
        toast.show({ message: `Tonight’s pick: ${chosen.title}`, icon: 'sparkles', tone: 'success' });
        router.push(`/drama/${chosen.id}`);
      }
    } finally {
      setSpinningPick(false);
    }
  };

  const leadersLoad = useDramas((s) => catalog.worldLeaders(s));
  const trendingLoad = useDramas((s) => catalog.trending(s));
  const airingLoad = useDramas((s) => catalog.airingSoon(7, s));
  const topRatedLoad = useDramas((s) => catalog.topRated(1, s));
  const upcomingLoad = useDramas((s) => catalog.upcoming(s));
  const netflixLoad = useDramas((s) => catalog.onProvider(NETFLIX, s));
  const faces = useLoad<Actor[]>(async (s) => adoptActors(await catalog.trendingPeople(s)), [], catalog.available);

  const rails = useMemo(
    () =>
      buildExploreRails({
        leaders: leadersLoad.data,
        trending: trendingLoad.data,
        airing: airingLoad.data,
        topRated: topRatedLoad.data,
        upcoming: upcomingLoad.data,
        netflix: netflixLoad.data,
      }),
    [leadersLoad.data, trendingLoad.data, airingLoad.data, topRatedLoad.data, upcomingLoad.data, netflixLoad.data],
  );

  const [selectedLeaderWorld, setSelectedLeaderWorld] = useState<FandomId>('kdrama');
  const activeLeader = useMemo(
    () => rails.leaders.find((entry) => entry.world === selectedLeaderWorld) ?? rails.leaders[0] ?? null,
    [rails.leaders, selectedLeaderWorld],
  );

  const pulse = useMemo(() => {
    const since = Date.now() - 86_400_000;
    const fresh = (iso?: string) => !!iso && Date.parse(iso) >= since;
    return {
      posts: state.posts.filter((p) => fresh(p.createdAt)).length,
      comments: state.comments.filter((c) => fresh(c.createdAt)).length,
      people: Object.keys(state.users).length,
    };
  }, [state]);

  const favGenres = useMemo(() => state.profile.favoriteGenres?.slice(0, 2) ?? [], [state.profile.favoriteGenres]);
  const forYou = useLoad<Drama[]>(async (signal) => {
    const lists = await Promise.all(favGenres.map((g) => catalog.byGenre(g, 1, signal)));
    const seen = new Set<string>();
    const out: Drama[] = [];
    for (const d of lists.flat()) {
      if (!seen.has(d.id)) {
        seen.add(d.id);
        out.push(d);
      }
    }
    return adoptDramas(out);
  }, [favGenres.join('|')], catalog.available && favGenres.length > 0);

  useEffect(() => {
    if (!refresh.refreshing) return;
    invalidateCatalogLists();
    leadersLoad.reload();
    trendingLoad.reload();
    airingLoad.reload();
    topRatedLoad.reload();
    upcomingLoad.reload();
    netflixLoad.reload();
    faces.reload();
    forYou.reload();
    void adoptPublicState({
      getState,
      apply: (patch) => adoptLocal({ type: 'hydrate', state: patch }),
      addPosts: (posts) => {
        for (const post of posts) adoptLocal({ type: 'addPost', post });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh.refreshing]);

  const discussions = useMemo(() => trendingDiscussions(state, 3), [state]);
  const collections = useMemo(() => publicCollections(state).slice(0, 8), [state]);
  const shortList = useMemo(() => shorts(state), [state]);
  const counts = useMemo(() => worldCounts(state), [state]);
  const quickTags = useMemo(() => trendingHashtags(state, 6).map((x) => x.tag), [state]);

  const heroW = Math.min(width - space.margin * 2, 640);
  const heroH = Math.round(Math.min(310, heroW * 0.6));
  const catalogDown = !!trendingLoad.error && !trendingLoad.data && !leadersLoad.data;

  const trendingState: Loadable<Drama[]> = useMemo(
    () => ({ ...trendingLoad, data: trendingLoad.data ? rails.trending : null }),
    [trendingLoad, rails.trending],
  );
  const airingState: Loadable<Drama[]> = useMemo(
    () => ({ ...airingLoad, data: airingLoad.data ? rails.airing : null }),
    [airingLoad, rails.airing],
  );
  const topRatedState: Loadable<Drama[]> = useMemo(
    () => ({ ...topRatedLoad, data: topRatedLoad.data ? rails.topRated : null }),
    [topRatedLoad, rails.topRated],
  );
  const upcomingState: Loadable<Drama[]> = useMemo(
    () => ({ ...upcomingLoad, data: upcomingLoad.data ? rails.upcoming : null }),
    [upcomingLoad, rails.upcoming],
  );
  const netflixState: Loadable<Drama[]> = useMemo(
    () => ({ ...netflixLoad, data: netflixLoad.data ? rails.netflix : null }),
    [netflixLoad, rails.netflix],
  );

  return (
    <Screen header={<TopBar mode="root" title="Explore" large />}>
      <ScrollScreen tabbed onScroll={tabBar.onScroll} scrollEventThrottle={16} refreshControl={refresh.control}>
        <View style={{ marginBottom: space.x6 }}>
          <View style={{ paddingHorizontal: space.margin }}>
            <SearchField asButton placeholder="Films, series, anime, actors, people…" onPressButton={() => router.push('/search')} />
          </View>
          <FlatList<{ key: string; label: string; icon: 'options-outline' | 'sparkles-outline' | 'people-circle-outline' | 'play-circle-outline'; onPress: () => void }>
            horizontal
            data={[
              { key: 'filter', label: 'Filter Catalog', icon: 'options-outline', onPress: () => router.push('/search') },
              { key: 'surprise', label: spinningPick ? 'Picking…' : 'Surprise Me Tonight', icon: 'sparkles-outline', onPress: () => void surpriseTonight() },
              { key: 'watch', label: 'Watch', icon: 'play-circle-outline', onPress: () => router.push('/watch') },
              { key: 'communities', label: 'Communities', icon: 'people-circle-outline', onPress: () => router.push('/communities') },
            ]}
            keyExtractor={(x) => x.key}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: space.margin, paddingTop: space.x3, gap: space.x2 }}
            renderItem={({ item }) => <Chip label={item.label} icon={item.icon} tone={item.key === 'surprise' ? 'accent' : 'default'} onPress={item.onPress} />}
          />
          <FlatList
            horizontal
            data={FANDOMS}
            keyExtractor={(f) => f.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: space.margin, paddingTop: space.x2, gap: space.x2 }}
            renderItem={({ item: f }) => <Chip label={`${f.flag} ${f.short}`} onPress={() => router.push(`/world/${f.id}`)} />}
          />
          {quickTags.length > 0 ? (
            <FlatList
              horizontal
              data={quickTags}
              keyExtractor={(t) => t}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: space.margin, paddingTop: space.x2, gap: space.x2 }}
              renderItem={({ item: t }) => (
                <Chip label={`#${t}`} tone="accent" onPress={() => router.push({ pathname: '/search', params: { q: `#${t}` } })} />
              )}
            />
          ) : null}
        </View>

        <View style={styles.section}>
          <SectionHeader
            eyebrow="Fandoms"
            title="Four worlds, one community"
            subtitle="Hallyu shows you all four at once. Step into one when that is what you want."
            actionLabel="Fandom rooms"
            onAction={() => router.push('/communities')}
          />
          <FlatList
            horizontal
            data={FANDOMS}
            keyExtractor={(f) => f.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.gutter }}
            initialNumToRender={4}
            renderItem={({ item: f }) => <WorldTile world={f} count={counts[f.id] ?? 0} onPress={() => router.push(`/world/${f.id}`)} />}
          />
        </View>

        {!catalog.available ? (
          <InlineNotice
            tone="warning"
            icon="key-outline"
            text="The catalog isn’t configured in this build, so live titles can’t load."
            style={{ marginHorizontal: space.margin, marginBottom: space.x6 }}
          />
        ) : catalogDown ? (
          <Pressable onPress={trendingLoad.reload} accessibilityRole="button" accessibilityLabel="Retry loading the catalog" style={{ marginHorizontal: space.margin, marginBottom: space.x6 }}>
            <InlineNotice
              tone="warning"
              icon={online ? 'cloud-offline-outline' : 'wifi-outline'}
              text={`${friendlyCatalogCopy(health, online).title}. ${friendlyCatalogCopy(health, online).body}`}
            />
          </Pressable>
        ) : null}

        {pulse.posts > 0 || pulse.comments > 0 || pulse.people > 1 ? (
          <View style={styles.section}>
            <SectionHeader eyebrow="Community" title="Recent pulse" subtitle="Posts, replies and members across your feed" />
            <View style={styles.pulseRow}>
              <PulsePill icon="flame-outline" label="New posts" value={pulse.posts} onPress={() => router.push('/trending')} />
              <PulsePill icon="chatbubbles-outline" label="Comments" value={pulse.comments} onPress={() => router.push('/trending')} />
              <PulsePill icon="people-outline" label="People" value={pulse.people} onPress={() => router.push('/people')} />
            </View>
          </View>
        ) : null}

        {/* Four genuine calculated world leaders: #1 K-Drama, #1 C-Drama, #1 Anime, #1 Hollywood */}
        {activeLeader ? (
          <View style={styles.section}>
            <SectionHeader
              eyebrow="This week’s leaders"
              title="#1 across every world"
              subtitle="Calculated per world from airing momentum, community follows, and live audience demand"
            />
            <FlatList
              horizontal
              data={rails.leaders}
              keyExtractor={(item) => item.world}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: space.margin, paddingBottom: space.x3, gap: space.x2 }}
              renderItem={({ item }) => {
                const worldMeta = fandomById(item.world);
                const selected = item.world === activeLeader.world;
                return (
                  <Chip
                    label={`${worldMeta.flag} #1 ${worldMeta.short}`}
                    selected={selected}
                    onPress={() => setSelectedLeaderWorld(item.world)}
                  />
                );
              }}
            />
            <Tap
              onPress={() => router.push(`/drama/${activeLeader.drama.id}`)}
              style={[styles.hero, { width: heroW, height: heroH, backgroundColor: activeLeader.drama.tone, marginBottom: space.x3 }]}
              accessibilityRole="button"
              accessibilityLabel={`#1 in ${fandomById(activeLeader.world).short}: ${activeLeader.drama.title}`}
            >
              <Backdrop
                uri={activeLeader.drama.backdropUrl ?? activeLeader.drama.posterUrl}
                fallbackColor={activeLeader.drama.tone}
                width={heroW}
                height={heroH}
                cinemaGradient
                accentGlow={fandomById(activeLeader.world).tint}
                style={StyleSheet.absoluteFill}
              />
              <View style={styles.heroBody}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
                  <View style={[styles.signal, { backgroundColor: fandomById(activeLeader.world).tint }]} />
                  <Text variant="overline" tone="accent">
                    {`${fandomById(activeLeader.world).flag} #1 ${fandomById(activeLeader.world).short}`}
                  </Text>
                  {activeLeader.drama.rating ? (
                    <Text variant="overline" tone="secondary">
                      · ★ {activeLeader.drama.rating.toFixed(1)}
                    </Text>
                  ) : null}
                  {activeLeader.drama.status === 'airing' ? (
                    <Text variant="overline" tone="secondary">
                      · Airing now
                    </Text>
                  ) : null}
                  {activeLeader.drama.network ? (
                    <Text variant="overline" tone="secondary" numberOfLines={1}>
                      · {activeLeader.drama.network}
                    </Text>
                  ) : null}
                </View>
                <Text variant={activeLeader.drama.title.length <= 22 ? 'display' : 'headline'} style={{ color: colors.onMedia, letterSpacing: -0.8 }} numberOfLines={2}>
                  {activeLeader.drama.title}
                </Text>
                <Text variant="bodySmall" style={{ color: colors.textSecondary }} numberOfLines={2}>
                  {activeLeader.drama.synopsis}
                </Text>
              </View>
            </Tap>

            <FlatList
              horizontal
              data={rails.leaders}
              keyExtractor={(item) => item.drama.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.gutter }}
              renderItem={({ item }) => {
                const w = fandomById(item.world);
                return (
                  <Tap
                    onPress={() => router.push(`/drama/${item.drama.id}`)}
                    style={[
                      styles.leaderMiniCard,
                      item.world === activeLeader.world && { borderColor: w.tint },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`#1 ${w.short}: ${item.drama.title}`}
                  >
                    <Poster drama={item.drama} width={48} rounded={radius.sm} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text variant="caption" style={{ color: w.tint }}>
                        {`${w.flag} #1 ${w.short}`}
                      </Text>
                      <Text variant="titleSmall" numberOfLines={1}>
                        {item.drama.title}
                      </Text>
                      <Text variant="caption" tone="secondary" numberOfLines={1}>
                        {[
                          item.drama.status === 'airing' ? 'Airing' : item.drama.status === 'upcoming' ? 'Upcoming' : String(item.drama.year),
                          item.drama.rating ? `★ ${item.drama.rating.toFixed(1)}` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </View>
                  </Tap>
                );
              }}
            />
          </View>
        ) : leadersLoad.showSkeleton || (leadersLoad.loading && !leadersLoad.data) ? (
          <Skeleton width={heroW} height={heroH} radius={radius.lg} style={{ alignSelf: 'center', marginBottom: space.section }} />
        ) : null}

        <LiveRail
          eyebrow="Trending"
          title="Everyone’s talking about"
          subtitle="Balanced across K-Dramas, C-Dramas, Anime and Hollywood"
          state={trendingState}
          size="m"
          onAction={() => router.push('/trending')}
        />

        {favGenres.length > 0 ? (
          <LiveRail
            eyebrow="For you"
            title={`Because you love ${favGenres.join(' & ')}`}
            subtitle="Fresh from your favorite genres"
            state={forYou}
            size="m"
          />
        ) : null}

        <LiveRail eyebrow="This week" title="New episodes airing" live state={airingState} size="l" onAction={() => router.push('/schedule')} actionLabel="Schedule" />

        <View style={styles.section}>
          <SectionHeader eyebrow="Browse" title="By genre" />
          <FlatList
            horizontal
            data={GENRES}
            keyExtractor={(g) => g}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.x2 }}
            initialNumToRender={6}
            renderItem={({ item: g }) => <GenreTile genre={g} onPress={() => router.push(`/genre/${encodeURIComponent(g)}`)} />}
          />
        </View>

        <LiveRail eyebrow="All time" title="Highest rated" state={topRatedState} size="m" badges={(d) => (d.rating ? `★ ${d.rating.toFixed(1)}` : undefined)} />

        {rails.wall.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader eyebrow="Discover" title="The wall" subtitle="More standouts across all four worlds" />
            <FlatList
              data={rails.wall}
              keyExtractor={(d) => d.id}
              numColumns={2}
              scrollEnabled={false}
              columnWrapperStyle={styles.wallCol}
              renderItem={({ item: d }) => <DramaCard drama={d} size="l" />}
            />
          </View>
        ) : null}

        <LiveRail eyebrow="Streaming" title="On Netflix" state={netflixState} size="m" />

        <View style={styles.section}>
          <SectionHeader eyebrow="Where to watch" title="Official apps and sites" />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16 }}>
            {exploreWatchLinks().map((link) => (
              <Chip
                key={link.service}
                label={`${link.label} ↗`}
                onPress={() => Linking.openURL(link.url).catch(() => toast.show({ message: `Could not open ${link.label}` }))}
              />
            ))}
          </View>
          <Text variant="caption" tone="tertiary" style={{ paddingHorizontal: 16 }}>
            These open the official service. Hallyu does not play third-party streams.
          </Text>
        </View>

        {shortList.length ? (
          <View style={styles.section}>
            <SectionHeader eyebrow="Shorts" title="Sixty seconds or less" onAction={() => router.push('/shorts')} />
            <ShortsRail posts={shortList} />
          </View>
        ) : null}

        <View style={styles.section}>
          <SectionHeader eyebrow="Discussions" title="Threads worth your time" onAction={() => router.push('/trending')} />
          {discussions.map((p) => (
            <PostCard key={p.id} post={p} />
          ))}
        </View>

        {faces.data?.length ? (
          <View style={styles.section}>
            <SectionHeader eyebrow="Actors" title="Faces of the week" subtitle="Trending across film & television" />
            <ActorRail actors={faces.data} size={80} />
          </View>
        ) : faces.showSkeleton ? (
          <View style={[styles.section, { flexDirection: 'row', gap: space.x3, paddingHorizontal: space.margin }]}>
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} width={80} height={80} circle />
            ))}
          </View>
        ) : null}

        <LiveRail
          eyebrow="Coming soon"
          title="Premieres"
          state={upcomingState}
          size="m"
          badges={(d) =>
            d.nextEpisodeAt
              ? new Date(d.nextEpisodeAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
              : String(d.year)
          }
        />

        <View style={styles.section}>
          <SectionHeader eyebrow="Collections" title="Shelves from the community" onAction={() => router.push('/collections')} />
          <FlatList
            horizontal
            data={collections}
            keyExtractor={(c) => c.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.gutter }}
            renderItem={({ item }) => <CollectionCard collection={item} />}
          />
        </View>

        <View style={styles.section}>
          <SectionHeader eyebrow="Hashtags" title="Trending tags" />
          <View style={styles.tags}>
            {trendingHashtags(state, 14).map(({ tag: t }) => (
              <Pressable key={t} onPress={() => router.push({ pathname: '/search', params: { q: `#${t}` } })} style={styles.tag} accessibilityRole="button" accessibilityLabel={`#${t}`}>
                <Text variant="label" tone="accent">
                  #{t}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={{ paddingHorizontal: space.margin, marginTop: space.x4, flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
          <Ionicons name="film-outline" size={14} color={colors.textTertiary} />
          <Text variant="caption" tone="tertiary" style={{ flex: 1 }}>
            Titles, art and ratings by TMDB. Hallyu is not endorsed or certified by TMDB.
          </Text>
        </View>
      </ScrollScreen>
    </Screen>
  );
}

function PulsePill({ icon, label, value, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: number; onPress: () => void }) {
  return (
    <Tap onPress={onPress} style={styles.pill} accessibilityRole="button" accessibilityLabel={`${label}: ${value}`}>
      <Ionicons name={icon} size={18} color={colors.accent} />
      <View style={{ flex: 1 }}>
        <Text variant="titleSmall">{formatCount(value)}</Text>
        <Text variant="caption" tone="secondary" numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Tap>
  );
}

const formatCount = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

function LiveRail({
  eyebrow,
  title,
  subtitle,
  live,
  state,
  size,
  slice,
  badges,
  onAction,
  actionLabel,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  live?: boolean;
  state: Loadable<Drama[]>;
  size: 's' | 'm' | 'l' | 'xl';
  slice?: [number, number?];
  badges?: (d: Drama) => string | undefined;
  onAction?: () => void;
  actionLabel?: string;
}) {
  const items = useMemo(() => {
    const all = state.data ?? [];
    return slice ? all.slice(slice[0], slice[1]) : all;
  }, [state.data, slice]);
  if (!state.data && !state.loading && state.error) {
    return (
      <View style={styles.section}>
        <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />
        <Pressable onPress={state.reload} style={styles.retry} accessibilityRole="button" accessibilityLabel={`Retry ${title}`}>
          <Ionicons name="refresh-outline" size={16} color={colors.textSecondary} />
          <Text variant="bodySmall" tone="secondary">
            Couldn’t load this row · Tap to retry
          </Text>
        </Pressable>
      </View>
    );
  }
  if (!state.data) {
    if (!state.loading) return null;
    return (
      <View style={styles.section}>
        <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} />
        <PosterRowSkeleton count={4} width={size === 'l' ? 140 : 104} />
      </View>
    );
  }
  if (!items.length) return null;
  const badgeMap = badges ? Object.fromEntries(items.map((d) => [d.id, badges(d)]).filter(([, v]) => !!v) as [string, string][]) : undefined;
  return (
    <View style={styles.section}>
      <SectionHeader eyebrow={eyebrow} title={title} subtitle={subtitle} live={live} onAction={onAction} actionLabel={actionLabel} />
      <DramaRail dramas={items} size={size} badges={badgeMap} />
    </View>
  );
}

function GenreTile({ genre, onPress }: { genre: string; onPress: () => void }) {
  const top = useDramas((s) => catalog.byGenre(genre, 1, s), [genre]);
  const lead = top.data?.[0];
  return (
    <Pressable onPress={onPress} style={[styles.genre, { backgroundColor: lead?.tone ?? colors.surface2 }]} accessibilityRole="button" accessibilityLabel={`${genre} dramas`}>
      {lead ? <Poster drama={lead} width={148} rounded={radius.md} style={{ position: 'absolute', top: -60, opacity: 0.45 }} /> : null}
      <View style={styles.genreScrim} />
      <View style={{ gap: 2 }}>
        <Text variant="titleSmall" style={{ color: colors.onMedia }}>
          {genre}
        </Text>
        <Text variant="caption" tone="secondary" numberOfLines={1}>
          {lead ? lead.title : top.loading ? ' ' : 'Browse'}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: {
    alignSelf: 'center',
    borderRadius: radius.lg,
    overflow: 'hidden',
    marginBottom: space.section,
    justifyContent: 'flex-end',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  heroScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(10,10,10,0.44)' },
  heroBody: { padding: space.x4, gap: 4 },
  signal: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  leaderMiniCard: {
    width: 214,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    backgroundColor: colors.surface1,
    borderRadius: radius.md,
    padding: space.x3,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  section: { marginBottom: space.section },
  pulseRow: { flexDirection: 'row', gap: space.gutter, paddingHorizontal: space.margin },
  pill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    backgroundColor: colors.surface1,
    borderRadius: radius.md,
    padding: space.x3,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  genre: { width: 148, height: 96, borderRadius: radius.md, padding: space.x3, justifyContent: 'flex-end', overflow: 'hidden' },
  genreScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(10,10,10,0.35)' },
  retry: {
    marginHorizontal: space.margin,
    height: 56,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.x2,
  },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x2, paddingHorizontal: space.margin },
  tag: { paddingHorizontal: 12, height: 32, borderRadius: 16, backgroundColor: colors.surface1, alignItems: 'center', justifyContent: 'center' },
  wallCol: { paddingHorizontal: space.margin, gap: space.gutter, marginBottom: space.x4 },
});
