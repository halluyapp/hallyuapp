import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Keyboard, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { CollectionCard } from '../components/collections/CollectionCard';
import { ActorCard } from '../components/drama/ActorCard';
import { DramaListRow } from '../components/drama/DramaCard';
import { PostCard } from '../components/feed/PostCard';
import { UserRow } from '../components/people/UserRow';
import { SearchField } from '../components/search/SearchField';
import { Button } from '../components/ui/Button';
import { Chip, ChipRow } from '../components/ui/Chip';
import { Screen, useListPadding } from '../components/ui/Screen';
import { Segmented } from '../components/ui/Segmented';
import { ListSkeleton } from '../components/ui/Skeleton';
import { EmptyState, InlineNotice } from '../components/ui/States';
import { MeganFallback } from '../components/search/MeganFallback';
import { VibeFinderSection } from '../components/search/VibeFinderSection';
import { Text } from '../components/ui/Text';
import { TopBar } from '../components/ui/TopBar';
import { colors, space } from '../constants/theme';
import { catalog } from '../lib/catalog';
import { adoptActors, adoptDramas } from '../lib/catalogSync';
import { discoverCatalogTitles, type CatalogFilterQuery } from '../lib/api/features';
import { FANDOMS } from '../lib/fandoms';
import { haptic, useApp, useDebounced, useLoad, useNetwork } from '../lib/hooks';
import { Actor, Drama, FandomId, GENRES } from '../lib/model';
import { searchLocal, trendingDramas, trendingHashtags } from '../lib/selectors';
import { track } from '../lib/analytics';

type Scope = 'all' | 'dramas' | 'actors' | 'people' | 'posts' | 'collections';

/**
 * Search — grouped results, one query. Local catalog answers instantly; the catalog provider (TMDB)
 * extends dramas/actors beyond what we hold locally. Hashtags land here in Posts scope.
 */
