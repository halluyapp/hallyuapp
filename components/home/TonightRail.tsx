import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { colors, radius, space } from '../../constants/theme';
import { countdown, dayLabel, timeOfDay } from '../../lib/format';
import { useApp, useLayout } from '../../lib/hooks';
import { Drama, Episode, REACTIONS, emptyReactions } from '../../lib/model';
import { postsForEpisode, topReactions } from '../../lib/selectors';
import { hasWatched } from '../../lib/spoiler';
import { withAlpha } from '../../lib/motion';
import { episodeState } from '../drama/EpisodeCard';
import { useReminder } from '../drama/Reminder';
import { LivePulse } from '../feed/LiveReactions';
import { Backdrop, Poster } from '../ui/Poster';
import { SectionHeader } from '../ui/Section';
import { Tap } from '../ui/Tap';
import { Text } from '../ui/Text';
import { Button } from '../ui/Button';

/** Re-render once a minute so countdowns and "just aired" states stay honest without a global clock. */
function useMinuteTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
}

/** The morning-after summary: how the room felt and the thread people are in. */
function recapFor(posts: ReturnType<typeof postsForEpisode>): { feeling?: string; thread?: string } {
  const meter = emptyReactions();
  for (const p of posts) for (const k of Object.keys(meter) as (keyof typeof meter)[]) meter[k] += p.reactions[k];
  const top = topReactions({ reactions: meter }, 1)[0];
  const feeling = top ? REACTIONS.find((r) => r.kind === top)?.label.toLowerCase() : undefined;
  const thread = [...posts].filter((p) => p.type === 'discussion' && p.title && p.spoiler === 'none').sort((a, b) => b.commentCount - a.commentCount)[0]?.title;
  return { feeling, thread };
}

/**
 * The lead card: the one episode that matters most right now — live, or the next to air — as a
 * cinematic still with the countdown and the room's pulse. "Join the room · 128 talking" is the
 * whole promise of the app in one tap.
 */
function TonightHero({ drama, episode }: { drama: Drama; episode: Episode }) {
  const router = useRouter();
  const { state, watch } = useApp();
  const { width } = useLayout();
  useMinuteTick();
  const reminder = useReminder(drama);
  const st = episodeState(episode);
  const watched = hasWatched(watch(drama.id), episode.season, episode.number);
  const posts = postsForEpisode(state, drama.id, episode.season, episode.number);
  const count = posts.length;
  const agoH = episode.airDate ? (Date.now() - new Date(episode.airDate).getTime()) / 3_600_000 : Infinity;
  const recap = st === 'aired' && count ? recapFor(posts) : undefined;
  const h = Math.min(220, Math.round(((width - space.margin * 2) * 9) / 16));
  const airs = episode.airDate ? `${dayLabel(episode.airDate)} · ${timeOfDay(episode.airDate)}` : '';
  const status = st === 'live' ? 'Live now' : st === 'upcoming' ? (countdown(episode.airDate!) === 'now' ? 'Starting now' : `Airs ${countdown(episode.airDate!)}`) : agoH < 24 ? 'Last night in the room' : `Aired ${dayLabel(episode.airDate!)}`;
  const sub =
    st === 'live'
      ? count
        ? `${count} talking right now`
        : 'Be the first in the room'
      : st === 'upcoming'
        ? `${airs}${count ? ` · ${count} waiting` : ''}`
        : recap
          ? `${count} ${count === 1 ? 'post' : 'posts'}${recap.feeling ? ` · mostly ${recap.feeling}` : ''}`
          : `${airs} · quiet room, so far`;
  const cta = st === 'live' ? 'Join the room' : st === 'upcoming' ? (reminder.on ? 'Reminder on' : 'Remind me') : watched ? 'Open the room' : 'Catch up';
  const open = () => router.push(`/episode/${drama.id}/${episode.season}/${episode.number}`);
  return (
    <View style={[styles.hero, st === 'live' ? styles.heroLive : null]}>
      <Backdrop uri={episode.stillUrl ?? drama.backdropUrl ?? drama.posterUrl ?? drama.posterLocal} fallbackColor={drama.tone} width="100%" height={h} label={`${drama.title} still`}>
        <View style={styles.heroScrim} />
        <View style={styles.heroBody}>
          <Pressable
            onPress={open}
            accessibilityRole="button"
            accessibilityLabel={`${drama.title}, episode ${episode.number}, ${status}. ${sub}`}
            style={{ gap: 2 }}
          >
            <View style={styles.top}>
              {st === 'live' ? <LivePulse size={7} style={{ marginLeft: -4, marginRight: -2 }} /> : null}
              <Text variant="overline" tone={st === 'live' ? 'accent' : 'onMedia'}>
                {status}
              </Text>
              {watched ? (
                <Text variant="overline" tone="success">
                  · Watched
                </Text>
              ) : null}
            </View>
            <Text variant="headline" tone="onMedia" numberOfLines={1}>
              {drama.title}
            </Text>
            <Text variant="bodySmall" tone="onMedia" numberOfLines={1} style={{ opacity: 0.85 }}>
              {drama.seasons.length > 1 ? `S${episode.season} · ` : ''}Episode {episode.number}
              {episode.title ? ` · ${episode.title}` : ''}
            </Text>
            {recap?.thread ? (
              <Text variant="caption" tone="onMedia" numberOfLines={1} style={{ opacity: 0.85, fontStyle: 'italic' }}>
                “{recap.thread}”
              </Text>
            ) : null}
          </Pressable>
          <View style={styles.heroFoot}>
            <Text variant="caption" tone="onMedia" numberOfLines={1} style={{ flex: 1, opacity: 0.85 }}>
              {sub}
            </Text>
            <Button
              label={cta}
              size="sm"
              variant={st === 'live' ? 'primary' : 'secondary'}
              icon={st === 'upcoming' ? (reminder.on ? 'checkmark' : 'notifications-outline') : undefined}
              onPress={st === 'upcoming' ? () => reminder.toggle(episode) : open}
            />
          </View>
        </View>
      </Backdrop>
    </View>
  );
}

