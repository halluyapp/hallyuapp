import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Share, StyleSheet, View } from 'react-native';
import { Button } from '../components/ui/Button';
import { Chip } from '../components/ui/Chip';
import { IconButton } from '../components/ui/IconButton';
import { Backdrop } from '../components/ui/Poster';
import { Screen, ScrollScreen } from '../components/ui/Screen';
import { Sheet } from '../components/ui/Sheet';
import { EmptyState } from '../components/ui/States';
import { Text } from '../components/ui/Text';
import { TextField } from '../components/ui/TextField';
import { useToast } from '../components/ui/Toast';
import { TopBar } from '../components/ui/TopBar';
import { colors, fonts, radius, space } from '../constants/theme';
import {
  createHallyuEvent,
  fetchHallyuEvents,
  type HallyuLiveEvent,
  toggleEventRsvp,
} from '../lib/api/features';
import { FANDOMS } from '../lib/fandoms';
import { haptic, useApp, useRequireMember } from '../lib/hooks';
import { shareEventsUrl } from '../lib/links';
import type { FandomId } from '../lib/model';

function formatCountdown(startsAt: string, endsAt: string, nowMs: number): {
  isLive: boolean;
  badge: string;
  localTime: string;
} {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  const localTime = new Date(startsAt).toLocaleString([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

  if (nowMs >= start && nowMs <= end) {
    return { isLive: true, badge: 'LIVE NOW', localTime };
  }
  const diffMin = Math.max(1, Math.round((start - nowMs) / 60_000));
  if (diffMin < 60) return { isLive: false, badge: `IN ${diffMin}M`, localTime };
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return {
    isLive: false,
    badge: mins > 0 ? `IN ${hours}H ${mins}M` : `IN ${hours}H`,
    localTime,
  };
}

export default function EventsScreen() {
  const router = useRouter();
  const toast = useToast();
  const requireMember = useRequireMember();
  const { me } = useApp();
  const [world, setWorld] = useState<FandomId | 'all'>('all');
  const [events, setEvents] = useState<HallyuLiveEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());

  // Host new event modal (staff / admin)
  const isStaff = me.role === 'admin' || me.role === 'moderator';
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSubtitle, setNewSubtitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newWorld, setNewWorld] = useState<FandomId>('kdrama');
  const [startsInMin, setStartsInMin] = useState('15');
  const [question, setQuestion] = useState('');
  const [opt1, setOpt1] = useState('');
  const [opt2, setOpt2] = useState('');
  const [opt3, setOpt3] = useState('');
  const [creating, setCreating] = useState(false);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchHallyuEvents(world);
      setEvents(list);
    } finally {
      setLoading(false);
    }
  }, [world]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const handleRsvp = (ev: HallyuLiveEvent, predictionIdx?: number) => {
    requireMember('RSVP & vote in live events', async () => {
      setBusyId(ev.id);
      try {
        const res = await toggleEventRsvp(
          ev.id,
          predictionIdx !== undefined ? true : !ev.viewerGoing,
          predictionIdx,
        );
        haptic.success();
        setEvents((prev) =>
          prev.map((item) => {
            if (item.id !== ev.id) return item;
            const nextCounts = { ...item.predictionCounts };
            if (predictionIdx !== undefined) {
              if (item.viewerPrediction !== null) {
                const prevKey = String(item.viewerPrediction);
                nextCounts[prevKey] = Math.max(0, (nextCounts[prevKey] ?? 1) - 1);
              }
              const nextKey = String(predictionIdx);
              nextCounts[nextKey] = (nextCounts[nextKey] ?? 0) + 1;
            }
            return {
              ...item,
              viewerGoing: res.going,
              rsvpCount: res.rsvpCount,
              viewerPrediction: res.predictionChoice,
              predictionCounts: nextCounts,
            };
          }),
        );
        toast.show({
          message:
            predictionIdx !== undefined
              ? 'Prediction locked in! You’re on the guest list.'
              : res.going
                ? 'Spot saved — we’ll keep you posted!'
                : 'Removed RSVP',
          tone: 'success',
        });
      } catch (err) {
        toast.show({
          message: err instanceof Error ? err.message : 'Could not update RSVP',
          tone: 'danger',
        });
      } finally {
        setBusyId(null);
      }
    });
  };

  const handleCreateEvent = async () => {
    if (!newTitle.trim() || creating) return;
    setCreating(true);
    try {
      await createHallyuEvent({
        title: newTitle,
        world: newWorld,
        subtitle: newSubtitle,
        description: newDesc,
        startsInMinutes: Math.max(0, Number.parseInt(startsInMin, 10) || 15),
        predictionQuestion: question,
        predictionOptions: [opt1, opt2, opt3].filter((x) => x.trim().length > 0),
      });
      haptic.success();
      toast.show({ message: 'Live Event published!', tone: 'success' });
      setCreateOpen(false);
      setNewTitle('');
      setNewSubtitle('');
      setNewDesc('');
      setQuestion('');
      setOpt1('');
      setOpt2('');
      setOpt3('');
      await loadEvents();
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Could not publish event',
        tone: 'danger',
      });
    } finally {
      setCreating(false);
    }
  };

  const handleShareHub = async () => {
    const url = shareEventsUrl();
    const message = `Join tonight's live K-Drama, Anime, C-Drama & Cinema Watch Parties on Hallyu!\n${url}`;
    try {
      await Share.share({ message });
    } catch {
      await Clipboard.setStringAsync(message);
      toast.show({ message: 'Copied Live Events link', tone: 'success' });
    }
  };

  return (
    <Screen
      header={
        <TopBar
          title="Live Events & Watch Parties"
          right={
            <>
              {isStaff ? (
                <IconButton
                  icon="add-circle-outline"
                  label="Host live event"
                  onPress={() => setCreateOpen(true)}
                />
              ) : null}
              <IconButton
                icon="share-social-outline"
                label="Share Live Events"
                onPress={() => void handleShareHub()}
              />
            </>
          }
        />
      }
    >
      <ScrollScreen padded column>
        {/* Hero Premiere Banner */}
        <LinearGradient
          colors={['rgba(225,29,72,0.24)', colors.surface1, '#09090D']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.hero}
        >
          <View style={styles.heroPill}>
            <View style={styles.liveDot} />
            <Text variant="overline" style={{ color: colors.textPrimary }}>
              SYNCHRONIZED GLOBAL PREMIERES
            </Text>
          </View>
          <Text variant="headline" style={{ marginTop: space.x2 }}>
            Never watch finale night alone.
          </Text>
          <Text variant="bodySmall" tone="secondary" style={{ marginTop: 6 }}>
            RSVP in your local timezone, lock in pre-episode predictions before spoilers drop, and
            jump straight into synchronized Episode Watch Rooms.
          </Text>
        </LinearGradient>

        {/* World Filter Pills */}
        <View style={styles.filterRow}>
          <Chip
            label="All Worlds"
            size="sm"
            selected={world === 'all'}
            onPress={() => setWorld('all')}
          />
          {FANDOMS.map((f) => (
            <Chip
              key={f.id}
              label={f.short}
              size="sm"
              selected={world === f.id}
              onPress={() => setWorld(f.id)}
            />
          ))}
        </View>

        {loading ? (
          <View style={{ paddingVertical: space.x10, alignItems: 'center' }}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : events.length === 0 ? (
          <EmptyState
            icon="sparkles-outline"
            title="Next watch party opens soon"
            body="Switch to All Worlds or check tonight's airing schedule while hosts line up the next room."
            actionLabel="All Worlds"
            onAction={() => setWorld('all')}
          />
        ) : (
          <View style={{ gap: space.x4 }}>
            {events.map((ev) => {
              const fandom = FANDOMS.find((f) => f.id === ev.world) ?? FANDOMS[0]!;
              const timer = formatCountdown(ev.startsAt, ev.endsAt, nowMs);
              const totalVotes = Object.values(ev.predictionCounts).reduce((a, b) => a + b, 0);

              return (
                <View key={ev.id} style={styles.card}>
                  <Backdrop
                    uri={ev.coverUrl}
                    fallbackColor={colors.surface2}
                    width="100%"
                    height={168}
                    cinemaGradient
                    accentGlow={`${fandom.tint}66`}
                  >
                    <View style={styles.coverTop}>
                      <View
                        style={[
                          styles.statusBadge,
                          {
                            backgroundColor: timer.isLive ? colors.accent : 'rgba(0,0,0,0.72)',
                            borderColor: timer.isLive ? colors.accent : colors.glassBorder,
                          },
                        ]}
                      >
                        {timer.isLive ? <View style={styles.whiteDot} /> : null}
                        <Text variant="overline" style={{ color: '#FFFFFF' }}>
                          {timer.badge}
                        </Text>
                      </View>
                      <View style={styles.worldBadge}>
                        <Text variant="overline" style={{ color: fandom.tint }}>
                          {fandom.label}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.coverBottom}>
                      <Text variant="caption" style={{ color: colors.textSecondary }}>
                        {timer.localTime} · Hosted by @{ev.host?.handle ?? 'ceohallyu'}
                      </Text>
                      <Text variant="title" style={{ marginTop: 2 }}>
                        {ev.title}
                      </Text>
                    </View>
                  </Backdrop>

                  <View style={styles.cardBody}>
                    {ev.subtitle ? (
                      <Text variant="label" style={{ color: fandom.tint }}>
                        {ev.subtitle}
                      </Text>
                    ) : null}
                    <Text variant="bodySmall" tone="secondary">
                      {ev.description}
                    </Text>

                    {/* Live Pre-Episode Prediction Poll */}
                    {ev.predictionQuestion && ev.predictionOptions.length > 0 ? (
                      <View style={styles.pollBox}>
                        <View style={styles.pollHeader}>
                          <Ionicons name="flash" size={14} color={colors.warm} />
                          <Text variant="overline" style={{ color: colors.warm }}>
                            LIVE PREDICTION POLL
                          </Text>
                        </View>
                        <Text variant="titleSmall" style={{ marginBottom: 4 }}>
                          {ev.predictionQuestion}
                        </Text>
                        {ev.predictionOptions.map((opt, idx) => {
                          const count = ev.predictionCounts[String(idx)] ?? 0;
                          const pct =
                            totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
                          const picked = ev.viewerPrediction === idx;
                          return (
                            <Pressable
                              key={`${ev.id}-opt-${idx}`}
                              onPress={() => void handleRsvp(ev, idx)}
                              disabled={busyId === ev.id}
                              style={[
                                styles.pollOption,
                                picked && {
                                  borderColor: colors.accent,
                                  backgroundColor: 'rgba(225,29,72,0.12)',
                                },
                              ]}
                            >
                              <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                <Ionicons
                                  name={picked ? 'checkmark-circle' : 'ellipse-outline'}
                                  size={16}
                                  color={picked ? colors.accent : colors.textTertiary}
                                />
                                <Text variant="bodySmall" style={{ flex: 1 }}>
                                  {opt}
                                </Text>
                              </View>
                              {totalVotes > 0 ? (
                                <Text
                                  variant="caption"
                                  style={{
                                    color: picked ? colors.accent : colors.textSecondary,
                                    fontFamily: fonts.bold,
                                  }}
                                >
                                  {pct}%
                                </Text>
                              ) : null}
                            </Pressable>
                          );
                        })}
                      </View>
                    ) : null}

                    {/* Action Row */}
                    <View style={styles.actions}>
                      <Button
                        label={
                          ev.viewerGoing
                            ? `Going · ${ev.rsvpCount}`
                            : `RSVP · ${ev.rsvpCount} going`
                        }
                        variant={ev.viewerGoing ? 'secondary' : 'primary'}
                        size="sm"
                        icon={ev.viewerGoing ? 'checkmark-circle' : 'notifications-outline'}
                        loading={busyId === ev.id}
                        onPress={() => void handleRsvp(ev)}
                      />

                      {ev.titleId ? (
                        <Button
                          label={
                            ev.season && ev.episode
                              ? `Enter S${ev.season}E${ev.episode} Room`
                              : 'Open Show Hub'
                          }
                          variant="ghost"
                          size="sm"
                          icon="chatbubbles-outline"
                          onPress={() => {
                            if (ev.season && ev.episode) {
                              router.push(`/episode/${ev.titleId}/${ev.season}/${ev.episode}`);
                            } else {
                              router.push(`/drama/${ev.titleId}`);
                            }
                          }}
                        />
                      ) : null}
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </ScrollScreen>

      {/* Staff Host Event Sheet */}
      <Sheet
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Host Live Event / Watch Party"
      >
        <View style={{ gap: space.x3 }}>
          <TextField
            label="Event headline"
            placeholder="e.g. Finale Watch Party & Live Reactions"
            value={newTitle}
            onChangeText={setNewTitle}
          />
          <TextField
            label="Subtitle"
            placeholder="Global synchronized room · Spoiler shield ON"
            value={newSubtitle}
            onChangeText={setNewSubtitle}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {FANDOMS.map((f) => (
              <Chip
                key={f.id}
                label={f.short}
                size="sm"
                selected={newWorld === f.id}
                onPress={() => setNewWorld(f.id)}
              />
            ))}
          </View>
          <TextField
            label="Starts in (minutes — 0 = LIVE right now)"
            placeholder="0"
            keyboardType="numeric"
            value={startsInMin}
            onChangeText={setStartsInMin}
          />
          <TextField
            label="Description"
            placeholder="What fans can expect in the live room..."
            multiline
            value={newDesc}
            onChangeText={setNewDesc}
          />
          <TextField
            label="Prediction poll question (optional)"
            placeholder="Who reveals the secret tonight?"
            value={question}
            onChangeText={setQuestion}
          />
          {question.trim() ? (
            <>
              <TextField label="Option 1" value={opt1} onChangeText={setOpt1} placeholder="First theory" />
              <TextField label="Option 2" value={opt2} onChangeText={setOpt2} placeholder="Second theory" />
              <TextField label="Option 3 (optional)" value={opt3} onChangeText={setOpt3} placeholder="Wildcard twist" />
            </>
          ) : null}
          <Button
            label="Publish Live Event"
            block
            loading={creating}
            onPress={() => void handleCreateEvent()}
          />
        </View>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    marginTop: space.x2,
    padding: space.x5,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: 'rgba(225,29,72,0.28)',
  },
  heroPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
    backgroundColor: 'rgba(225,29,72,0.16)',
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.live,
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.x2,
    marginVertical: space.x4,
  },
  card: {
    backgroundColor: colors.surface1,
    borderRadius: radius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  coverTop: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  whiteDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
  worldBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  coverBottom: {
    position: 'absolute',
    bottom: 12,
    left: 14,
    right: 14,
  },
  cardBody: {
    padding: space.x4,
    gap: space.x3,
  },
  pollBox: {
    padding: space.x3,
    borderRadius: radius.lg,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    gap: 8,
  },
  pollHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pollOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    gap: 8,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.x2,
    marginTop: 2,
  },
});