export default function Search() {
  const router = useRouter();
  const params = useLocalSearchParams<{ q?: string; scope?: Scope }>();
  const { state, dispatch } = useApp();
  const online = useNetwork();
  const padding = useListPadding();
  const inputRef = useRef<TextInput>(null);
  const [q, setQ] = useState(params.q ?? '');
  const [scope, setScope] = useState<Scope>(params.scope ?? (params.q?.startsWith('#') ? 'posts' : 'all'));
  const [fWorld, setFWorld] = useState<FandomId | null>(null);
  const [fProvider, setFProvider] = useState<string | null>(null);
  const [fStatus, setFStatus] = useState<'airing' | 'upcoming' | 'completed' | null>(null);
  const [fGenre, setFGenre] = useState<string | null>(null);
  const [fMinRating, setFMinRating] = useState<number | null>(null);
  const [fSort, setFSort] = useState<'relevance' | 'rating' | 'popular' | 'newest'>('relevance');

  const hasFilters = Boolean(fWorld || fProvider || fStatus || fGenre || fMinRating || fSort !== 'relevance');
  const filterLoad = useLoad(
    async () => {
      const query: CatalogFilterQuery = {
        world: fWorld,
        provider: fProvider,
        status: fStatus,
        genre: fGenre,
        minRating: fMinRating,
        sort: fSort,
        limit: 36,
      };
      const items = await discoverCatalogTitles(query, state.importedDramas);
      return adoptDramas(items);
    },
    [fWorld, fProvider, fStatus, fGenre, fMinRating, fSort],
    hasFilters,
  );
  const debounced = useDebounced(q.trim(), 250);
  const local = useMemo(() => searchLocal(state, debounced), [state, debounced]);
  const isTag = debounced.startsWith('#');

  const remote = useLoad(
    async (signal) => {
      const [rawDramas, rawActors] = await Promise.all([catalog.searchDramas(debounced, signal), catalog.searchActors(debounced, signal)]);
      const dramas = adoptDramas(rawDramas);
      const actors = adoptActors(rawActors);
      const knownIds = new Set(local.dramas.map((d) => d.id));
      const knownAIds = new Set(local.actors.map((a) => a.id));
      return { dramas: dramas.filter((d) => !knownIds.has(d.id)), actors: actors.filter((a) => !knownAIds.has(a.id)) };
    },
    [debounced],
    catalog.available && online && debounced.length >= 2 && !isTag && (scope === 'all' || scope === 'dramas' || scope === 'actors'),
  );

  useEffect(() => {
    if (params.q !== undefined) {
      setQ(params.q);
      if (params.scope) setScope(params.scope);
      else if (params.q.startsWith('#')) setScope('posts');
    } else if (params.scope) {
      setScope(params.scope);
    }
  }, [params.q, params.scope]);

  useEffect(() => {
    if (!params.q) setTimeout(() => inputRef.current?.focus(), 80);
  }, [params.q]);

  useEffect(() => {
    if (debounced.length >= 2) {
      dispatch({ type: 'recentSearch', q: debounced });
      track('search.query', { length: debounced.length, scope, tag: debounced.startsWith('#') });
    }
  }, [debounced, dispatch, scope]);

  const dramas: Drama[] = useMemo(() => {
    const seen = new Set<string>();
    return [...local.dramas, ...(remote.data?.dramas ?? [])].filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
  }, [local.dramas, remote.data?.dramas]);
  const actors: Actor[] = useMemo(() => {
    const seen = new Set<string>();
    return [...local.actors, ...(remote.data?.actors ?? [])].filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
  }, [local.actors, remote.data?.actors]);
  const total = dramas.length + actors.length + local.people.length + local.posts.length + local.collections.length + local.episodes.length;
  const openDrama = (d: Drama) => {
    const [adopted] = !state.importedDramas.some((x) => x.id === d.id) && d.provider ? adoptDramas([d]) : [d];
    router.push(`/drama/${(adopted ?? d).id}`);
  };

  const Group = ({ title, count, scopeKey, children }: { title: string; count: number; scopeKey: Scope; children: React.ReactNode }) =>
    count ? (
      <View style={styles.group}>
        <View style={styles.groupHead}>
          <Text variant="overline">
            {title} · {count}
          </Text>
          {scope === 'all' && count > 3 ? (
            <Pressable onPress={() => setScope(scopeKey)} hitSlop={8} accessibilityRole="button">
              <Text variant="label" tone="accent">
                See all
              </Text>
            </Pressable>
          ) : null}
        </View>
        {children}
      </View>
    ) : null;

  const limit = (n: number) => (scope === 'all' ? n : 50);

  const idle = !debounced;
  return (
    <Screen
      header={
        <TopBar
          mode="stack"
          center={<SearchField ref={inputRef} value={q} onChangeText={setQ} placeholder="Describe a mood, or search dramas, actors, #tags" style={{ flex: 1, height: 40 }} onSubmitEditing={() => Keyboard.dismiss()} />}
          right={<Button label="Cancel" variant="ghost" size="sm" onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/explore'))} />}
        />
      }
    >
      {!idle ? <Segmented scrollable items={[{ key: 'all', label: 'All' }, { key: 'dramas', label: 'Dramas' }, { key: 'actors', label: 'Actors' }, { key: 'people', label: 'People' }, { key: 'posts', label: 'Posts' }, { key: 'collections', label: 'Collections' }]} value={scope} onChange={setScope} /> : null}

      {idle ? (
        <ScrollView contentContainerStyle={padding} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          {/* Vibe Finder entry: describe a mood in a sentence. Examples fill the box and show results. */}
          <View style={styles.group}>
            <Text variant="overline" tone="accent">
              VIBE FINDER
            </Text>
            <Text variant="body" tone="secondary" style={{ marginTop: space.x1 }}>
              Describe the drama you’re in the mood for, in a sentence. Hallyu reads it with filters on this device (no AI model is connected yet).
            </Text>
            <ChipRow style={{ marginTop: space.x2 }}>
              {[
                'A dark historical K-Drama with political intrigue and revenge',
                'A completed C-Drama with a powerful female lead',
                'Something funny and comforting after a stressful day',
                'Anime with clever battles and little romance',
                'A short series with a satisfying ending',
              ].map((example) => (
                <Chip key={example} label={example} onPress={() => { haptic.select(); setQ(example); }} />
              ))}
            </ChipRow>
          </View>
          {/* Multi-Filter Catalog Discovery + Tonight's Pick */}
          <View style={styles.group}>
            <View style={styles.groupHead}>
              <Text variant="overline" tone="accent">
                MULTI-FILTER CATALOG BROWSER
              </Text>
              {hasFilters ? (
                <Pressable
                  onPress={() => {
                    haptic.select();
                    setFWorld(null);
                    setFProvider(null);
                    setFStatus(null);
                    setFGenre(null);
                    setFMinRating(null);
                    setFSort('relevance');
                  }}
                  hitSlop={8}
                  accessibilityRole="button"
                >
                  <Text variant="label" tone="accent">
                    Reset filters
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={async () => {
                    haptic.medium();
                    const pick = await discoverCatalogTitles(
                      { world: fWorld, genre: fGenre, provider: fProvider, minRating: 7.2, sort: 'random', limit: 1 },
                      state.importedDramas,
                    );
                    if (pick[0]) openDrama(pick[0]);
                  }}
                  hitSlop={8}
                  accessibilityRole="button"
                >
                  <Text variant="label" tone="accent">
                    ✨ Surprise me
                  </Text>
                </Pressable>
              )}
            </View>

            {/* World Filter */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.x2, marginBottom: space.x2 }}>
              <Chip label="All Worlds" size="sm" selected={!fWorld} onPress={() => setFWorld(null)} />
              {FANDOMS.map((w) => (
                <Chip
                  key={w.id}
                  label={`${w.flag} ${w.short}`}
                  size="sm"
                  selected={fWorld === w.id}
                  onPress={() => {
                    haptic.select();
                    setFWorld(fWorld === w.id ? null : w.id);
                  }}
                />
              ))}
            </ScrollView>

            {/* Platform + Status + Score + Sort */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.x2, marginBottom: space.x2 }}>
              {(['airing', 'upcoming', 'completed'] as const).map((st) => (
                <Chip
                  key={st}
                  label={st === 'airing' ? '● Airing' : st === 'upcoming' ? 'Upcoming' : 'Completed'}
                  size="sm"
                  selected={fStatus === st}
                  onPress={() => {
                    haptic.select();
                    setFStatus(fStatus === st ? null : st);
                  }}
                />
              ))}
              {['Netflix', 'Viki', 'Crunchyroll', 'Disney+', 'Prime Video', 'iQIYI'].map((prov) => (
                <Chip
                  key={prov}
                  label={prov}
                  size="sm"
                  selected={fProvider === prov}
                  onPress={() => {
                    haptic.select();
                    setFProvider(fProvider === prov ? null : prov);
                  }}
                />
              ))}
              {[7.5, 8.2].map((sc) => (
                <Chip
                  key={sc}
                  label={`★ ${sc}+`}
                  size="sm"
                  selected={fMinRating === sc}
                  onPress={() => {
                    haptic.select();
                    setFMinRating(fMinRating === sc ? null : sc);
                  }}
                />
              ))}
              {([
                { key: 'rating', label: 'Top Rated' },
                { key: 'popular', label: 'Most Popular' },
                { key: 'newest', label: 'Newest' },
              ] as const).map((s) => (
                <Chip
                  key={s.key}
                  label={s.label}
                  size="sm"
                  selected={fSort === s.key}
                  onPress={() => {
                    haptic.select();
                    setFSort(fSort === s.key ? 'relevance' : s.key);
                  }}
                />
              ))}
            </ScrollView>

            {/* Genre Filter */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.x2 }}>
              {GENRES.slice(0, 10).map((g) => (
                <Chip
                  key={g}
                  label={g}
                  size="sm"
                  selected={fGenre === g}
                  onPress={() => {
                    haptic.select();
                    setFGenre(fGenre === g ? null : g);
                  }}
                />
              ))}
            </ScrollView>

            {hasFilters ? (
              <View style={{ marginTop: space.x3 }}>
                <View style={styles.groupHead}>
                  <Text variant="overline">
                    MATCHING TITLES {filterLoad.data ? `· ${filterLoad.data.length}` : ''}
                  </Text>
                </View>
                {filterLoad.showSkeleton ? <ListSkeleton rows={4} /> : null}
                {(filterLoad.data ?? []).map((d) => (
                  <DramaListRow
                    key={d.id}
                    drama={d}
                    subtitle={`${d.year}${d.rating ? ` · ★ ${d.rating.toFixed(1)}` : ''}${d.network ? ` · ${d.network}` : ''} · ${d.genres.slice(0, 2).join(', ')}`}
                    onPress={() => openDrama(d)}
                  />
                ))}
                {!filterLoad.loading && (filterLoad.data?.length ?? 0) === 0 ? (
                  <Text variant="bodySmall" tone="secondary" style={{ paddingHorizontal: space.margin, paddingVertical: space.x3 }}>
                    No exact matches for that combination — tap a chip to widen your filter.
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>

          {state.recentSearches.length ? (
            <View style={styles.group}>
              <View style={styles.groupHead}>
                <Text variant="overline">Recent</Text>
                <Pressable onPress={() => dispatch({ type: 'recentSearch', clear: true })} hitSlop={8} accessibilityRole="button">
                  <Text variant="label" tone="secondary">
                    Clear
                  </Text>
                </Pressable>
              </View>
              {state.recentSearches.slice(0, 8).map((r) => (
                <Pressable key={r} onPress={() => setQ(r)} style={styles.recent} accessibilityRole="button" accessibilityLabel={`Search ${r}`}>
                  <Ionicons name="time-outline" size={18} color={colors.textTertiary} />
                  <Text variant="body" style={{ flex: 1 }}>
                    {r}
                  </Text>
                  <Ionicons name="arrow-up-outline" size={16} color={colors.textTertiary} style={{ transform: [{ rotate: '-45deg' }] }} />
                </Pressable>
              ))}
            </View>
          ) : null}
          <View style={styles.group}>
            <Text variant="overline" style={{ paddingHorizontal: space.margin, marginBottom: space.x2 }}>
              Trending tags
            </Text>
            <ChipRow style={{ paddingHorizontal: space.margin }}>
              {trendingHashtags(state, 12).map(({ tag: t }) => (
                <Chip key={t} label={`#${t}`} onPress={() => { setQ(`#${t}`); setScope('posts'); }} />
              ))}
            </ChipRow>
          </View>
          <View style={styles.group}>
            <Text variant="overline" style={{ paddingHorizontal: space.margin, marginBottom: space.x2 }}>
              Trending dramas
            </Text>
            {trendingDramas(state, 6).map((d) => (
              <DramaListRow key={d.id} drama={d} subtitle={`${d.year} · ${d.genres.slice(0, 2).join(', ')}`} />
            ))}
          </View>
          {!catalog.available ? (
            <View style={{ paddingHorizontal: space.margin }}>
              <InlineNotice tone="info" icon="information-circle-outline" text="Searching the local catalog across K-Dramas, C-Dramas, Anime & Hollywood." />
            </View>
          ) : null}
        </ScrollView>
      ) : (
        <FlatList
          data={[0]}
          keyExtractor={() => 'results'}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={padding}
          renderItem={() => (
            <View>
              {(scope === 'all' || scope === 'dramas') && !isTag ? <VibeFinderSection text={debounced} /> : null}
              {!online ? (
                <View style={{ paddingHorizontal: space.margin, marginTop: space.x3 }}>
                  <InlineNotice tone="warning" icon="cloud-offline-outline" text="You’re offline — showing what’s on this device." />
                </View>
              ) : null}
              {(scope === 'all' || scope === 'dramas') && (
                <Group title="Dramas" count={dramas.length} scopeKey="dramas">
                  {dramas.slice(0, limit(4)).map((d) => (
                    <DramaListRow key={d.id} drama={d} subtitle={`${d.year}${d.network ? ` · ${d.network}` : ''} · ${d.genres.slice(0, 2).join(', ')}`} badge={d.provider && !state.importedDramas.some((x) => x.id === d.id) ? 'TMDB' : undefined} onPress={() => openDrama(d)} />
                  ))}
                  {remote.showSkeleton ? <ListSkeleton rows={2} /> : null}
                </Group>
              )}
              {(scope === 'all' || scope === 'dramas') && local.episodes.length ? (
                <Group title="Episodes" count={local.episodes.length} scopeKey="dramas">
                  {local.episodes.slice(0, limit(3)).map(({ drama, episode }) => (
                    <DramaListRow key={episode.id} drama={drama} title={`${drama.title} · Ep ${episode.number}`} subtitle={episode.title ?? ''} onPress={() => router.push(`/episode/${drama.id}/${episode.season}/${episode.number}`)} />
                  ))}
                </Group>
              ) : null}
              {(scope === 'all' || scope === 'actors') && (
                <Group title="Actors" count={actors.length} scopeKey="actors">
                  {actors.slice(0, limit(4)).map((a) => (
                    <ActorCard key={a.id} actor={a} layout="row" role={a.knownFor.length ? `Known for ${a.knownFor.length} titles` : undefined} />
                  ))}
                  {remote.showSkeleton && !dramas.length ? <ListSkeleton rows={2} /> : null}
                </Group>
              )}
              {(scope === 'all' || scope === 'people') && (
                <Group title="People" count={local.people.length} scopeKey="people">
                  {local.people.slice(0, limit(4)).map((u) => (
                    <UserRow key={u.id} user={u} />
                  ))}
                </Group>
              )}
              {(scope === 'all' || scope === 'collections') && (
                <Group title="Collections" count={local.collections.length} scopeKey="collections">
                  <View style={{ paddingHorizontal: space.margin, gap: space.x3 }}>
                    {local.collections.slice(0, limit(3)).map((c) => (
                      <CollectionCard key={c.id} collection={c} layout="row" />
                    ))}
                  </View>
                </Group>
              )}
              {(scope === 'all' || scope === 'posts') && (
                <Group title={isTag ? `Posts tagged ${debounced}` : 'Posts'} count={local.posts.length} scopeKey="posts">
                  {local.posts.slice(0, limit(3)).map((p) => (
                    <PostCard key={p.id} post={p} />
                  ))}
                </Group>
              )}
              {remote.error && online ? (
                <View style={{ paddingHorizontal: space.margin, marginTop: space.x3, gap: space.x2 }}>
                  <InlineNotice tone="warning" icon="cloud-offline-outline" text="Couldn’t reach the wider catalog. Showing local results." />
                  <Button label="Retry" variant="ghost" size="sm" onPress={remote.reload} style={{ alignSelf: 'flex-start' }} />
                </View>
              ) : null}
              {!total && !remote.loading ? (
                <EmptyState icon="search-outline" title={`Nothing for “${debounced}”`} body={isTag ? 'No posts carry this tag yet. Be the first — tag it in a post.' : 'Check the spelling, try the original or English title, or search an actor’s name.'} actionLabel={isTag ? 'Post with this tag' : 'Browse Explore'} onAction={() => (isTag ? router.push({ pathname: '/create/post', params: { tag: debounced.slice(1) } }) : router.replace('/(tabs)/explore'))} />
              ) : null}
              {!total && !remote.loading && !isTag && debounced.length >= 2 ? <MeganFallback query={debounced} /> : null}
              {debounced.length === 1 ? (
                <Text variant="caption" tone="tertiary" style={{ paddingHorizontal: space.margin, marginTop: space.x3 }}>
                  Keep typing…
                </Text>
              ) : null}
            </View>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { marginTop: space.x5 },
  groupHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: space.margin, marginBottom: space.x2 },
  recent: { flexDirection: 'row', alignItems: 'center', gap: space.x3, paddingHorizontal: space.margin, height: 48 },
});
