/**
 * Hallyu Recognition, Achievements, 2-Tier Verification & Commercial Admin Platform API.
 *
 * Every mutation executes server-side via hardened SECURITY DEFINER RPCs on Supabase with:
 * - Atomic serial allocation (`First Arrival`, `Founding Ten #1–#10`, `Founding Member`, `Day One`)
 * - Strict founder & pre-launch exclusions (`@ceohallyu`, `@darasimi`, synthetic test accounts)
 * - Separate 2-tier Account Verification (`blue` = authentic identity, `red` = official authority)
 * - Immutable audit logging in `public.recognition_audit_log` with mandatory reasons
 */
import type {
  BadgeCategory,
  BadgeDefinition,
  BadgeRarity,
  UserAward,
  VerificationTier,
} from '../model';
import { ensureBackendSessionToken, supabase } from './client';
import { signedUrls } from './media';

// ── Shared Normalizers ────────────────────────────────────────────────────────────────────────

export function normalizeUserAward(raw: Record<string, unknown>): UserAward {
  return {
    awardId: String(raw.award_id ?? raw.id ?? ''),
    badgeId: String(raw.badge_id ?? ''),
    serialNumber: typeof raw.serial_number === 'number' ? raw.serial_number : null,
    source: String(raw.source ?? 'auto_achievement'),
    awardNote: raw.award_note ? String(raw.award_note) : null,
    awardedAt: String(raw.awarded_at ?? new Date().toISOString()),
    name: String(raw.name ?? raw.badge_id ?? 'Achievement'),
    subtitle: String(raw.subtitle ?? ''),
    description: String(raw.description ?? ''),
    category: ((raw.category as BadgeCategory) || 'participation'),
    rarity: ((raw.rarity as BadgeRarity) || 'standard'),
    iconKey: String(raw.icon_key ?? 'shield_crest'),
    accentHex: String(raw.accent_hex ?? '#E11D48'),
    maxSupply: typeof raw.max_supply === 'number' ? raw.max_supply : null,
    isNumbered: Boolean(raw.is_numbered),
  };
}

export function normalizeBadgeDefinition(raw: Record<string, unknown>): BadgeDefinition {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? 'Badge'),
    subtitle: String(raw.subtitle ?? ''),
    description: String(raw.description ?? ''),
    category: ((raw.category as BadgeCategory) || 'participation'),
    rarity: ((raw.rarity as BadgeRarity) || 'standard'),
    iconKey: String(raw.icon_key ?? 'shield_crest'),
    accentHex: String(raw.accent_hex ?? '#E11D48'),
    maxSupply: typeof raw.max_supply === 'number' ? raw.max_supply : null,
    isNumbered: Boolean(raw.is_numbered),
    isAutomatic: Boolean(raw.is_automatic),
    thresholdKind: raw.threshold_kind ? String(raw.threshold_kind) : null,
    thresholdValue: typeof raw.threshold_value === 'number' ? raw.threshold_value : null,
    sortOrder: Number(raw.sort_order ?? 100),
    claimedCount: typeof raw.claimed_count === 'number' ? raw.claimed_count : undefined,
  };
}

// ── Member Recognition & Verification Types ───────────────────────────────────────────────────

export interface RecognitionLaunchConfig {
  launchStartsAt: string;
  dayOneWindowHours: number;
  foundingMemberWindowDays: number;
  foundingMemberCap: number;
  foundingTenCap: number;
  awardsEnabled: boolean;
}

export interface UserRecognitionBundle {
  config: RecognitionLaunchConfig;
  userId: string | null;
  verificationTier: VerificationTier;
  verificationNote: string | null;
  verifiedAt: string | null;
  isFounder: boolean;
  featuredBadgeIds: string[];
  awards: UserAward[];
  catalog: BadgeDefinition[];
}

