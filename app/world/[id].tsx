import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { DramaRail } from '../../components/drama/DramaCard';
import { WorldTile } from '../../components/fandom/WorldTile';
import { PostCard } from '../../components/feed/PostCard';
import { useTabBarMotion } from '../../components/navigation/TabBarMotion';
import { Backdrop } from '../../components/ui/Poster';
import { useRefresh } from '../../components/ui/Refresh';
import { ScrollScreen, Screen } from '../../components/ui/Screen';
import { SectionHeader } from '../../components/ui/Section';
import { Segmented } from '../../components/ui/Segmented';
import { PosterRowSkeleton } from '../../components/ui/Skeleton';
import { InlineNotice } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { colors, radius, space } from '../../constants/theme';
import { catalog, friendlyCatalogCopy, invalidateCatalogLists } from '../../lib/catalog';
import { adoptDramas } from '../../lib/catalogSync';
import { FANDOMS, Fandom, fandomById, isFandomId } from '../../lib/fandoms';
import { useApp, useCatalogHealth, useLayout, useLoad } from '../../lib/hooks';
import { Drama } from '../../lib/model';
import { dramasInWorld, followsWorld, postsInWorld } from '../../lib/selectors';

type Sort = 'trending' | 'top' | 'new';

/**
 * A world on its own: K-Dramas, C-Dramas, Anime or Hollywood.
 *
 * The Hallyu default is ALL worlds mixed together — this page is what you get when you deliberately
 * narrow to one. It is also where the fandom chip on every card and every Content Hub leads, so a
 * member can always go from "one title" to "this whole world" in a tap.
 */
