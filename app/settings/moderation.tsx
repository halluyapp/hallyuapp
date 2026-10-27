import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
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

export function resolveStudioTab(raw?: string): StudioTab {
  if (raw === 'support' || raw === 'tickets' || raw === 'bugs') return 'support';
  if (raw === 'creators') return 'creators';
  if (raw === 'reports') return 'reports';
  if (raw === 'communities' || raw === 'rooms') return 'communities';
  return 'broadcast';
}

export default function ModerationStudioScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string }>();
  const toast = useToast();
  const { me } = useApp();
  const [tab, setTab] = useState<StudioTab>(() => resolveStudioTab(params.tab));

  useEffect(() => {
    if (params.tab) {
      setTab(resolveStudioTab(params.tab));
    }
  }, [params.tab]);

  const [data, setData] = useState<StaffOverviewPayload | null>(null);
  const [tickets, setTickets] = useState<SupportTicketRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [grantHandle, setGrantHandle] = useState('');
  const [quotaMb, setQuotaMb] = useState(2048);
  const [busyId, setBusyId] = useState<string | null>(null);

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
  const openReportsCount = data?.reports.length ?? 0;

  return (
    <Screen
      header={
        <TopBar
          mode="stack"
          title="Admin & CEO Studio"
          right={
            <Button
              label="Full Console"
              variant="ghost"
              size="sm"
              icon="grid-outline"
              onPress={() => router.push('/admin')}
            />
          }
        />
      }
    >
      <Segmented
        scrollable
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
            label: openReportsCount ? `Reports (${openReportsCount})` : 'Reports',
            dot: openReportsCount > 0,
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
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.accent} />}
          contentContainerStyle={styles.content}
        >
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Chip
              label={`Bugs · ${openTickets.length}`}
              icon="bug-outline"
              size="sm"
              selected={tab === 'support'}
              onPress={() => setTab('support')}
            />
            <Chip
              label={`Reports · ${openReportsCount}`}
              icon="flag-outline"
              size="sm"
              selected={tab === 'reports'}
              onPress={() => setTab('reports')}
            />
            <Chip
              label={`Creators · ${pendingRequests.length}`}
              icon="videocam-outline"
              size="sm"
              selected={tab === 'creators'}
              onPress={() => setTab('creators')}
            />
            <Chip
              label={`Rooms · ${data?.communities.length ?? 0}`}
              icon="people-outline"
              size="sm"
              selected={tab === 'communities'}
              onPress={() => setTab('communities')}
            />
            <Chip
              label="Admin Console"
              icon="stats-chart-outline"
              size="sm"
              onPress={() => router.push('/admin')}
            />
          </View>

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
                  placeholder="e.g. Hallyu Founding Ten Launch Opens at 9:00 PM!"
                  value={bcTitle}
                  onChangeText={setBcTitle}
                />
                <TextField
                  label="Message Body"
                  placeholder="Jump into the synchronized room now & claim your place..."
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
                <Text variant="titleSmall">Commercial Admin Platform</Text>
                <Text variant="caption" tone="secondary">
                  Manage Launch & Founding Ten (#1–#10), Blue/Red Verification, Member Directory, Badges & Audit Ledger.
                </Text>
                <Button
                  label="Open Commercial Admin Console"
                  variant="secondary"
                  icon="stats-chart-outline"
                  onPress={() => router.push('/admin')}
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
                  label="Approve Creator"
                  icon="videocam"
                  loading={busyId === 'grant-handle'}
                  disabled={!grantHandle.trim()}
                  onPress={() => void handleGrantByHandle()}
                  block
                />
              </View>

              {pendingRequests.map((req) => (
                <View key={req.id} style={styles.card}>
                  <Text variant="titleSmall">
                    {req.displayName} (@{req.handle})
                  </Text>
                  {req.note ? (
                    <Text variant="bodySmall" tone="secondary">
                      {req.note}
                    </Text>
                  ) : null}
                  <View style={{ flexDirection: 'row', gap: space.x2 }}>
                    <Button
                      label="Approve"
                      size="sm"
                      loading={busyId === req.id}
                      onPress={() => void handleReviewRequest(req.id, req.handle, true)}
                      style={{ flex: 1 }}
                    />
                    <Button
                      label="Decline"
                      variant="secondary"
                      size="sm"
                      loading={busyId === req.id}
                      onPress={() => void handleReviewRequest(req.id, req.handle, false)}
                      style={{ flex: 1 }}
                    />
                  </View>
                </View>
              ))}

              {(data?.creators ?? []).map((c) => (
                <View key={c.userId} style={styles.card}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text variant="titleSmall">
                      {c.displayName} (@{c.handle})
                    </Text>
                    <Text variant="caption" tone="accent" numeric>
                      {formatMb(c.usedThisMonth)} / {formatMb(c.budget)}
                    </Text>
                  </View>
                </View>
              ))}
            </>
          ) : tab === 'reports' ? (
            (data?.reports ?? []).length === 0 ? (
              <EmptyState
                icon="shield-checkmark-outline"
                title="Zero open reports"
                body="Flagged posts, comments, and member profiles appear here for staff action."
              />
            ) : (
              (data?.reports ?? []).map((rep) => (
                <View key={rep.id} style={styles.card}>
                  <Text variant="overline" style={{ color: colors.danger }}>
                    {rep.targetType.toUpperCase()} · {rep.reason.toUpperCase()}
                  </Text>
                  {rep.postBody ? (
                    <Text variant="bodySmall" tone="secondary">
                      “{rep.postBody}”
                    </Text>
                  ) : null}
                  <View style={{ flexDirection: 'row', gap: space.x2 }}>
                    <Button
                      label="Hide Content"
                      size="sm"
                      loading={busyId === rep.id}
                      onPress={() => void handleReportDecision(rep.id, rep.targetType, rep.targetId, true)}
                      style={{ flex: 1 }}
                    />
                    <Button
                      label="Dismiss"
                      variant="secondary"
                      size="sm"
                      loading={busyId === rep.id}
                      onPress={() => void handleReportDecision(rep.id, rep.targetType, rep.targetId, false)}
                      style={{ flex: 1 }}
                    />
                  </View>
                </View>
              ))
            )
          ) : (
            (data?.communities ?? []).map((c) => (
              <View key={c.id} style={styles.card}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <Text variant="titleSmall">{c.name}</Text>
                    <Text variant="caption" tone="secondary">
                      {c.memberCount} members · {c.postCount} posts
                    </Text>
                  </View>
                  <Button
                    label={c.isLocked ? 'Unlock' : 'Lock'}
                    variant={c.isLocked ? 'primary' : 'secondary'}
                    size="sm"
                    loading={busyId === c.id}
                    onPress={() => void handleToggleLock(c.id, !c.isLocked)}
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
  card: {
    backgroundColor: colors.surface1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: space.x4,
    gap: space.x3,
  },
});
