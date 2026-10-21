import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, Share, StyleSheet, TextInput, View } from 'react-native';
import { CreateSheet } from '../../../../components/create/CreateSheet';
import { episodeState } from '../../../../components/drama/EpisodeCard';
import { ReminderCard } from '../../../../components/drama/Reminder';
import { LivePulse, LiveReactions } from '../../../../components/feed/LiveReactions';
import { PostCard } from '../../../../components/feed/PostCard';
import { FeedAutoplay } from '../../../../components/media/FeedViewport';
import { ReactionGlyph, ReactionMeter, ReactionRow } from '../../../../components/feed/Reactions';
import { ShortsRail } from '../../../../components/feed/ShortCard';
import { Avatar } from '../../../../components/ui/Avatar';
import { Button } from '../../../../components/ui/Button';
import { Chip, ChipRow } from '../../../../components/ui/Chip';
import { IconButton } from '../../../../components/ui/IconButton';
import { Backdrop, Poster } from '../../../../components/ui/Poster';
import { Screen, useListPadding } from '../../../../components/ui/Screen';
import { SectionHeader } from '../../../../components/ui/Section';
import { EmptyState, ErrorState } from '../../../../components/ui/States';
import { Text } from '../../../../components/ui/Text';
import { useToast } from '../../../../components/ui/Toast';
import { TopBar } from '../../../../components/ui/TopBar';
import { colors, fonts, radius, space } from '../../../../constants/theme';
import { connectLiveEpisodeRoom, type LiveRoomConnection, type LiveRoomViewer } from '../../../../lib/api/features';
import { catalog } from '../../../../lib/catalog';
import { countdown, dayLabel, runtimeLabel, shortDate, timeOfDay } from '../../../../lib/format';
import { haptic, useApp, useLayout, useLoad, useReduceMotion, useRequireMember } from '../../../../lib/hooks';
import { emptyReactions, Episode, Post, ReactionKind, REACTIONS } from '../../../../lib/model';
import { uid } from '../../../../lib/store';
import { heroInterpolations, useScrollY, withAlpha } from '../../../../lib/motion';
import { getEpisode, isPostVeiled, postsForEpisode } from '../../../../lib/selectors';
import { hasWatched } from '../../../../lib/spoiler';

type Filter = 'all' | 'discussion' | 'reaction' | 'short' | 'post';