/** "Tonight / This week": the lead episode as a hero, the rest as a rail. Live ones lead. */
export function TonightRail({ items, title = 'Tonight', eyebrow = 'On air', onSeeAll, hero = true }: { items: { drama: Drama; episode: Episode }[]; title?: string; eyebrow?: string; onSeeAll?: () => void; hero?: boolean }) {
  const router = useRouter();
  const { state, watch } = useApp();
  if (!items.length) return null;
  const lead = hero ? items[0] : undefined;
  const rest = hero ? items.slice(1) : items;
  return (
    <View style={{ marginBottom: space.section }}>
      <SectionHeader eyebrow={eyebrow} title={title} live onAction={onSeeAll} actionLabel="Schedule" />
      {lead ? <TonightHero drama={lead.drama} episode={lead.episode} /> : null}
      {rest.length ? (
        <FlatList
          horizontal
          data={rest}
          keyExtractor={(i) => i.episode.id}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.gutter }}
          renderItem={({ item: { drama, episode } }) => {
            const st = episodeState(episode);
            const watched = hasWatched(watch(drama.id), episode.season, episode.number);
            const count = postsForEpisode(state, drama.id, episode.season, episode.number).length;
            const when =
              st === 'upcoming'
                ? `${dayLabel(episode.airDate!)} · ${timeOfDay(episode.airDate!)} · ${countdown(episode.airDate!)}`
                : st === 'live'
                  ? 'Just aired · room is live'
                  : `Aired ${dayLabel(episode.airDate!).toLowerCase()}`;
            return (
              <Tap
                onPress={() => router.push(`/episode/${drama.id}/${episode.season}/${episode.number}`)}
                accessibilityRole="button"
                accessibilityLabel={`${drama.title} episode ${episode.number}, ${when}`}
                style={[styles.card, { backgroundColor: withAlpha(drama.tone, 0.75) }, st === 'live' ? styles.liveCard : null]}
              >
                <Poster drama={drama} width={64} />
                <View style={{ flex: 1, justifyContent: 'space-between' }}>
                  <View>
                    <View style={styles.top}>
                      {st === 'live' ? <LivePulse size={6} style={{ marginLeft: -6, marginRight: -4 }} /> : null}
                      <Text variant="overline" tone={st === 'live' ? 'accent' : 'secondary'}>
                        {st === 'live' ? 'Live now' : st === 'upcoming' ? 'Coming up' : 'Aired'}
                      </Text>
                    </View>
                    <Text variant="titleSmall" numberOfLines={1}>
                      {drama.title}
                    </Text>
                    <Text variant="caption" tone="secondary" numberOfLines={1}>
                      {drama.seasons.length > 1 ? `S${episode.season} · ` : ''}Episode {episode.number}
                      {episode.title ? ` · ${episode.title}` : ''}
                    </Text>
                  </View>
                  <Text variant="caption" tone={watched ? 'success' : 'tertiary'} numberOfLines={1}>
                    {watched ? 'Watched · ' : ''}
                    {count ? `${count} talking` : when}
                  </Text>
                </View>
              </Tap>
            );
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { marginHorizontal: space.margin, marginBottom: space.x3, borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  heroLive: { borderColor: colors.accent },
  heroScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(10,10,10,0.42)' },
  heroBody: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end', padding: space.x4, gap: 2 },
  heroFoot: { flexDirection: 'row', alignItems: 'center', gap: space.x3, marginTop: space.x3 },
  card: { width: 280, flexDirection: 'row', gap: space.x3, padding: space.x3, backgroundColor: colors.surface1, borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  liveCard: { borderColor: colors.accent },
  top: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
});
