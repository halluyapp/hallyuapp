import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, Share, StyleSheet, View } from 'react-native';
import { CreateSheet } from '../../components/create/CreateSheet';
import { ActorPortrait, ActorRail } from '../../components/drama/ActorCard';
import { DramaCard } from '../../components/drama/DramaCard';
import { FollowButton } from '../../components/drama/FollowButton';
import { PostCard } from '../../components/feed/PostCard';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { Screen, useListPadding } from '../../components/ui/Screen';
import { SectionHeader } from '../../components/ui/Section';
import { Segmented } from '../../components/ui/Segmented';
import { EmptyState, ErrorState } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { sizes, space } from '../../constants/theme';
import { compact, pluralize } from '../../lib/format';
import { catalog } from '../../lib/catalog';
import { useApp, useLayout, useLoad, useNetwork, useRequireMember } from '../../lib/hooks';
import { Drama } from '../../lib/model';
import { postsForActor, relatedActors } from '../../lib/selectors';
import { allDramas } from '../../lib/store';

type Tab = 'filmography' | 'community';

/** Actor page — filmography with your watch status on each title, and the actor’s fandom. */
export default function ActorPage() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state, getActor, isFollowing, watch, dispatch } = useApp();
  const require = useRequireMember();
  const { columns } = useLayout();
  const padding = useListPadding(false);
  const [tab, setTab] = useState<Tab>('filmography');
  const [create, setCreate] = useState(false);
  const [bioOpen, setBioOpen] = useState(false);
  const actor = getActor(id);
  const online = useNetwork();

  // Catalog enrichment: biography, headshot and the full filmography for anyone with a catalog id or resolvable name.
  const parsedTmdb = !actor && id ? /^tmdb-(\d+)$/.exec(id) : null;
  const thin = (!!actor && (!actor.photoUrl || !actor.bio || actor.knownFor.length < 4)) || !!parsedTmdb;
  const detail = useLoad(
    async (signal) => {
      if (actor?.provider) return catalog.getActor(actor.provider.id, signal);
      if (parsedTmdb) return catalog.getActor(Number(parsedTmdb[1]), signal);
      if (actor) {
        const resolved = await catalog.resolveActor(actor.name, actor.koreanName, signal);
        if (resolved?.provider) return catalog.getActor(resolved.provider.id, signal);
        if (resolved) return { actor: resolved, credits: resolved.knownForDramas ?? [] };
      }
      return null;
    },
    [actor?.id ?? id],
    thin && catalog.available && online,
  );
  useEffect(() => {
    if (!detail.data) return;
    const targetId = actor?.id ?? id;
    if (!targetId) return;
    const known = allDramas(state);
    const byProvider = new Map(known.filter((d) => d.provider).map((d) => [`${d.provider!.mediaType ?? d.mediaType ?? 'tv'}:${d.provider!.id}`, d]));
    const credits = detail.data.credits.map((c) => (c.provider ? byProvider.get(`${c.provider.mediaType ?? c.mediaType ?? 'tv'}:${c.provider.id}`) ?? c : c));
    const merged = {
      ...(actor ?? detail.data.actor),
      ...detail.data.actor,
      id: targetId,
      followerCount: Math.max(actor?.followerCount ?? 0, detail.data.actor.followerCount),
      knownFor: [...new Set([...(actor?.knownFor ?? []), ...credits.slice(0, 12).map((c) => c.id)])],
    };
    dispatch({ type: 'import', actors: [merged], dramas: credits.length ? credits : undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data]);

  const filmography = useMemo<Drama[]>(() => {
    if (!actor) return [];
    const all = allDramas(state);
    const byCast = all.filter((d) => d.cast.some((c) => c.actorId === actor.id));
    const byKnown = actor.knownFor.map((k) => all.find((d) => d.id === k)).filter(Boolean) as Drama[];
    return [...byCast, ...byKnown].filter((d, i, a) => a.findIndex((x) => x.id === d.id) === i).sort((a, b) => b.year - a.year);
  }, [actor, state]);
  const posts = useMemo(() => (actor ? postsForActor(state, actor.id) : []), [state, actor]);
  const related = useMemo(() => (actor ? relatedActors(state, actor, 8) : []), [state, actor]);

  if (!actor) {
    return (
      <Screen header={<TopBar mode="stack" title="Actor" />}>
        <ErrorState kind="notFound" title="This actor page isn’t available" body="We couldn’t find this person in the catalog." onRetry={() => router.back()} />
      </Screen>
    );
  }

  const following = isFollowing('actors', actor.id);
  const seen = filmography.filter((d) => watch(d.id)?.status === 'completed').length;
  const roleIn = (d: Drama) => d.cast.find((c) => c.actorId === actor.id)?.role;
  const age = actor.birthDate ? Math.floor((Date.now() - new Date(actor.birthDate).getTime()) / (365.25 * 86_400_000)) : undefined;

  const header = (
    <View>
      <View style={styles.head}>
        <ActorPortrait actor={actor} size={sizes.avatar.xl + 8} />
        <View style={{ flex: 1 }}>
          <Text variant="headline" accessibilityRole="header">
            {actor.name}
          </Text>
          {actor.koreanName ? (
            <Text variant="bodySmall" tone="secondary">
              {actor.koreanName}
              {age ? ` · ${age}` : ''}
            </Text>
          ) : null}
          <Text variant="caption" tone="secondary" style={{ marginTop: 4 }}>
            {compact(actor.followerCount + (following ? 1 : 0))} followers · {pluralize(filmography.length, 'title')}{seen ? ` · you’ve seen ${seen}` : ''}
          </Text>
        </View>
      </View>
      {actor.bio ? (
        <Pressable onPress={() => setBioOpen((v) => !v)} style={{ paddingHorizontal: space.margin, marginTop: space.x3 }} accessibilityRole="button">
          <Text variant="body" tone="secondary" numberOfLines={bioOpen ? undefined : 3}>
            {actor.bio}
          </Text>
        </Pressable>
      ) : null}
      <View style={styles.actions}>
        <FollowButton kind="actors" id={actor.id} name={actor.name} style={{ flex: 1 }} />
        <Button label="Post" variant="secondary" size="sm" icon="create-outline" onPress={() => require('post', () => setCreate(true))} />
        <IconButton icon="share-social-outline" label="Share" filled onPress={() => Share.share({ message: `${actor.name} on Hallyu — https://hallyu.app/a/${actor.id}` })} />
      </View>
      <Segmented items={[{ key: 'filmography', label: 'Filmography', count: filmography.length }, { key: 'community', label: 'Community', count: posts.length || undefined }]} value={tab} onChange={setTab} style={{ marginTop: space.x4 }} />
      {tab === 'filmography' && filmography.length ? (
        <Text variant="caption" tone="secondary" style={{ paddingHorizontal: space.margin, paddingVertical: space.x3 }}>
          Newest first · your watch status shown on each title
        </Text>
      ) : null}
    </View>
  );

  const footer = (
    <View>
      {related.length ? (
        <View style={{ paddingVertical: space.x6 }}>
          <SectionHeader eyebrow="Also followed by fans of" title={(actor.name ?? '').split(' ')[0] || actor.name || 'Fans'} />
          <ActorRail actors={related} />
        </View>
      ) : null}
      {actor.provider ? (
        <Text variant="caption" tone="tertiary" style={{ paddingHorizontal: space.margin, paddingBottom: space.x4 }}>
          Biography and credits via TMDB.
        </Text>
      ) : null}
    </View>
  );

  return (
    <Screen header={<TopBar mode="stack" title={actor.name} />}>
      {tab === 'filmography' ? (
        <FlatList
          key={`f${columns}`}
          data={filmography}
          numColumns={columns}
          keyExtractor={(d) => d.id}
          ListHeaderComponent={header}
          ListFooterComponent={footer}
          columnWrapperStyle={{ gap: space.gutter, paddingHorizontal: space.margin }}
          contentContainerStyle={[padding, { gap: space.x4 }]}
          renderItem={({ item: d }) => {
            const w = watch(d.id);
            return <DramaCard drama={d} size="m" meta={roleIn(d) ? `as ${roleIn(d)}` : String(d.year)} badge={w ? { want: 'Want', watching: 'Watching', completed: 'Seen', dropped: 'Dropped' }[w.status] : undefined} style={{ flex: 1 / columns }} />;
          }}
          ListEmptyComponent={<EmptyState compact icon="film-outline" title="No credits listed" body="We don’t have this actor’s filmography yet." />}
        />
      ) : (
        <FlatList key="c" data={posts} keyExtractor={(p) => p.id} ListHeaderComponent={header} ListFooterComponent={footer} contentContainerStyle={padding} renderItem={({ item: p }) => <PostCard post={p} />} ListEmptyComponent={<EmptyState compact icon="chatbubbles-outline" title={`Nobody’s posted about ${actor.name} yet`} body="Best role, underrated performance, that one scene — start the thread." actionLabel="Post about this actor" onAction={() => require('post', () => setCreate(true))} />} />
      )}
      <CreateSheet visible={create} onClose={() => setCreate(false)} context={{ actorId: actor.id }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', gap: space.x4, paddingHorizontal: space.margin, paddingTop: space.x4, alignItems: 'center' },
  actions: { flexDirection: 'row', gap: space.x2, paddingHorizontal: space.margin, marginTop: space.x4, alignItems: 'center' },
});
