import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Animated, FlatList, Linking, Pressable, StyleSheet, View } from 'react-native';
import { ShareCardModal } from '../../components/share/ShareCardModal';
import { fetchTitleRatingSummary, rateTitleOnServer } from '../../lib/api/features';
import { crossCheckRuntimes } from '../../lib/api/megan';
import { fetchDramasByUuids } from '../../lib/api/feed';
import { isUuid } from '../../lib/api/social';
import { setActiveComposerContext } from '../../lib/tabEvents';
import { officialWatchLink } from '../../lib/whereToWatch';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AddToCollectionSheet } from '../../components/collections/AddToCollectionSheet';
import { CollectionCard } from '../../components/collections/CollectionCard';
import { ActorCard, ActorRail } from '../../components/drama/ActorCard';
import { DramaRail } from '../../components/drama/DramaCard';
import { EpisodeCard, EpisodeChip, episodeState } from '../../components/drama/EpisodeCard';
import { FollowButton } from '../../components/drama/FollowButton';
import { WatchStatusButton } from '../../components/drama/WatchStatus';
import { CreateSheet } from '../../components/create/CreateSheet';
import { PostCard } from '../../components/feed/PostCard';
import { FeedAutoplay } from '../../components/media/FeedViewport';
import { ReactionMeter } from '../../components/feed/Reactions';
import { ShortsRail } from '../../components/feed/ShortCard';
import { Button } from '../../components/ui/Button';
import { Chip, ChipRow } from '../../components/ui/Chip';
import { CoachMarks } from '../../components/ui/CoachMarks';
import { Disclosure } from '../../components/ui/Disclosure';
import { IconButton } from '../../components/ui/IconButton';
import { Backdrop, Poster } from '../../components/ui/Poster';
import { useRefresh } from '../../components/ui/Refresh';
import { Screen, useColumn, useListPadding } from '../../components/ui/Screen';
import { KeyValue, ProgressBar, SectionHeader } from '../../components/ui/Section';
import { Segmented } from '../../components/ui/Segmented';
import { Sheet, SheetRow } from '../../components/ui/Sheet';
import { ListSkeleton, PostSkeleton } from '../../components/ui/Skeleton';
import { EmptyState, ErrorState } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { useToast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import { colors, radius, shadows, sizes, space } from '../../constants/theme';
import { catalog } from '../../lib/catalog';
import { adoptDramas } from '../../lib/catalogSync';
import { compact, countdown, dayLabel, timeOfDay } from '../../lib/format';
import { haptic, useApp, useLayout, useLoad, useRequireMember } from '../../lib/hooks';
import { heroInterpolations, useArrive, useHeroSettle, useScrollY, withAlpha } from '../../lib/motion';
import { dramaFandom, isFilm, runtimeLabel } from '../../lib/fandoms';
import { CastCredit, Drama, emptyReactions, Episode, Post, PostType } from '../../lib/model';
import { collectionsContaining, isPostVeiled as postVeiled, postsForDrama, relatedDramas } from '../../lib/selectors';

type Tab = 'overview' | 'episodes' | 'community' | 'cast';
/** Old deep links used six tabs; Media now lives in Overview and Activity is Community sorted by Latest. */
const LEGACY_TAB: Record<string, Tab> = {
  media: 'overview',
  activity: 'community',
};
type Filter = 'all' | PostType;

/** Drama Hub — the home of a fandom. Four tabs under a sticky bar, one header, spoiler-aware everywhere. */
export default function DramaHub() {
  const router = useRouter();
  const toast = useToast();
  const params = useLocalSearchParams<{ id: string; tab?: string }>();
  const { state, dispatch, getDrama, getActor, watch, isFollowing } = useApp();
  const require = useRequireMember();
  const { width, wc } = useLayout();
  const insets = useSafeAreaInsets();
  const padding = useListPadding(false);
  const column = useColumn(sizes.readingColumn + 200);
  const refresh = useRefresh('drama');
  const drama = getDrama(params.id);
  // Expanded widths (tablet landscape, desktop web): Overview stays put on the left while
  // Episodes / Community / Cast scroll on the right — the hub becomes a two-pane reading room.
  const twoPane = wc === 'expanded';
  const leftW = twoPane ? Math.min(560, Math.round(width * 0.46)) : width;
  const [tabState, setTab] = useState<Tab>(() => (params.tab && params.tab in LEGACY_TAB ? LEGACY_TAB[params.tab]! : ((params.tab as Tab | undefined) ?? 'overview')));
  // A film has no episode list: keep the tab out of the bar, and out of reach if it was linked to.
  const film = !!drama && isFilm(drama);
  const tab: Tab = film && tabState === 'episodes' ? 'overview' : twoPane && tabState === 'overview' ? 'community' : tabState;
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<'top' | 'latest'>(params.tab === 'activity' ? 'latest' : 'top');
  const [safe, setSafe] = useState(false);
  const [season, setSeason] = useState<number>(watch(params.id)?.season ?? 1);
  const [menu, setMenu] = useState(false);
  const [collect, setCollect] = useState(false);
  const [create, setCreate] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [synopsisOpen, setSynopsisOpen] = useState(false);
  const [myScore, setMyScore] = useState<number | null>(null);
  const [ratingCount, setRatingCount] = useState<number>(0);

  useEffect(() => {
    if (!drama?.id) return;
    setActiveComposerContext({ dramaId: drama.id, season });
    let alive = true;
    fetchTitleRatingSummary(drama.id, state.profile.id)
      .then((res) => {
        if (!alive) return;
        setMyScore(res.myScore);
        setRatingCount(res.ratingCount);
        if (res.communityRating && res.communityRating !== drama.rating) {
          dispatch({ type: 'rateDrama', dramaId: drama.id, rating: res.communityRating });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      setActiveComposerContext(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drama?.id, state.profile.id]);
  const { scrollY, onScroll } = useScrollY();
  const arrivePoster = useArrive(0);
  const arriveTitle = useArrive(60);
  const arriveChips = useArrive(110);
  const arriveActions = useArrive(150);
  const heroSettle = useHeroSettle();

  // Thin (search-imported) or un-hydrated records get enriched from the catalog provider.
  const parsedTmdb = !drama && params.id ? /^tmdb-(?:(movie)-)?(\d+)$/.exec(params.id) : null;
  useEffect(() => {
    if (drama || !params.id || !isUuid(params.id)) return;
    let alive = true;
    void fetchDramasByUuids([params.id]).then(({ dramas }) => {
      if (!alive || !dramas[0]) return;
      const [adopted] = adoptDramas(dramas);
      router.replace(`/drama/${(adopted ?? dramas[0]).id}`);
    });
    return () => {
      alive = false;
    };
  }, [drama, params.id, router]);
  const thin =
    (!!drama?.provider && (!drama.posterUrl || !drama.backdropUrl || !drama.trailerUrl || drama.cast.length < 4 || (!film && drama.episodes.length === 0))) ||
    !!parsedTmdb;
  const enrich = useLoad(
    async (signal) => {
      if (drama?.provider) return catalog.getDrama(drama.provider.id, drama.mediaType ?? 'tv', signal);
      if (parsedTmdb) return catalog.getDrama(Number(parsedTmdb[2]), (parsedTmdb[1] as 'movie' | undefined) ?? 'tv', signal);
      return null;
    },
    [drama?.id ?? params.id],
    thin && catalog.available,
  );
  useEffect(() => {
    if (enrich.data) dispatch({ type: 'import', dramas: [{ ...enrich.data, id: drama?.id ?? params.id }] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrich.data]);

  // On-demand multi-season episode loading when the viewer switches to a season not yet in drama.episodes.
  const hasSeasonEps = !!drama && drama.episodes.some((e) => e.season === season);
  const seasonEnrich = useLoad(
    async (signal) => {
      if (!drama?.provider || film) return [] as Episode[];
      return catalog.getSeasonEpisodes(drama.provider.id, season, drama.id, signal);
    },
    [drama?.id, drama?.provider?.id, season, film],
    !!drama?.provider && !film && !hasSeasonEps && catalog.available,
  );
  useEffect(() => {
    if (drama && seasonEnrich.data?.length) {
      dispatch({ type: 'import', dramas: [{ ...drama, episodes: [...drama.episodes, ...seasonEnrich.data] }] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasonEnrich.data]);

  // Live TMDB recommendations merged with local related dramas.
  const liveRecs = useLoad<Drama[]>(
    async (signal) => (drama?.provider ? adoptDramas(await catalog.recommendations(drama.provider.id, drama.mediaType ?? 'tv', signal)) : []),
    [drama?.id, drama?.provider?.id, drama?.mediaType],
    !!drama?.provider && catalog.available,
  );

  const posts = useMemo(() => (drama ? postsForDrama(state, drama.id, sort) : []), [state, drama, sort]);
  /** First unveiled member/Hallyu video for this title. Plays only content hosted on Hallyu. */
  const hallyuPlayable = useMemo(
    () => posts.find((p) => !!p.video && p.spoiler === 'none' && !postVeiled(state, p)) ?? null,
    [posts, state],
  );
  const typed = useMemo(() => (filter === 'all' ? posts.filter((p) => p.type !== 'short') : posts.filter((p) => p.type === filter)), [posts, filter]);
  // "Safe for me" hides what would be veiled for this viewer, so a mid-series read isn't a wall of veils.
  const veiledCount = useMemo(() => typed.filter((p) => p.spoiler !== 'none' || postVeiled(state, p)).length, [state, typed]);
  const filtered = useMemo(() => (safe && veiledCount ? typed.filter((p) => p.spoiler === 'none' && !postVeiled(state, p)) : typed), [typed, safe, veiledCount, state]);
  const shorts = useMemo(() => posts.filter((p) => p.type === 'short'), [posts]);
  const meter = useMemo(
    () =>
      posts.reduce((acc, p) => {
        for (const k of Object.keys(acc) as (keyof typeof acc)[]) acc[k] += p.reactions[k];
        return acc;
      }, emptyReactions()),
    [posts],
  );
  const meterTotal = useMemo(() => Object.values(meter).reduce((a, b) => a + b, 0), [meter]);
  const related = useMemo(() => {
    if (!drama) return [];
    const local = relatedDramas(state, drama, 8);
    const remote = (liveRecs.data ?? []).filter((d) => d.id !== drama.id);
    const seen = new Set<string>();
    return [...remote, ...local].filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true))).slice(0, 10);
  }, [state, drama, liveRecs.data]);
  const inCollections = useMemo(() => (drama ? collectionsContaining(state, drama.id) : []), [state, drama]);
  const publicCols = useMemo(() => (drama ? state.collections.filter((c) => c.visibility === 'public' && c.items.some((i) => i.dramaId === drama.id)).slice(0, 6) : []), [state.collections, drama]);

  // Runtime cross-check against a second metadata source (Megan, via the server). Informational only.
  const crossRows = useMemo(
    () =>
      drama && !film
        ? drama.episodes.filter((e) => e.season === season && e.runtime).map((e) => ({ episode: e.number, runtime: e.runtime as number }))
        : [],
    [drama, film, season],
  );
  const providerId = drama?.provider?.id;
  const [runtimeNote, setRuntimeNote] = useState<string | null>(null);
  useEffect(() => {
    setRuntimeNote(null);
    if (!providerId || crossRows.length < 2) return;
    let cancelled = false;
    crossCheckRuntimes(providerId, season, crossRows).then((r) => {
      if (cancelled || !r.ok) return;
      setRuntimeNote(
        r.value.agrees
          ? `Runtimes match a second source for ${r.value.compared} episodes.`
          : `Runtimes differ from a second source for ${r.value.mismatches.length} of ${r.value.compared} episodes.`,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [providerId, season, crossRows]);

  if (!drama) {
    return (
      <Screen header={<TopBar mode="stack" title="Drama" />}>
        {enrich.loading ? <PostSkeleton /> : <ErrorState kind="notFound" title="This drama isn’t available" body="It may have been removed from the catalog, or the link is wrong." onRetry={() => router.back()} />}
      </Screen>
    );
  }

  const item = watch(drama.id);
  const following = isFollowing('dramas', drama.id);
  const world = dramaFandom(drama);
  const notify = state.dramaNotify[drama.id] ?? true;
  const multi = drama.seasons.length > 1;
  const rawEps = drama.episodes.filter((e) => e.season === season).sort((a, b) => a.number - b.number);
  const seasonMeta = drama.seasons.find((s) => s.number === season);
  const fallbackEpCount = seasonMeta?.episodeCount || drama.episodeCount || (film ? 0 : 16);
  const eps: Episode[] = rawEps.length
    ? rawEps
    : !film && fallbackEpCount > 0
      ? Array.from({ length: fallbackEpCount }, (_, i) => ({
          id: `${drama.id}-s${season}e${i + 1}`,
          dramaId: drama.id,
          season,
          number: i + 1,
          title: `Episode ${i + 1}`,
        }))
      : [];
  const next = drama.episodes.filter((e) => episodeState(e) !== 'aired').sort((a, b) => (a.airDate ?? '').localeCompare(b.airDate ?? ''))[0];
  const liveEp = drama.episodes.find((e) => episodeState(e) === 'live');
  const talking = posts.filter((p) => new Date(p.createdAt) > new Date(Date.now() - 7 * 86_400_000)).length;
  const openTrailer = async () => {
    if (!drama.trailerUrl) return;
    haptic.light();
    try {
      await WebBrowser.openBrowserAsync(drama.trailerUrl, {
        toolbarColor: '#000000',
        controlsColor: colors.accent,
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
    } catch {
      Linking.openURL(drama.trailerUrl).catch(() => toast.show({ message: 'Could not open trailer' }));
    }
  };
  const stillH = 96;
  const stills: {
    uri: string;
    title: string;
    kind: 'backdrop' | 'poster' | 'still';
  }[] = [
    ...(drama.backdropUrl
      ? [
          {
            uri: drama.backdropUrl,
            title: drama.title,
            kind: 'backdrop' as const,
          },
        ]
      : []),
    ...(drama.posterUrl
      ? [
          {
            uri: drama.posterUrl,
            title: `${drama.title} poster`,
            kind: 'poster' as const,
          },
        ]
      : []),
    ...drama.episodes
      .filter((e) => e.stillUrl)
      .slice(0, 12)
      .map((e) => ({
        uri: e.stillUrl!,
        title: `Episode ${e.number}`,
        kind: 'still' as const,
      })),
  ];
  const heroH = Math.min(sizes.heroMax, Math.round((leftW * 9) / 16));
  const total = drama.seasons.find((s) => s.number === (item?.season ?? 1))?.episodeCount ?? drama.episodeCount;
  const share = () => {
    haptic.light();
    setShareOpen(true);
  };
  const submitQuickRating = async (score: number) => {
    require('rate titles', async () => {
      haptic.success();
      setMyScore(score);
      dispatch({ type: 'rateDrama', dramaId: drama.id, rating: score });
      try {
        const res = await rateTitleOnServer(drama.id, score);
        if (res) {
          setMyScore(res.myScore);
          setRatingCount(res.ratingCount);
          if (res.communityRating) {
            dispatch({ type: 'rateDrama', dramaId: drama.id, rating: res.communityRating });
          }
        }
        toast.show({
          message: `Rated ${drama.title} ★ ${score}/10`,
          icon: 'star',
          tone: 'success',
        });
      } catch {
        toast.show({ message: 'Saved locally — sign in to sync community score' });
      }
    });
  };
  const hero = heroInterpolations(scrollY, heroH, heroH + 8);
  const editorial = drama.title.length <= 22;

  const header = (
    <View>
      {/* Poster-lit surface: the drama's own tone washes the hero block and the title area beneath it. */}
      <View pointerEvents="none" style={[styles.wash, { height: heroH + 220, backgroundColor: withAlpha(drama.tone, 0.55) }]} />
      <View
        pointerEvents="none"
        style={[
          styles.wash,
          {
            top: heroH + 220,
            height: 100,
            backgroundColor: withAlpha(drama.tone, 0.22),
          },
        ]}
      />
      <Animated.View
        style={{
          height: heroH,
          overflow: 'hidden',
          opacity: hero.heroFade,
          transform: [{ translateY: hero.parallax }, { scale: hero.stretch }, { scale: heroSettle }],
        }}
      >
        <Backdrop
          uri={drama.backdropUrl ?? drama.posterUrl ?? drama.posterLocal}
          fallbackColor={drama.tone}
          width="100%"
          height={heroH}
          cinemaGradient
          accentGlow={withAlpha(drama.tone, 0.72)}
          label={`${drama.title} backdrop`}
        />
      </Animated.View>
      <View style={styles.headRow}>
        <Animated.View style={arrivePoster}>
          <Poster drama={drama} width={sizes.poster.m} style={[{ marginTop: -56 }, styles.posterEdge]} />
        </Animated.View>
        <Animated.View style={[{ flex: 1, gap: 2 }, arriveTitle]}>
          <Text variant={editorial ? 'display' : 'headline'} numberOfLines={3} accessibilityRole="header" style={editorial ? styles.editorialTitle : styles.headlineTitle}>
            {drama.title}
          </Text>
          {drama.originalTitle ? (
            <Text variant="bodySmall" tone="secondary" style={{ marginTop: 2 }}>
              {drama.originalTitle}
            </Text>
          ) : null}
          <Text variant="caption" tone="secondary">
            {drama.year}
            {drama.endYear && drama.endYear !== drama.year ? `–${drama.endYear}` : ''}
            {drama.network ? ` · ${drama.network}` : ''}
            {film ? ` · ${runtimeLabel(drama.runtime) ?? 'Film'}` : ` · ${drama.episodeCount} ep${drama.episodeCount === 1 ? '' : 's'}`}
            {drama.status === 'airing' ? ' · Airing' : drama.status === 'upcoming' ? ' · Upcoming' : ''}
          </Text>
          <Text variant="caption" tone="secondary">
            {drama.title} fandom · {compact(drama.followerCount + (following ? 1 : 0))} fans
            {talking ? ` · ${compact(talking)} talking this week` : ''}
            {drama.rating ? ` · ★ ${drama.rating.toFixed(1)}` : ''}
          </Text>
        </Animated.View>
      </View>
      <Animated.View style={arriveChips}>
        <ChipRow style={{ paddingHorizontal: space.margin, marginTop: space.x3 }}>
          <Chip label={`${world.flag} ${world.short}`} size="sm" tone="accent" onPress={() => router.push(`/world/${world.id}`)} />
          {drama.genres.slice(0, 4).map((g) => (
            <Chip key={g} label={g} size="sm" onPress={() => router.push(`/genre/${encodeURIComponent(g)}`)} />
          ))}
        </ChipRow>
      </Animated.View>
      <Animated.View style={[styles.actions, arriveActions]}>
        <FollowButton kind="dramas" id={drama.id} name={drama.title} style={{ flex: 1 }} />
        <WatchStatusButton drama={drama} style={{ flex: 1.4 }} />
        {drama.trailerUrl ? <IconButton icon="play-circle-outline" label="Watch trailer" filled onPress={openTrailer} /> : null}
        {hallyuPlayable ? <IconButton icon="play" label="Play on Hallyu" filled onPress={() => router.push(`/post/${hallyuPlayable.id}`)} /> : null}
        <IconButton icon="albums-outline" label="Add to collection" filled onPress={() => require('save to a collection', () => setCollect(true))} />
        {following ? (
          <IconButton
            icon={notify ? 'notifications' : 'notifications-off-outline'}
            label={notify ? 'Episode alerts on' : 'Episode alerts off'}
            filled
            onPress={() => {
              dispatch({ type: 'dramaNotify', id: drama.id, on: !notify });
              toast.show({
                message: notify ? 'Episode alerts off for this drama' : 'You’ll hear when an episode airs',
              });
            }}
          />
        ) : null}
      </Animated.View>

      {liveEp || (next && drama.status !== 'completed') ? (
        <Pressable
          onPress={() => router.push(`/episode/${drama.id}/${(liveEp ?? next)!.season}/${(liveEp ?? next)!.number}`)}
          style={[styles.airing, liveEp ? { backgroundColor: colors.accentSoft } : null]}
          accessibilityRole="button"
        >
          <View style={[styles.dot, { backgroundColor: liveEp ? colors.live : colors.textTertiary }]} />
          <Text variant="label" style={{ flex: 1 }}>
            {liveEp
              ? `Episode ${liveEp.number} just aired — the room is live`
              : `Next: Episode ${next!.number}${next!.airDate ? ` · ${dayLabel(next!.airDate)} ${timeOfDay(next!.airDate)} · ${countdown(next!.airDate)}` : ''}`}
          </Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
        </Pressable>
      ) : null}
    </View>
  );

  const tabsBar = (
    <View style={styles.tabsBar}>
      <Segmented
        scrollable
        items={[
          ...(twoPane ? [] : [{ key: 'overview' as Tab, label: 'Overview' }]),
          ...(film
            ? []
            : [
                {
                  key: 'episodes' as Tab,
                  label: 'Episodes',
                  count: drama.episodes.length || undefined,
                },
              ]),
          {
            key: 'community',
            label: 'Community',
            count: posts.length || undefined,
          },
          { key: 'cast', label: 'Cast' },
        ]}
        value={tab}
        onChange={(t) => {
          setTab(t);
          if (t === 'community' && params.tab === 'activity') setSort('latest');
        }}
      />
    </View>
  );

  const details: { label: string; value: string }[] = [
    ...(drama.streamingOn?.length ? [{ label: 'Watch on', value: drama.streamingOn.join(', ') }] : []),
    ...(drama.airsOn ? [{ label: 'Airs', value: drama.airsOn }] : []),
    ...(drama.network ? [{ label: 'Network', value: drama.network }] : []),
    ...(drama.creators?.length ? [{ label: 'Written / directed', value: drama.creators.join(', ') }] : []),
    ...(drama.tags?.length ? [{ label: 'Tags', value: drama.tags.join(' · ') }] : []),
  ];
  const moreSummary = [meterTotal ? 'Reaction meter' : null, details.length ? 'Details' : null, stills.length ? 'Stills' : null, shorts.length ? 'Shorts' : null, publicCols.length ? 'Shelves' : null].filter(Boolean).join(' · ');

  // Overview answers three things in under a second: what is it, where am I, who's in it.
  // Everything else waits behind one calm row.
  const overview = (
    <View>
      <View style={styles.section}>
        <Pressable onPress={() => setSynopsisOpen((v) => !v)} accessibilityRole="button" accessibilityLabel={synopsisOpen ? 'Collapse synopsis' : 'Expand synopsis'} accessibilityState={{ expanded: synopsisOpen }}>
          <Text variant="body" numberOfLines={synopsisOpen ? undefined : 3} style={{ maxWidth: 640 }}>
            {drama.synopsis}
          </Text>
          {drama.synopsis.length > 160 ? (
            <Text variant="label" tone="accent" style={{ marginTop: 6 }}>
              {synopsisOpen ? 'Less' : 'More'}
            </Text>
          ) : null}
        </Pressable>
        {(drama.streamingOn?.length || drama.trailerUrl) ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.x2, marginTop: space.x3 }}>
            {drama.trailerUrl ? (
              <Pressable onPress={openTrailer} style={styles.trailerPill} accessibilityRole="button" accessibilityLabel={`Watch ${drama.title} trailer`}>
                <Ionicons name="play" size={13} color={colors.accentText} />
                <Text variant="label" tone="accent">
                  Watch trailer
                </Text>
              </Pressable>
            ) : null}
            {drama.streamingOn?.map((providerName) => {
              const low = providerName.toLowerCase();
              const official = officialWatchLink(providerName, drama.title);
              const brandDot = low.includes('netflix')
                ? '#E50914'
                : low.includes('crunchyroll')
                  ? '#F47521'
                  : low.includes('viki')
                    ? '#1C9BF0'
                    : low.includes('disney')
                      ? '#2563EB'
                      : low.includes('iqiyi')
                        ? '#10B981'
                        : low.includes('prime')
                          ? '#00A8E1'
                          : colors.textSecondary;
              const pillBody = (
                  <>
                    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: brandDot }} />
                    <Text variant="caption" style={{ color: colors.textPrimary }}>
                      {providerName}
                    </Text>
                    {official ? <Ionicons name="open-outline" size={12} color={colors.textSecondary} /> : null}
                  </>
                );
                if (!official) {
                  return (
                    <View key={providerName} style={[styles.streamPill, { borderColor: `${brandDot}55` }]}>
                      {pillBody}
                    </View>
                  );
                }
                return (
                  <Pressable
                    key={providerName}
                    onPress={() => Linking.openURL(official.url).catch(() => toast.show({ message: `Could not open ${official.label}` }))}
                    accessibilityRole="link"
                    accessibilityHint={official.hint}
                    accessibilityLabel={`Open ${official.label} to watch ${drama.title}`}
                    style={[styles.streamPill, { borderColor: `${brandDot}55` }]}
                  >
                    {pillBody}
                  </Pressable>
                );
            })}
          </View>
        ) : null}

        {/* Instant 1–10 Community Score Strip */}
        <View style={styles.quickRateCard}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="star" size={14} color={colors.warm} />
              <Text variant="label">
                {myScore ? `Your score: ${myScore.toFixed(1)}/10` : 'Rate this title'}
              </Text>
            </View>
            <Text variant="caption" tone="secondary">
              {drama.rating ? `Community ★ ${drama.rating.toFixed(1)}` : 'Be the first to score'}
              {ratingCount > 0 ? ` (${ratingCount})` : ''}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: space.x2 }}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => {
              const active = myScore != null && Math.round(myScore) >= n;
              return (
                <Pressable
                  key={n}
                  onPress={() => void submitQuickRating(n)}
                  hitSlop={4}
                  accessibilityRole="button"
                  accessibilityLabel={`Rate ${n} out of 10`}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: active ? colors.warmSoft : colors.surface2,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: active ? colors.warm : colors.borderSubtle,
                  }}
                >
                  <Text variant="caption" style={{ color: active ? colors.warm : colors.textSecondary, fontWeight: '700' }}>
                    {n}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
      {!film ? (
        <View style={styles.progressCard}>
          <Pressable
            onPress={() => setTab('episodes')}
            style={{ flex: 1 }}
            accessibilityRole="button"
            accessibilityLabel={`Your progress: episode ${item?.currentEpisode ?? 0} of ${total}. Opens episodes`}
          >
            <Text variant="titleSmall">
              {item ? 'Your episode progress' : 'Track episode progress'}
            </Text>
            <Text variant="caption" tone="secondary">
              Ep {item?.currentEpisode ?? 0} of {total || '?'}
              {multi ? ` · Season ${item?.season ?? season}` : ''}
              {item && item.currentEpisode >= total && total > 0 ? ' · Completed 🎉' : ''}
            </Text>
            <ProgressBar value={item?.currentEpisode ?? 0} max={Math.max(1, total)} style={{ marginTop: space.x2 }} />
          </Pressable>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
            {(item?.currentEpisode ?? 0) > 0 ? (
              <IconButton
                icon="remove"
                label="Previous episode"
                size={18}
                filled
                onPress={() =>
                  require('track progress', () => {
                    haptic.light();
                    dispatch({
                      type: 'progress',
                      dramaId: drama.id,
                      season: item?.season ?? season,
                      episode: Math.max(0, (item?.currentEpisode ?? 1) - 1),
                      total: Math.max(1, total),
                    });
                  })
                }
              />
            ) : null}
            <Button
              label={`+1 Ep`}
              size="sm"
              onPress={() =>
                require('track progress', () => {
                  const nextEp = Math.min(Math.max(1, total), (item?.currentEpisode ?? 0) + 1);
                  haptic.success();
                  dispatch({
                    type: 'progress',
                    dramaId: drama.id,
                    season: item?.season ?? season,
                    episode: nextEp,
                    total: Math.max(1, total),
                  });
                  toast.show({
                    message: `Watched Ep ${nextEp} · Enter Live Watch Room?`,
                    icon: 'checkmark-circle',
                    tone: 'success',
                    actionLabel: 'Room',
                    onAction: () => router.push(`/episode/${drama.id}/${item?.season ?? season}/${nextEp}`),
                  });
                })
              }
            />
          </View>
        </View>
      ) : null}
      {drama.cast.length ? (
        <View style={{ paddingTop: space.x5, paddingBottom: space.x2 }}>
          <SectionHeader eyebrow="Cast" title="Who’s in it" onAction={() => setTab('cast')} />
          <ActorRail
            actors={drama.cast.map((c) => getActor(c.actorId)).filter(Boolean) as NonNullable<ReturnType<typeof getActor>>[]}
            roles={Object.fromEntries(drama.cast.map((c) => [c.actorId, c.role]))}
          />
        </View>
      ) : null}
      {posts.length ? (
        <View style={{ paddingTop: space.x4 }}>
          <SectionHeader eyebrow="Community" title="Top conversations" onAction={() => setTab('community')} />
          {posts
            .filter((p) => p.type === 'discussion' || p.type === 'review')
            .slice(0, 2)
            .map((p) => (
              <PostCard key={p.id} post={p} hideContext />
            ))}
        </View>
      ) : null}

      {moreSummary || item?.note ? (
        <Disclosure title={`More about ${drama.title}`} summary={moreSummary || 'Your note'} style={{ marginTop: space.x4 }}>
          {item?.note ? (
            <View style={[styles.section, { paddingBottom: 0 }]}>
              <Text variant="overline" style={{ marginBottom: 4 }}>
                Your private note
              </Text>
              <Text variant="bodySmall" tone="secondary">
                {item.note}
              </Text>
            </View>
          ) : null}
          {meterTotal ? (
            <View style={styles.section}>
              <SectionHeader eyebrow="Reaction meter" title="How the fandom feels" style={{ paddingHorizontal: 0 }} />
              <ReactionMeter counts={meter} />
            </View>
          ) : null}
          {details.length ? (
            <View style={[styles.section, { paddingTop: meterTotal ? 0 : space.x4 }]}>
              {details.map((d) => (
                <KeyValue key={d.label} label={d.label} value={d.value} />
              ))}
            </View>
          ) : null}
          {stills.length ? (
            <View style={styles.moduleRail}>
              <SectionHeader eyebrow="Media" title="Stills & art" />
              <FlatList
                horizontal
                data={stills}
                keyExtractor={(m) => m.uri}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{
                  paddingHorizontal: space.margin,
                  gap: space.gutter,
                }}
                renderItem={({ item: m }) => (
                  <Pressable
                    onPress={() =>
                      router.push({
                        pathname: '/media',
                        params: { uri: m.uri, title: m.title },
                      })
                    }
                    accessibilityRole="imagebutton"
                    accessibilityLabel={m.title}
                  >
                    <Backdrop
                      uri={m.uri}
                      fallbackColor={drama.tone}
                      width={m.kind === 'poster' ? Math.round((stillH * 2) / 3) : Math.round((stillH * 16) / 9)}
                      height={stillH}
                      style={{ borderRadius: radius.sm, overflow: 'hidden' }}
                    />
                  </Pressable>
                )}
              />
            </View>
          ) : null}
          {shorts.length ? (
            <View style={{ paddingVertical: space.x4 }}>
              <SectionHeader
                eyebrow="Shorts"
                title={`${drama.title} in sixty seconds`}
                onAction={() =>
                  router.push({
                    pathname: '/shorts',
                    params: { id: shorts[0]!.id, dramaId: drama.id },
                  })
                }
              />
              <ShortsRail posts={shorts} />
            </View>
          ) : null}
          {publicCols.length ? (
            <View style={{ paddingVertical: space.x4 }}>
              <SectionHeader eyebrow="Collections" title="Shelves it’s on" />
              <FlatList
                horizontal
                data={publicCols}
                keyExtractor={(c) => c.id}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{
                  paddingHorizontal: space.margin,
                  gap: space.gutter,
                }}
                renderItem={({ item: c }) => <CollectionCard collection={c} />}
              />
            </View>
          ) : null}
          {inCollections.length ? (
            <Text variant="caption" tone="secondary" style={{ paddingHorizontal: space.margin, paddingBottom: space.x4 }}>
              In your collections: {inCollections.map((c) => c.title).join(', ')}
            </Text>
          ) : null}
        </Disclosure>
      ) : null}

      {related.length ? (
        <View style={{ paddingVertical: space.x5 }}>
          <SectionHeader eyebrow="If you liked this" title="Related dramas" />
          <DramaRail dramas={related} size="m" />
        </View>
      ) : null}
    </View>
  );

  const sub = (
    <View>
      {tab === 'community' ? (
        <View>
          <ChipRow
            style={{
              paddingHorizontal: space.margin,
              paddingVertical: space.x3,
            }}
          >
            {(['all', 'discussion', 'review', 'reaction', 'recommendation', 'post'] as Filter[]).map((f) => (
              <Chip key={f} label={f === 'all' ? 'All' : f === 'post' ? 'Posts' : f[0]!.toUpperCase() + f.slice(1) + 's'} size="sm" selected={filter === f} onPress={() => setFilter(f)} />
            ))}
          </ChipRow>
          <View style={styles.sortRow}>
            <Text variant="caption" tone="secondary" style={{ flex: 1 }} numberOfLines={1}>
              {filtered.length} {filtered.length === 1 ? 'post' : 'posts'}
              {veiledCount && !safe ? ` · ${veiledCount} veiled for you` : safe && veiledCount ? ` · ${veiledCount} hidden` : ''}
            </Text>
            {veiledCount ? (
              <Pressable
                onPress={() => {
                  haptic.select();
                  setSafe((v) => !v);
                }}
                accessibilityRole="switch"
                accessibilityState={{ checked: safe }}
                accessibilityLabel="Safe for me: hide posts that would be veiled"
                style={[styles.safeToggle, safe ? styles.safeOn : null]}
              >
                <Ionicons name={safe ? 'eye-off' : 'eye-off-outline'} size={13} color={safe ? colors.accentText : colors.textSecondary} />
                <Text variant="label" tone={safe ? 'accent' : 'secondary'}>
                  Safe for me
                </Text>
              </Pressable>
            ) : null}
            <Pressable onPress={() => setSort((s) => (s === 'top' ? 'latest' : 'top'))} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Ionicons name="swap-vertical" size={14} color={colors.textSecondary} />
              <Text variant="label" tone="secondary">
                {sort === 'top' ? 'Top' : 'Latest'}
              </Text>
            </Pressable>
          </View>
          {enrich.showSkeleton ? <PostSkeleton /> : null}
        </View>
      ) : null}

      {tab === 'episodes' ? (
        <View>
          {multi ? (
            <ChipRow
              style={{
                paddingHorizontal: space.margin,
                paddingVertical: space.x3,
              }}
            >
              {drama.seasons.map((s) => (
                <EpisodeChip
                  key={s.number}
                  label={`Season ${s.number}`}
                  selected={season === s.number}
                  onPress={() => setSeason(s.number)}
                  live={drama.episodes.some((e) => e.season === s.number && episodeState(e) === 'live')}
                />
              ))}
            </ChipRow>
          ) : null}
          <View style={styles.sortRow}>
            <Text variant="caption" tone="secondary">
              {eps.length ? `${eps.length} episodes${item ? ` · ${item.season === season ? item.currentEpisode : 0} watched` : ''}` : enrich.loading ? 'Loading episodes…' : 'Episode list not available yet'}
              {runtimeNote ? `\n${runtimeNote}` : ''}
            </Text>
            {item && eps.length ? (
              <Button
                label="Mark all watched"
                variant="ghost"
                size="sm"
                onPress={() => {
                  dispatch({
                    type: 'progress',
                    dramaId: drama.id,
                    season,
                    episode: eps.length,
                    total: eps.length,
                  });
                  toast.show({
                    message: `All ${eps.length} episodes marked watched`,
                  });
                }}
              />
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );

  type Row =
    | { key: string; k: 'tabs' }
    | { key: string; k: 'sub' }
    | { key: string; k: 'overview' }
    | { key: string; k: 'ep'; e: Episode }
    | { key: string; k: 'cast'; c: CastCredit }
    | { key: string; k: 'post'; p: Post }
    | { key: string; k: 'empty' }
    | { key: string; k: 'footer' };
  const rows: Row[] = [{ key: 'tabs', k: 'tabs' }];
  if (tab === 'overview') rows.push({ key: 'overview', k: 'overview' });
  else {
    rows.push({ key: 'sub', k: 'sub' });
    if (tab === 'episodes') eps.forEach((e) => rows.push({ key: e.id, k: 'ep', e }));
    if (tab === 'cast') drama.cast.filter((c) => !!getActor(c.actorId)).forEach((c) => rows.push({ key: c.actorId, k: 'cast', c }));
    if (tab === 'community') filtered.forEach((p) => rows.push({ key: p.id, k: 'post', p }));
    if (rows.length === 2) rows.push({ key: 'empty', k: 'empty' });
    else if (tab === 'community') rows.push({ key: 'footer', k: 'footer' });
  }
  const renderRow = ({ item: row }: { item: Row }) => {
    switch (row.k) {
      case 'tabs':
        return tabsBar;
      case 'sub':
        return sub;
      case 'overview':
        return overview;
      case 'ep':
        return <EpisodeCard drama={drama} episode={row.e} postCount={posts.filter((p) => p.context.season === row.e.season && p.context.episode === row.e.number).length} />;
      case 'cast': {
        const a = getActor(row.c.actorId);
        return a ? <ActorCard actor={a} role={row.c.role} layout="row" style={{ paddingHorizontal: space.margin }} right={<FollowButton kind="actors" id={a.id} name={a.name} />} /> : null;
      }
      case 'post':
        return <PostCard post={row.p} hideContext />;
      case 'empty':
        return tab === 'episodes' ? (
          enrich.loading ? (
            <ListSkeleton rows={4} />
          ) : enrich.error ? (
            <ErrorState compact kind="network" title="Couldn’t load the episodes" body="The live catalogue didn’t answer. Everything else on this page is still here." onRetry={enrich.reload} />
          ) : (
            <EmptyState
              compact
              icon="film-outline"
              title="No episodes listed"
              body={drama.status === 'upcoming' ? 'The schedule lands closer to the premiere.' : 'We don’t have the episode list for this title yet.'}
            />
          )
        ) : tab === 'cast' ? (
          <EmptyState compact icon="people-outline" title="Cast not available" body="We’re missing the credits for this title." />
        ) : (
          <EmptyState
            compact
            icon="chatbubbles-outline"
            title={filter === 'all' ? 'Be the first voice' : `No ${filter}s yet`}
            body={`Nobody’s posted ${filter === 'all' ? 'about' : `a ${filter} for`} ${drama.title} yet. Your take could start the room.`}
            actionLabel="Post in this fandom"
            onAction={() => require('post', () => setCreate(true))}
          />
        );
      case 'footer':
        return (
          <View style={{ padding: space.margin }}>
            <Button label={`Post in the ${drama.title} fandom`} variant="secondary" block icon="create-outline" onPress={() => require('post', () => setCreate(true))} />
          </View>
        );
    }
  };

  return (
    <Screen
      header={
        <TopBar
          mode="stack"
          transparent
          title={drama.title}
          backgroundOpacity={hero.barOpacity}
          titleOpacity={hero.titleOpacity}
          titleRise={hero.titleRise}
          right={
            <>
              <IconButton icon="share-social-outline" label="Share" onPress={share} />
              <IconButton icon="ellipsis-horizontal" label="More" onPress={() => setMenu(true)} />
            </>
          }
        />
      }
    >
      {twoPane ? (
        <View style={styles.panes}>
          <Animated.ScrollView style={{ width: leftW }} onScroll={onScroll} scrollEventThrottle={16} contentContainerStyle={padding} showsVerticalScrollIndicator={false}>
            {header}
            {overview}
          </Animated.ScrollView>
          <View style={styles.paneRule} />
          <FeedAutoplay<Row> getVideoId={(r) => (r.k === 'post' && r.p.video ? r.p.id : null)}>
            {(vp) => (
              <FlatList
                data={rows}
                keyExtractor={(r) => r.key}
                renderItem={renderRow}
                onViewableItemsChanged={vp.onViewableItemsChanged}
                viewabilityConfig={vp.viewabilityConfig}
                refreshControl={refresh.control}
                stickyHeaderIndices={[0]}
                contentContainerStyle={[padding, { paddingTop: insets.top + sizes.topBar }]}
                style={{ flex: 1 }}
                initialNumToRender={8}
                windowSize={7}
              />
            )}
          </FeedAutoplay>
        </View>
      ) : (
        <FeedAutoplay<Row> getVideoId={(r) => (r.k === 'post' && r.p.video ? r.p.id : null)}>
          {(vp) => (
            <Animated.FlatList
              data={rows}
              keyExtractor={(r) => r.key}
              renderItem={renderRow}
              onScroll={onScroll}
              scrollEventThrottle={16}
              onViewableItemsChanged={vp.onViewableItemsChanged}
              viewabilityConfig={vp.viewabilityConfig}
              refreshControl={refresh.control}
              ListHeaderComponent={header}
              stickyHeaderIndices={[1]}
              contentContainerStyle={[padding, column]}
              initialNumToRender={8}
              windowSize={7}
            />
          )}
        </FeedAutoplay>
      )}

      <Sheet visible={menu} onClose={() => setMenu(false)} title={drama.title}>
        {drama.trailerUrl ? (
          <SheetRow
            icon="play-circle-outline"
            label="Watch trailer"
            onPress={() => {
              setMenu(false);
              openTrailer();
            }}
          />
        ) : null}
        <SheetRow
          icon="share-social-outline"
          label="Share"
          onPress={() => {
            setMenu(false);
            share();
          }}
        />
        <SheetRow
          icon="albums-outline"
          label="Add to collection"
          onPress={() => {
            setMenu(false);
            require('save to a collection', () => setCollect(true));
          }}
        />
        <SheetRow
          icon="create-outline"
          label="Post about this drama"
          onPress={() => {
            setMenu(false);
            require('post', () => setCreate(true));
          }}
        />
        <SheetRow
          icon={state.mutedDramas.includes(drama.id) ? 'volume-high-outline' : 'volume-mute-outline'}
          label={state.mutedDramas.includes(drama.id) ? 'Unmute this drama' : 'Mute this drama in feeds'}
          onPress={() => {
            setMenu(false);
            dispatch({
              type: 'muteDrama',
              dramaId: drama.id,
              on: !state.mutedDramas.includes(drama.id),
            });
            toast.show({
              message: state.mutedDramas.includes(drama.id) ? `${drama.title} unmuted` : `Muted. ${drama.title} won’t appear in your feeds.`,
            });
          }}
        />
        <SheetRow
          icon="flag-outline"
          label="Report a problem with this page"
          tone="danger"
          onPress={() => {
            setMenu(false);
            router.push({
              pathname: '/report',
              params: { targetId: drama.id, kind: 'drama' },
            });
          }}
        />
      </Sheet>
      <AddToCollectionSheet dramaId={drama.id} visible={collect} onClose={() => setCollect(false)} />
      <CoachMarks
        id="hub"
        when={(twoPane || tab === 'overview') && !menu && !collect && !create}
        delay={1200}
        steps={[
          { icon: 'shield-checkmark-outline', title: 'Track it, and we protect you', body: 'Set Watching and tell us your episode. Anything past that point is veiled until you catch up.' },
          { icon: 'chatbubbles-outline', title: 'Every episode has a room', body: 'Reactions, theories and the meter live per episode — open the Episodes tab and pick one.' },
        ]}
      />
      <CreateSheet
        visible={create}
        onClose={() => setCreate(false)}
        context={{
          dramaId: drama.id,
          season: item?.season,
          episode: item?.currentEpisode || undefined,
        }}
      />
      <ShareCardModal visible={shareOpen} onClose={() => setShareOpen(false)} drama={drama} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  panes: { flex: 1, flexDirection: 'row' },
  paneRule: { width: StyleSheet.hairlineWidth, backgroundColor: colors.borderSubtle },
  quickRateCard: {
    marginTop: space.x4,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  tabsBar: {
    backgroundColor: colors.canvas,
    paddingTop: space.x4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  moduleRail: { paddingVertical: space.x4 },
  heroScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10,10,10,0.35)',
  },
  wash: { position: 'absolute', top: 0, left: 0, right: 0 },
  posterEdge: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  editorialTitle: { letterSpacing: -0.8 },
  headlineTitle: { letterSpacing: -0.4 },
  headRow: {
    flexDirection: 'row',
    gap: space.x4,
    paddingHorizontal: space.margin,
    alignItems: 'flex-end',
  },
  /** Glass action dock (spec: floating glass dock): glass fill, 1px glass border, shadow-2. */
  actions: {
    flexDirection: 'row',
    gap: space.x2,
    marginHorizontal: space.margin,
    marginTop: space.x4,
    alignItems: 'center',
    paddingHorizontal: space.x3,
    paddingVertical: space.x2,
    borderRadius: radius.full,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    ...shadows.float,
  },
  airing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    marginHorizontal: space.margin,
    marginTop: space.x3,
    paddingHorizontal: space.x3,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  section: { paddingHorizontal: space.margin, paddingVertical: space.x4 },
  trailerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 30,
    paddingHorizontal: 12,
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  streamPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 30,
    paddingHorizontal: 10,
    borderRadius: radius.full,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  progressCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    marginHorizontal: space.margin,
    padding: space.x4,
    backgroundColor: colors.surface1,
    borderRadius: radius.lg,
  },
  safeToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, height: 28, borderRadius: 14, borderWidth: 1, borderColor: colors.borderSubtle, marginRight: space.x2 },
  safeOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.margin,
    paddingVertical: space.x2,
    minHeight: 40,
  },
});
