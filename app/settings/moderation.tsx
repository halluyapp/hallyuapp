import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Avatar } from '../../components/ui/Avatar';
import { Button } from '../../components/ui/Button';
import { Chip, ChipRow } from '../../components/ui/Chip';
import { Screen } from '../../components/ui/Screen';
import { Segmented } from '../../components/ui/Segmented';
import { EmptyState, ErrorState } from '../../components/ui/States';
import { Text } from '../../components/ui/Text';
import { TextField } from '../../components/ui/TextField';
import { useToast } from '../../components/ui/Toast';
import { TopBar } from '../../components/ui/TopBar';
import { colors, radius, space } from '../../constants/theme';
import {
  fetchStaffOverview,
  fetchSupportTickets,
  grantVideoAccessByHandle,
  moderatePostState,
  resolveSupportTicket,
  reviewModerationReport,
  reviewVideoAccessRequest,
  sendCeoBroadcast,
  type StaffOverviewPayload,
  type SupportTicketRecord,
  toggleCommunityLock,
} from '../../lib/api/features';
import { timeAgo } from '../../lib/format';
import { haptic, useApp } from '../../lib/hooks';

type StudioTab = 'broadcast' | 'support' | 'creators' | 'reports' | 'communities';

const QUOTA_PRESETS = [
  { label: '1 GB / mo', mb: 1024 },
  { label: '2 GB / mo', mb: 2048 },
  { label: '5 GB / mo', mb: 5120 },
  { label: '10 GB / mo', mb: 10240 },
];

const BROADCAST_DESTINATIONS = [
  { label: 'Live Events Hub', path: '/events' },
  { label: 'Social Feed', path: '/' },
  { label: 'Explore Shows', path: '/(tabs)/explore' },
  { label: 'Communities', path: '/communities' },
  { label: 'App Updates', path: '/settings/updates' },
];