/** Spec 4.9B — mark-watched pill: surface-1 at rest, crimson when watched; scales down then springs back on toggle. */
function WatchPill({ watched, onPress }: { watched: boolean; onPress: () => void }) {
  const reduce = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const toggle = () => {
    onPress();
    if (reduce) return;
    scale.setValue(0.92);
    Animated.spring(scale, { toValue: 1, friction: 5, tension: 200, useNativeDriver: true }).start();
  };
  return (
    <Animated.View style={{ flex: 1, transform: [{ scale }] }}>
      <Pressable
        onPress={toggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: watched }}
        accessibilityLabel={watched ? 'Watched — tap to unmark' : 'Mark as watched'}
        style={[styles.dockWatch, watched ? styles.dockWatchOn : null]}
      >
        <Ionicons name={watched ? 'checkmark' : 'checkmark-outline'} size={18} color={watched ? colors.onMedia : colors.textSecondary} />
        <Text variant="label" style={watched ? { color: colors.onMedia } : null}>
          {watched ? 'Watched' : 'Mark watched'}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

/** Spec 4.9B — spoiler stance segmented control: “I’ve watched this / I haven’t”. */
function SpoilerSeg({ value, onChange }: { value: boolean; onChange: (protect: boolean) => void }) {
  return (
    <View style={styles.seg} accessibilityRole="tablist" accessibilityLabel="Spoiler protection">
      <Pressable onPress={() => onChange(false)} style={[styles.segBtn, !value ? styles.segOn : null]} accessibilityRole="tab" accessibilityState={{ selected: !value }}>
        <Text variant="caption" numberOfLines={1} style={!value ? styles.segTextOn : styles.segTextOff}>
          I’ve watched this
        </Text>
      </Pressable>
      <Pressable onPress={() => onChange(true)} style={[styles.segBtn, value ? styles.segOn : null]} accessibilityRole="tab" accessibilityState={{ selected: value }}>
        <Text variant="caption" numberOfLines={1} style={value ? styles.segTextOn : styles.segTextOff}>
          I haven’t
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * Episode room — the unit of conversation. Watched gate first, then the meter, then the thread.
 * Everything posted from here carries drama + season + episode context.
 */
export default function EpisodeRoom() {
  const router = useRouter();
  const toast = useToast();
  const { dramaId, season: seasonParam, number: numberParam } = useLocalSearchParams<{ dramaId: string; season: string; number: string }>();
  const season = Number(seasonParam) || 1;
  const number = Number(numberParam) || 1;
  const { state, dispatch, getDrama, watch, me } = useApp();
  const require = useRequireMember();
  const { width } = useLayout();
  const padding = useListPadding(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [safe, setSafe] = useState(false);
  const [create, setCreate] = useState(false);
  const [gateDismissed, setGateDismissed] = useState(false);
  const [viewers, setViewers] = useState<LiveRoomViewer[]>([]);
  const [burst, setBurst] = useState<{ seq: number; kind: ReactionKind } | null>(null);
  const [sceneStamp, setSceneStamp] = useState<string | null>(null);
  const [roomNote, setRoomNote] = useState('');
  const roomRef = useRef<LiveRoomConnection | null>(null);
  const burstSeq = useRef(0);
  const { scrollY, onScroll } = useScrollY();

  useEffect(() => {
    if (!dramaId) return;
    const room = connectLiveEpisodeRoom(`${dramaId}-s${season}e${number}`, me, {
      onViewersChange: (list) => setViewers(list),
      onReactionBurst: (evt) => {
        setBurst({ seq: ++burstSeq.current, kind: evt.kind });
      },
    });
    roomRef.current = room;
    return () => {
      room.leave();
      roomRef.current = null;
    };
  }, [dramaId, season, number, me]);

  const drama = getDrama(dramaId);
  const hasSeasonEpisodes = useMemo(
    () => !!drama?.episodes.some((e) => e.season === season),
    [drama?.episodes, season],
  );
  const enrich = useLoad(
    async (signal) => (drama?.provider ? catalog.getDrama(drama.provider.id, drama.mediaType ?? 'tv', signal) : null),
    [drama?.id],
    !!drama?.provider && drama.episodes.length === 0 && catalog.available,
  );
  useEffect(() => {
    if (enrich.data && drama) dispatch({ type: 'import', dramas: [{ ...enrich.data, id: drama.id }] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrich.data]);

  const seasonLoad = useLoad(
    async (signal) =>
      drama?.provider && drama.mediaType !== 'movie'
        ? catalog.getSeasonEpisodes(drama.provider.id, season, drama.id, signal)
        : [],
    [drama?.id, season],
    !!drama?.provider && drama.mediaType !== 'movie' && season > 1 && !hasSeasonEpisodes && catalog.available,
  );
  useEffect(() => {
    if (seasonLoad.data?.length && drama) {
      dispatch({ type: 'import', dramas: [{ ...drama, episodes: seasonLoad.data }] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasonLoad.data]);

  // Spec 4.9B: the spoiler stance defaults to your watch progress and follows it when it changes.
  const watchedEarly = hasWatched(watch(drama?.id ?? ''), season, number);
  const [safeInit] = useState(!watchedEarly);
  useEffect(() => {
    setSafe(!watchedEarly);
  }, [watchedEarly, safeInit]);
  const episode: Episode | undefined = useMemo(() => {
    if (!drama) return undefined;
    const found = getEpisode(drama, season, number);
    if (found) return found;
    if (number >= 1) {
      return {
        id: `${drama.id}-s${season}e${number}`,
        dramaId: drama.id,
        season,
        number,
        title: drama.mediaType === 'movie' ? drama.title : `Episode ${number}`,
        runtime: drama.runtime ?? 60,
      };
    }
    return undefined;
  }, [drama, season, number]);
  const posts = useMemo(() => (drama ? postsForEpisode(state, drama.id, season, number) : []), [state, drama, season, number]);
  const typed = useMemo(() => (filter === 'all' ? posts : posts.filter((p) => p.type === filter)), [posts, filter]);
  const episodeShorts = useMemo(() => posts.filter((p) => p.type === 'short' && p.context.episode === number), [posts, number]);
  const veiledForMe = useMemo(() => typed.filter((p) => p.spoiler !== 'none' || isPostVeiled(state, p)).length, [state, typed]);
  const filtered = useMemo(() => (safe && veiledForMe ? typed.filter((p) => p.spoiler === 'none' && !isPostVeiled(state, p)) : typed), [typed, safe, veiledForMe, state]);
  const meter = useMemo(
    () =>
      posts.reduce((acc, p) => {
        for (const k of Object.keys(acc) as (keyof typeof acc)[]) acc[k] += p.reactions[k];
        return acc;
      }, emptyReactions()),
    [posts],
  );

  if (!drama || !episode) {
    return (
      <Screen header={<TopBar mode="stack" title="Episode" />}>
        <ErrorState
          kind="notFound"
          title="Episode not found"
          body="This episode isn’t in the schedule yet, or the link is wrong."
          onRetry={() => (drama ? router.replace(`/drama/${drama.id}`) : router.back())}
        />
      </Screen>
    );
  }

  const item = watch(drama.id);
  const watched = hasWatched(item, season, number);
  const st = episodeState(episode, drama.status);
  const rawTotal = drama.seasons.find((s) => s.number === season)?.episodeCount ?? drama.episodeCount;
  const total = rawTotal || (drama.mediaType === 'movie' ? 1 : 16);
  const prev =
    getEpisode(drama, season, number - 1) ??
    (number > 1
      ? { id: `${drama.id}-s${season}e${number - 1}`, dramaId: drama.id, season, number: number - 1, title: `Episode ${number - 1}` }
      : undefined);
  const next =
    getEpisode(drama, season, number + 1) ??
    (number < total
      ? { id: `${drama.id}-s${season}e${number + 1}`, dramaId: drama.id, season, number: number + 1, title: `Episode ${number + 1}` }
      : undefined);
  const multi = drama.seasons.length > 1;
  const showGate = st !== 'upcoming' && !watched && !gateDismissed && state.prefs.protection !== 'off' && item?.status !== 'completed';
  const veiledCount = posts.filter((p) => p.spoiler !== 'none').length;

  const markWatched = () =>
    require('mark episodes watched', () => {
      haptic.success();
      dispatch({ type: 'progress', dramaId: drama.id, season, episode: number, total });
      toast.show({ message: number >= total ? `${drama.title} completed 🎉` : `Episode ${number} marked watched`, tone: 'success', icon: 'checkmark-circle' });
    });

  const unwatch = () =>
    require('change progress', () => {
      dispatch({ type: 'progress', dramaId: drama.id, season, episode: number - 1, total });
      toast.show({ message: `Episode ${number} marked unwatched` });
    });

  const heroH = Math.min(300, Math.round((width * 9) / 16));
  const hero = heroInterpolations(scrollY, heroH, heroH - 20);
  const here = Math.max(viewers.length, st === 'live' ? 1 : 0);

  const sendLiveBurst = (kind: ReactionKind) => {
    haptic.light();
    setBurst({ seq: ++burstSeq.current, kind });
    roomRef.current?.sendReaction(kind);
  };

  const publishSceneReaction = () => {
    const clean = roomNote.trim();
    if (!clean) return;
    require('post a scene reaction', () => {
      haptic.success();
      const body = sceneStamp ? `[${sceneStamp}] ${clean}` : clean;
      const created: Post = {
        id: uid(''),
        authorId: me.id,
        type: 'reaction',
        body,
        spoiler: 'episode',
        hashtags: [],
        mentions: [],
        context: { dramaId: drama.id, season, episode: number },
        createdAt: new Date().toISOString(),
        reactions: emptyReactions(),
        commentCount: 0,
        saveCount: 0,
        shareCount: 0,
      };
      dispatch({ type: 'addPost', post: created });
      setRoomNote('');
      setSceneStamp(null);
      toast.show({ message: 'Posted to Episode Watch Room', tone: 'success', icon: 'checkmark-circle' });
    });
  };

  const header = (
    <View>
      <View pointerEvents="none" style={[styles.wash, { height: heroH + 180, backgroundColor: withAlpha(drama.tone, 0.5) }]} />
      <Animated.View style={{ height: heroH, overflow: 'hidden', opacity: hero.heroFade, transform: [{ translateY: hero.parallax }, { scale: hero.stretch }] }}>
        <Backdrop uri={episode.stillUrl ?? drama.backdropUrl ?? drama.posterUrl ?? drama.posterLocal} fallbackColor={drama.tone} width="100%" height={heroH} cinemaGradient accentGlow={drama.tone} label={`Episode ${number} still`}>
          <View pointerEvents="none" style={StyleSheet.absoluteFill} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Text style={styles.numeral}>{String(number).padStart(2, '0')}</Text>
          </View>
          <LiveReactions counts={meter} active={st === 'live' || viewers.length > 0} burst={burst} style={{ right: 0, bottom: 0 }} />
          <View style={styles.heroText}>
            <Pressable onPress={() => router.push(`/drama/${drama.id}`)} accessibilityRole="link" style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
              <Poster drama={drama} width={28} rounded={4} />
              <Text variant="label" style={{ color: colors.onMedia }} numberOfLines={1}>
                {drama.title}
              </Text>
              <Ionicons name="chevron-forward" size={12} color={colors.onMedia} />
            </Pressable>
            <Text variant="headline" style={{ color: colors.onMedia }}>
              {multi ? `S${season} · ` : ''}Episode {number}
              {episode.title ? ` — ${episode.title}` : ''}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {here > 0 ? <LivePulse size={6} style={{ marginLeft: -6 }} /> : null}
              <Text variant="caption" style={{ color: here > 0 ? colors.onMedia : colors.textSecondary }}>
                {here > 0
                  ? `${here} ${here === 1 ? 'viewer' : 'viewers'} live in room`
                  : st === 'upcoming' && episode.airDate
                    ? `Airs ${dayLabel(episode.airDate)} · ${timeOfDay(episode.airDate)} · ${countdown(episode.airDate)}`
                    : [episode.airDate ? shortDate(episode.airDate) : 'TBA', runtimeLabel(episode.runtime)].filter(Boolean).join(' · ')}
                {' · '}
                {posts.length} {posts.length === 1 ? 'post' : 'posts'}
              </Text>
            </View>
          </View>
        </Backdrop>
      </Animated.View>

      {/* Live Watch Room Presence + Real-Time Floating Burst Strip + Scene Timestamp Composer */}
      <View
        style={{
          marginHorizontal: space.margin,
          marginTop: space.x3,
          padding: space.x3,
          borderRadius: radius.md,
          backgroundColor: colors.surface1,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.borderStrong,
          gap: space.x2 + 2,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <LivePulse size={6} />
            <Text variant="overline" tone="accent">
              LIVE WATCH ROOM {viewers.length > 0 ? `· ${viewers.length} HERE NOW` : ''}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: -6 }}>
            {viewers.slice(0, 5).map((v) => (
              <Avatar key={v.userId} uri={v.avatarUrl} name={v.displayName} size="xs" />
            ))}
          </View>
        </View>

        {/* 1-Tap Broadcast Reaction Bursts */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {REACTIONS.map((r) => (
            <Pressable
              key={r.kind}
              onPress={() => sendLiveBurst(r.kind)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 5,
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: radius.full,
                backgroundColor: colors.surface2,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.borderSubtle,
              }}
              accessibilityRole="button"
              accessibilityLabel={`Send live ${r.label} reaction`}
            >
              <ReactionGlyph kind={r.kind} size={15} active />
              <Text variant="caption">{r.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {/* Scene Timestamp Quick Note */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {['05:00', '18:30', '34:00', '48:15', 'Ending'].map((ts) => (
            <Chip
              key={ts}
              label={`⏱ ${ts}`}
              size="sm"
              selected={sceneStamp === ts}
              onPress={() => {
                haptic.select();
                setSceneStamp(sceneStamp === ts ? null : ts);
              }}
            />
          ))}
        </ScrollView>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
          <TextInput
            value={roomNote}
            onChangeText={setRoomNote}
            placeholder={sceneStamp ? `React to scene [${sceneStamp}]…` : `Drop a live reaction to Ep ${number}…`}
            placeholderTextColor={colors.textTertiary}
            style={{
              flex: 1,
              height: 38,
              paddingHorizontal: 12,
              borderRadius: radius.full,
              backgroundColor: colors.surface2,
              color: colors.textPrimary,
              fontSize: 13.5,
            }}
          />
          <Button label="Drop" size="sm" disabled={!roomNote.trim()} onPress={publishSceneReaction} />
        </View>
      </View>

      <View style={styles.nav}>
        <Button
          label={prev ? `Ep ${prev.number}` : 'First'}
          icon="chevron-back"
          variant="ghost"
          size="sm"
          disabled={!prev}
          onPress={() => prev && router.replace(`/episode/${drama.id}/${season}/${prev.number}`)}
        />
        <Pressable onPress={() => router.push({ pathname: '/drama/[id]', params: { id: drama.id, tab: 'episodes' } })} accessibilityRole="button" accessibilityLabel="All episodes">
          <Text variant="label" tone="secondary">
            {number} / {total}
          </Text>
        </Pressable>
        <Button
          label={next ? `Ep ${next.number}` : 'Last'}
          iconRight="chevron-forward"
          variant="ghost"
          size="sm"
          disabled={!next}
          onPress={() => next && router.replace(`/episode/${drama.id}/${season}/${next.number}`)}
        />
      </View>

      {st === 'upcoming' ? (
        <ReminderCard drama={drama} episode={episode} />
      ) : showGate ? (
        <View style={styles.gate}>
          <Ionicons name="eye-off-outline" size={22} color={colors.textPrimary} />
          <Text variant="titleSmall" style={{ marginTop: space.x2 }}>
            Have you watched Episode {number}?
          </Text>
          <Text variant="bodySmall" tone="secondary" align="center" style={{ marginTop: 4 }}>
            {veiledCount ? `${veiledCount} of ${posts.length} posts here are marked as spoilers. ` : ''}Say yes and we unveil this room; say not yet and spoilers stay covered.
          </Text>
          <View style={{ flexDirection: 'row', gap: space.x2, marginTop: space.x4 }}>
            <Button label="Yes, mark watched" size="sm" onPress={markWatched} />
            <Button label="Not yet — protect me" size="sm" variant="secondary" onPress={() => setGateDismissed(true)} />
          </View>
        </View>
      ) : (
        <View style={styles.dock}>
          <WatchPill watched={watched} onPress={watched ? unwatch : markWatched} />
          <SpoilerSeg value={safe} onChange={setSafe} />
        </View>
      )}

      {episode.synopsis ? (
        <View style={{ paddingHorizontal: space.margin, paddingTop: space.x4 }}>
          <Text variant="body" tone="secondary" numberOfLines={watched ? undefined : 2}>
            {episode.synopsis}
          </Text>
        </View>
      ) : null}

      {posts.length ? (
        <View style={{ paddingHorizontal: space.margin, paddingTop: space.x5 }}>
          <SectionHeader eyebrow="Reaction meter" title="How this episode landed" style={{ paddingHorizontal: 0 }} />
          <ReactionMeter counts={meter} />
        </View>
      ) : null}

      {posts.length ? (
        <View style={{ paddingHorizontal: space.margin, paddingTop: space.x5 }}>
          <SectionHeader eyebrow="Reactions" title="How did it land?" style={{ paddingHorizontal: 0 }} />
          <ReactionRow counts={meter} onPressKind={() => require('post', () => setCreate(true))} style={{ marginTop: space.x4 }} />
        </View>
      ) : null}

      <ChipRow style={{ paddingHorizontal: space.margin, paddingTop: space.x5, paddingBottom: space.x2 }}>
        {(['all', 'discussion', 'reaction', 'post', 'short'] as Filter[]).map((f) => (
          <Chip
            key={f}
            label={f === 'all' ? `All · ${posts.length}` : f === 'post' ? 'Posts' : f[0]!.toUpperCase() + f.slice(1) + 's'}
            size="sm"
            selected={filter === f}
            onPress={() => setFilter(f)}
          />
        ))}
      </ChipRow>

      {episodeShorts.length ? (
        <View style={{ paddingTop: space.x5, paddingBottom: space.x2 }}>
          <SectionHeader eyebrow="Clips" title="From this episode" style={{ paddingHorizontal: space.margin }} />
          <ShortsRail posts={episodeShorts} width={120} />
        </View>
      ) : null}
    </View>
  );

  return (
    <Screen
      header={
        <TopBar
          mode="stack"
          transparent
          title={`Ep ${number}`}
          subtitle={drama.title}
          backgroundOpacity={hero.barOpacity}
          titleOpacity={hero.titleOpacity}
          titleRise={hero.titleRise}
          right={
            <IconButton
              icon="share-social-outline"
              label="Share"
              onPress={() => Share.share({ message: `${drama.title} Ep ${number} on Hallyu — https://hallyu.app/d/${drama.id}/e/${season}/${number}` })}
            />
          }
        />
      }
    >
      <FeedAutoplay<Post> getVideoId={(p) => (p.video ? p.id : null)}>
        {(vp) => (
          <Animated.FlatList<Post>
            data={filtered}
            keyExtractor={(p) => p.id}
            onScroll={onScroll}
            scrollEventThrottle={16}
            onViewableItemsChanged={vp.onViewableItemsChanged}
            viewabilityConfig={vp.viewabilityConfig}
            ListHeaderComponent={header}
            contentContainerStyle={padding}
            renderItem={({ item: p }) => <PostCard post={p} hideContext />}
            ListEmptyComponent={
              <EmptyState
                compact
                icon="chatbubbles-outline"
                title={st === 'upcoming' ? 'The room opens when it airs' : filter === 'all' ? 'Be the first to react' : `No ${filter}s for this episode`}
                body={st === 'upcoming' ? 'Follow the drama with alerts on and we’ll bring you back the moment it airs.' : 'Reactions, theories, that one scene — post first and set the tone.'}
                actionLabel={st === 'upcoming' ? undefined : 'Post about this episode'}
                onAction={() => require('post', () => setCreate(true))}
              />
            }
            ListFooterComponent={
              filtered.length || next ? (
                <View style={{ padding: space.margin, gap: space.x3 }}>
                  {next ? (
                    <Pressable
                      onPress={() => router.replace(`/episode/${drama.id}/${season}/${next.number}`)}
                      style={styles.nextCard}
                      accessibilityRole="button"
                      accessibilityLabel={`Go to episode ${next.number}`}
                    >
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text variant="overline" tone="tertiary">
                          Next episode
                        </Text>
                        <Text variant="title" numberOfLines={1}>
                          {next.title ?? `Episode ${next.number}`}
                        </Text>
                        <Text variant="caption" tone="secondary">
                          {`S${season} · E${next.number}${next.airDate ? ` · ${shortDate(next.airDate)}` : ''}`}
                        </Text>
                      </View>
                      <Ionicons name="arrow-forward" size={18} color={colors.textTertiary} />
                    </Pressable>
                  ) : null}
                  <Button label={`Post about Episode ${number}`} variant="secondary" icon="create-outline" block onPress={() => require('post', () => setCreate(true))} />
                </View>
              ) : null
            }
          />
        )}
      </FeedAutoplay>
      <CreateSheet visible={create} onClose={() => setCreate(false)} context={{ dramaId: drama.id, season, episode: number }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(10,10,10,0.5)' },
  wash: { position: 'absolute', top: 0, left: 0, right: 0 },
  numeral: { position: 'absolute', right: space.x2, top: 44, fontFamily: fonts.extrabold, fontSize: 132, lineHeight: 132, letterSpacing: -6, color: 'rgba(255,255,255,0.10)' },
  heroText: { position: 'absolute', left: space.margin, right: space.margin, bottom: space.x4, gap: 6 },
  live: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.live },
  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.x2, paddingVertical: space.x2 },
  gate: { marginHorizontal: space.margin, padding: space.x5, alignItems: 'center', backgroundColor: colors.surface1, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderSubtle },
  watchedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    marginHorizontal: space.margin,
    paddingHorizontal: space.x4,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
  },
  watchedOn: { borderWidth: 1, borderColor: colors.borderSubtle },
  dock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    marginHorizontal: space.margin,
    marginTop: space.x3,
    padding: space.x2,
    borderRadius: radius.full,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  dockWatch: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.x2,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surface1,
    paddingHorizontal: space.x4,
  },
  dockWatchOn: { backgroundColor: colors.accent },
  seg: { flex: 1.1, flexDirection: 'row', backgroundColor: colors.surface1, borderRadius: 22, padding: 2 },
  segBtn: { flex: 1, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  segOn: { backgroundColor: colors.accent },
  segTextOn: { color: colors.onMedia },
  segTextOff: { color: colors.textSecondary },
  nextCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    padding: space.x4,
    borderRadius: radius.md,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
});
