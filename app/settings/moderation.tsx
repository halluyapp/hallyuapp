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
  grantVideoAccessByHandle,
  moderatePostState,
  reviewModerationReport,
  reviewVideoAccessRequest,
  toggleCommunityLock,
  type StaffOverviewPayload,
} from '../../lib/api/features';
import { timeAgo } from '../../lib/format';
import { haptic, useApp } from '../../lib/hooks';

type StudioTab = 'creators' | 'reports' | 'communities';

const QUOTA_PRESETS = [
  { label: '1 GB / mo', mb: 1024 },
  { label: '2 GB / mo', mb: 2048 },
  { label: '5 GB / mo', mb: 5120 },
  { label: '10 GB / mo', mb: 10240 },
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
  const [tab, setTab] = useState<StudioTab>('creators');
  const [data, setData] = useState<StaffOverviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [grantHandle, setGrantHandle] = useState('');
  const [quotaMb, setQuotaMb] = useState(2048);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchStaffOverview();
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load Staff Studio');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <Screen header={<TopBar mode="stack" title="Admin & Creator Studio" />}>
      <Segmented
        items={[
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
          {tab === 'creators' ? (
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
                      {creator.displayName} <Text variant="caption" tone="secondary">@{creator.handle}</Text>
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
                    {comm.fandom.toUpperCase()} · {comm.memberCount} members · {comm.postCount} posts · {comm.joinPolicy}
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