function formatMb(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export default function ModerationStudioScreen() {
  const router = useRouter();
  const toast = useToast();
  const { me } = useApp();
  const [tab, setTab] = useState<StudioTab>('broadcast');
  const [data, setData] = useState<StaffOverviewPayload | null>(null);
  const [tickets, setTickets] = useState<SupportTicketRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [grantHandle, setGrantHandle] = useState('');
  const [quotaMb, setQuotaMb] = useState(2048);
  const [busyId, setBusyId] = useState<string | null>(null);

  // CEO Megaphone state
  const [bcTitle, setBcTitle] = useState('');
  const [bcBody, setBcBody] = useState('');
  const [bcPath, setBcPath] = useState('/events');
  const [sendingBc, setSendingBc] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [next, nextTickets] = await Promise.all([
        fetchStaffOverview(),
        fetchSupportTickets('all').catch(() => []),
      ]);
      setData(next);
      setTickets(nextTickets);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load Admin Studio');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleBroadcast = async () => {
    if (!bcTitle.trim() || !bcBody.trim() || sendingBc) return;
    setSendingBc(true);
    try {
      const notifiedMembers = await sendCeoBroadcast({
        title: bcTitle.trim(),
        body: bcBody.trim(),
        deepLink: bcPath,
      });
      haptic.success();
      setBcTitle('');
      setBcBody('');
      toast.show({
        message: `Megaphone sent to ${notifiedMembers} member(s) + push queue!`,
        tone: 'success',
      });
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Broadcast failed',
        tone: 'danger',
      });
    } finally {
      setSendingBc(false);
    }
  };

  const handleResolveTicket = async (id: string, status: 'resolved' | 'investigating') => {
    setBusyId(id);
    try {
      await resolveSupportTicket(
        id,
        status,
        status === 'resolved' ? `Resolved by @${me.handle}` : `In review by @${me.handle}`,
      );
      haptic.success();
      toast.show({
        message: status === 'resolved' ? 'Ticket marked resolved & reporter notified!' : 'Marked in progress',
        tone: 'success',
      });
      await load();
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Could not update ticket',
        tone: 'danger',
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleGrantByHandle = async () => {
    const clean = grantHandle.trim().replace(/^@/, '');
    if (!clean) return;
    setBusyId('grant-handle');
    try {
      await grantVideoAccessByHandle(clean, quotaMb, `Granted by @${me.handle}`);
      haptic.success();
      setGrantHandle('');
      toast.show({
        message: `@${clean} now has Video Creator Access`,
        icon: 'checkmark-circle',
        tone: 'success',
      });
      await load();
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Could not grant video access',
        tone: 'danger',
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleReviewRequest = async (reqId: string, handle: string, approve: boolean) => {
    setBusyId(reqId);
    try {
      await reviewVideoAccessRequest(
        reqId,
        approve,
        quotaMb,
        approve ? 'Welcome to Hallyu Video Creators!' : 'Not approved yet — feel free to reapply anytime.',
      );
      haptic.success();
      toast.show({
        message: approve ? `Approved @${handle} for video uploads` : `Declined @${handle}'s request`,
        icon: approve ? 'checkmark-circle' : 'close-circle',
        tone: approve ? 'success' : 'default',
      });
      await load();
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Action failed',
        tone: 'danger',
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleReportDecision = async (
    reportId: string,
    targetType: string,
    targetId: string,
    hideContent: boolean,
  ) => {
    setBusyId(reportId);
    try {
      if (hideContent && targetType === 'post') {
        await moderatePostState(targetId, 'hidden', 'Hidden following community report review');
      }
      await reviewModerationReport(
        reportId,
        hideContent ? 'resolved' : 'dismissed',
        hideContent ? 'Content hidden by staff' : 'Reviewed — no violation found',
      );
      haptic.success();
      toast.show({
        message: hideContent ? 'Content hidden & report resolved' : 'Report dismissed',
        icon: 'checkmark-circle',
        tone: 'success',
      });
      await load();
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Could not update report',
        tone: 'danger',
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleLock = async (communityId: string, nextLock: boolean) => {
    setBusyId(communityId);
    try {
      await toggleCommunityLock(communityId, nextLock);
      haptic.light();
      toast.show({ message: nextLock ? 'Community locked' : 'Community unlocked' });
      await load();
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : 'Could not update community lock',
        tone: 'danger',
      });
    } finally {
      setBusyId(null);
    }
  };

  const pendingRequests = (data?.videoRequests ?? []).filter((r) => r.status === 'pending');
  const openTickets = tickets.filter((t) => t.status !== 'resolved');

  return (
    <Screen header={<TopBar mode="stack" title="Admin & CEO Studio" />}>
      <Segmented
        items={[
          { key: 'broadcast', label: 'Megaphone' },
          {
            key: 'support',
            label: openTickets.length ? `Bugs (${openTickets.length})` : 'Bugs',
            dot: openTickets.length > 0,
          },
          {
            key: 'creators',
            label: pendingRequests.length ? `Creators (${pendingRequests.length})` : 'Creators',
            dot: pendingRequests.length > 0,
          },
          {
            key: 'reports',
            label: data?.reports.length ? `Reports (${data.reports.length})` : 'Reports',
            dot: (data?.reports.length ?? 0) > 0,
          },
          { key: 'communities', label: 'Rooms' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {error ? (
        <ErrorState body={error} onRetry={load} />
      ) : (
        <ScrollView
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.accent} />}
          contentContainerStyle={styles.content}
        >
          {tab === 'broadcast' ? (
            <>
              <View style={styles.card}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Ionicons name="megaphone" size={20} color={colors.accent} />
                  <Text variant="titleSmall">CEO Global Push Megaphone</Text>
                </View>
                <Text variant="caption" tone="secondary">
                  Sends an instant real-time notification + Android FCM & iPhone Web Push lock-screen
                  alert to every Hallyu member worldwide.
                </Text>
                <TextField
                  label="Push Headline"
                  placeholder="e.g. 🔴 LIVE NOW: Doctor X Finale Watch Party!"
                  value={bcTitle}
                  onChangeText={setBcTitle}
                />
                <TextField
                  label="Message Body"
                  placeholder="Jump into the synchronized room now & vote before the twist drops..."
                  multiline
                  value={bcBody}
                  onChangeText={setBcBody}
                />
                <Text variant="overline" tone="secondary">
                  OPENS WHEN TAPPED
                </Text>
                <ChipRow>
                  {BROADCAST_DESTINATIONS.map((d) => (
                    <Chip
                      key={d.path}
                      label={d.label}
                      size="sm"
                      selected={bcPath === d.path}
                      onPress={() => setBcPath(d.path)}
                    />
                  ))}
                </ChipRow>
                <Button
                  label="Send Global Push Alert"
                  icon="paper-plane"
                  loading={sendingBc}
                  disabled={!bcTitle.trim() || !bcBody.trim()}
                  onPress={() => void handleBroadcast()}
                  block
                />
              </View>

              <View style={styles.card}>
                <Text variant="titleSmall">Host a Scheduled Watch Party</Text>
                <Text variant="caption" tone="secondary">
                  Create countdown Watch Parties & Episode Prediction Polls on the Live Events Hub.
                </Text>
                <Button
                  label="Open Live Events Hub"
                  variant="secondary"
                  icon="flame-outline"
                  onPress={() => router.push('/events')}
                  block
                />
              </View>
            </>
          ) : tab === 'support' ? (
            tickets.length === 0 ? (
              <EmptyState
                icon="checkmark-done-circle-outline"
                title="Zero open bug reports"
                body="In-app bug reports, crash traces, and missing show requests appear right here."
              />
            ) : (
              tickets.map((t) => (
                <View key={t.id} style={styles.card}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text
                      variant="overline"
                      style={{
                        color:
                          t.category === 'crash'
                            ? colors.danger
                            : t.status === 'resolved'
                              ? colors.success
                              : colors.accent,
                      }}
                    >
                      {t.category.toUpperCase()} · {t.status.toUpperCase()}
                    </Text>
                    <Text variant="caption" tone="tertiary">
                      {timeAgo(t.createdAt)}
                    </Text>
                  </View>
                  <Text variant="titleSmall">{t.subject}</Text>
                  <Text variant="bodySmall" tone="secondary">
                    {t.description}
                  </Text>
                  <Text variant="caption" tone="tertiary">
                    {t.reporter?.handle ? `@${t.reporter.handle}` : 'Guest'} · {t.platform} {t.appVersion}
                    {t.reporterEmail ? ` · ${t.reporterEmail}` : ''}
                  </Text>
                  {t.status !== 'resolved' ? (
                    <View style={{ flexDirection: 'row', gap: space.x2 }}>
                      <Button
                        label="Mark Resolved"
                        size="sm"
                        icon="checkmark-circle-outline"
                        loading={busyId === t.id}
                        onPress={() => void handleResolveTicket(t.id, 'resolved')}
                        style={{ flex: 1 }}
                      />
                      <Button
                        label="In Progress"
                        variant="secondary"
                        size="sm"
                        onPress={() => void handleResolveTicket(t.id, 'investigating')}
                        disabled={busyId === t.id}
                        style={{ flex: 1 }}
                      />
                    </View>
                  ) : null}
                </View>
              ))
            )
          ) : tab === 'creators' ? (
            <>
              <View style={styles.card}>
                <Text variant="titleSmall">Grant Creator Access by Handle</Text>
                <Text variant="caption" tone="secondary" style={{ marginBottom: space.x2 }}>
                  Instantly enable Shorts & HD video clips for any Hallyu member and send their welcome alert.
                </Text>
                <TextField
                  placeholder="handle (e.g. darasimi)"
                  value={grantHandle}
                  onChangeText={setGrantHandle}
                  leading="at-outline"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <ChipRow>
                  {QUOTA_PRESETS.map((q) => (
                    <Chip
                      key={q.mb}
                      label={q.label}
                      size="sm"
                      selected={quotaMb === q.mb}
                      onPress={() => setQuotaMb(q.mb)}
                    />
                  ))}
                </ChipRow>
                <Button
                  label="Grant Video Creator Access"
                  icon="videocam-outline"
                  onPress={handleGrantByHandle}
                  loading={busyId === 'grant-handle'}
                  disabled={!grantHandle.trim()}
                  block
                />
              </View>

              <Text variant="overline" tone="secondary" style={styles.sectionHeader}>
                PENDING ACCESS REQUESTS · {pendingRequests.length}
              </Text>
              {pendingRequests.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Ionicons name="checkmark-done-circle-outline" size={24} color={colors.success} />
                  <Text variant="bodySmall" tone="secondary">
                    No pending video access requests right now.
                  </Text>
                </View>
              ) : (
                pendingRequests.map((req) => (
                  <View key={req.id} style={styles.card}>
                    <Pressable
                      onPress={() => router.push(`/user/${req.handle}`)}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: space.x3 }}
                    >
                      <Avatar uri={req.avatarUrl} name={req.displayName} size="md" />
                      <View style={{ flex: 1 }}>
                        <Text variant="label">{req.displayName}</Text>
                        <Text variant="caption" tone="secondary">
                          @{req.handle} · {timeAgo(req.createdAt)}
                        </Text>
                      </View>
                    </Pressable>
                    {req.note ? (
                      <Text variant="bodySmall" tone="secondary">
                        “{req.note}”
                      </Text>
                    ) : null}
                    <View style={{ flexDirection: 'row', gap: space.x2 }}>
                      <Button
                        label="Approve"
                        size="sm"
                        icon="checkmark"
                        onPress={() => handleReviewRequest(req.id, req.handle, true)}
                        loading={busyId === req.id}
                        style={{ flex: 1 }}
                      />
                      <Button
                        label="Decline"
                        variant="secondary"
                        size="sm"
                        onPress={() => handleReviewRequest(req.id, req.handle, false)}
                        disabled={busyId === req.id}
                        style={{ flex: 1 }}
                      />
                    </View>
                  </View>
                ))
              )}

              <Text variant="overline" tone="secondary" style={styles.sectionHeader}>
                ACTIVE VIDEO CREATORS · {data?.creators.length ?? 0}
              </Text>
              {(data?.creators ?? []).map((creator) => (
                <Pressable
                  key={creator.userId}
                  onPress={() => router.push(`/user/${creator.handle}`)}
                  style={styles.creatorRow}
                >
                  <View style={{ flex: 1 }}>
                    <Text variant="label">
                      {creator.displayName}{' '}
                      <Text variant="caption" tone="secondary">
                        @{creator.handle}
                      </Text>
                    </Text>
                    <Text variant="caption" tone="tertiary">
                      {formatMb(creator.usedThisMonth)} used of {formatMb(creator.budget)} monthly quota
                    </Text>
                  </View>
                  <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                </Pressable>
              ))}
            </>
          ) : tab === 'reports' ? (
            (data?.reports.length ?? 0) === 0 ? (
              <EmptyState
                icon="shield-checkmark-outline"
                title="Moderation queue clear"
                body="Open community reports on posts, comments, or profiles will appear here for review."
              />
            ) : (
              data!.reports.map((rep) => (
                <View key={rep.id} style={styles.card}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text variant="overline" tone="accent">
                      {rep.targetType.toUpperCase()} · {rep.reason.toUpperCase()}
                    </Text>
                    <Text variant="caption" tone="tertiary">
                      {timeAgo(rep.createdAt)}
                    </Text>
                  </View>
                  {rep.postBody ? (
                    <Text variant="bodySmall" numberOfLines={3}>
                      “{rep.postBody}”
                    </Text>
                  ) : null}
                  {rep.detail ? (
                    <Text variant="caption" tone="secondary">
                      Reporter note: {rep.detail}
                    </Text>
                  ) : null}
                  <View style={{ flexDirection: 'row', gap: space.x2 }}>
                    <Button
                      label="Hide & Resolve"
                      size="sm"
                      icon="eye-off-outline"
                      onPress={() => handleReportDecision(rep.id, rep.targetType, rep.targetId, true)}
                      loading={busyId === rep.id}
                      style={{ flex: 1 }}
                    />
                    <Button
                      label="Dismiss"
                      variant="secondary"
                      size="sm"
                      onPress={() => handleReportDecision(rep.id, rep.targetType, rep.targetId, false)}
                      disabled={busyId === rep.id}
                      style={{ flex: 1 }}
                    />
                  </View>
                </View>
              ))
            )
          ) : (
            (data?.communities ?? []).map((comm) => (
              <View key={comm.id} style={styles.card}>
                <Pressable onPress={() => router.push(`/community/${comm.id}`)}>
                  <Text variant="titleSmall">{comm.name}</Text>
                  <Text variant="caption" tone="secondary" style={{ marginTop: 2 }}>
                    {comm.fandom.toUpperCase()} · {comm.memberCount} members · {comm.postCount} posts ·{' '}
                    {comm.joinPolicy}
                  </Text>
                </Pressable>
                <View style={{ flexDirection: 'row', gap: space.x2 }}>
                  <Button
                    label="Open Room"
                    variant="secondary"
                    size="sm"
                    onPress={() => router.push(`/community/${comm.id}`)}
                    style={{ flex: 1 }}
                  />
                  <Button
                    label={comm.isLocked ? 'Unlock Room' : 'Lock Room'}
                    variant="ghost"
                    size="sm"
                    icon={comm.isLocked ? 'lock-open-outline' : 'lock-closed-outline'}
                    onPress={() => handleToggleLock(comm.id, !comm.isLocked)}
                    loading={busyId === comm.id}
                  />
                </View>
              </View>
            ))
          )}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.margin,
    gap: space.x3,
    paddingBottom: space.x8,
  },
  sectionHeader: {
    marginTop: space.x3,
  },
  card: {
    backgroundColor: colors.surface2,
    borderRadius: radius.md,
    padding: space.x4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    gap: space.x3,
  },
  emptyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    backgroundColor: colors.surface1,
    borderRadius: radius.md,
    padding: space.x4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  creatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface1,
    borderRadius: radius.md,
    padding: space.x3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
});