export interface VerificationRequestRecord {
  id: string;
  userId: string;
  requestedTier: 'blue' | 'red';
  category: 'creator' | 'journalist' | 'community_leader' | 'public_figure' | 'official_brand' | 'staff';
  evidenceLinks: string[];
  statement: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  reviewReason: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface MyVerificationStatus {
  tier: VerificationTier;
  verifiedAt: string | null;
  verificationNote: string | null;
  isFounder: boolean;
  request: VerificationRequestRecord | null;
}

function parseLaunchConfig(raw: Record<string, unknown> | null | undefined): RecognitionLaunchConfig {
  return {
    launchStartsAt: String(raw?.launch_starts_at ?? '2026-10-23T20:00:00+00:00'),
    dayOneWindowHours: Number(raw?.day_one_window_hours ?? 24),
    foundingMemberWindowDays: Number(raw?.founding_member_window_days ?? 14),
    foundingMemberCap: Number(raw?.founding_member_cap ?? 250),
    foundingTenCap: Number(raw?.founding_ten_cap ?? 10),
    awardsEnabled: raw?.awards_enabled === undefined ? true : Boolean(raw?.awards_enabled),
  };
}

function parseRecognitionBundle(raw: Record<string, unknown>): UserRecognitionBundle {
  const awardsRaw = Array.isArray(raw.awards) ? (raw.awards as Record<string, unknown>[]) : [];
  const catalogRaw = Array.isArray(raw.catalog) ? (raw.catalog as Record<string, unknown>[]) : [];
  const tier = String(raw.verification_tier ?? 'none');
  return {
    config: parseLaunchConfig((raw.config ?? null) as Record<string, unknown> | null),
    userId: raw.user_id ? String(raw.user_id) : null,
    verificationTier: tier === 'red' || tier === 'blue' ? tier : 'none',
    verificationNote: raw.verification_note ? String(raw.verification_note) : null,
    verifiedAt: raw.verified_at ? String(raw.verified_at) : null,
    isFounder: Boolean(raw.is_founder),
    featuredBadgeIds: Array.isArray(raw.featured_badge_ids) ? raw.featured_badge_ids.map(String) : [],
    awards: awardsRaw.map(normalizeUserAward),
    catalog: catalogRaw.map(normalizeBadgeDefinition),
  };
}

function parseVerificationRequest(raw: Record<string, unknown>): VerificationRequestRecord {
  return {
    id: String(raw.id ?? ''),
    userId: String(raw.user_id ?? ''),
    requestedTier: raw.requested_tier === 'red' ? 'red' : 'blue',
    category:
      (raw.category as VerificationRequestRecord['category']) || 'creator',
    evidenceLinks: Array.isArray(raw.evidence_links) ? raw.evidence_links.map(String) : [],
    statement: String(raw.statement ?? ''),
    status: (raw.status as VerificationRequestRecord['status']) || 'pending',
    reviewReason: raw.review_reason ? String(raw.review_reason) : null,
    reviewedAt: raw.reviewed_at ? String(raw.reviewed_at) : null,
    createdAt: String(raw.created_at ?? new Date().toISOString()),
  };
}

// ── Member Recognition & Verification RPCs ────────────────────────────────────────────────────

export async function fetchUserRecognition(userId?: string | null): Promise<UserRecognitionBundle | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('get_user_recognition', {
    p_user_id: userId ?? undefined,
  });
  if (error || !data || typeof data !== 'object') return null;
  return parseRecognitionBundle(data as Record<string, unknown>);
}

