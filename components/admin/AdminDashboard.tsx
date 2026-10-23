import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { colors, radius, space } from '../../constants/theme';
import {
  createHallyuEvent,
  fetchStaffOverview,
  fetchSupportTickets,
  grantVideoAccessByHandle,
  moderatePostState,
  resolveSupportTicket,
  reviewModerationReport,
  reviewVideoAccessRequest,
  sendCeoBroadcast,
  toggleCommunityLock,
  type StaffOverviewPayload,
  type SupportTicketRecord,
} from '../../lib/api/features';
import {
  adminGrantBadge,
  adminListAuditLog,
  adminListVerificationRequests,
  adminManageUserAccount,
  adminReviewVerificationRequest,
  adminRevokeBadge,
  adminSearchUsers,
  adminSetVerification,
  adminUpdateRecognitionConfig,
  adminUpsertBadgeDefinition,
  fetchAdminDashboardMetrics,
  fetchUserRecognition,
  type AdminDashboardMetrics,
  type AdminUserRecord,
  type AdminVerificationQueueItem,
  type RecognitionAuditEntry,
} from '../../lib/api/recognition';
import { compact, timeAgo } from '../../lib/format';
import { haptic, useApp, useLayout } from '../../lib/hooks';
import type { BadgeCategory, BadgeDefinition, BadgeRarity } from '../../lib/model';
import { BadgeCrest } from '../recognition/BadgeCrest';
import { VerificationSeal } from '../recognition/VerificationSeal';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { Chip, ChipRow } from '../ui/Chip';
import { Screen } from '../ui/Screen';
import { Segmented } from '../ui/Segmented';
import { Sheet } from '../ui/Sheet';
import { EmptyState, ErrorState } from '../ui/States';
import { Text } from '../ui/Text';
import { TextField } from '../ui/TextField';
import { useToast } from '../ui/Toast';
import { TopBar } from '../ui/TopBar';

export type AdminSection =
  | 'overview'
  | 'launch'
  | 'users'
  | 'badges'
  | 'verification'
  | 'broadcast'
  | 'support'
  | 'creators'
  | 'reports'
  | 'communities'
  | 'audit';

export function resolveAdminSection(raw?: string, fallback: AdminSection = 'overview'): AdminSection {
  if (!raw) return fallback;
  const clean = raw.toLowerCase().trim();
  if (clean === 'overview' || clean === 'dashboard' || clean === 'kpis') return 'overview';
  if (clean === 'launch' || clean === 'founding') return 'launch';
  if (clean === 'users' || clean === 'members') return 'users';
  if (clean === 'badges' || clean === 'awards' || clean === 'achievements') return 'badges';
  if (clean === 'verification' || clean === 'verify') return 'verification';
  if (clean === 'broadcast' || clean === 'megaphone') return 'broadcast';
  if (clean === 'support' || clean === 'tickets' || clean === 'bugs') return 'support';
  if (clean === 'creators' || clean === 'video') return 'creators';
  if (clean === 'reports' || clean === 'moderation') return 'reports';
  if (clean === 'communities' || clean === 'rooms') return 'communities';
  if (clean === 'audit' || clean === 'logs') return 'audit';
  return fallback;
}

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

const ICON_KEYS = [
  'crown_star',
  'laurel_shield',
  'pillar_flame',
  'sunrise_horizon',
  'spark_quill',
  'thread_weave',
  'lantern_circle',
  'quill_scroll',
  'cinema_lens',
  'curated_vault',
  'constellation_orbit',
  'compass_worlds',
  'beacon_tower',
  'shield_crest',
];