export default function WorldScreen() {
  const router = useRouter();
  const tabBar = useTabBarMotion();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state, dispatch } = useApp();
  const { width } = useLayout();
  const refresh = useRefresh('world');
  const health = useCatalogHealth();
  const [sort, setSort] = useState<Sort>('trending');

  const world: Fandom | undefined = isFandomId(id) ? fandomById(id) : undefined;
  const mine = world ? followsWorld(state, world.id) : false;

  const live = useLoad<Drama[]>(async (signal) => adoptDramas(await catalog.byFandom(world!.id, sort, 1, signal)), [world?.id, sort], !!world && catalog.available);
  const local = useMemo(() => (world ? dramasInWorld(state, world.id, 12) : []), [state, world]);
  const posts = useMemo(() => (world ? postsInWorld(state, world.id, 4) : []), [state, world]);

  useEffect(() => {
    if (!refresh.refreshing || !world) return;
    invalidateCatalogLists();
    live.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh.refreshing]);

  if (!world) {
    return (
      <Screen header={<TopBar mode="stack" title="World" />}>
        <View style={{ padding: space.margin }}>
          <Text variant="title">That isn’t a Hallyu world.</Text>
          <Text variant="body" tone="secondary" style={{ marginTop: space.x2 }}>
            Hallyu has four: {FANDOMS.map((f) => f.label).join(', ')}.
          </Text>
        </View>
      </Screen>
    );
  }

  const heroW = Math.min(width, 720);
  const heroH = Math.round(Math.min(260, heroW * 0.42));
  const lead = live.data?.[0];
  const toggleMine = () => {
    const current = state.profile.fandoms ?? [];
    const hasExplicit = current.includes(world.id);
    const next = hasExplicit ? current.filter((x) => x !== world.id) : [...new Set([...current, world.id])];
    dispatch({ type: 'profile', patch: { fandoms: next } });
    dispatch({ type: 'onboarding', patch: { fandoms: next } });
  };

  return (
    <Screen header={<TopBar mode="stack" title={world.label} />}>
      <ScrollScreen tabbed onScroll={tabBar.onScroll} scrollEventThrottle={16} refreshControl={refresh.control}>
        {/* Hero — the world's own identity, tinted by the world, not by the brand accent. */}
        <Pressable
          disabled={!lead}
          onPress={() => lead && router.push(`/drama/${lead.id}`)}
          accessibilityRole={lead ? 'button' : undefined}
          accessibilityLabel={lead ? `${world.label} featured: ${lead.title}` : undefined}
          style={[styles.hero, { width: heroW, height: heroH, backgroundColor: lead?.tone ?? colors.surface2 }]}
        >
          {lead ? <Backdrop uri={lead.backdropUrl ?? lead.posterUrl} fallbackColor={lead.tone} width={heroW} height={heroH} style={StyleSheet.absoluteFill} /> : null}
          <View style={styles.heroScrim} />
          <View style={{ padding: space.x4, gap: 4, justifyContent: 'flex-end', flex: 1 }}>
            <Text variant="overline" style={{ color: world.tint }}>
              {world.flag} {world.home}
            </Text>
            <Text variant="display" style={{ color: colors.onMedia }} accessibilityRole="header">
              {world.label}
            </Text>
            <Text variant="bodySmall" style={{ color: colors.textSecondary }}>
              {world.tagline}
            </Text>
          </View>
        </Pressable>

        <View style={{ paddingHorizontal: space.margin, marginTop: space.x4, gap: space.x3 }}>
          <Text variant="body" tone="secondary">
            {world.blurb}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x3, flexWrap: 'wrap' }}>
            {!mine ? (
              <Pressable onPress={toggleMine} style={[styles.add, { borderColor: world.tint }]} accessibilityRole="button" accessibilityLabel={`Add ${world.label} to my worlds`}>
                <Ionicons name="add-circle-outline" size={16} color={world.tint} />
                <Text variant="label" style={{ color: world.tint }}>
                  Add {world.short} to my worlds
                </Text>
              </Pressable>
            ) : (
              <Pressable onPress={toggleMine} style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2, alignSelf: 'flex-start' }} accessibilityRole="button" accessibilityLabel={`One of your worlds: ${world.label}`}>
                <Ionicons name="checkmark-circle" size={16} color={world.tint} />
                <Text variant="caption" tone="secondary">
                  One of your worlds
                </Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => router.push('/communities')}
              style={[styles.add, { borderColor: colors.borderStrong }]}
              accessibilityRole="button"
              accessibilityLabel={`${world.label} fandom rooms`}
            >
              <Ionicons name="people-outline" size={16} color={colors.textPrimary} />
              <Text variant="label">Fandom Rooms</Text>
            </Pressable>
          </View>
        </View>

        <View style={{ marginTop: space.x5 }}>
          <Segmented
            scrollable
            items={[
              { key: 'trending', label: 'Trending' },
              { key: 'top', label: 'Top rated' },
              { key: 'new', label: 'New' },
            ]}
            value={sort}
            onChange={(s) => setSort(s as Sort)}
          />
        </View>

        {!catalog.available ? (
          <InlineNotice tone="warning" icon="key-outline" text="The catalog isn’t configured in this build, so live titles can’t load." style={{ marginHorizontal: space.margin, marginTop: space.x5 }} />
        ) : live.error && !live.data ? (
          <Pressable onPress={live.reload} accessibilityRole="button" accessibilityLabel="Retry" style={{ marginHorizontal: space.margin, marginTop: space.x5 }}>
            <InlineNotice tone="warning" icon="cloud-offline-outline" text={`${friendlyCatalogCopy(health).title}. ${friendlyCatalogCopy(health).body}`} />
          </Pressable>
        ) : null}

        <View style={styles.section}>
          <SectionHeader eyebrow={`Live from ${world.home}`} title={sort === 'top' ? 'Highest rated' : sort === 'new' ? 'Just arrived' : 'What everyone is watching'} />
          {live.data?.length ? (
            <DramaRail dramas={live.data} size="l" />
          ) : live.loading ? (
            <PosterRowSkeleton count={4} width={140} />
          ) : (
            <Text variant="bodySmall" tone="tertiary" style={{ paddingHorizontal: space.margin }}>
              Nothing to show right now. Pull to refresh.
            </Text>
          )}
        </View>

        {local.length ? (
          <View style={styles.section}>
            <SectionHeader eyebrow="On your device" title="In your list" onAction={() => router.push('/watchlist')} actionLabel="Watchlist" />
            <DramaRail dramas={local} size="m" />
          </View>
        ) : null}

        {posts.length ? (
          <View style={styles.section}>
            <SectionHeader eyebrow="Community" title={`The ${world.short} room`} onAction={() => router.push('/trending')} actionLabel="More" />
            {posts.map((p) => (
              <PostCard key={p.id} post={p} />
            ))}
          </View>
        ) : null}

        <View style={styles.section}>
          <SectionHeader eyebrow="Other worlds" title="One community, four fandoms" />
          <FlatList
            horizontal
            data={FANDOMS.filter((f) => f.id !== world.id)}
            keyExtractor={(f) => f.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.gutter }}
            renderItem={({ item: f }) => <WorldTile world={f} count={dramasInWorld(state, f.id, 99).length} onPress={() => router.push(`/world/${f.id}`)} />}
          />
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

const styles = StyleSheet.create({
  hero: { alignSelf: 'center', overflow: 'hidden', justifyContent: 'flex-end' },
  heroScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(10,10,10,0.45)' },
  add: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: space.x2, height: 40, paddingHorizontal: space.x4, borderRadius: radius.full, borderWidth: 1 },
  section: { marginTop: space.section },
});