export async function syncMyRecognition(): Promise<{
  newlyUnlocked: string[];
  recognition: UserRecognitionBundle;
} | null> {
  if (!supabase || !(await ensureBackendSessionToken())) return null;
  const { data, error } = await supabase.rpc('sync_my_recognition');
  if (error || !data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  return {
    newlyUnlocked: Array.isArray(raw.newly_unlocked) ? raw.newly_unlocked.map(String) : [],
    recognition: parseRecognitionBundle((raw.recognition ?? {}) as Record<string, unknown>),
  };
}

export async function setFeaturedBadgesOnServer(badgeIds: string[]): Promise<string[]> {
  if (!supabase || !(await ensureBackendSessionToken())) {
    throw new Error('Sign in to customize your profile showcase');
  }
  const { data, error } = await supabase.rpc('set_featured_badges', {
    p_badge_ids: badgeIds.slice(0, 4),
  });
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data.map(String) : [];
}

export async function fetchMyVerificationStatus(): Promise<MyVerificationStatus> {
  if (!supabase || !(await ensureBackendSessionToken())) {
    return { tier: 'none', verifiedAt: null, verificationNote: null, isFounder: false, request: null };
  }
  const { data, error } = await supabase.rpc('my_verification_status');
  if (error || !data || typeof data !== 'object') {
    return { tier: 'none', verifiedAt: null, verificationNote: null, isFounder: false, request: null };
  }
  const raw = data as Record<string, unknown>;
  const tier = String(raw.tier ?? 'none');
  return {
    tier: tier === 'red' || tier === 'blue' ? tier : 'none',
    verifiedAt: raw.verified_at ? String(raw.verified_at) : null,
    verificationNote: raw.verification_note ? String(raw.verification_note) : null,
    isFounder: Boolean(raw.is_founder),
    request: raw.request && typeof raw.request === 'object'
      ? parseVerificationRequest(raw.request as Record<string, unknown>)
      : null,
  };
}

export async function submitVerificationApplication(input: {
  requestedTier: 'blue' | 'red';
  category: VerificationRequestRecord['category'];
  statement: string;
  evidenceLinks: string[];
}): Promise<string> {
  if (!supabase || !(await ensureBackendSessionToken())) {
    throw new Error('Sign in to apply for account verification');
  }
  const { data, error } = await supabase.rpc('submit_verification_request', {
    p_requested_tier: input.requestedTier,
    p_category: input.category,
    p_statement: input.statement.trim(),
    p_evidence_links: input.evidenceLinks.map((l) => l.trim()).filter(Boolean).slice(0, 5),
  });
  if (error) throw new Error(error.message);
  return String(data);
}

// ── Commercial Admin Platform Types & RPCs ────────────────────────────────────────────────────

export interface FoundingTenSlotRecord {
  slot: number;
  state: 'open' | 'claimed' | 'retired';
  awardId: string | null;
  userId: string | null;
  handle: string | null;
  displayName: string | null;
  avatarUrl?: string;
  verificationTier: VerificationTier;
  awardedAt: string | null;
  revokeReason: string | null;
}

export interface FirstArrivalRecord {
  awardId: string;
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  verificationTier: VerificationTier;
  status: 'active' | 'revoked';
  awardedAt: string;
  revokeReason: string | null;
}

export interface AdminDashboardMetrics {
  serverNow: string;
  config: RecognitionLaunchConfig;
  kpis: {
    totalMembers: number;
    eligiblePostLaunchMembers: number;
    prelaunchOrExcludedMembers: number;
    newMembers24h: number;
    verifiedBlueCount: number;
    verifiedRedCount: number;
    pendingVerifications: number;
    activeAwardsTotal: number;
    foundingMemberClaimed: number;
    dayOneClaimed: number;
    activePosts: number;
    activeComments: number;
    communitiesCount: number;
    openReports: number;
    openTickets: number;
    pendingVideoRequests: number;
  };
  firstArrival: FirstArrivalRecord | null;
  foundingTen: FoundingTenSlotRecord[];
}

export interface AdminUserRecord {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  bio: string | null;
  email: string | null;
  role: 'member' | 'moderator' | 'admin';
  accountStatus: 'active' | 'suspended' | 'deleted';
  verified: boolean;
  verificationTier: VerificationTier;
  verificationNote: string | null;
  verifiedAt: string | null;
  isFounder: boolean;
  excludeFromCompetitions: boolean;
  featuredBadgeIds: string[];
  followerCount: number;
  followingCount: number;
  postCount: number;
  commentCount: number;
  createdAt: string;
  awards: UserAward[];
  revokedAwards: {
    awardId: string;
    badgeId: string;
    serialNumber: number | null;
    revokedAt: string | null;
    revokeReason: string | null;
  }[];
}

export interface AdminVerificationQueueItem {
  request: VerificationRequestRecord;
  applicant: {
    id: string;
    handle: string;
    displayName: string;
    avatarUrl?: string;
    verificationTier: VerificationTier;
    followerCount: number;
    postCount: number;
    createdAt: string;
  };
  reviewerHandle: string | null;
}

export interface RecognitionAuditEntry {
  id: string;
  domain: 'award' | 'verification' | 'launch_config' | 'user_admin';
  action: string;
  badgeId: string | null;
  serialNumber: number | null;
  previousState: Record<string, unknown> | null;
  newState: Record<string, unknown> | null;
  reason: string;
  createdAt: string;
  actorHandle: string | null;
  actorName: string | null;
  targetHandle: string | null;
  targetName: string | null;
}

export async function fetchAdminDashboardMetrics(): Promise<AdminDashboardMetrics> {
  if (!supabase || !(await ensureBackendSessionToken())) {
    throw new Error('Staff authentication required');
  }
  const { data, error } = await supabase.rpc('admin_dashboard_metrics');
  if (error) throw new Error(error.message);
  const raw = (data ?? {}) as Record<string, unknown>;
  const kpis = (raw.kpis ?? {}) as Record<string, unknown>;
  const firstRaw = raw.first_arrival as Record<string, unknown> | null;
  const tenRaw = Array.isArray(raw.founding_ten) ? (raw.founding_ten as Record<string, unknown>[]) : [];

  const paths = [
    firstRaw?.avatar_path,
    ...tenRaw.map((s) => s.avatar_path),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  const avatars = paths.length ? await signedUrls(paths).catch(() => new Map<string, string>()) : new Map<string, string>();

  const toTier = (v: unknown): VerificationTier =>
    v === 'red' || v === 'blue' ? v : 'none';

  return {
    serverNow: String(raw.server_now ?? new Date().toISOString()),
    config: parseLaunchConfig((raw.config ?? null) as Record<string, unknown> | null),
    kpis: {
      totalMembers: Number(kpis.total_members ?? 0),
      eligiblePostLaunchMembers: Number(kpis.eligible_post_launch_members ?? 0),
      prelaunchOrExcludedMembers: Number(kpis.prelaunch_or_excluded_members ?? 0),
      newMembers24h: Number(kpis.new_members_24h ?? 0),
      verifiedBlueCount: Number(kpis.verified_blue_count ?? 0),
      verifiedRedCount: Number(kpis.verified_red_count ?? 0),
      pendingVerifications: Number(kpis.pending_verifications ?? 0),
      activeAwardsTotal: Number(kpis.active_awards_total ?? 0),
      foundingMemberClaimed: Number(kpis.founding_member_claimed ?? 0),
      dayOneClaimed: Number(kpis.day_one_claimed ?? 0),
      activePosts: Number(kpis.active_posts ?? 0),
      activeComments: Number(kpis.active_comments ?? 0),
      communitiesCount: Number(kpis.communities_count ?? 0),
      openReports: Number(kpis.open_reports ?? 0),
      openTickets: Number(kpis.open_tickets ?? 0),
      pendingVideoRequests: Number(kpis.pending_video_requests ?? 0),
    },
    firstArrival: firstRaw
      ? {
          awardId: String(firstRaw.award_id),
          userId: String(firstRaw.user_id),
          handle: String(firstRaw.handle ?? ''),
          displayName: String(firstRaw.display_name ?? firstRaw.handle ?? 'Member'),
          avatarUrl: typeof firstRaw.avatar_path === 'string' ? avatars.get(firstRaw.avatar_path) : undefined,
          verificationTier: toTier(firstRaw.verification_tier),
          status: firstRaw.status === 'revoked' ? 'revoked' : 'active',
          awardedAt: String(firstRaw.awarded_at ?? new Date().toISOString()),
          revokeReason: firstRaw.revoke_reason ? String(firstRaw.revoke_reason) : null,
        }
      : null,
    foundingTen: tenRaw.map((s) => ({
      slot: Number(s.slot ?? 0),
      state:
        s.state === 'claimed' || s.state === 'retired'
          ? s.state
          : 'open',
      awardId: s.award_id ? String(s.award_id) : null,
      userId: s.user_id ? String(s.user_id) : null,
      handle: s.handle ? String(s.handle) : null,
      displayName: s.display_name ? String(s.display_name) : null,
      avatarUrl: typeof s.avatar_path === 'string' ? avatars.get(s.avatar_path) : undefined,
      verificationTier: toTier(s.verification_tier),
      awardedAt: s.awarded_at ? String(s.awarded_at) : null,
      revokeReason: s.revoke_reason ? String(s.revoke_reason) : null,
    })),
  };
}

export async function adminSearchUsers(
  query = '',
  filter: 'all' | 'verified_blue' | 'verified_red' | 'staff' | 'suspended' | 'excluded' | 'early_awards' = 'all',
  limit = 60,
  offset = 0,
): Promise<AdminUserRecord[]> {
  if (!supabase || !(await ensureBackendSessionToken())) {
    throw new Error('Staff authentication required');
  }
  const { data, error } = await supabase.rpc('admin_search_users', {
    p_query: query,
    p_filter: filter,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  const paths = rows
    .map((r) => r.avatar_path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  const avatars = paths.length ? await signedUrls(paths).catch(() => new Map<string, string>()) : new Map<string, string>();

  return rows.map((r) => {
    const tier = String(r.verification_tier ?? 'none');
    const awardsRaw = Array.isArray(r.awards) ? (r.awards as Record<string, unknown>[]) : [];
    const revRaw = Array.isArray(r.revoked_awards) ? (r.revoked_awards as Record<string, unknown>[]) : [];
    return {
      id: String(r.id),
      handle: String(r.handle ?? ''),
      displayName: String(r.display_name ?? r.handle ?? 'Member'),
      avatarUrl: typeof r.avatar_path === 'string' ? avatars.get(r.avatar_path) : undefined,
      bio: r.bio ? String(r.bio) : null,
      email: r.email ? String(r.email) : null,
      role: (r.role === 'admin' || r.role === 'moderator' ? r.role : 'member'),
      accountStatus: (r.account_status === 'suspended' || r.account_status === 'deleted' ? r.account_status : 'active'),
      verified: Boolean(r.verified),
      verificationTier: tier === 'red' || tier === 'blue' ? tier : 'none',
      verificationNote: r.verification_note ? String(r.verification_note) : null,
      verifiedAt: r.verified_at ? String(r.verified_at) : null,
      isFounder: Boolean(r.is_founder),
      excludeFromCompetitions: Boolean(r.exclude_from_competitions),
      featuredBadgeIds: Array.isArray(r.featured_badge_ids) ? r.featured_badge_ids.map(String) : [],
      followerCount: Number(r.follower_count ?? 0),
      followingCount: Number(r.following_count ?? 0),
      postCount: Number(r.post_count ?? 0),
      commentCount: Number(r.comment_count ?? 0),
      createdAt: String(r.created_at ?? new Date().toISOString()),
      awards: awardsRaw.map(normalizeUserAward),
      revokedAwards: revRaw.map((rv) => ({
        awardId: String(rv.award_id ?? ''),
        badgeId: String(rv.badge_id ?? ''),
        serialNumber: typeof rv.serial_number === 'number' ? rv.serial_number : null,
        revokedAt: rv.revoked_at ? String(rv.revoked_at) : null,
        revokeReason: rv.revoke_reason ? String(rv.revoke_reason) : null,
      })),
    };
  });
}

export async function adminSetVerification(
  targetUserId: string,
  tier: VerificationTier,
  reason: string,
): Promise<void> {
  if (!supabase || !(await ensureBackendSessionToken())) {
    throw new Error('Admin authentication required');
  }
  const { error } = await supabase.rpc('admin_set_verification', {
    p_target_user_id: targetUserId,
    p_tier: tier,
    p_reason: reason.trim(),
  });
  if (error) throw new Error(error.message);
}

export async function adminListVerificationRequests(
  status: 'all' | 'pending' | 'approved' | 'rejected' = 'all',
  limit = 50,
): Promise<AdminVerificationQueueItem[]> {
  if (!supabase || !(await ensureBackendSessionToken())) {
    throw new Error('Staff authentication required');
  }
  const { data, error } = await supabase.rpc('admin_list_verification_requests', {
    p_status: status,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  const paths = rows
    .map((r) => (r.applicant as Record<string, unknown> | undefined)?.avatar_path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  const avatars = paths.length ? await signedUrls(paths).catch(() => new Map<string, string>()) : new Map<string, string>();

  return rows.map((row) => {
    const app = (row.applicant ?? {}) as Record<string, unknown>;
    const tier = String(app.verification_tier ?? 'none');
    return {
      request: parseVerificationRequest((row.request ?? {}) as Record<string, unknown>),
      applicant: {
        id: String(app.id ?? ''),
        handle: String(app.handle ?? 'member'),
        displayName: String(app.display_name ?? app.handle ?? 'Member'),
        avatarUrl: typeof app.avatar_path === 'string' ? avatars.get(app.avatar_path) : undefined,
        verificationTier: tier === 'red' || tier === 'blue' ? tier : 'none',
        followerCount: Number(app.follower_count ?? 0),
        postCount: Number(app.post_count ?? 0),
        createdAt: String(app.created_at ?? new Date().toISOString()),
      },
      reviewerHandle: row.reviewer_handle ? String(row.reviewer_handle) : null,
    };
  });
}

export async function adminReviewVerificationRequest(
  requestId: string,
  decision: 'approved' | 'rejected',
  tier: 'blue' | 'red',
  reason: string,
): Promise<void> {
  if (!supabase || !(await ensureBackendSessionToken())) {
    throw new Error('Admin authentication required');
  }
  const { error } = await supabase.rpc('admin_review_verification_request', {
    p_request_id: requestId,
    p_decision: decision,
    p_tier: tier,
    p_reason: reason.trim(),
  });
  if (error) throw new Error(error.message);
}

export async function adminGrantBadge(
  targetUserId: string,
  badgeId: string,
  reason: string,
  serialNumber?: number | null,
): Promise<void> {
  if (!supabase || !(await ensureBackendSessionToken())) {
    throw new Error('Admin authentication required');
  }
  const { error } = await supabase.rpc('admin_grant_badge', {
    p_target_user_id: targetUserId,
    p_badge_id: badgeId,
    p_reason: reason.trim(),
    p_serial_number: serialNumber ?? undefined,
  });
  if (error) throw new Error(error.message);
}

export async function adminRevokeBadge(
  awardId: string,
  reason: string,
  releaseSlot = false,
): Promise<void> {
  if (!supabase || !(await ensureBackendSessionToken())) {
    throw new Error('Admin authentication required');
  }
  const { error } = await supabase.rpc('admin_revoke_badge', {
    p_award_id: awardId,
    p_reason: reason.trim(),
    p_release_slot: releaseSlot,
  });
  if (error) throw new Error(error.message);
}

export async function adminUpsertBadgeDefinition(input: {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  category: BadgeCategory;
  rarity: BadgeRarity;
  iconKey: string;
  accentHex: string;
  maxSupply?: number | null;
  isNumbered?: boolean;
  isAutomatic?: boolean;
  isActive?: boolean;
  sortOrder?: number;
}): Promise<BadgeDefinition> {
  if (!supabase || !(await ensureBackendSessionToken())) {
    throw new Error('Admin authentication required');
  }
  const { data, error } = await supabase.rpc('admin_upsert_badge_definition', {
    p_id: input.id,
    p_name: input.name,
    p_subtitle: input.subtitle,
    p_description: input.description,
    p_category: input.category,
    p_rarity: input.rarity,
    p_icon_key: input.iconKey,
    p_accent_hex: input.accentHex,
    p_max_supply: input.maxSupply ?? undefined,
    p_is_numbered: input.isNumbered ?? false,
    p_is_automatic: input.isAutomatic ?? false,
    p_is_active: input.isActive ?? true,
    p_sort_order: input.sortOrder ?? 150,
  });
  if (error) throw new Error(error.message);
  return normalizeBadgeDefinition((data ?? {}) as Record<string, unknown>);
}

export async function adminUpdateRecognitionConfig(input: {
  launchStartsAt: string;
  dayOneWindowHours: number;
  foundingMemberWindowDays: number;
  foundingMemberCap: number;
  awardsEnabled: boolean;
  reason: string;
}): Promise<RecognitionLaunchConfig> {
  if (!supabase || !(await ensureBackendSessionToken())) {
    throw new Error('Admin authentication required');
  }
  const { data, error } = await supabase.rpc('admin_update_recognition_config', {
    p_launch_starts_at: input.launchStartsAt,
    p_day_one_window_hours: input.dayOneWindowHours,
    p_founding_member_window_days: input.foundingMemberWindowDays,
    p_founding_member_cap: input.foundingMemberCap,
    p_awards_enabled: input.awardsEnabled,
    p_reason: input.reason.trim(),
  });
  if (error) throw new Error(error.message);
  return parseLaunchConfig((data ?? null) as Record<string, unknown> | null);
}

export async function adminManageUserAccount(input: {
  targetUserId: string;
  role?: 'member' | 'moderator' | 'admin';
  accountStatus?: 'active' | 'suspended';
  excludeFromCompetitions?: boolean;
  reason: string;
}): Promise<void> {
  if (!supabase || !(await ensureBackendSessionToken())) {
    throw new Error('Admin authentication required');
  }
  const { error } = await supabase.rpc('admin_manage_user_account', {
    p_target_user_id: input.targetUserId,
    p_role: input.role ?? undefined,
    p_account_status: input.accountStatus ?? undefined,
    p_exclude_from_competitions: input.excludeFromCompetitions ?? undefined,
    p_reason: input.reason.trim(),
  });
  if (error) throw new Error(error.message);
}

export async function adminListAuditLog(
  domain: 'all' | 'award' | 'verification' | 'launch_config' | 'user_admin' = 'all',
  limit = 80,
): Promise<RecognitionAuditEntry[]> {
  if (!supabase || !(await ensureBackendSessionToken())) {
    throw new Error('Staff authentication required');
  }
  const { data, error } = await supabase.rpc('admin_list_audit_log', {
    p_domain: domain === 'all' ? undefined : domain,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  return rows.map((r) => ({
    id: String(r.id ?? ''),
    domain: (r.domain as RecognitionAuditEntry['domain']) || 'award',
    action: String(r.action ?? ''),
    badgeId: r.badge_id ? String(r.badge_id) : null,
    serialNumber: typeof r.serial_number === 'number' ? r.serial_number : null,
    previousState: (r.previous_state as Record<string, unknown> | null) ?? null,
    newState: (r.new_state as Record<string, unknown> | null) ?? null,
    reason: String(r.reason ?? ''),
    createdAt: String(r.created_at ?? new Date().toISOString()),
    actorHandle: r.actor_handle ? String(r.actor_handle) : null,
    actorName: r.actor_name ? String(r.actor_name) : null,
    targetHandle: r.target_handle ? String(r.target_handle) : null,
    targetName: r.target_name ? String(r.target_name) : null,
  }));
}