function formatMb(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function formatLaunchClockStatus(iso: string): { isLive: boolean; label: string } {
  const diff = Date.parse(iso) - Date.now();
  if (Number.isNaN(diff) || diff <= 0) {
    return { isLive: true, label: 'LAUNCH LIVE — Early-member slots actively evaluating' };
  }
  const s = Math.floor(diff / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return {
    isLive: false,
    label: `PRE-LAUNCH ARMED — Starts in ${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`,
  };
}

export function AdminDashboard({
  initialSection = 'overview',
  routeParam,
  title = 'Hallyu Admin Console',
}: {
  initialSection?: AdminSection;
  routeParam?: string;
  title?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const { me } = useApp();
  const { width } = useLayout();
  const isWide = width >= 980;
  const isAdmin = me.role === 'admin';

  const [section, setSection] = useState<AdminSection>(() =>
    resolveAdminSection(routeParam, initialSection),
  );
  useEffect(() => {
    if (routeParam) {
      setSection(resolveAdminSection(routeParam, initialSection));
    }
  }, [routeParam, initialSection]);

  // Core data slices
  const [metrics, setMetrics] = useState<AdminDashboardMetrics | null>(null);
  const [staffData, setStaffData] = useState<StaffOverviewPayload | null>(null);
  const [tickets, setTickets] = useState<SupportTicketRecord[]>([]);
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [catalog, setCatalog] = useState<BadgeDefinition[]>([]);
  const [verifQueue, setVerifQueue] = useState<AdminVerificationQueueItem[]>([]);
  const [auditEntries, setAuditEntries] = useState<RecognitionAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, setClockTick] = useState(0);

  // User search state
  const [userQuery, setUserQuery] = useState('');
  const [userFilter, setUserFilter] = useState<
    'all' | 'verified_blue' | 'verified_red' | 'staff' | 'suspended' | 'excluded' | 'early_awards'
  >('all');
  const [inspectingUser, setInspectingUser] = useState<AdminUserRecord | null>(null);
  const [adminReason, setAdminReason] = useState('');
  const [selectedBadgeToGrant, setSelectedBadgeToGrant] = useState('founding_member');
  const [releaseSlotOnRevoke, setReleaseSlotOnRevoke] = useState(false);

  // Launch clock config form state
  const [cfgLaunchIso, setCfgLaunchIso] = useState('2026-10-23T20:00:00.000Z');
  const [cfgDayOneHours, setCfgDayOneHours] = useState('24');
  const [cfgFoundingDays, setCfgFoundingDays] = useState('14');
  const [cfgFoundingCap, setCfgFoundingCap] = useState('250');
  const [cfgEnabled, setCfgEnabled] = useState(true);
  const [cfgReason, setCfgReason] = useState('');

  // Verification review & direct verify state
  const [verifFilter, setVerifFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [verifReviewReason, setVerifReviewReason] = useState('');
  const [directVerifyHandle, setDirectVerifyHandle] = useState('');
  const [directVerifyTier, setDirectVerifyTier] = useState<'blue' | 'red' | 'none'>('blue');
  const [directVerifyReason, setDirectVerifyReason] = useState('');

  // Custom badge studio state
  const [badgeCreatorOpen, setBadgeCreatorOpen] = useState(false);
  const [newBadgeId, setNewBadgeId] = useState('');
  const [newBadgeName, setNewBadgeName] = useState('');
  const [newBadgeSubtitle, setNewBadgeSubtitle] = useState('');
  const [newBadgeDesc, setNewBadgeDesc] = useState('');
  const [newBadgeCategory, setNewBadgeCategory] = useState<BadgeCategory>('community');
  const [newBadgeRarity, setNewBadgeRarity] = useState<BadgeRarity>('rare');
  const [newBadgeIcon, setNewBadgeIcon] = useState('shield_crest');
  const [newBadgeHex, setNewBadgeHex] = useState('#F59E0B');
  const [newBadgeSupply, setNewBadgeSupply] = useState('');

  // Audit filter
  const [auditDomain, setAuditDomain] = useState<
    'all' | 'award' | 'verification' | 'launch_config' | 'user_admin'
  >('all');

  // Legacy Studio controls (Megaphone / Creators)
  const [bcTitle, setBcTitle] = useState('');
  const [bcBody, setBcBody] = useState('');
  const [bcPath, setBcPath] = useState('/events');
  const [sendingBc, setSendingBc] = useState(false);
  const [grantHandle, setGrantHandle] = useState('');
  const [quotaMb, setQuotaMb] = useState(2048);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [staffRes, ticketRes, metricsRes, usersRes, recogRes, verifRes, auditRes] =
        await Promise.all([
          fetchStaffOverview(),
          fetchSupportTickets('all').catch(() => []),
          fetchAdminDashboardMetrics().catch(() => null),
          adminSearchUsers(userQuery, userFilter, 60, 0).catch(() => []),
          fetchUserRecognition(me.id).catch(() => null),
          adminListVerificationRequests(verifFilter, 50).catch(() => []),
          adminListAuditLog(auditDomain, 80).catch(() => []),
        ]);

      setStaffData(staffRes);
      setTickets(ticketRes);
      if (metricsRes) {
        setMetrics(metricsRes);
        setCfgLaunchIso(metricsRes.config.launchStartsAt);
        setCfgDayOneHours(String(metricsRes.config.dayOneWindowHours));
        setCfgFoundingDays(String(metricsRes.config.foundingMemberWindowDays));
        setCfgFoundingCap(String(metricsRes.config.foundingMemberCap));
        setCfgEnabled(metricsRes.config.awardsEnabled);
      }
      setUsers(usersRes);
      if (recogRes?.catalog) setCatalog(recogRes.catalog);
      setVerifQueue(verifRes);
      setAuditEntries(auditRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Staff privileges required to open Admin Console');
    } finally {
      setLoading(false);
    }
  }, [userQuery, userFilter, verifFilter, auditDomain, me.id]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    const timer = setInterval(() => setClockTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const pendingVideoCount = (staffData?.videoRequests ?? []).filter((r) => r.status === 'pending').length;
  const openTicketsCount = tickets.filter((t) => t.status !== 'resolved').length;
  const openReportsCount = staffData?.reports.length ?? 0;
  const pendingVerifCount = metrics?.kpis.pendingVerifications ?? verifQueue.filter((q) => q.request.status === 'pending').length;

  const navGroups = useMemo<
    {
      heading: string;
      items: {
        key: AdminSection;
        label: string;
        short: string;
        icon: React.ComponentProps<typeof Ionicons>['name'];
        badge?: number;
      }[];
    }[]
  >(
    () => [
      {
        heading: 'COMMAND',
        items: [
          { key: 'overview' as AdminSection, label: 'Executive Overview', short: 'Overview', icon: 'stats-chart-outline' as const },
          { key: 'launch' as AdminSection, label: 'Launch & Founding 10', short: 'Launch', icon: 'rocket-outline' as const },
          { key: 'users' as AdminSection, label: 'User Directory', short: 'Users', icon: 'people-outline' as const },
        ],
      },
      {
        heading: 'RECOGNITION & TRUST',
        items: [
          {
            key: 'verification' as AdminSection,
            label: 'Verification Queue',
            short: pendingVerifCount ? `Verify (${pendingVerifCount})` : 'Verify',
            icon: 'shield-checkmark-outline' as const,
            badge: pendingVerifCount,
          },
          { key: 'badges' as AdminSection, label: 'Badges & Awards', short: 'Badges', icon: 'ribbon-outline' as const },
          { key: 'audit' as AdminSection, label: 'Audit Ledger', short: 'Audit', icon: 'receipt-outline' as const },
        ],
      },
      {
        heading: 'SAFETY & GROWTH',
        items: [
          { key: 'broadcast' as AdminSection, label: 'CEO Megaphone', short: 'Megaphone', icon: 'megaphone-outline' as const },
          {
            key: 'support' as AdminSection,
            label: 'Bug & Support Inbox',
            short: openTicketsCount ? `Bugs (${openTicketsCount})` : 'Bugs',
            icon: 'bug-outline' as const,
            badge: openTicketsCount,
          },
          {
            key: 'reports' as AdminSection,
            label: 'Content Reports',
            short: openReportsCount ? `Reports (${openReportsCount})` : 'Reports',
            icon: 'flag-outline' as const,
            badge: openReportsCount,
          },
          {
            key: 'creators' as AdminSection,
            label: 'Video Creators',
            short: pendingVideoCount ? `Creators (${pendingVideoCount})` : 'Creators',
            icon: 'videocam-outline' as const,
            badge: pendingVideoCount,
          },
          { key: 'communities' as AdminSection, label: 'Community Rooms', short: 'Rooms', icon: 'chatbubbles-outline' as const },
        ],
      },
    ],
    [pendingVerifCount, openTicketsCount, openReportsCount, pendingVideoCount],
  );

  // ── Action Handlers ───────────────────────────────────────────────────────────────────────────

  const handleSaveLaunchConfig = async (overrideIso?: string, overrideReason?: string) => {
    const reason = (overrideReason ?? cfgReason).trim();
    if (reason.length < 4) {
      toast.show({ message: 'Enter an audit reason (min 4 characters)', tone: 'danger' });
      return;
    }
    setBusyId('save-config');
    try {
      await adminUpdateRecognitionConfig({
        launchStartsAt: overrideIso ?? cfgLaunchIso.trim(),
        dayOneWindowHours: Math.max(1, Number(cfgDayOneHours) || 24),
        foundingMemberWindowDays: Math.max(1, Number(cfgFoundingDays) || 14),
        foundingMemberCap: Math.max(10, Number(cfgFoundingCap) || 250),
        awardsEnabled: cfgEnabled,
        reason,
      });
      setCfgReason('');
      haptic.success();
      toast.show({ message: 'Launch clock & early-member rules updated', tone: 'success' });
      await loadAll();
    } catch (err) {
      toast.show({ message: err instanceof Error ? err.message : 'Update failed', tone: 'danger' });
    } finally {
      setBusyId(null);
    }
  };

  const handleSetMemberVerification = async (
    targetId: string,
    tier: 'none' | 'blue' | 'red',
    reasonInput?: string,
  ) => {
    const reason = (reasonInput ?? adminReason).trim();
    if (reason.length < 4) {
      toast.show({ message: 'Enter a clear audit reason first', tone: 'danger' });
      return;
    }
    setBusyId(`verif-${targetId}`);
    try {
      await adminSetVerification(targetId, tier, reason);
      haptic.success();
      toast.show({
        message: tier === 'none' ? 'Verification revoked & logged' : `${tier.toUpperCase()} verification granted`,
        tone: 'success',
      });
      setInspectingUser(null);
      setAdminReason('');
      await loadAll();
    } catch (err) {
      toast.show({ message: err instanceof Error ? err.message : 'Verification update failed', tone: 'danger' });
    } finally {
      setBusyId(null);
    }
  };

  const handleDirectVerifyByHandle = async () => {
    const clean = directVerifyHandle.trim().replace(/^@/, '').toLowerCase();
    if (!clean || directVerifyReason.trim().length < 4) {
      toast.show({ message: 'Provide @handle and audit reason', tone: 'danger' });
      return;
    }
    setBusyId('direct-verify');
    try {
      const found = await adminSearchUsers(clean, 'all', 10, 0);
      const exact = found.find((u) => u.handle.toLowerCase() === clean);
      if (!exact) throw new Error(`Member @${clean} not found`);
      await adminSetVerification(exact.id, directVerifyTier, directVerifyReason.trim());
      setDirectVerifyHandle('');
      setDirectVerifyReason('');
      haptic.success();
      toast.show({
        message: `@${exact.handle} verification set to ${directVerifyTier.toUpperCase()}`,
        tone: 'success',
      });
      await loadAll();
    } catch (err) {
      toast.show({ message: err instanceof Error ? err.message : 'Direct verification failed', tone: 'danger' });
    } finally {
      setBusyId(null);
    }
  };

  const handleReviewVerification = async (
    reqId: string,
    decision: 'approved' | 'rejected',
    tier: 'blue' | 'red',
  ) => {
    const reason =
      verifReviewReason.trim() ||
      (decision === 'approved'
        ? `Identity verified by @${me.handle}`
        : `Insufficient identity proof at this time`);
    setBusyId(reqId);
    try {
      await adminReviewVerificationRequest(reqId, decision, tier, reason);
      setVerifReviewReason('');
      haptic.success();
      toast.show({
        message: decision === 'approved' ? `Approved ${tier.toUpperCase()} verification` : 'Request declined',
        tone: 'success',
      });
      await loadAll();
    } catch (err) {
      toast.show({ message: err instanceof Error ? err.message : 'Review failed', tone: 'danger' });
    } finally {
      setBusyId(null);
    }
  };

  const handleManualGrantBadge = async (targetUserId: string) => {
    const reason = adminReason.trim();
    if (reason.length < 4) {
      toast.show({ message: 'Enter an audit reason before granting a badge', tone: 'danger' });
      return;
    }
    setBusyId(`grant-${targetUserId}`);
    try {
      await adminGrantBadge(targetUserId, selectedBadgeToGrant, reason);
      haptic.success();
      toast.show({ message: `Badge "${selectedBadgeToGrant}" granted & member notified`, tone: 'success' });
      setInspectingUser(null);
      setAdminReason('');
      await loadAll();
    } catch (err) {
      toast.show({ message: err instanceof Error ? err.message : 'Badge grant failed', tone: 'danger' });
    } finally {
      setBusyId(null);
    }
  };

  const handleRevokeAward = async (awardId: string, customReason?: string) => {
    const reason = (customReason ?? adminReason).trim();
    if (reason.length < 4) {
      toast.show({ message: 'A mandatory audit reason is required to revoke an award', tone: 'danger' });
      return;
    }
    setBusyId(`revoke-${awardId}`);
    try {
      await adminRevokeBadge(awardId, reason, releaseSlotOnRevoke);
      haptic.success();
      toast.show({
        message: releaseSlotOnRevoke
          ? 'Award revoked & slot released to pool'
          : 'Award revoked & slot permanently retired (no renumbering)',
        tone: 'success',
      });
      setInspectingUser(null);
      setAdminReason('');
      await loadAll();
    } catch (err) {
      toast.show({ message: err instanceof Error ? err.message : 'Revocation failed', tone: 'danger' });
    } finally {
      setBusyId(null);
    }
  };

  const handleUpdateUserAccount = async (
    target: AdminUserRecord,
    patch: {
      role?: 'member' | 'moderator' | 'admin';
      accountStatus?: 'active' | 'suspended';
      excludeFromCompetitions?: boolean;
    },
  ) => {
    const reason = adminReason.trim();
    if (reason.length < 4) {
      toast.show({ message: 'Enter an audit reason first', tone: 'danger' });
      return;
    }
    setBusyId(`acct-${target.id}`);
    try {
      await adminManageUserAccount({
        targetUserId: target.id,
        ...patch,
        reason,
      });
      haptic.success();
      toast.show({ message: `Updated @${target.handle}`, tone: 'success' });
      setInspectingUser(null);
      setAdminReason('');
      await loadAll();
    } catch (err) {
      toast.show({ message: err instanceof Error ? err.message : 'Account update failed', tone: 'danger' });
    } finally {
      setBusyId(null);
    }
  };

  const handleCreateOrUpdateBadge = async () => {
    if (newBadgeId.trim().length < 3 || !newBadgeName.trim() || !newBadgeDesc.trim()) {
      toast.show({ message: 'Provide badge slug, name, and description', tone: 'danger' });
      return;
    }
    setBusyId('create-badge');
    try {
      await adminUpsertBadgeDefinition({
        id: newBadgeId.trim(),
        name: newBadgeName.trim(),
        subtitle: newBadgeSubtitle.trim(),
        description: newBadgeDesc.trim(),
        category: newBadgeCategory,
        rarity: newBadgeRarity,
        iconKey: newBadgeIcon,
        accentHex: newBadgeHex.trim() || '#F59E0B',
        maxSupply: newBadgeSupply.trim() ? Number(newBadgeSupply) : null,
        isNumbered: Boolean(newBadgeSupply.trim()),
        isAutomatic: false,
      });
      haptic.success();
      setBadgeCreatorOpen(false);
      setNewBadgeId('');
      setNewBadgeName('');
      setNewBadgeSubtitle('');
      setNewBadgeDesc('');
      toast.show({ message: 'Badge definition saved to live catalog', tone: 'success' });
      await loadAll();
    } catch (err) {
      toast.show({ message: err instanceof Error ? err.message : 'Could not save badge', tone: 'danger' });
    } finally {
      setBusyId(null);
    }
  };

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
        message: status === 'resolved' ? 'Ticket resolved & reporter notified' : 'Ticket marked in progress',
        tone: 'success',
      });
      await loadAll();
    } catch (err) {
      toast.show({ message: err instanceof Error ? err.message : 'Update failed', tone: 'danger' });
    } finally {
      setBusyId(null);
    }
  };

  const handleGrantCreatorByHandle = async () => {
    const clean = grantHandle.trim().replace(/^@/, '');
    if (!clean) return;
    setBusyId('grant-creator');
    try {
      await grantVideoAccessByHandle(clean, quotaMb, `Granted by @${me.handle}`);
      haptic.success();
      setGrantHandle('');
      toast.show({ message: `@${clean} granted Video Creator Access`, tone: 'success' });
      await loadAll();
    } catch (err) {
      toast.show({ message: err instanceof Error ? err.message : 'Grant failed', tone: 'danger' });
    } finally {
      setBusyId(null);
    }
  };

  const handleReviewVideoReq = async (reqId: string, handle: string, approve: boolean) => {
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
        message: approve ? `Approved @${handle}` : `Declined @${handle}`,
        tone: approve ? 'success' : 'default',
      });
      await loadAll();
    } catch (err) {
      toast.show({ message: err instanceof Error ? err.message : 'Action failed', tone: 'danger' });
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
        tone: 'success',
      });
      await loadAll();
    } catch (err) {
      toast.show({ message: err instanceof Error ? err.message : 'Report action failed', tone: 'danger' });
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleLock = async (communityId: string, nextLock: boolean) => {
    setBusyId(communityId);
    try {
      await toggleCommunityLock(communityId, nextLock);
      haptic.light();
      toast.show({ message: nextLock ? 'Room locked' : 'Room unlocked' });
      await loadAll();
    } catch (err) {
      toast.show({ message: err instanceof Error ? err.message : 'Room update failed', tone: 'danger' });
    } finally {
      setBusyId(null);
    }
  };

  const clockStatus = metrics ? formatLaunchClockStatus(metrics.config.launchStartsAt) : null;

  // Ordered mobile Segmented items keeping Megaphone, Bugs, Creators, Reports, Rooms front-and-center on /settings/moderation while giving full access to all 11 modules!
  const segmentedItems =
    initialSection === 'broadcast'
      ? [
          { key: 'broadcast' as AdminSection, label: 'Megaphone' },
          {
            key: 'support' as AdminSection,
            label: openTicketsCount ? `Bugs (${openTicketsCount})` : 'Bugs',
            dot: openTicketsCount > 0,
          },
          {
            key: 'creators' as AdminSection,
            label: pendingVideoCount ? `Creators (${pendingVideoCount})` : 'Creators',
            dot: pendingVideoCount > 0,
          },
          {
            key: 'reports' as AdminSection,
            label: openReportsCount ? `Reports (${openReportsCount})` : 'Reports',
            dot: openReportsCount > 0,
          },
          { key: 'communities' as AdminSection, label: 'Rooms' },
          { key: 'overview' as AdminSection, label: 'KPIs' },
          { key: 'launch' as AdminSection, label: 'Launch 10' },
          { key: 'users' as AdminSection, label: 'Users' },
          {
            key: 'verification' as AdminSection,
            label: pendingVerifCount ? `Verify (${pendingVerifCount})` : 'Verify',
            dot: pendingVerifCount > 0,
          },
          { key: 'badges' as AdminSection, label: 'Badges' },
          { key: 'audit' as AdminSection, label: 'Audit' },
        ]
      : [
          { key: 'overview' as AdminSection, label: 'Overview' },
          { key: 'launch' as AdminSection, label: 'Launch 10' },
          { key: 'users' as AdminSection, label: 'Users' },
          {
            key: 'verification' as AdminSection,
            label: pendingVerifCount ? `Verify (${pendingVerifCount})` : 'Verify',
            dot: pendingVerifCount > 0,
          },
          { key: 'badges' as AdminSection, label: 'Badges' },
          { key: 'broadcast' as AdminSection, label: 'Megaphone' },
          {
            key: 'support' as AdminSection,
            label: openTicketsCount ? `Bugs (${openTicketsCount})` : 'Bugs',
            dot: openTicketsCount > 0,
          },
          {
            key: 'reports' as AdminSection,
            label: openReportsCount ? `Reports (${openReportsCount})` : 'Reports',
            dot: openReportsCount > 0,
          },
          {
            key: 'creators' as AdminSection,
            label: pendingVideoCount ? `Creators (${pendingVideoCount})` : 'Creators',
            dot: pendingVideoCount > 0,
          },
          { key: 'communities' as AdminSection, label: 'Rooms' },
          { key: 'audit' as AdminSection, label: 'Audit' },
        ];

  return (
    <Screen
      header={
        <TopBar
          mode="stack"
          title={title}
          right={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {initialSection === 'broadcast' ? (
                <Button
                  label="Admin Home"
                  variant="ghost"
                  size="sm"
                  icon="stats-chart-outline"
                  onPress={() => router.push('/admin')}
                />
              ) : (
                <Button
                  label="Refresh"
                  variant="ghost"
                  size="sm"
                  icon="refresh-outline"
                  onPress={() => void loadAll()}
                />
              )}
            </View>
          }
        />
      }
    >
      {!isWide ? (
        <Segmented
          scrollable
          items={segmentedItems}
          value={section}
          onChange={setSection}
        />
      ) : null}

      <View style={styles.workspaceRow}>
        {/* Enterprise Desktop Sidebar */}
        {isWide ? (
          <View style={styles.sidebar}>
            <View style={styles.sidebarIdentity}>
              <Avatar uri={me.avatarUrl} name={me.displayName} size="md" />
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <Text variant="label" numberOfLines={1}>
                    {me.displayName}
                  </Text>
                  <VerificationSeal tier={me.verificationTier} verified={me.verified} size={14} />
                </View>
                <Text variant="caption" tone="tertiary">
                  @{me.handle} · {(me.role ?? 'staff').toUpperCase()}
                </Text>
              </View>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: space.x4, paddingBottom: space.x6 }}>
              {navGroups.map((group) => (
                <View key={group.heading} style={{ gap: 4 }}>
                  <Text variant="overline" tone="tertiary" style={{ paddingHorizontal: space.x3, marginBottom: 2 }}>
                    {group.heading}
                  </Text>
                  {group.items.map((item) => {
                    const active = section === item.key;
                    return (
                      <Pressable
                        key={item.key}
                        onPress={() => {
                          haptic.select();
                          setSection(item.key);
                        }}
                        style={[styles.sidebarItem, active ? styles.sidebarItemActive : null]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                      >
                        <Ionicons
                          name={item.icon}
                          size={17}
                          color={active ? colors.accent : colors.textSecondary}
                        />
                        <Text
                          variant="label"
                          style={{
                            flex: 1,
                            color: active ? colors.textPrimary : colors.textSecondary,
                          }}
                          numberOfLines={1}
                        >
                          {item.label}
                        </Text>
                        {item.badge ? (
                          <View style={styles.sidebarBadge}>
                            <Text style={{ fontSize: 10, fontWeight: '800', color: '#FFFFFF' }} numeric>
                              {item.badge}
                            </Text>
                          </View>
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {/* Main Scrollable Admin Canvas */}
        <View style={{ flex: 1 }}>
          {error ? (
            <ErrorState body={error} onRetry={loadAll} />
          ) : (
            <ScrollView
              style={{ flex: 1 }}
              keyboardShouldPersistTaps="handled"
              refreshControl={
                <RefreshControl refreshing={loading} onRefresh={loadAll} tintColor={colors.accent} />
              }
              contentContainerStyle={styles.canvasContent}
            >
              {/* Live Launch Clock Status Banner across Overview & Launch */}
              {clockStatus && (section === 'overview' || section === 'launch') ? (
                <Pressable
                  onPress={() => setSection('launch')}
                  style={[
                    styles.clockBanner,
                    clockStatus.isLive
                      ? { backgroundColor: 'rgba(16, 185, 129, 0.12)', borderColor: 'rgba(16, 185, 129, 0.4)' }
                      : { backgroundColor: 'rgba(245, 158, 11, 0.12)', borderColor: 'rgba(245, 158, 11, 0.4)' },
                  ]}
                >
                  <Ionicons
                    name={clockStatus.isLive ? 'radio-button-on' : 'time-outline'}
                    size={18}
                    color={clockStatus.isLive ? colors.success : '#F59E0B'}
                  />
                  <View style={{ flex: 1 }}>
                    <Text variant="label" style={{ color: clockStatus.isLive ? '#6EE7B7' : '#FDE68A' }}>
                      {clockStatus.label}
                    </Text>
                    <Text variant="caption" tone="secondary">
                      Scheduled: {new Date(metrics!.config.launchStartsAt).toLocaleString()} · Pre-launch accounts (@ceohallyu, @darasimi) excluded
                    </Text>
                  </View>
                  {section !== 'launch' ? (
                    <Text variant="caption" tone="accent">
                      Configure →
                    </Text>
                  ) : null}
                </Pressable>
              ) : null}

              {/* ── 1. OVERVIEW ────────────────────────────────────────────────────────── */}
              {section === 'overview' ? (
                <>
                  <View style={styles.kpiGrid}>
                    <KpiTile
                      label="Total Members"
                      value={compact(metrics?.kpis.totalMembers ?? 0)}
                      sub={`${metrics?.kpis.eligiblePostLaunchMembers ?? 0} post-launch · ${metrics?.kpis.prelaunchOrExcludedMembers ?? 0} excluded`}
                      onPress={() => setSection('users')}
                    />
                    <KpiTile
                      label="Joined Last 24h"
                      value={compact(metrics?.kpis.newMembers24h ?? 0)}
                      sub="Active member signups"
                      onPress={() => setSection('users')}
                    />
                    <KpiTile
                      label="Verified Accounts"
                      value={`${(metrics?.kpis.verifiedRedCount ?? 0) + (metrics?.kpis.verifiedBlueCount ?? 0)}`}
                      sub={`${metrics?.kpis.verifiedRedCount ?? 0} Red Official · ${metrics?.kpis.verifiedBlueCount ?? 0} Blue Authentic`}
                      accent={colors.accent}
                      onPress={() => setSection('verification')}
                    />
                    <KpiTile
                      label="Pending Verification"
                      value={`${pendingVerifCount}`}
                      sub="Identity review queue"
                      accent={pendingVerifCount > 0 ? '#F59E0B' : undefined}
                      onPress={() => setSection('verification')}
                    />
                    <KpiTile
                      label="Active Badges Issued"
                      value={`${metrics?.kpis.activeAwardsTotal ?? 0}`}
                      sub={`${metrics?.kpis.foundingMemberClaimed ?? 0}/${metrics?.config.foundingMemberCap ?? 250} Founding Members`}
                      onPress={() => setSection('badges')}
                    />
                    <KpiTile
                      label="Posts & Comments"
                      value={compact((metrics?.kpis.activePosts ?? 0) + (metrics?.kpis.activeComments ?? 0))}
                      sub={`${metrics?.kpis.activePosts ?? 0} posts · ${metrics?.kpis.activeComments ?? 0} replies`}
                    />
                    <KpiTile
                      label="Open Reports"
                      value={`${openReportsCount}`}
                      sub="Content safety queue"
                      accent={openReportsCount > 0 ? colors.danger : undefined}
                      onPress={() => setSection('reports')}
                    />
                    <KpiTile
                      label="Bug Tickets"
                      value={`${openTicketsCount}`}
                      sub={`${pendingVideoCount} pending video creators`}
                      accent={openTicketsCount > 0 ? '#F59E0B' : undefined}
                      onPress={() => setSection('support')}
                    />
                  </View>

                  {/* Founding Ten Snapshot */}
                  <View style={styles.card}>
                    <View style={styles.rowBetween}>
                      <View>
                        <Text variant="titleSmall">First Arrival & Founding Ten (#1–#10)</Text>
                        <Text variant="caption" tone="secondary">
                          Atomic server-assigned slots starting strictly after launch clock opens.
                        </Text>
                      </View>
                      <Button
                        label="Full Control"
                        variant="secondary"
                        size="sm"
                        onPress={() => setSection('launch')}
                      />
                    </View>
                    <View style={styles.slotsGrid}>
                      {(metrics?.foundingTen ?? []).map((slot) => (
                        <View
                          key={slot.slot}
                          style={[
                            styles.slotMiniCard,
                            slot.state === 'claimed'
                              ? { borderColor: 'rgba(245, 158, 11, 0.5)' }
                              : slot.state === 'retired'
                                ? { borderColor: 'rgba(239, 68, 68, 0.4)' }
                                : null,
                          ]}
                        >
                          <Text variant="label" style={{ color: '#FDE68A' }} numeric>
                            #{slot.slot}
                          </Text>
                          <Text variant="caption" tone="secondary" numberOfLines={1}>
                            {slot.state === 'claimed'
                              ? `@${slot.handle}`
                              : slot.state === 'retired'
                                ? 'Retired'
                                : 'Open'}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </View>

                  {/* Recent Audit Trail Preview */}
                  <View style={styles.card}>
                    <View style={styles.rowBetween}>
                      <Text variant="titleSmall">Recent Immutable Audit Log</Text>
                      <Button
                        label="View Ledger"
                        variant="ghost"
                        size="sm"
                        onPress={() => setSection('audit')}
                      />
                    </View>
                    {auditEntries.length === 0 ? (
                      <Text variant="caption" tone="tertiary">
                        All badge grants, revocations, verification updates, and clock changes are recorded here permanently.
                      </Text>
                    ) : (
                      auditEntries.slice(0, 5).map((entry) => (
                        <View key={entry.id} style={styles.auditRow}>
                          <View style={{ flex: 1 }}>
                            <Text variant="label">
                              {entry.action.replace(/_/g, ' ').toUpperCase()}
                              {entry.targetHandle ? ` → @${entry.targetHandle}` : ''}
                            </Text>
                            <Text variant="caption" tone="secondary">
                              {entry.reason}
                            </Text>
                          </View>
                          <Text variant="caption" tone="tertiary">
                            {timeAgo(entry.createdAt)}
                          </Text>
                        </View>
                      ))
                    )}
                  </View>
                </>
              ) : null}

              {/* ── 2. LAUNCH & FOUNDING TEN CONTROL CENTER ───────────────────────────── */}
              {section === 'launch' ? (
                <>
                  <View style={styles.card}>
                    <Text variant="titleSmall">Launch Clock & Eligibility Rules</Text>
                    <Text variant="caption" tone="secondary">
                      Only active members whose account created_at is greater than or equal to Launch Start Time (excluding @ceohallyu, @darasimi, and synthetic test accounts) can claim early-member awards.
                    </Text>

                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.x2 }}>
                      <Button
                        label="Preset: Tonight 9:00 PM WAT (20:00 UTC)"
                        variant="secondary"
                        size="sm"
                        icon="moon-outline"
                        disabled={!isAdmin}
                        onPress={() =>
                          void handleSaveLaunchConfig(
                            '2026-10-23T20:00:00.000Z',
                            'Set launch clock to Tonight 9:00 PM WAT (2026-10-23 20:00 UTC)',
                          )
                        }
                      />
                      <Button
                        label="Open Launch Clock Right Now"
                        variant="secondary"
                        size="sm"
                        icon="flash-outline"
                        disabled={!isAdmin}
                        onPress={() =>
                          void handleSaveLaunchConfig(
                            new Date().toISOString(),
                            'Opened launch clock immediately by admin',
                          )
                        }
                      />
                    </View>

                    <TextField
                      label="Launch Start Timestamp (ISO-8601 UTC)"
                      value={cfgLaunchIso}
                      onChangeText={setCfgLaunchIso}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />

                    <View style={{ flexDirection: 'row', gap: space.x2, flexWrap: 'wrap' }}>
                      <View style={{ flex: 1, minWidth: 120 }}>
                        <TextField
                          label="Day One Window (Hours)"
                          value={cfgDayOneHours}
                          onChangeText={setCfgDayOneHours}
                          keyboardType="numeric"
                        />
                      </View>
                      <View style={{ flex: 1, minWidth: 120 }}>
                        <TextField
                          label="Founding Window (Days)"
                          value={cfgFoundingDays}
                          onChangeText={setCfgFoundingDays}
                          keyboardType="numeric"
                        />
                      </View>
                      <View style={{ flex: 1, minWidth: 120 }}>
                        <TextField
                          label="Founding Member Cap"
                          value={cfgFoundingCap}
                          onChangeText={setCfgFoundingCap}
                          keyboardType="numeric"
                        />
                      </View>
                    </View>

                    <View style={styles.rowBetween}>
                      <View style={{ flex: 1 }}>
                        <Text variant="label">Automatic Awards Engine Enabled</Text>
                        <Text variant="caption" tone="secondary">
                          Pause safely at any time without losing member history.
                        </Text>
                      </View>
                      <Switch value={cfgEnabled} onValueChange={setCfgEnabled} />
                    </View>

                    <TextField
                      label="Audit Reason (Required)"
                      placeholder="Reason for updating launch configuration..."
                      value={cfgReason}
                      onChangeText={setCfgReason}
                    />

                    <Button
                      label="Save Launch Configuration"
                      icon="save-outline"
                      loading={busyId === 'save-config'}
                      disabled={!isAdmin}
                      onPress={() => void handleSaveLaunchConfig()}
                      block
                    />
                  </View>

                  {/* First Arrival #1 */}
                  <View style={styles.card}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x3 }}>
                      <BadgeCrest iconKey="crown_star" accentHex="#F59E0B" rarity="mythic" serialNumber={1} size={56} />
                      <View style={{ flex: 1 }}>
                        <Text variant="overline" style={{ color: '#FDE68A' }}>
                          MYTHIC 1-OF-1 AWARD
                        </Text>
                        <Text variant="titleSmall">First Arrival</Text>
                        {metrics?.firstArrival ? (
                          <Text variant="bodySmall" tone="secondary">
                            Held by @{metrics.firstArrival.handle} ({metrics.firstArrival.status.toUpperCase()}) ·{' '}
                            {new Date(metrics.firstArrival.awardedAt).toLocaleString()}
                          </Text>
                        ) : (
                          <Text variant="bodySmall" tone="secondary">
                            UNCLAIMED — Waiting for first eligible member signup after launch clock opens.
                          </Text>
                        )}
                      </View>
                    </View>
                  </View>

                  {/* Founding Ten Full Ledger */}
                  <View style={styles.card}>
                    <Text variant="titleSmall">Founding Ten Permanent Slot Ledger (#1–#10)</Text>
                    <Text variant="caption" tone="secondary">
                      Revoking a fraudulent account retires its slot permanently by default so legitimate members never shift numbers silently.
                    </Text>
                    {(metrics?.foundingTen ?? []).map((slot) => (
                      <View key={slot.slot} style={styles.slotDetailRow}>
                        <BadgeCrest
                          iconKey="laurel_shield"
                          accentHex="#D97706"
                          rarity="legendary"
                          serialNumber={slot.slot}
                          size={40}
                          locked={slot.state !== 'claimed'}
                        />
                        <View style={{ flex: 1 }}>
                          <Text variant="titleSmall">
                            Slot #{slot.slot} ·{' '}
                            {slot.state === 'claimed'
                              ? `@${slot.handle}`
                              : slot.state === 'retired'
                                ? 'RETIRED / VOIDED'
                                : 'OPEN'}
                          </Text>
                          <Text variant="caption" tone="secondary">
                            {slot.state === 'claimed' && slot.awardedAt
                              ? `${slot.displayName} · Claimed ${new Date(slot.awardedAt).toLocaleString()}`
                              : slot.state === 'retired'
                                ? `Revoked: ${slot.revokeReason ?? 'Fraudulent signup retired'}`
                                : 'Reserved for post-launch signup'}
                          </Text>
                        </View>
                        {slot.state === 'claimed' && slot.awardId && isAdmin ? (
                          <Button
                            label="Retire"
                            variant="secondary"
                            size="sm"
                            loading={busyId === `revoke-${slot.awardId}`}
                            onPress={() =>
                              void handleRevokeAward(
                                slot.awardId!,
                                `Slot #${slot.slot} retired by @${me.handle}`,
                              )
                            }
                          />
                        ) : null}
                      </View>
                    ))}
                  </View>
                </>
              ) : null}

              {/* ── 3. COMMERCIAL USER DIRECTORY ──────────────────────────────────────── */}
              {section === 'users' ? (
                <>
                  <View style={styles.card}>
                    <TextField
                      placeholder="Search by @handle, display name, or email..."
                      value={userQuery}
                      onChangeText={setUserQuery}
                      leading="search-outline"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <ChipRow>
                      {(
                        [
                          ['all', 'All Members'],
                          ['verified_red', 'Red Official'],
                          ['verified_blue', 'Blue Verified'],
                          ['early_awards', 'Early Awards'],
                          ['excluded', 'Pre-Launch / Excluded'],
                          ['staff', 'Staff'],
                          ['suspended', 'Suspended'],
                        ] as const
                      ).map(([k, label]) => (
                        <Chip
                          key={k}
                          label={label}
                          size="sm"
                          selected={userFilter === k}
                          onPress={() => setUserFilter(k)}
                        />
                      ))}
                    </ChipRow>
                  </View>

                  {users.map((u) => (
                    <View key={u.id} style={styles.card}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x3 }}>
                        <Pressable onPress={() => router.push(`/user/${u.handle}`)}>
                          <Avatar uri={u.avatarUrl} name={u.displayName} size="lg" />
                        </Pressable>
                        <View style={{ flex: 1, gap: 2 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <Text variant="titleSmall">{u.displayName}</Text>
                            <VerificationSeal tier={u.verificationTier} verified={u.verified} size={16} showPill />
                            <View style={styles.tagPill}>
                              <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textSecondary }}>
                                {u.role.toUpperCase()}
                              </Text>
                            </View>
                            {u.excludeFromCompetitions || u.isFounder ? (
                              <View style={[styles.tagPill, { borderColor: 'rgba(245, 158, 11, 0.4)' }]}>
                                <Text style={{ fontSize: 10, fontWeight: '700', color: '#FDE68A' }}>
                                  COMPETITION EXCLUDED
                                </Text>
                              </View>
                            ) : null}
                            {u.accountStatus !== 'active' ? (
                              <View style={[styles.tagPill, { borderColor: colors.danger }]}>
                                <Text style={{ fontSize: 10, fontWeight: '700', color: colors.danger }}>
                                  {u.accountStatus.toUpperCase()}
                                </Text>
                              </View>
                            ) : null}
                          </View>
                          <Text variant="caption" tone="secondary">
                            @{u.handle}
                            {u.email ? ` · ${u.email}` : ''} · Joined {new Date(u.createdAt).toLocaleDateString()}
                          </Text>
                          <Text variant="caption" tone="tertiary">
                            {u.postCount} posts · {u.commentCount} comments · {u.followerCount} followers ·{' '}
                            {u.awards.length} active badge(s)
                          </Text>
                        </View>
                        {isAdmin ? (
                          <Button
                            label="Manage"
                            variant="secondary"
                            size="sm"
                            icon="options-outline"
                            onPress={() => {
                              setAdminReason('');
                              setInspectingUser(u);
                            }}
                          />
                        ) : null}
                      </View>

                      {u.awards.length > 0 ? (
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                          {u.awards.map((aw) => (
                            <View key={aw.awardId} style={styles.miniAwardChip}>
                              <BadgeCrest
                                iconKey={aw.iconKey}
                                accentHex={aw.accentHex}
                                rarity={aw.rarity}
                                serialNumber={aw.serialNumber}
                                size={26}
                              />
                              <Text variant="caption">
                                {aw.name}
                                {aw.serialNumber != null ? ` #${aw.serialNumber}` : ''}
                              </Text>
                            </View>
                          ))}
                        </ScrollView>
                      ) : null}
                    </View>
                  ))}
                </>
              ) : null}

              {/* ── 4. VERIFICATION QUEUE & DIRECT BLUE/RED ASSIGNMENT ────────────────── */}
              {section === 'verification' ? (
                <>
                  <View style={styles.card}>
                    <Text variant="titleSmall">Direct Account Verification (@handle)</Text>
                    <Text variant="caption" tone="secondary">
                      Grant Blue (Authentic Identity), grant Red (Official Hallyu Authority), or revoke verification with full audit history.
                    </Text>
                    <TextField
                      placeholder="handle (e.g. darasimi)"
                      value={directVerifyHandle}
                      onChangeText={setDirectVerifyHandle}
                      leading="at-outline"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <ChipRow>
                      <Chip
                        label="Blue — Authentic Identity"
                        size="sm"
                        selected={directVerifyTier === 'blue'}
                        onPress={() => setDirectVerifyTier('blue')}
                      />
                      <Chip
                        label="Red — Official Authority"
                        size="sm"
                        selected={directVerifyTier === 'red'}
                        onPress={() => setDirectVerifyTier('red')}
                      />
                      <Chip
                        label="None — Revoke Checkmark"
                        size="sm"
                        selected={directVerifyTier === 'none'}
                        onPress={() => setDirectVerifyTier('none')}
                      />
                    </ChipRow>
                    <TextField
                      label="Audit Reason (Shown on member's Verification Record)"
                      placeholder="e.g. Verified K-Drama critic & community host"
                      value={directVerifyReason}
                      onChangeText={setDirectVerifyReason}
                    />
                    <Button
                      label="Apply Verification Decision"
                      icon="shield-checkmark-outline"
                      loading={busyId === 'direct-verify'}
                      disabled={!isAdmin || !directVerifyHandle.trim() || directVerifyReason.trim().length < 4}
                      onPress={() => void handleDirectVerifyByHandle()}
                      block
                    />
                  </View>

                  <ChipRow>
                    {(['all', 'pending', 'approved', 'rejected'] as const).map((st) => (
                      <Chip
                        key={st}
                        label={st.toUpperCase()}
                        size="sm"
                        selected={verifFilter === st}
                        onPress={() => setVerifFilter(st)}
                      />
                    ))}
                  </ChipRow>

                  {verifQueue.length === 0 ? (
                    <EmptyState
                      icon="shield-checkmark-outline"
                      title="No verification applications in this filter"
                      body="Member verification applications submitted from Settings appear here for review."
                    />
                  ) : (
                    verifQueue.map((item) => (
                      <View key={item.request.id} style={styles.card}>
                        <View style={styles.rowBetween}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x2 }}>
                            <Avatar uri={item.applicant.avatarUrl} name={item.applicant.displayName} size="md" />
                            <View>
                              <Text variant="titleSmall">
                                {item.applicant.displayName} (@{item.applicant.handle})
                              </Text>
                              <Text variant="caption" tone="secondary">
                                Requested {item.request.requestedTier.toUpperCase()} ·{' '}
                                {item.request.category.replace('_', ' ')} · {item.request.status.toUpperCase()}
                              </Text>
                            </View>
                          </View>
                          <Text variant="caption" tone="tertiary">
                            {timeAgo(item.request.createdAt)}
                          </Text>
                        </View>
                        <Text variant="bodySmall" tone="secondary">
                          {item.request.statement}
                        </Text>
                        {item.request.evidenceLinks.map((lnk) => (
                          <Pressable key={lnk} onPress={() => void Linking.openURL(lnk).catch(() => {})}>
                            <Text variant="caption" tone="accent" numberOfLines={1}>
                              {lnk}
                            </Text>
                          </Pressable>
                        ))}
                        {item.request.status === 'pending' && isAdmin ? (
                          <View style={{ gap: space.x2 }}>
                            <TextField
                              placeholder="Review note / audit reason..."
                              value={verifReviewReason}
                              onChangeText={setVerifReviewReason}
                            />
                            <View style={{ flexDirection: 'row', gap: space.x2 }}>
                              <Button
                                label="Approve Blue"
                                size="sm"
                                loading={busyId === item.request.id}
                                onPress={() => void handleReviewVerification(item.request.id, 'approved', 'blue')}
                                style={{ flex: 1 }}
                              />
                              <Button
                                label="Approve Red"
                                variant="secondary"
                                size="sm"
                                loading={busyId === item.request.id}
                                onPress={() => void handleReviewVerification(item.request.id, 'approved', 'red')}
                                style={{ flex: 1 }}
                              />
                              <Button
                                label="Decline"
                                variant="ghost"
                                size="sm"
                                onPress={() => void handleReviewVerification(item.request.id, 'rejected', 'blue')}
                              />
                            </View>
                          </View>
                        ) : null}
                      </View>
                    ))
                  )}
                </>
              ) : null}

              {/* ── 5. BADGES & ACHIEVEMENTS STUDIO ───────────────────────────────────── */}
              {section === 'badges' ? (
                <>
                  <View style={styles.card}>
                    <View style={styles.rowBetween}>
                      <View style={{ flex: 1 }}>
                        <Text variant="titleSmall">Hallyu Badge Catalog ({catalog.length} Active Crests)</Text>
                        <Text variant="caption" tone="secondary">
                          Bespoke vector crests across Early-Member, Participation, Content & Community.
                        </Text>
                      </View>
                      {isAdmin ? (
                        <Button
                          label="New Badge"
                          size="sm"
                          icon="add"
                          onPress={() => setBadgeCreatorOpen(true)}
                        />
                      ) : null}
                    </View>
                  </View>

                  {catalog.map((def) => (
                    <View key={def.id} style={styles.card}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.x3 }}>
                        <BadgeCrest
                          iconKey={def.iconKey}
                          accentHex={def.accentHex}
                          rarity={def.rarity}
                          size={52}
                        />
                        <View style={{ flex: 1, gap: 2 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <Text variant="titleSmall">{def.name}</Text>
                            <View style={styles.tagPill}>
                              <Text style={{ fontSize: 10, fontWeight: '700', color: def.accentHex }}>
                                {def.rarity.toUpperCase()} · {def.category.replace('_', ' ').toUpperCase()}
                              </Text>
                            </View>
                          </View>
                          <Text variant="caption" tone="secondary">
                            {def.description}
                          </Text>
                          <Text variant="caption" tone="tertiary">
                            ID: {def.id} ·{' '}
                            {def.maxSupply
                              ? `Claimed: ${def.claimedCount ?? 0} / ${def.maxSupply}`
                              : `Awarded: ${def.claimedCount ?? 0} member(s)`}{' '}
                            · {def.isAutomatic ? 'Automatic server rule' : 'Manual staff grant'}
                          </Text>
                        </View>
                      </View>
                    </View>
                  ))}
                </>
              ) : null}

              {/* ── 6. CEO MEGAPHONE ──────────────────────────────────────────────────── */}
              {section === 'broadcast' ? (
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
                      placeholder="e.g. Hallyu Founding Ten Launch Clock Opens at 9:00 PM!"
                      value={bcTitle}
                      onChangeText={setBcTitle}
                    />
                    <TextField
                      label="Message Body"
                      placeholder="Share an announcement, premiere alert, or community milestone..."
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
                    <View style={{ flexDirection: 'row', gap: space.x2 }}>
                      <Button
                        label="Open Live Events Hub"
                        variant="secondary"
                        icon="flame-outline"
                        onPress={() => router.push('/events')}
                        style={{ flex: 1 }}
                      />
                      <Button
                        label="Quick Tonight Room"
                        variant="ghost"
                        size="sm"
                        onPress={() =>
                          void createHallyuEvent({
                            title: 'Tonight Finale Watch Room',
                            world: 'kdrama',
                            startsInMinutes: 15,
                          })
                            .then(() => toast.show({ message: 'Live room scheduled on /events!', tone: 'success' }))
                            .catch((e) => toast.show({ message: String(e.message ?? e), tone: 'danger' }))
                        }
                      />
                    </View>
                  </View>
                </>
              ) : null}

              {/* ── 7. BUG & SUPPORT TRIAGE ───────────────────────────────────────────── */}
              {section === 'support' ? (
                tickets.length === 0 ? (
                  <EmptyState
                    icon="checkmark-done-circle-outline"
                    title="Zero open bug reports"
                    body="In-app bug reports, crash traces, and missing show requests appear right here."
                  />
                ) : (
                  tickets.map((t) => (
                    <View key={t.id} style={styles.card}>
                      <View style={styles.rowBetween}>
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
              ) : null}

              {/* ── 8. VIDEO CREATOR QUOTAS & REQUESTS ────────────────────────────────── */}
              {section === 'creators' ? (
                <>
                  <View style={styles.card}>
                    <Text variant="titleSmall">Grant Creator Access by Handle</Text>
                    <Text variant="caption" tone="secondary">
                      Instantly enable Shorts & HD video clips for any Hallyu member.
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
                      loading={busyId === 'grant-creator'}
                      disabled={!grantHandle.trim()}
                      onPress={() => void handleGrantCreatorByHandle()}
                      block
                    />
                  </View>

                  {(staffData?.videoRequests ?? []).map((req) => (
                    <View key={req.id} style={styles.card}>
                      <View style={styles.rowBetween}>
                        <Text variant="titleSmall">
                          {req.displayName} (@{req.handle})
                        </Text>
                        <Text variant="overline" tone="secondary">
                          {req.status.toUpperCase()}
                        </Text>
                      </View>
                      {req.note ? (
                        <Text variant="bodySmall" tone="secondary">
                          {req.note}
                        </Text>
                      ) : null}
                      {req.status === 'pending' ? (
                        <View style={{ flexDirection: 'row', gap: space.x2 }}>
                          <Button
                            label="Approve"
                            size="sm"
                            loading={busyId === req.id}
                            onPress={() => void handleReviewVideoReq(req.id, req.handle, true)}
                            style={{ flex: 1 }}
                          />
                          <Button
                            label="Decline"
                            variant="secondary"
                            size="sm"
                            loading={busyId === req.id}
                            onPress={() => void handleReviewVideoReq(req.id, req.handle, false)}
                            style={{ flex: 1 }}
                          />
                        </View>
                      ) : null}
                    </View>
                  ))}

                  {(staffData?.creators ?? []).map((c) => (
                    <View key={c.userId} style={styles.card}>
                      <View style={styles.rowBetween}>
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
              ) : null}

              {/* ── 9. CONTENT REPORTS ────────────────────────────────────────────────── */}
              {section === 'reports' ? (
                (staffData?.reports ?? []).length === 0 ? (
                  <EmptyState
                    icon="shield-checkmark-outline"
                    title="Zero open content reports"
                    body="Flagged posts, comments, and member profiles appear here for staff action."
                  />
                ) : (
                  (staffData?.reports ?? []).map((rep) => (
                    <View key={rep.id} style={styles.card}>
                      <View style={styles.rowBetween}>
                        <Text variant="overline" style={{ color: colors.danger }}>
                          {rep.targetType.toUpperCase()} · {rep.reason.toUpperCase()}
                        </Text>
                        <Text variant="caption" tone="tertiary">
                          {timeAgo(rep.createdAt)}
                        </Text>
                      </View>
                      {rep.postBody ? (
                        <Text variant="bodySmall" tone="secondary">
                          “{rep.postBody}”
                        </Text>
                      ) : null}
                      {rep.detail ? (
                        <Text variant="caption" tone="tertiary">
                          Note: {rep.detail}
                        </Text>
                      ) : null}
                      <View style={{ flexDirection: 'row', gap: space.x2 }}>
                        <Button
                          label="Hide Content & Resolve"
                          size="sm"
                          loading={busyId === rep.id}
                          onPress={() =>
                            void handleReportDecision(rep.id, rep.targetType, rep.targetId, true)
                          }
                          style={{ flex: 1 }}
                        />
                        <Button
                          label="Dismiss"
                          variant="secondary"
                          size="sm"
                          loading={busyId === rep.id}
                          onPress={() =>
                            void handleReportDecision(rep.id, rep.targetType, rep.targetId, false)
                          }
                          style={{ flex: 1 }}
                        />
                      </View>
                    </View>
                  ))
                )
              ) : null}

              {/* ── 10. COMMUNITY ROOMS ───────────────────────────────────────────────── */}
              {section === 'communities' ? (
                (staffData?.communities ?? []).map((c) => (
                  <View key={c.id} style={styles.card}>
                    <View style={styles.rowBetween}>
                      <View style={{ flex: 1 }}>
                        <Text variant="titleSmall">{c.name}</Text>
                        <Text variant="caption" tone="secondary">
                          {c.memberCount} members · {c.postCount} posts · {c.fandom.toUpperCase()}
                        </Text>
                      </View>
                      <Button
                        label={c.isLocked ? 'Unlock Room' : 'Lock Room'}
                        variant={c.isLocked ? 'primary' : 'secondary'}
                        size="sm"
                        loading={busyId === c.id}
                        onPress={() => void handleToggleLock(c.id, !c.isLocked)}
                      />
                    </View>
                  </View>
                ))
              ) : null}

              {/* ── 11. UNIFIED IMMUTABLE AUDIT LEDGER ────────────────────────────────── */}
              {section === 'audit' ? (
                <>
                  <ChipRow>
                    {(
                      [
                        ['all', 'All Domains'],
                        ['award', 'Awards & Slots'],
                        ['verification', 'Verification'],
                        ['launch_config', 'Launch Clock'],
                        ['user_admin', 'User Admin'],
                      ] as const
                    ).map(([d, label]) => (
                      <Chip
                        key={d}
                        label={label}
                        size="sm"
                        selected={auditDomain === d}
                        onPress={() => setAuditDomain(d)}
                      />
                    ))}
                  </ChipRow>

                  {auditEntries.length === 0 ? (
                    <EmptyState
                      icon="receipt-outline"
                      title="No audit entries in this filter yet"
                      body="Every badge award, revocation, verification update, and clock change is permanently protected against edits or deletion."
                    />
                  ) : (
                    auditEntries.map((entry) => (
                      <View key={entry.id} style={styles.card}>
                        <View style={styles.rowBetween}>
                          <Text variant="overline" tone="accent">
                            {entry.domain.toUpperCase()} · {entry.action.replace(/_/g, ' ').toUpperCase()}
                          </Text>
                          <Text variant="caption" tone="tertiary">
                            {new Date(entry.createdAt).toLocaleString()}
                          </Text>
                        </View>
                        <Text variant="titleSmall">
                          {entry.actorHandle ? `Actor: @${entry.actorHandle}` : 'System Engine'}
                          {entry.targetHandle ? ` → Target: @${entry.targetHandle}` : ''}
                          {entry.serialNumber != null ? ` (Slot #${entry.serialNumber})` : ''}
                        </Text>
                        <Text variant="bodySmall" tone="secondary">
                          Reason: {entry.reason}
                        </Text>
                      </View>
                    ))
                  )}
                </>
              ) : null}
            </ScrollView>
          )}
        </View>
      </View>

      {/* Member Administration Sheet */}
      <Sheet
        visible={Boolean(inspectingUser)}
        onClose={() => setInspectingUser(null)}
        title={inspectingUser ? `Manage @${inspectingUser.handle}` : 'Manage Member'}
      >
        {inspectingUser ? (
          <View style={{ gap: space.x3, paddingBottom: space.x4 }}>
            <TextField
              label="Mandatory Audit Reason (Recorded in Immutable Audit Ledger)"
              placeholder="Explain why this administrative action is being taken..."
              value={adminReason}
              onChangeText={setAdminReason}
            />

            <Text variant="overline" tone="secondary">
              1. ACCOUNT VERIFICATION TIER
            </Text>
            <View style={{ flexDirection: 'row', gap: space.x2, flexWrap: 'wrap' }}>
              <Button
                label="Grant Blue"
                size="sm"
                variant={inspectingUser.verificationTier === 'blue' ? 'primary' : 'secondary'}
                onPress={() => void handleSetMemberVerification(inspectingUser.id, 'blue')}
              />
              <Button
                label="Grant Red"
                size="sm"
                variant={inspectingUser.verificationTier === 'red' ? 'primary' : 'secondary'}
                onPress={() => void handleSetMemberVerification(inspectingUser.id, 'red')}
              />
              <Button
                label="Revoke Checkmark"
                size="sm"
                variant="ghost"
                onPress={() => void handleSetMemberVerification(inspectingUser.id, 'none')}
              />
            </View>

            <Text variant="overline" tone="secondary">
              2. GRANT ACHIEVEMENT / BADGE
            </Text>
            <ChipRow>
              {catalog.map((b) => (
                <Chip
                  key={b.id}
                  label={b.name}
                  size="sm"
                  selected={selectedBadgeToGrant === b.id}
                  onPress={() => setSelectedBadgeToGrant(b.id)}
                />
              ))}
            </ChipRow>
            <Button
              label={`Grant "${selectedBadgeToGrant}"`}
              size="sm"
              icon="ribbon-outline"
              loading={busyId === `grant-${inspectingUser.id}`}
              onPress={() => void handleManualGrantBadge(inspectingUser.id)}
            />

            {inspectingUser.awards.length > 0 ? (
              <>
                <Text variant="overline" tone="secondary">
                  3. REVOKE ACTIVE BADGES
                </Text>
                <View style={styles.rowBetween}>
                  <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
                    Release numbered slot back to open pool? (Off = permanently retire slot so numbers never shift)
                  </Text>
                  <Switch value={releaseSlotOnRevoke} onValueChange={setReleaseSlotOnRevoke} />
                </View>
                {inspectingUser.awards.map((aw) => (
                  <View key={aw.awardId} style={styles.rowBetween}>
                    <Text variant="bodySmall">
                      {aw.name}
                      {aw.serialNumber != null ? ` #${aw.serialNumber}` : ''}
                    </Text>
                    <Button
                      label="Revoke"
                      variant="secondary"
                      size="sm"
                      loading={busyId === `revoke-${aw.awardId}`}
                      onPress={() => void handleRevokeAward(aw.awardId)}
                    />
                  </View>
                ))}
              </>
            ) : null}

            <Text variant="overline" tone="secondary">
              4. ACCOUNT STATUS, ROLE & COMPETITION ELIGIBILITY
            </Text>
            <View style={{ flexDirection: 'row', gap: space.x2, flexWrap: 'wrap' }}>
              <Button
                label={
                  inspectingUser.excludeFromCompetitions
                    ? 'Allow in Competitions'
                    : 'Exclude from Competitions'
                }
                variant="secondary"
                size="sm"
                onPress={() =>
                  void handleUpdateUserAccount(inspectingUser, {
                    excludeFromCompetitions: !inspectingUser.excludeFromCompetitions,
                  })
                }
              />
              <Button
                label={inspectingUser.role === 'moderator' ? 'Set Role: Member' : 'Promote Moderator'}
                variant="secondary"
                size="sm"
                disabled={inspectingUser.isFounder}
                onPress={() =>
                  void handleUpdateUserAccount(inspectingUser, {
                    role: inspectingUser.role === 'moderator' ? 'member' : 'moderator',
                  })
                }
              />
              <Button
                label={inspectingUser.accountStatus === 'suspended' ? 'Reinstate Account' : 'Suspend Account'}
                variant="ghost"
                size="sm"
                disabled={inspectingUser.isFounder}
                onPress={() =>
                  void handleUpdateUserAccount(inspectingUser, {
                    accountStatus: inspectingUser.accountStatus === 'suspended' ? 'active' : 'suspended',
                  })
                }
              />
            </View>
          </View>
        ) : null}
      </Sheet>

      {/* Create / Edit Badge Definition Sheet */}
      <Sheet
        visible={badgeCreatorOpen}
        onClose={() => setBadgeCreatorOpen(false)}
        title="Create or Update Badge Crest"
      >
        <View style={{ gap: space.x3, paddingBottom: space.x4 }}>
          <View style={{ alignItems: 'center' }}>
            <BadgeCrest
              iconKey={newBadgeIcon}
              accentHex={newBadgeHex}
              rarity={newBadgeRarity}
              size={68}
            />
          </View>
          <TextField
            label="Badge Slug ID (lowercase_snake_case)"
            placeholder="e.g. seoul_critic_vanguard"
            value={newBadgeId}
            onChangeText={setNewBadgeId}
            autoCapitalize="none"
          />
          <TextField
            label="Badge Name"
            placeholder="e.g. Seoul Vanguard"
            value={newBadgeName}
            onChangeText={setNewBadgeName}
          />
          <TextField
            label="Subtitle"
            placeholder="e.g. Distinguished Critic"
            value={newBadgeSubtitle}
            onChangeText={setNewBadgeSubtitle}
          />
          <TextField
            label="Description"
            placeholder="Explain how this badge is earned..."
            multiline
            value={newBadgeDesc}
            onChangeText={setNewBadgeDesc}
          />
          <Text variant="overline" tone="secondary">
            CATEGORY
          </Text>
          <ChipRow>
            {(['early_member', 'participation', 'content', 'community'] as BadgeCategory[]).map((c) => (
              <Chip
                key={c}
                label={c.replace('_', ' ').toUpperCase()}
                size="sm"
                selected={newBadgeCategory === c}
                onPress={() => setNewBadgeCategory(c)}
              />
            ))}
          </ChipRow>
          <Text variant="overline" tone="secondary">
            RARITY TIER
          </Text>
          <ChipRow>
            {(['standard', 'rare', 'epic', 'legendary', 'mythic'] as BadgeRarity[]).map((r) => (
              <Chip
                key={r}
                label={r.toUpperCase()}
                size="sm"
                selected={newBadgeRarity === r}
                onPress={() => setNewBadgeRarity(r)}
              />
            ))}
          </ChipRow>
          <Text variant="overline" tone="secondary">
            BESPOKE VECTOR CREST ARTWORK
          </Text>
          <ChipRow>
            {ICON_KEYS.map((ik) => (
              <Chip
                key={ik}
                label={ik.replace('_', ' ')}
                size="sm"
                selected={newBadgeIcon === ik}
                onPress={() => setNewBadgeIcon(ik)}
              />
            ))}
          </ChipRow>
          <View style={{ flexDirection: 'row', gap: space.x2 }}>
            <View style={{ flex: 1 }}>
              <TextField label="Accent Hex" value={newBadgeHex} onChangeText={setNewBadgeHex} />
            </View>
            <View style={{ flex: 1 }}>
              <TextField
                label="Max Supply (Optional)"
                placeholder="Unlimited"
                value={newBadgeSupply}
                onChangeText={setNewBadgeSupply}
                keyboardType="numeric"
              />
            </View>
          </View>
          <Button
            label="Save Badge Crest to Catalog"
            icon="checkmark-circle-outline"
            loading={busyId === 'create-badge'}
            onPress={() => void handleCreateOrUpdateBadge()}
            block
          />
        </View>
      </Sheet>
    </Screen>
  );
}

function KpiTile({
  label,
  value,
  sub,
  accent,
  onPress,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: string;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={styles.kpiTile}
      accessibilityRole={onPress ? 'button' : undefined}
    >
      <Text variant="overline" tone="tertiary">
        {label.toUpperCase()}
      </Text>
      <Text variant="headline" style={accent ? { color: accent } : undefined} numeric>
        {value}
      </Text>
      <Text variant="caption" tone="secondary" numberOfLines={2}>
        {sub}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  workspaceRow: {
    flex: 1,
    flexDirection: 'row',
  },
  sidebar: {
    width: 248,
    backgroundColor: colors.surface1,
    borderRightWidth: 1,
    borderRightColor: colors.glassBorder,
    paddingHorizontal: space.x3,
    paddingTop: space.x3,
  },
  sidebarIdentity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    padding: space.x3,
    marginBottom: space.x4,
    backgroundColor: colors.surface2,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  sidebarItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: space.x3,
    borderRadius: radius.md,
  },
  sidebarItemActive: {
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  sidebarBadge: {
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    paddingHorizontal: 6,
    paddingVertical: 1,
    minWidth: 18,
    alignItems: 'center',
  },
  canvasContent: {
    padding: space.margin,
    gap: space.x3,
    paddingBottom: space.x8,
    maxWidth: 1080,
  },
  clockBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    padding: space.x3,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.x3,
  },
  kpiTile: {
    flexGrow: 1,
    flexBasis: 205,
    minWidth: 155,
    backgroundColor: colors.surface1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: space.x4,
    gap: 4,
  },
  card: {
    backgroundColor: colors.surface1,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    padding: space.x4,
    gap: space.x3,
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.x2,
  },
  slotsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  slotMiniCard: {
    width: 92,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    alignItems: 'center',
    gap: 2,
  },
  slotDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    paddingVertical: space.x2,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
  },
  auditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    paddingVertical: space.x2,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
  },
  tagPill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.surface2,
  },
  miniAwardChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
});
