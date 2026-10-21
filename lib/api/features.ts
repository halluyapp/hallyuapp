/**
 * Consumer Product APIs (Phases 1–3) — 100% real Supabase RPCs & Realtime channels:
 *  - Interactive Polls (`create_post_poll`, `vote_post_poll`, `get_post_polls`)
 *  - Instant Community Title Ratings (`rate_title`, `title_ratings`)
 *  - Direct Messages & Send-to-Friend (`send_direct_message`, `list_conversations`, `list_direct_messages`, `mark_conversation_read`)
 *  - Multi-Filter Catalog Discovery & Tonight's Pick (`discover_catalog`)
 *  - Live Episode Watch Rooms (`supabase.channel` Presence + Broadcast reactions)
 */
import type { RealtimeChannel } from '@supabase/supabase-js';
import type {
  ConversationSummary,
  DirectMessage,
  Drama,
  FandomId,
  PostPoll,
  ReactionKind,
  User,
} from '../model';
import { getBackendAccessToken, supabase } from './client';
import { serverTitleToDrama, type ServerTitleRow } from './feed';
import { signedUrls } from './media';
import { isUuid, resolveTitleUuid } from './social';

interface RawPollPayload {
  post_id?: string;
  question?: string;
  options?: string[];
  counts?: number[];
  total_votes?: number;
  my_vote?: number | null;
  closes_at?: string | null;
}

export function normalizePoll(raw?: RawPollPayload | null): PostPoll | undefined {
  if (!raw || !Array.isArray(raw.options) || raw.options.length < 2) return undefined;
  const counts = raw.options.map((_, idx) => Number(raw.counts?.[idx] ?? 0));
  const totalVotes =
    typeof raw.total_votes === 'number'
      ? raw.total_votes
      : counts.reduce((sum, n) => sum + n, 0);
  return {
    question: raw.question?.trim() || 'Vote below',
    options: raw.options,
    counts,
    totalVotes,
    myVote: typeof raw.my_vote === 'number' ? raw.my_vote : null,
    closesAt: raw.closes_at ?? null,
  };
}

// ── 1. Interactive Polls ──────────────────────────────────────────────────────────────────────

export async function createPollOnServer(
  postId: string,
  question: string,
  options: string[],
  hours = 168,
): Promise<PostPoll | undefined> {
  if (!supabase || !getBackendAccessToken() || !isUuid(postId)) return undefined;
  const cleanOptions = options.map((o) => o.trim()).filter(Boolean).slice(0, 4);
  if (cleanOptions.length < 2) return undefined;
  const { data, error } = await supabase.rpc('create_post_poll', {
    p_post_id: postId,
    p_question: question.trim() || 'Vote below',
    p_options: cleanOptions,
    p_hours: hours,
  });
  if (error) throw new Error(error.message);
  return normalizePoll(data as RawPollPayload);
}

export async function votePollOnServer(postId: string, optionIndex: number): Promise<PostPoll | undefined> {
  if (!supabase || !getBackendAccessToken() || !isUuid(postId)) return undefined;
  const { data, error } = await supabase.rpc('vote_post_poll', {
    p_post_id: postId,
    p_option_index: optionIndex,
  });
  if (error) throw new Error(error.message);
  return normalizePoll(data as RawPollPayload);
}

export async function fetchPollsForPosts(postIds: string[]): Promise<Map<string, PostPoll>> {
  const out = new Map<string, PostPoll>();
  if (!supabase) return out;
  const uuids = [...new Set(postIds.filter(isUuid))];
  if (!uuids.length) return out;
  const { data, error } = await supabase.rpc('get_post_polls', { p_post_ids: uuids });
  if (error || !data || typeof data !== 'object') return out;
  for (const [id, raw] of Object.entries(data as Record<string, RawPollPayload>)) {
    const parsed = normalizePoll(raw);
    if (parsed) out.set(id, parsed);
  }
  return out;
}

// ── 2. Instant Community Title Ratings ────────────────────────────────────────────────────────

export interface TitleRatingSummary {
  myScore: number | null;
  communityRating: number | null;
  ratingCount: number;
}

