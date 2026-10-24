import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LivePulse, LiveReactions } from '../../components/feed/LiveReactions';
import { ReactionGlyph } from '../../components/feed/Reactions';
import { Avatar } from '../../components/ui/Avatar';
import { Button } from '../../components/ui/Button';
import { Chip } from '../../components/ui/Chip';
import { Backdrop } from '../../components/ui/Poster';
import { Screen } from '../../components/ui/Screen';
import { ErrorState } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { useToast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import { colors, fonts, radius, space } from '../../constants/theme';
import {
  connectLiveEpisodeRoom,
  fetchHallyuEvents,
  type HallyuLiveEvent,
  type LiveRoomChatMessage,
  type LiveRoomConnection,
  type LiveRoomStatus,
  type LiveRoomViewer,
  toggleEventRsvp,
} from '../../lib/api/features';
import { isUuid } from '../../lib/api/social';
import { adoptDramas } from '../../lib/catalogSync';
import { FANDOMS } from '../../lib/fandoms';
import { timeAgo } from '../../lib/format';
import { haptic, useApp, useRequireMember } from '../../lib/hooks';
import { emptyReactions, type ReactionKind, REACTIONS } from '../../lib/model';

const STATUS_COPY: Record<LiveRoomStatus, { label: string; color: string }> = {
  connecting: { label: 'Connecting…', color: '#F59E0B' },
  connected: { label: 'Live Sync Active', color: '#10B981' },
  reconnecting: { label: 'Reconnecting…', color: '#F59E0B' },
  disconnected: { label: 'Left / Offline', color: colors.textTertiary },
  error: { label: 'Connection issue', color: colors.accent },
};

export default function WatchPartyRoomScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const requireMember = useRequireMember();
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const { me } = useApp();

  const [event, setEvent] = useState<HallyuLiveEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [roomStatus, setRoomStatus] = useState<LiveRoomStatus>('connecting');
  const [viewers, setViewers] = useState<LiveRoomViewer[]>([]);
  const [messages, setMessages] = useState<LiveRoomChatMessage[]>([]);
  const [burst, setBurst] = useState<{ seq: number; kind: ReactionKind } | null>(null);
  const [lastBurstFrom, setLastBurstFrom] = useState<string | null>(null);
  const [sceneStamp, setSceneStamp] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busyRsvp, setBusyRsvp] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);

  const roomRef = useRef<LiveRoomConnection | null>(null);
  const burstSeq = useRef(0);

  const loadEvent = useCallback(async () => {
    if (!eventId || !isUuid(eventId)) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const all = await fetchHallyuEvents('all');
      const found = all.find((item) => item.id === eventId) ?? null;
      if (!found) {
        setNotFound(true);
      } else {
        if (found.linkedDrama) adoptDramas([found.linkedDrama]);
        setEvent(found);
        setNotFound(false);
      }
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    void loadEvent();
  }, [loadEvent]);

  useEffect(() => {
    if (!event || notFound) return;
    const conn = connectLiveEpisodeRoom(
      `event-${event.id}`,
      {
        id: me.id,
        handle: me.handle,
        displayName: me.displayName,
        avatarUrl: me.avatarUrl,
      },
      {
        onStatusChange: setRoomStatus,
        onViewersChange: setViewers,
        onReactionBurst: (evt) => {
          setBurst({ seq: ++burstSeq.current, kind: evt.kind });
          setLastBurstFrom(
            evt.timestampTag
              ? `@${evt.senderHandle} reacted at ${evt.timestampTag}`
              : `@${evt.senderHandle} reacted live`,
          );
        },
        onChatMessage: (msg) => {
          setMessages((prev) => (prev.some((x) => x.id === msg.id) ? prev : [...prev.slice(-79), msg]));
        },
      },
    );
    roomRef.current = conn;
    return () => {
      conn.leave();
      roomRef.current = null;
    };
  }, [event?.id, me.id, me.handle, me.displayName, me.avatarUrl, notFound, reconnectKey, event]);

  const handleLeave = () => {
    roomRef.current?.leave();
    roomRef.current = null;
    toast.show({ message: 'Left Watch Party room' });
    if (router.canGoBack()) router.back();
    else router.replace('/events');
  };

  const handleSendReaction = (kind: ReactionKind) => {
    haptic.light();
    setBurst({ seq: ++burstSeq.current, kind });
    roomRef.current?.sendReaction(kind, sceneStamp ?? undefined);
  };

  const handleSendMessage = () => {
    const clean = draft.trim();
    if (!clean) return;
    requireMember('chat live in Watch Parties', () => {
      const sent = roomRef.current?.sendChat(clean, sceneStamp ?? undefined);
      if (sent) {
        haptic.light();
        setMessages((prev) => [...prev.slice(-79), sent]);
        setDraft('');
      }
    });
  };

  const handleVoteOrRsvp = (predictionIdx?: number) => {
    if (!event || busyRsvp) return;
    requireMember('RSVP & vote in Watch Parties', async () => {
      setBusyRsvp(true);
      try {
        const res = await toggleEventRsvp(
          event.id,
          predictionIdx !== undefined ? true : !event.viewerGoing,
          predictionIdx,
        );
        haptic.success();
        setEvent((prev) => {
          if (!prev) return prev;
          const nextCounts = { ...prev.predictionCounts };
          if (predictionIdx !== undefined) {
            if (prev.viewerPrediction !== null) {
              const prevKey = String(prev.viewerPrediction);
              nextCounts[prevKey] = Math.max(0, (nextCounts[prevKey] ?? 1) - 1);
            }
            const nextKey = String(predictionIdx);
            nextCounts[nextKey] = (nextCounts[nextKey] ?? 0) + 1;
          }
          return {
            ...prev,
            viewerGoing: res.going,
            rsvpCount: res.rsvpCount,
            viewerPrediction: res.predictionChoice,
            predictionCounts: nextCounts,
          };
        });
      } catch (err) {
        toast.show({
          message: err instanceof Error ? err.message : 'Could not update RSVP',
          tone: 'danger',
        });
      } finally {
        setBusyRsvp(false);
      }
    });
  };

  const statusMeta = STATUS_COPY[roomStatus];
  const fandom = useMemo(
    () => FANDOMS.find((f) => f.id === event?.world) ?? FANDOMS[0]!,
    [event?.world],
  );

  if (loading) {
    return (
      <Screen header={<TopBar mode="stack" title="Watch Party" />}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </Screen>
    );
  }

  if (notFound || !event) {
    return (
      <Screen header={<TopBar mode="stack" title="Watch Party" />}>
        <ErrorState
          kind="notFound"
          title="Watch Party unavailable"
          body="This Watch Party has ended or the link is no longer valid."
          onRetry={() => router.replace('/events')}
        />
      </Screen>
    );
  }

  const totalVotes = Object.values(event.predictionCounts).reduce((a, b) => a + b, 0);

  return (
    <Screen
      header={
        <TopBar
          mode="stack"
          title="Watch Party Room"
          right={
            <Button
              label="Leave"
              variant="secondary"
              size="sm"
              icon="exit-outline"
              onPress={handleLeave}
            />
          }
        />
      }
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={56}
      >
        <ScrollView
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: space.x6, gap: space.x4 }}
        >
          <Backdrop
            uri={event.coverUrl}
            fallbackColor={colors.surface2}
            width="100%"
            height={176}
            cinemaGradient
            accentGlow={`${fandom.tint}66`}
          >
            <LiveReactions
              counts={emptyReactions()}
              active
              burst={burst}
              style={{ right: 0, bottom: 0 }}
            />
            <View style={styles.heroTop}>
              <View style={styles.liveBadge}>
                <LivePulse size={6} />
                <Text variant="overline" style={{ color: '#FFFFFF' }}>
                  {statusMeta.label}
                </Text>
              </View>
              {(roomStatus === 'disconnected' || roomStatus === 'error') ? (
                <Button
                  label="Reconnect"
                  size="sm"
                  onPress={() => setReconnectKey((n) => n + 1)}
                />
              ) : null}
            </View>
            <View style={styles.heroBottom}>
              <Text variant="caption" style={{ color: colors.textSecondary }}>
                Hosted by @{event.host?.handle ?? 'ceohallyu'} · {viewers.length}{' '}
                {viewers.length === 1 ? 'member' : 'members'} in room
              </Text>
              <Text variant="title" style={{ marginTop: 2 }}>
                {event.title}
              </Text>
            </View>
          </Backdrop>

          {/* Honest Playback Stage Notice */}
          <View style={styles.stageCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="tv-outline" size={18} color={colors.accent} />
              <Text variant="label">Companion Watch Room (Live Presence, Reactions & Polls)</Text>
            </View>
            <Text variant="caption" tone="secondary">
              Play the episode alongside fellow fans while chatting, voting, and reacting together in
              real time. Direct in-app video playback will connect when Hallyu’s streaming engine launches.
            </Text>

            <View style={styles.viewerStrip}>
              {viewers.map((v) => (
                <Pressable
                  key={v.userId}
                  onPress={() => (v.handle !== 'guest' ? router.push(`/user/${v.handle}`) : undefined)}
                  style={styles.viewerChip}
                >
                  <Avatar uri={v.avatarUrl} name={v.displayName} size="xs" />
                  <Text variant="caption" numberOfLines={1}>
                    @{v.handle}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Button
                label={event.viewerGoing ? `Going · ${event.rsvpCount}` : `RSVP · ${event.rsvpCount}`}
                variant={event.viewerGoing ? 'secondary' : 'primary'}
                size="sm"
                icon={event.viewerGoing ? 'checkmark-circle' : 'notifications-outline'}
                loading={busyRsvp}
                onPress={() => void handleVoteOrRsvp()}
              />
              {event.linkedDrama || event.titleId ? (
                <Button
                  label={
                    event.season && event.episode
                      ? `Open S${event.season}E${event.episode} Thread`
                      : 'Open Show Hub'
                  }
                  variant="ghost"
                  size="sm"
                  icon="chatbubbles-outline"
                  onPress={() => {
                    const targetId = event.linkedDrama?.id ?? event.titleId!;
                    if (event.season && event.episode) {
                      router.push(`/episode/${targetId}/${event.season}/${event.episode}`);
                    } else {
                      router.push(`/drama/${targetId}`);
                    }
                  }}
                />
              ) : null}
            </View>
          </View>

          {/* Live Reactions Bar */}
          <View style={styles.card}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text variant="overline" tone="accent">
                LIVE ROOM REACTIONS
              </Text>
              {lastBurstFrom ? (
                <Text variant="caption" tone="secondary">
                  {lastBurstFrom}
                </Text>
              ) : null}
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {REACTIONS.map((r) => (
                <Pressable
                  key={r.kind}
                  onPress={() => handleSendReaction(r.kind)}
                  style={styles.reactionPill}
                  accessibilityRole="button"
                  accessibilityLabel={`Send live ${r.label} reaction`}
                >
                  <ReactionGlyph kind={r.kind} size={15} active />
                  <Text variant="caption">{r.label}</Text>
                </Pressable>
              ))}
            </ScrollView>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              {['05:00', '18:30', '34:00', '48:15', 'Finale'].map((ts) => (
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
          </View>

          {/* Prediction Poll */}
          {event.predictionQuestion && event.predictionOptions.length > 0 ? (
            <View style={styles.card}>
              <Text variant="overline" style={{ color: colors.warm }}>
                LIVE PREDICTION POLL
              </Text>
              <Text variant="titleSmall">{event.predictionQuestion}</Text>
              {event.predictionOptions.map((opt, idx) => {
                const count = event.predictionCounts[String(idx)] ?? 0;
                const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
                const picked = event.viewerPrediction === idx;
                return (
                  <Pressable
                    key={`${event.id}-poll-${idx}`}
                    onPress={() => void handleVoteOrRsvp(idx)}
                    disabled={busyRsvp}
                    style={[
                      styles.pollRow,
                      picked && {
                        borderColor: colors.accent,
                        backgroundColor: 'rgba(225,29,72,0.12)',
                      },
                    ]}
                  >
                    <Ionicons
                      name={picked ? 'checkmark-circle' : 'ellipse-outline'}
                      size={16}
                      color={picked ? colors.accent : colors.textTertiary}
                    />
                    <Text variant="bodySmall" style={{ flex: 1 }}>
                      {opt}
                    </Text>
                    {totalVotes > 0 ? (
                      <Text variant="caption" style={{ fontFamily: fonts.bold }}>
                        {pct}%
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          {/* Live Room Chat Feed */}
          <View style={styles.card}>
            <Text variant="overline" tone="secondary">
              LIVE ROOM CHAT ({messages.length})
            </Text>
            {messages.length === 0 ? (
              <Text variant="caption" tone="tertiary">
                Say hi or tag a timestamp above — everyone connected to this Watch Party sees your
                reactions immediately.
              </Text>
            ) : (
              messages.map((m) => (
                <View key={m.id} style={styles.chatRow}>
                  <Avatar uri={m.senderAvatarUrl} name={m.senderName} size="xs" />
                  <View style={{ flex: 1, gap: 2 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text variant="caption" style={{ fontFamily: fonts.semibold }}>
                        @{m.senderHandle}
                      </Text>
                      {m.timestampTag ? (
                        <Text variant="caption" tone="accent">
                          [{m.timestampTag}]
                        </Text>
                      ) : null}
                      <Text variant="caption" tone="tertiary">
                        {timeAgo(m.sentAt)}
                      </Text>
                    </View>
                    <Text variant="bodySmall">{m.body}</Text>
                  </View>
                </View>
              ))
            )}
          </View>
        </ScrollView>

        <View style={[styles.composer, { paddingBottom: insets.bottom + space.x2 }]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={
              sceneStamp ? `Message room [${sceneStamp}]…` : 'Message everyone in this Watch Party…'
            }
            placeholderTextColor={colors.textTertiary}
            returnKeyType="send"
            onSubmitEditing={handleSendMessage}
            style={styles.input}
          />
          <Button label="Send" size="sm" disabled={!draft.trim()} onPress={handleSendMessage} />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: space.margin,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  heroBottom: {
    marginTop: 'auto',
    padding: space.margin,
  },
  stageCard: {
    marginHorizontal: space.margin,
    padding: space.x4,
    borderRadius: radius.lg,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    gap: space.x3,
  },
  viewerStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  viewerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  card: {
    marginHorizontal: space.margin,
    padding: space.x4,
    borderRadius: radius.lg,
    backgroundColor: colors.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    gap: space.x2 + 2,
  },
  reactionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  pollRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  chatRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 4,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    paddingHorizontal: space.margin,
    paddingTop: space.x2,
    backgroundColor: colors.surface1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  input: {
    flex: 1,
    height: 40,
    paddingHorizontal: 14,
    borderRadius: radius.full,
    backgroundColor: colors.surface2,
    color: colors.textPrimary,
    fontSize: 14,
  },
});
