import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, View } from 'react-native';
import { FollowButton } from '../../components/drama/FollowButton';
import { Avatar } from '../../components/ui/Avatar';
import { useTabBarMotion } from '../../components/navigation/TabBarMotion';
import { Button } from '../../components/ui/Button';
import { Poster } from '../../components/ui/Poster';
import { useRefresh } from '../../components/ui/Refresh';
import { Screen, useListPadding } from '../../components/ui/Screen';
import { Segmented } from '../../components/ui/Segmented';
import { EmptyState } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { useToast } from '../../components/ui/Toast';
import { colors, radius, space } from '../../constants/theme';
import { fetchFollowRequests, respondFollowRequest, type IncomingFollowRequest } from '../../lib/api/features';
import { useAuth } from '../../lib/auth';
import { dayLabel, timeAgo } from '../../lib/format';
import { haptic, useApp } from '../../lib/hooks';
import { Notification, NotificationGroup } from '../../lib/model';
import { getState } from '../../lib/store';
import { adoptLocal, adoptNotifications } from '../../lib/sync';

type Tab = 'all' | NotificationGroup;

const GROUP_LABEL: Record<NotificationGroup, string> = { social: 'Social', drama: 'Dramas', mentions: 'Mentions', system: 'System' };

/** Activity — grouped, calm, actionable. Not an unread-number graveyard. */
export default function Activity() {
  const router = useRouter();
  const tabBar = useTabBarMotion();
  const refresh = useRefresh('activity');
  const auth = useAuth();
  const toast = useToast();
  const { state, dispatch, getUser, getDrama, getPost, getCollection } = useApp();
  const [tab, setTab] = useState<Tab>('all');
  const [followReqs, setFollowReqs] = useState<IncomingFollowRequest[]>([]);
  const [busyReqId, setBusyReqId] = useState<string | null>(null);
  const padding = useListPadding();
  const guest = auth.status !== 'signedIn';

  const loadFollowReqs = useCallback(async () => {
    if (guest) return;
    const res = await fetchFollowRequests().catch(() => null);
    if (res) setFollowReqs(res.incoming);
  }, [guest]);

  useFocusEffect(
    useCallback(() => {
      dispatch({ type: 'seenActivity' });
      void adoptNotifications({
        getState,
        apply: (patch) => adoptLocal({ type: 'hydrate', state: patch }),
      });
      void loadFollowReqs();
    }, [dispatch, loadFollowReqs]),
  );

  React.useEffect(() => {
    if (!refresh.refreshing) return;
    void adoptNotifications({
      getState,
      apply: (patch) => adoptLocal({ type: 'hydrate', state: patch }),
    });
    void loadFollowReqs();
  }, [refresh.refreshing, loadFollowReqs]);

  const handleFollowRequest = async (req: IncomingFollowRequest, accept: boolean) => {
    setBusyReqId(req.id);
    try {
      await respondFollowRequest(req.requesterId, accept);
      haptic.success();
      setFollowReqs((prev) => prev.filter((r) => r.id !== req.id));
      toast.show({
        message: accept ? `Accepted @${req.handle}'s follow request` : `Declined @${req.handle}`,
        tone: accept ? 'success' : 'default',
      });
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Could not update follow request',
        tone: 'danger',
      });
    } finally {
      setBusyReqId(null);
    }
  };

  const items = useMemo(() => state.notifications.filter((n) => tab === 'all' || n.group === tab).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.notifications, tab]);
  const sections = useMemo(() => {
    const map = new Map<string, Notification[]>();
    for (const n of items) {
      const k = dayLabel(n.createdAt);
      const label = ['Today', 'Yesterday'].includes(k) ? k : new Date(n.createdAt) > new Date(Date.now() - 7 * 86_400_000) ? 'This week' : 'Earlier';
      map.set(label, [...(map.get(label) ?? []), n]);
    }
    return [...map.entries()].map(([title, data]) => ({ title, data }));
  }, [items]);
  const counts = useMemo(() => ({ all: state.notifications.filter((n) => !n.read).length, social: state.notifications.filter((n) => !n.read && n.group === 'social').length, drama: state.notifications.filter((n) => !n.read && n.group === 'drama').length, mentions: state.notifications.filter((n) => !n.read && n.group === 'mentions').length, system: state.notifications.filter((n) => !n.read && n.group === 'system').length }), [state.notifications]);

  const describe = (n: Notification): { text: string; sub?: string; icon: keyof typeof Ionicons.glyphMap; go: () => void } => {
    const actors = (n.actorIds ?? []).map((a) => getUser(a)).filter(Boolean);
    const names = actors.length > 2 ? `${actors[0]!.displayName}, ${actors[1]!.displayName} and ${actors.length - 2} others` : actors.map((a) => a!.displayName).join(' and ');
    const post = getPost(n.postId);
    const drama = getDrama(n.dramaId);
    const col = getCollection(n.collectionId);
    const snippet = post ? (post.title ?? post.body).slice(0, 60) : undefined;
    switch (n.kind) {
      case 'reaction':
        return { text: `${names} reacted to your ${post?.type ?? 'post'}`, sub: snippet, icon: 'heart-outline', go: () => post && router.push(`/post/${post.id}`) };
      case 'comment':
        return { text: `${names} commented on your ${post?.type ?? 'post'}`, sub: snippet, icon: 'chatbubble-outline', go: () => post && router.push(`/post/${post.id}`) };
      case 'reply':
        return { text: `${names} replied to you`, sub: snippet, icon: 'arrow-undo-outline', go: () => post && router.push({ pathname: '/post/[id]', params: { id: post.id, commentId: n.commentId ?? '' } }) };
      case 'mention':
        return { text: `${names} mentioned you`, sub: snippet, icon: 'at-outline', go: () => post && router.push(`/post/${post.id}`) };
      case 'follow':
        return { text: `${names} started following you`, icon: 'person-add-outline', go: () => actors[0] && router.push(`/user/${actors[0]!.handle}`) };
      case 'episode_live':
        return { text: `${drama?.title} · Episode ${n.episode} just aired`, sub: 'The room is live — join the conversation', icon: 'radio-outline', go: () => drama && router.push(`/episode/${drama.id}/${drama.seasons.at(-1)?.number ?? 1}/${n.episode}`) };
      case 'episode_aired':
        return { text: `${drama?.title} · Episode ${n.episode} is out`, sub: 'Mark it watched when you’re done', icon: 'play-circle-outline', go: () => drama && router.push(`/episode/${drama.id}/${drama.seasons.at(-1)?.number ?? 1}/${n.episode}`) };
      case 'drama_trending':
        return { text: `${drama?.title} is trending`, sub: 'See what the fandom is saying', icon: 'trending-up-outline', go: () => drama && router.push(`/drama/${drama.id}`) };
      case 'collection_saved':
        return { text: `${names} followed your collection “${col?.title ?? ''}”`, icon: 'albums-outline', go: () => col && router.push(`/collection/${col.id}`) };
      default:
        return { text: n.title ?? 'Hallyu', sub: n.body, icon: 'information-circle-outline', go: () => n.title?.includes('Spoiler') && router.push('/settings/content') };
    }
  };

  if (guest) {
    return (
      <Screen header={<TopBar mode="root" title="Activity" large />}>
        <EmptyState icon="notifications-outline" title="Your activity lives here" body="Reactions, replies, episode nights and mentions — once you join." actionLabel="Join Hallyu" onAction={() => router.push('/(auth)/welcome')} />
      </Screen>
    );
  }

  return (
    <Screen header={<TopBar mode="root" title="Activity" large right={counts.all ? <Button label="Mark all read" variant="ghost" size="sm" onPress={() => dispatch({ type: 'readNotifications', group: 'all' })} /> : null} />}>
      <Segmented scrollable items={[{ key: 'all', label: 'All', dot: counts.all > 0 }, { key: 'social', label: 'Social', dot: counts.social > 0 }, { key: 'drama', label: 'Dramas', dot: counts.drama > 0 }, { key: 'mentions', label: 'Mentions', dot: counts.mentions > 0 }, { key: 'system', label: 'System', dot: counts.system > 0 }]} value={tab} onChange={setTab} />
      <SectionList
        refreshControl={refresh.control}
        onScroll={tabBar.onScroll}
        scrollEventThrottle={16}
        sections={sections}
        keyExtractor={(n) => n.id}
        contentContainerStyle={[padding, sections.length || followReqs.length ? null : { flex: 1 }]}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          followReqs.length > 0 ? (
            <View style={{ paddingHorizontal: space.margin, paddingTop: space.x3, gap: space.x2 }}>
              <Text variant="overline" tone="accent">
                FOLLOW REQUESTS · {followReqs.length}
              </Text>
              {followReqs.map((req) => (
                <View
                  key={req.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.x3,
                    padding: space.x3,
                    borderRadius: radius.md,
                    backgroundColor: colors.surface2,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: colors.borderStrong,
                  }}
                >
                  <Pressable
                    onPress={() => router.push(`/user/${req.handle}`)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: space.x3, flex: 1 }}
                  >
                    <Avatar uri={req.avatarUrl} name={req.displayName} size="md" />
                    <View style={{ flex: 1 }}>
                      <Text variant="label" numberOfLines={1}>
                        {req.displayName}
                      </Text>
                      <Text variant="caption" tone="secondary" numberOfLines={1}>
                        @{req.handle} wants to follow you
                      </Text>
                    </View>
                  </Pressable>
                  <Button
                    label="Approve"
                    size="sm"
                    onPress={() => handleFollowRequest(req, true)}
                    loading={busyReqId === req.id}
                  />
                  <Button
                    label="Decline"
                    variant="secondary"
                    size="sm"
                    onPress={() => handleFollowRequest(req, false)}
                    disabled={busyReqId === req.id}
                  />
                </View>
              ))}
            </View>
          ) : null
        }
        renderSectionHeader={({ section }) => (
          <Text variant="overline" style={styles.sectionTitle}>
            {section.title}
          </Text>
        )}
        ListEmptyComponent={<EmptyState icon="notifications-off-outline" title={tab === 'mentions' ? 'No mentions yet' : tab === 'drama' ? 'No episode news yet' : 'All quiet'} body={tab === 'drama' ? 'Follow airing dramas with notifications on and episode nights will show up here.' : tab === 'mentions' ? 'When someone @mentions or replies to you, it lands here.' : 'New reactions, replies and episode nights will appear here.'} actionLabel={tab === 'drama' ? 'Find airing dramas' : undefined} onAction={() => router.push('/schedule')} />}
        renderItem={({ item: n }) => {
          const d = describe(n);
          const actor = n.actorIds?.[0] ? getUser(n.actorIds[0]) : undefined;
          const drama = getDrama(n.dramaId);
          return (
            <Pressable onPress={() => { dispatch({ type: 'readNotifications', id: n.id }); d.go(); }} style={({ pressed }) => [styles.row, !n.read ? styles.unread : null, pressed ? { backgroundColor: colors.surface2 } : null]} accessibilityRole="button" accessibilityLabel={`${n.read ? '' : 'Unread. '}${d.text}${d.sub ? `. ${d.sub}` : ''}. ${timeAgo(n.createdAt)}`}>
              {actor ? <Avatar uri={actor.avatarUrl} name={actor.displayName} size="md" /> : drama ? <Poster drama={drama} width={40} rounded={6} /> : <View style={styles.sysIcon}><Ionicons name={d.icon} size={20} color={colors.textPrimary} /></View>}
              <View style={{ flex: 1 }}>
                <Text variant="bodySmall" numberOfLines={2}>
                  {d.text}
                </Text>
                {d.sub ? (
                  <Text variant="caption" tone="secondary" numberOfLines={1}>
                    {d.sub}
                  </Text>
                ) : null}
                <Text variant="caption" tone="tertiary" style={{ marginTop: 2 }}>
                  {timeAgo(n.createdAt)} · {GROUP_LABEL[n.group]}
                </Text>
              </View>
              {n.kind === 'follow' && actor && (n.actorIds?.length ?? 0) === 1 ? (
                <FollowButton kind="users" id={actor.id} name={actor.displayName} size="sm" />
              ) : (
                <View style={styles.kindIcon}>
                  <Ionicons name={d.icon} size={14} color={!n.read ? colors.accentText : colors.textTertiary} />
                </View>
              )}
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  sectionTitle: { paddingHorizontal: space.margin, paddingTop: space.x5, paddingBottom: space.x2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.x3, paddingHorizontal: space.margin, paddingVertical: space.x3 },
  unread: { backgroundColor: colors.surface1 },
  sysIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  kindIcon: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
});