export async function fetchTitleRatingSummary(dramaId: string, userId?: string): Promise<TitleRatingSummary> {
  if (!supabase) return { myScore: null, communityRating: null, ratingCount: 0 };
  const titleId = await resolveTitleUuid(dramaId);
  if (!titleId) return { myScore: null, communityRating: null, ratingCount: 0 };

  const [titleRes, countRes, mineRes] = await Promise.all([
    supabase.from('titles').select('community_rating, vote_average').eq('id', titleId).maybeSingle(),
    supabase.from('title_ratings').select('score', { count: 'exact', head: true }).eq('title_id', titleId),
    userId && isUuid(userId)
      ? supabase.from('title_ratings').select('score').eq('title_id', titleId).eq('user_id', userId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const row = titleRes.data as { community_rating?: number | null; vote_average?: number | null } | null;
  const mine = mineRes.data as { score?: number | string | null } | null;
  return {
    myScore: mine?.score != null ? Number(mine.score) : null,
    communityRating: row?.community_rating ?? row?.vote_average ?? null,
    ratingCount: countRes.count ?? 0,
  };
}

export async function rateTitleOnServer(dramaId: string, score: number): Promise<TitleRatingSummary | null> {
  if (!supabase || !getBackendAccessToken()) return null;
  const titleId = await resolveTitleUuid(dramaId);
  if (!titleId) return null;
  const { data, error } = await supabase.rpc('rate_title', {
    p_title_id: titleId,
    p_score: Math.round(score * 10) / 10,
  });
  if (error) throw new Error(error.message);
  const raw = (data ?? {}) as {
    my_score?: number;
    community_rating?: number | null;
    rating_count?: number;
  };
  return {
    myScore: raw.my_score != null ? Number(raw.my_score) : score,
    communityRating: raw.community_rating != null ? Number(raw.community_rating) : score,
    ratingCount: raw.rating_count ?? 1,
  };
}

// ── 3. Direct Messages & Send-to-Friend ───────────────────────────────────────────────────────

interface RawConversation {
  peer_id: string;
  handle: string;
  display_name: string;
  avatar_path?: string | null;
  verified?: boolean;
  last_message_id: string;
  last_sender_id: string;
  last_body: string;
  shared_drama_id?: string | null;
  shared_post_id?: string | null;
  last_at: string;
  unread_count?: number;
}

interface RawDirectMessage {
  id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  shared_drama_id?: string | null;
  shared_post_id?: string | null;
  read_at?: string | null;
  created_at: string;
}

function toDirectMessage(raw: RawDirectMessage): DirectMessage {
  return {
    id: raw.id,
    senderId: raw.sender_id,
    recipientId: raw.recipient_id,
    body: raw.body,
    sharedDramaId: raw.shared_drama_id ?? undefined,
    sharedPostId: raw.shared_post_id ?? undefined,
    readAt: raw.read_at ?? null,
    createdAt: raw.created_at,
  };
}

export async function fetchConversations(): Promise<ConversationSummary[]> {
  if (!supabase || !getBackendAccessToken()) return [];
  const { data, error } = await supabase.rpc('list_conversations', { p_limit: 50 });
  if (error || !Array.isArray(data)) return [];
  const rows = data as RawConversation[];
  const avatarPaths = rows.map((r) => r.avatar_path).filter((p): p is string => Boolean(p));
  let avatars = new Map<string, string>();
  if (avatarPaths.length) {
    try {
      avatars = await signedUrls(avatarPaths);
    } catch {
      avatars = new Map();
    }
  }
  return rows.map((r) => ({
    peerId: r.peer_id,
    handle: r.handle,
    displayName: r.display_name,
    avatarUrl: r.avatar_path ? avatars.get(r.avatar_path) : undefined,
    verified: Boolean(r.verified),
    lastMessageId: r.last_message_id,
    lastSenderId: r.last_sender_id,
    lastBody: r.last_body,
    sharedDramaId: r.shared_drama_id ?? undefined,
    sharedPostId: r.shared_post_id ?? undefined,
    lastAt: r.last_at,
    unreadCount: Number(r.unread_count ?? 0),
  }));
}

export async function fetchDirectMessages(peerHandle: string): Promise<DirectMessage[]> {
  if (!supabase || !getBackendAccessToken()) return [];
  const { data, error } = await supabase.rpc('list_direct_messages', {
    p_peer_handle: peerHandle,
    p_limit: 80,
  });
  if (error || !Array.isArray(data)) return [];
  return (data as RawDirectMessage[]).map(toDirectMessage);
}

export async function sendDirectMessage(
  recipientHandle: string,
  body: string,
  options?: { sharedDramaId?: string; sharedPostId?: string },
): Promise<DirectMessage | null> {
  if (!supabase || !getBackendAccessToken()) {
    throw new Error('Sign in to send messages');
  }
  const { data, error } = await supabase.rpc('send_direct_message', {
    p_recipient_handle: recipientHandle.trim().replace(/^@/, ''),
    p_body: body.trim(),
    p_shared_drama_id: options?.sharedDramaId ?? null,
    p_shared_post_id: isUuid(options?.sharedPostId) ? options!.sharedPostId! : null,
  });
  if (error) throw new Error(error.message);
  return data ? toDirectMessage(data as RawDirectMessage) : null;
}

export async function markConversationReadOnServer(peerHandle: string): Promise<void> {
  if (!supabase || !getBackendAccessToken()) return;
  await supabase.rpc('mark_conversation_read', {
    p_peer_handle: peerHandle.trim().replace(/^@/, ''),
  });
}

export function subscribeDirectMessages(
  myUserId: string,
  onNewMessage: (msg: DirectMessage) => void,
): () => void {
  if (!supabase || !isUuid(myUserId)) return () => {};
  const channel = supabase
    .channel(`dm-live:${myUserId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'direct_messages' },
      (payload) => {
        const raw = payload.new as RawDirectMessage | undefined;
        if (!raw) return;
        if (raw.sender_id === myUserId || raw.recipient_id === myUserId) {
          onNewMessage(toDirectMessage(raw));
        }
      },
    )
    .subscribe();
  return () => {
    void supabase?.removeChannel(channel);
  };
}

// ── 4. Multi-Filter Catalog Discovery & Tonight's Random Pick ────────────────────────────────

export interface CatalogFilterQuery {
  world?: FandomId | null;
  genre?: string | null;
  provider?: string | null;
  status?: 'airing' | 'upcoming' | 'completed' | null;
  minRating?: number | null;
  minYear?: number | null;
  sort?: 'relevance' | 'rating' | 'popular' | 'newest' | 'random';
  limit?: number;
  offset?: number;
}

export async function discoverCatalogTitles(
  query: CatalogFilterQuery,
  fallbackDramas: Drama[] | Record<string, Drama> = [],
): Promise<Drama[]> {
  const fallbackList: Drama[] = Array.isArray(fallbackDramas)
    ? fallbackDramas
    : Object.values(fallbackDramas);
  if (supabase) {
    const { data, error } = await supabase.rpc('discover_catalog', {
      p_world: query.world ?? null,
      p_genre: query.genre ?? null,
      p_provider: query.provider ?? null,
      p_status: query.status ?? null,
      p_min_rating: query.minRating ?? null,
      p_min_year: query.minYear ?? null,
      p_sort: query.sort ?? 'relevance',
      p_limit: query.limit ?? 30,
      p_offset: query.offset ?? 0,
    });
    if (!error && Array.isArray(data) && data.length > 0) {
      return (data as ServerTitleRow[]).map(serverTitleToDrama);
    }
  }

  // Honest offline fallback against already-cached real dramas in device store
  let list = [...fallbackList];
  if (query.world) {
    list = list.filter((d) =>
      query.world === 'hollywood'
        ? d.format === 'hollywood-series' || d.format === 'hollywood-movie'
        : d.format === query.world,
    );
  }
  if (query.genre) {
    const g = query.genre.toLowerCase();
    list = list.filter((d) => d.genres.some((item) => item.toLowerCase() === g));
  }
  if (query.provider) {
    const p = query.provider.toLowerCase();
    list = list.filter(
      (d) =>
        (d.network ?? '').toLowerCase().includes(p) ||
        (d.streamingOn ?? []).some((s) => s.toLowerCase().includes(p)),
    );
  }
  if (query.status) {
    list = list.filter((d) => d.status === query.status);
  }
  if (query.minRating) {
    list = list.filter((d) => (d.rating ?? 0) >= query.minRating!);
  }
  if (query.sort === 'rating') list.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  else if (query.sort === 'newest') list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  else if (query.sort === 'random' && list.length > 1) {
    const idx = Math.floor(Math.random() * list.length);
    return [list[idx]!];
  }
  return list.slice(0, query.limit ?? 30);
}

// ── 5. Real-Time Live Episode Watch Rooms (Presence + Live Reaction Broadcast) ───────────────

export interface LiveRoomViewer {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  joinedAt: string;
}

export interface LiveReactionBurst {
  kind: ReactionKind;
  senderHandle: string;
  timestampTag?: string;
  sentAt: string;
}

export interface LiveRoomConnection {
  sendReaction: (kind: ReactionKind, timestampTag?: string) => void;
  leave: () => void;
}

export function connectLiveEpisodeRoom(
  roomKey: string,
  viewer: Pick<User, 'id' | 'handle' | 'displayName' | 'avatarUrl'>,
  handlers: {
    onViewersChange: (viewers: LiveRoomViewer[]) => void;
    onReactionBurst: (burst: LiveReactionBurst) => void;
  },
): LiveRoomConnection {
  if (!supabase) {
    handlers.onViewersChange([
      {
        userId: viewer.id,
        handle: viewer.handle,
        displayName: viewer.displayName,
        avatarUrl: viewer.avatarUrl,
        joinedAt: new Date().toISOString(),
      },
    ]);
    return {
      sendReaction: () => {},
      leave: () => {},
    };
  }

  const channel: RealtimeChannel = supabase.channel(`episode-watch-room:${roomKey}`, {
    config: {
      presence: { key: viewer.id },
      broadcast: { self: false },
    },
  });

  const syncPresence = () => {
    const state = channel.presenceState<LiveRoomViewer>();
    const map = new Map<string, LiveRoomViewer>();
    for (const entries of Object.values(state)) {
      for (const entry of entries) {
        if (entry?.userId) map.set(entry.userId, entry);
      }
    }
    if (!map.has(viewer.id)) {
      map.set(viewer.id, {
        userId: viewer.id,
        handle: viewer.handle,
        displayName: viewer.displayName,
        avatarUrl: viewer.avatarUrl,
        joinedAt: new Date().toISOString(),
      });
    }
    handlers.onViewersChange([...map.values()]);
  };

  channel
    .on('presence', { event: 'sync' }, syncPresence)
    .on('presence', { event: 'join' }, syncPresence)
    .on('presence', { event: 'leave' }, syncPresence)
    .on('broadcast', { event: 'live_reaction' }, ({ payload }) => {
      if (payload?.kind) {
        handlers.onReactionBurst(payload as LiveReactionBurst);
      }
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({
          userId: viewer.id,
          handle: viewer.handle,
          displayName: viewer.displayName,
          avatarUrl: viewer.avatarUrl,
          joinedAt: new Date().toISOString(),
        });
      }
    });

  return {
    sendReaction: (kind: ReactionKind, timestampTag?: string) => {
      void channel.send({
        type: 'broadcast',
        event: 'live_reaction',
        payload: {
          kind,
          senderHandle: viewer.handle,
          timestampTag,
          sentAt: new Date().toISOString(),
        },
      });
    },
    leave: () => {
      void supabase?.removeChannel(channel);
    },
  };
}

// ── 6. Share Analytics, Video Creator Access, Staff Moderation, Follow Requests & Communities ──

export interface VideoAccessStatus {
  allowed: boolean;
  role: string;
  status: 'approved' | 'pending' | 'declined' | 'none' | 'signed_out';
  requestId?: string | null;
  requestNote?: string | null;
  decisionNote?: string | null;
  monthlyBudget: number;
  usedThisMonth: number;
}

export async function recordPostShare(postId: string, channel = 'copy_link'): Promise<void> {
  if (!supabase || !isUuid(postId)) return;
  try {
    await supabase.rpc('record_post_share', { p_post_id: postId, p_channel: channel });
  } catch {
    // Non-blocking telemetry
  }
}

export async function fetchVideoAccessStatus(): Promise<VideoAccessStatus> {
  if (!supabase || !getBackendAccessToken()) {
    return { allowed: false, role: 'guest', status: 'signed_out', monthlyBudget: 0, usedThisMonth: 0 };
  }
  const { data, error } = await supabase.rpc('my_video_access_status');
  if (error || !data) {
    const fallback = await supabase.rpc('video_access');
    return {
      allowed: Boolean(fallback.data),
      role: 'member',
      status: fallback.data ? 'approved' : 'none',
      monthlyBudget: fallback.data ? 1073741824 : 0,
      usedThisMonth: 0,
    };
  }
  const raw = data as Record<string, unknown>;
  return {
    allowed: Boolean(raw.allowed),
    role: String(raw.role ?? 'member'),
    status: (raw.status as VideoAccessStatus['status']) ?? 'none',
    requestId: (raw.request_id as string | null) ?? null,
    requestNote: (raw.request_note as string | null) ?? null,
    decisionNote: (raw.decision_note as string | null) ?? null,
    monthlyBudget: Number(raw.monthly_budget ?? 0),
    usedThisMonth: Number(raw.used_this_month ?? 0),
  };
}

export async function requestVideoCreatorAccess(note?: string): Promise<string> {
  if (!supabase || !getBackendAccessToken()) throw new Error('Sign in to request creator access');
  const { data, error } = await supabase.rpc('request_video_access', {
    p_note: note?.trim() ? note.trim() : undefined,
  });
  if (error) throw new Error(error.message);
  return String(data ?? '');
}

export interface StaffOverviewPayload {
  videoRequests: {
    id: string;
    userId: string;
    handle: string;
    displayName: string;
    avatarUrl?: string;
    status: string;
    note?: string | null;
    decisionNote?: string | null;
    createdAt: string;
  }[];
  creators: {
    userId: string;
    handle: string;
    displayName: string;
    budget: number;
    usedThisMonth: number;
    grantedAt: string;
    revokedAt?: string | null;
  }[];
  reports: {
    id: string;
    targetType: string;
    targetId: string;
    reason: string;
    detail?: string | null;
    status: string;
    createdAt: string;
    reporterHandle?: string | null;
    postBody?: string | null;
  }[];
  communities: {
    id: string;
    name: string;
    fandom: FandomId;
    description: string;
    memberCount: number;
    postCount: number;
    joinPolicy: string;
    isLocked: boolean;
  }[];
}

export async function fetchStaffOverview(): Promise<StaffOverviewPayload> {
  if (!supabase || !getBackendAccessToken()) throw new Error('Staff authentication required');
  const { data, error } = await supabase.rpc('get_staff_overview');
  if (error) throw new Error(error.message);
  const raw = (data ?? {}) as Record<string, unknown>;
  const rawReqs = Array.isArray(raw.video_requests) ? (raw.video_requests as Record<string, unknown>[]) : [];
  const avatarPaths = rawReqs
    .map((r) => r.avatar_path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  const avatars = avatarPaths.length ? await signedUrls(avatarPaths).catch(() => new Map<string, string>()) : new Map<string, string>();

  return {
    videoRequests: rawReqs.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      handle: String(r.handle ?? ''),
      displayName: String(r.display_name ?? r.handle ?? 'Member'),
      avatarUrl: typeof r.avatar_path === 'string' ? avatars.get(r.avatar_path) : undefined,
      status: String(r.status ?? 'pending'),
      note: (r.note as string | null) ?? null,
      decisionNote: (r.decision_note as string | null) ?? null,
      createdAt: String(r.created_at ?? new Date().toISOString()),
    })),
    creators: (Array.isArray(raw.creators) ? (raw.creators as Record<string, unknown>[]) : []).map((c) => ({
      userId: String(c.user_id),
      handle: String(c.handle ?? ''),
      displayName: String(c.display_name ?? c.handle ?? 'Creator'),
      budget: Number(c.budget ?? 0),
      usedThisMonth: Number(c.used_this_month ?? 0),
      grantedAt: String(c.granted_at ?? new Date().toISOString()),
      revokedAt: (c.revoked_at as string | null) ?? null,
    })),
    reports: (Array.isArray(raw.reports) ? (raw.reports as Record<string, unknown>[]) : []).map((rep) => ({
      id: String(rep.id),
      targetType: String(rep.target_type ?? 'post'),
      targetId: String(rep.target_id ?? ''),
      reason: String(rep.reason ?? 'other'),
      detail: (rep.detail as string | null) ?? null,
      status: String(rep.status ?? 'open'),
      createdAt: String(rep.created_at ?? new Date().toISOString()),
      reporterHandle: (rep.reporter_handle as string | null) ?? null,
      postBody: (rep.post_body as string | null) ?? null,
    })),
    communities: (Array.isArray(raw.communities) ? (raw.communities as Record<string, unknown>[]) : []).map((c) => ({
      id: String(c.id),
      name: String(c.name ?? ''),
      fandom: ((c.fandom as FandomId) ?? 'kdrama'),
      description: String(c.description ?? ''),
      memberCount: Number(c.member_count ?? 0),
      postCount: Number(c.post_count ?? 0),
      joinPolicy: String(c.join_policy ?? 'open'),
      isLocked: Boolean(c.is_locked),
    })),
  };
}

export async function reviewVideoAccessRequest(
  requestId: string,
  approve: boolean,
  budgetMb = 2048,
  note?: string,
): Promise<void> {
  if (!supabase) throw new Error('Backend unavailable');
  const { error } = await supabase.rpc('review_video_access_request', {
    p_request_id: requestId,
    p_approve: approve,
    p_monthly_byte_budget: approve ? budgetMb * 1048576 : undefined,
    p_note: note?.trim() ? note.trim() : undefined,
  });
  if (error) throw new Error(error.message);
}

export async function grantVideoAccessByHandle(handle: string, budgetMb = 2048, note?: string): Promise<void> {
  if (!supabase) throw new Error('Backend unavailable');
  const { error } = await supabase.rpc('staff_grant_video_by_handle', {
    p_handle: handle.trim().replace(/^@/, ''),
    p_budget_mb: budgetMb,
    p_note: note?.trim() ? note.trim() : undefined,
  });
  if (error) throw new Error(error.message);
}

export async function reviewModerationReport(
  reportId: string,
  decision: 'resolved' | 'dismissed' | 'escalated',
  reason?: string,
): Promise<void> {
  if (!supabase) throw new Error('Backend unavailable');
  const { error } = await supabase.rpc('review_report', {
    p_report_id: reportId,
    p_decision: decision as never,
    p_reason: reason ?? undefined,
  });
  if (error) throw new Error(error.message);
}

export async function moderatePostState(postId: string, state: 'active' | 'hidden', reason?: string): Promise<void> {
  if (!supabase) throw new Error('Backend unavailable');
  const { error } = await supabase.rpc('set_post_state', {
    p_post_id: postId,
    p_state: state,
    p_reason: reason ?? 'Staff moderation update',
  });
  if (error) throw new Error(error.message);
}

export async function toggleCommunityLock(communityId: string, lock: boolean): Promise<void> {
  if (!supabase) throw new Error('Backend unavailable');
  const { error } = await supabase.rpc('lock_community', {
    p_community_id: communityId,
    p_lock: lock,
    p_reason: lock ? 'Locked by community staff' : 'Unlocked by community staff',
  });
  if (error) throw new Error(error.message);
}

export interface IncomingFollowRequest {
  id: string;
  requesterId: string;
  handle: string;
  displayName: string;
  avatarUrl?: string;
  verified: boolean;
  bio?: string | null;
  createdAt: string;
}

export async function fetchFollowRequests(): Promise<{
  incoming: IncomingFollowRequest[];
  outgoingIds: string[];
}> {
  if (!supabase || !getBackendAccessToken()) return { incoming: [], outgoingIds: [] };
  const { data, error } = await supabase.rpc('list_follow_requests');
  if (error || !data) return { incoming: [], outgoingIds: [] };
  const raw = data as { incoming?: Record<string, unknown>[]; outgoing_ids?: string[] };
  const incomingRaw = Array.isArray(raw.incoming) ? raw.incoming : [];
  const paths = incomingRaw
    .map((r) => r.avatar_path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  const signed = paths.length ? await signedUrls(paths).catch(() => new Map<string, string>()) : new Map<string, string>();
  return {
    incoming: incomingRaw.map((r) => ({
      id: String(r.id),
      requesterId: String(r.requester_id),
      handle: String(r.handle ?? ''),
      displayName: String(r.display_name ?? r.handle ?? 'Member'),
      avatarUrl: typeof r.avatar_path === 'string' ? signed.get(r.avatar_path) : undefined,
      verified: Boolean(r.verified),
      bio: (r.bio as string | null) ?? null,
      createdAt: String(r.created_at ?? new Date().toISOString()),
    })),
    outgoingIds: Array.isArray(raw.outgoing_ids) ? raw.outgoing_ids.map(String) : [],
  };
}

export async function respondFollowRequest(requesterId: string, accept: boolean): Promise<void> {
  if (!supabase || !getBackendAccessToken()) throw new Error('Sign in required');
  const { error } = await supabase.rpc('respond_follow_request', {
    p_requester_id: requesterId,
    p_accept: accept,
  });
  if (error) throw new Error(error.message);
}

export interface LiveCommunityDetail {
  id: string;
  name: string;
  fandom: FandomId;
  description: string;
  coverTone: string;
  coverUrl?: string;
  dramaId?: string;
  memberCount: number;
  postCount: number;
  joinPolicy: string;
  isLocked: boolean;
  isMember: boolean;
  myRole?: string | null;
}

export async function createCommunityRoom(input: {
  name: string;
  fandom: FandomId;
  description?: string;
  coverTone?: string;
}): Promise<LiveCommunityDetail> {
  if (!supabase || !getBackendAccessToken()) throw new Error('Sign in to create a community');
  const { data, error } = await supabase.rpc('create_community_room', {
    p_name: input.name.trim(),
    p_fandom: input.fandom,
    p_description: input.description?.trim() ?? '',
    p_cover_tone: input.coverTone ?? '#E11D48',
  });
  if (error) throw new Error(error.message);
  const raw = (data ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id),
    name: String(raw.name ?? input.name),
    fandom: (raw.fandom as FandomId) ?? input.fandom,
    description: String(raw.description ?? input.description ?? ''),
    coverTone: String(raw.cover_tone ?? input.coverTone ?? '#E11D48'),
    memberCount: Number(raw.member_count ?? 1),
    postCount: Number(raw.post_count ?? 0),
    joinPolicy: 'open',
    isLocked: false,
    isMember: true,
    myRole: 'moderator',
  };
}

export async function fetchCommunityDetail(communityId: string): Promise<LiveCommunityDetail | null> {
  if (!supabase || !isUuid(communityId)) return null;
  const { data, error } = await supabase.rpc('get_community_detail', { p_community_id: communityId });
  if (error || !data) return null;
  const raw = data as {
    community?: Record<string, unknown>;
    is_member?: boolean;
    my_role?: string | null;
  };
  const c = raw.community;
  if (!c) return null;
  return {
    id: String(c.id),
    name: String(c.name ?? 'Community'),
    fandom: (c.fandom as FandomId) ?? 'kdrama',
    description: String(c.description ?? ''),
    coverTone: String(c.cover_tone ?? '#E11D48'),
    coverUrl: (c.cover_url as string | null) ?? undefined,
    dramaId: (c.drama_id as string | null) ?? undefined,
    memberCount: Number(c.member_count ?? 0),
    postCount: Number(c.post_count ?? 0),
    joinPolicy: String(c.join_policy ?? 'open'),
    isLocked: Boolean(c.is_locked),
    isMember: Boolean(raw.is_member),
    myRole: raw.my_role ?? null,
  };
}
