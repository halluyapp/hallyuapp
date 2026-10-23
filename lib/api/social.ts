/**
 * Social write layer — the production mirror for member content.
 *
 * Every mutation the app performs on member content goes to the Hallyu backend whenever the build is
 * connected AND a session exists; the Zustand store stays the optimistic cache the screens read
 * (lib/sync.ts is the bridge). Writes use the primitives the schema was designed around:
 *
 *  - explicit-id inserts for content — client ids are real UUIDs (lib/format.ts `uid()`), so a post
 *    or comment created on the device IS the row the server stores, with no remapping;
 *  - explicit ownership-scoped update/delete for edits and soft deletes (RLS enforces the owner);
 *  - the RPCs where the server owns the semantics: follows, watchlist, preferences, notification
 *    read state, blocks/mutes, reports and communities.
 *
 * Nothing here runs without a session: `hasSession()` gates the mirror, so a device-local build or a
 * signed-out member keeps the original device-local behaviour untouched.
 */
import type { Actor, Collection, Comment, Drama, NotificationGroup, Post, ReactionKind, User } from '../model';
import type { Prefs } from '../store';
import { ensureBackendSessionToken, getBackendAccessToken, supabase } from './client';
import { uploadAvatar } from './media';

/** True when a real backend session exists (Supabase client + a member access token). */
export function hasSession(): boolean {
  return Boolean(supabase && getBackendAccessToken());
}

async function dbSession() {
  const client = supabase;
  if (!client || !(await ensureBackendSessionToken())) {
    throw new Error('a backend session is required');
  }
  return client;
}

const fail = (what: string, message?: string): never => {
  throw new Error(`${what} failed: ${message ?? 'unknown backend error'}`);
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value?: string | null): value is string => Boolean(value && UUID_RE.test(value));

// ── Provider id ↔ server uuid resolution ──────────────────────────────────────────────────────
// Client catalog ids are provider slugs (`tmdb-<external>`, `tmdb-movie-<external>`); the database
// keys titles by uuid. Everything that writes a title reference goes through these caches and
// materialises newly discovered TMDB titles/people on demand via `ensure_client_title` / `ensure_client_person`.

let lookupClientDrama: ((id: string) => Drama | undefined) | null = null;
let lookupClientActor: ((id: string) => Actor | undefined) | null = null;

export function registerCatalogLookup(
  getDrama: (id: string) => Drama | undefined,
  getActor: (id: string) => Actor | undefined,
) {
  lookupClientDrama = getDrama;
  lookupClientActor = getActor;
}

const titleIdBySlug = new Map<string, string>();
const titleInflight = new Map<string, Promise<string | null>>();
const personIdBySlug = new Map<string, string>();
const personInflight = new Map<string, Promise<string | null>>();

function parseProviderSlug(clientId: string): { external: string; mediaType: 'tv' | 'movie' } | null {
  const m = /^tmdb-(movie-)?(.+)$/.exec(clientId);
  if (!m) return null;
  return { external: m[2]!, mediaType: m[1] ? 'movie' : 'tv' };
}

function worldForDrama(drama?: Drama): string {
  if (!drama) return 'hollywood';
  if (drama.format === 'kdrama' || drama.format === 'cdrama' || drama.format === 'anime') return drama.format;
  return 'hollywood';
}

/** Client drama id (`tmdb-…`) → `titles.id` uuid, materialising imported TMDB titles on demand. */
export function resolveTitleUuid(clientId?: string | null): Promise<string | null> {
  if (!clientId) return Promise.resolve(null);
  if (isUuid(clientId)) return Promise.resolve(clientId);
  const cached = titleIdBySlug.get(clientId);
  if (cached) return Promise.resolve(cached);
  const inflight = titleInflight.get(clientId);
  if (inflight) return inflight;

  const run = (async (): Promise<string | null> => {
    if (!supabase) return null;
    const parsed = parseProviderSlug(clientId);
    if (!parsed) return null;

    const exact = await supabase
      .from('titles')
      .select('id')
      .eq('external_id', parsed.external)
      .eq('media_type', parsed.mediaType)
      .limit(1);
    if (!exact.error && exact.data?.length) {
      const found = exact.data[0]!.id as string;
      titleIdBySlug.set(clientId, found);
      return found;
    }

    const loose = await supabase.from('titles').select('id').eq('external_id', parsed.external).limit(1);
    if (!loose.error && loose.data?.length) {
      const found = loose.data[0]!.id as string;
      titleIdBySlug.set(clientId, found);
      return found;
    }

    const drama = lookupClientDrama?.(clientId);
    if (drama && (await ensureBackendSessionToken())) {
      const { data: ensured, error: ensureErr } = await supabase.rpc('ensure_client_title', {
        p_external_id: parsed.external,
        p_media_type: drama.mediaType ?? parsed.mediaType,
        p_world: worldForDrama(drama),
        p_title: drama.title,
        p_original_title: drama.originalTitle ?? null,
        p_year: drama.year || 2024,
        p_status: drama.status ?? 'completed',
        p_genres: drama.genres ?? [],
        p_synopsis: drama.synopsis ?? '',
        p_poster_url: drama.posterUrl ?? null,
        p_backdrop_url: drama.backdropUrl ?? null,
        p_tone: drama.tone ?? '#1F2430',
        p_episode_count: drama.episodeCount ?? 0,
        p_vote_average: drama.rating ?? null,
      });
      if (!ensureErr && typeof ensured === 'string' && isUuid(ensured)) {
        titleIdBySlug.set(clientId, ensured);
        return ensured;
      }
    }
    return null;
  })()
    .catch(() => null)
    .finally(() => {
      titleInflight.delete(clientId);
    });

  titleInflight.set(clientId, run);
  return run;
}

/** Client actor id (`tmdb-<external>`) → `people.id` uuid, materialising imported TMDB actors on demand. */
export function resolvePersonUuid(clientId?: string | null): Promise<string | null> {
  if (!clientId) return Promise.resolve(null);
  if (isUuid(clientId)) return Promise.resolve(clientId);
  const cached = personIdBySlug.get(clientId);
  if (cached) return Promise.resolve(cached);
  const inflight = personInflight.get(clientId);
  if (inflight) return inflight;

  const run = (async (): Promise<string | null> => {
    if (!supabase) return null;
    const parsed = parseProviderSlug(clientId);
    if (!parsed) return null;
    const { data, error } = await supabase.from('people').select('id').eq('external_id', parsed.external).limit(1);
    if (!error && data?.length) {
      const found = data[0]!.id as string;
      personIdBySlug.set(clientId, found);
      return found;
    }

    const actor = lookupClientActor?.(clientId);
    if (actor && (await ensureBackendSessionToken())) {
      const { data: ensured, error: ensureErr } = await supabase.rpc('ensure_client_person', {
        p_external_id: parsed.external,
        p_name: actor.name,
        p_original_name: actor.koreanName ?? null,
        p_photo_url: actor.photoUrl ?? null,
        p_bio: actor.bio ?? '',
      });
      if (!ensureErr && typeof ensured === 'string' && isUuid(ensured)) {
        personIdBySlug.set(clientId, ensured);
        return ensured;
      }
    }
    return null;
  })()
    .catch(() => null)
    .finally(() => {
      personInflight.delete(clientId);
    });

  personInflight.set(clientId, run);
  return run;
}

// ── Posts ─────────────────────────────────────────────────────────────────────────────────────

export async function insertPost(post: Post, authorId: string, world?: string | null): Promise<void> {
  const client = await dbSession();
  const [titleId, secondaryId] = await Promise.all([
    resolveTitleUuid(post.context.dramaId),
    resolveTitleUuid(post.context.secondaryDramaId),
  ]);
  const { error } = await client
    .from('posts')
    .insert({
      id: post.id,
      author_id: authorId,
      type: post.type,
      title: post.title ?? null,
      body: post.body,
      kind: post.kind ?? null,
      rating: post.rating ?? null,
      verdict: post.verdict ?? null,
      spoiler: post.spoiler,
      visibility: 'public',
      world: world ?? null,
      title_id: titleId,
      secondary_title_id: secondaryId,
      community_id: isUuid(post.context.communityId) ? post.context.communityId : null,
      season: post.context.season ?? null,
      episode: post.context.episode ?? null,
      hashtags: post.hashtags,
      mentions: post.mentions.filter(isUuid),
      created_at: post.createdAt,
    });
  if (error) fail('post insert', error.message);

  if (post.poll && post.poll.options.length >= 2) {
    const cleanOptions = post.poll.options.map((o) => o.trim()).filter(Boolean).slice(0, 4);
    if (cleanOptions.length >= 2) {
      const { error: pollError } = await client.rpc('create_post_poll', {
        p_post_id: post.id,
        p_question: post.poll.question.trim() || 'Vote below',
        p_options: cleanOptions,
        p_hours: 168,
      });
      if (pollError) {
        await client.from('posts').delete().eq('id', post.id).then(() => undefined, () => undefined);
        fail('poll insert', pollError.message);
      }
    }
  }
}

/**
 * Removes an incomplete post row created during an aborted publish attempt before media or poll
 * verification succeeded. RLS (`posts_delete_own`) strictly confines deletion to `author_id = auth.uid()`.
 */
export async function cleanupUnpublishedPost(postId: string): Promise<void> {
  if (!isUuid(postId)) return;
  const client = await dbSession();
  const { error } = await client.from('posts').delete().eq('id', postId);
  if (error) fail('post rollback', error.message);
}

/** Edit by its author: persists every mutable composer field cleanly and verifies row update. */
export async function updatePost(
  id: string,
  patch: Partial<Post>,
  world?: string | null,
): Promise<void> {
  const client = await dbSession();
  const row: Record<string, unknown> = { edited_at: new Date().toISOString() };
  if ('body' in patch && patch.body !== undefined) row.body = patch.body;
  if ('title' in patch) row.title = patch.title?.trim() ? patch.title.trim() : null;
  if ('kind' in patch) row.kind = patch.kind ?? null;
  if ('rating' in patch) row.rating = typeof patch.rating === 'number' ? patch.rating : null;
  if ('verdict' in patch) row.verdict = patch.verdict?.trim() ? patch.verdict.trim() : null;
  if ('spoiler' in patch && patch.spoiler !== undefined) row.spoiler = patch.spoiler;
  if ('hashtags' in patch && Array.isArray(patch.hashtags)) row.hashtags = patch.hashtags;
  if ('mentions' in patch && Array.isArray(patch.mentions)) {
    row.mentions = patch.mentions.filter((m): m is string => isUuid(m));
  }
  if ('context' in patch && patch.context) {
    const [primaryUuid, secondaryUuid] = await Promise.all([
      patch.context.dramaId ? resolveTitleUuid(patch.context.dramaId) : Promise.resolve(null),
      patch.context.secondaryDramaId
        ? resolveTitleUuid(patch.context.secondaryDramaId)
        : Promise.resolve(null),
    ]);
    row.title_id = primaryUuid;
    row.secondary_title_id = secondaryUuid;
    row.season = patch.context.season ?? null;
    row.episode = patch.context.episode ?? null;
    if (world !== undefined) {
      row.world = world;
    }
  }
  const { data, error } = await client
    .from('posts')
    .update(row)
    .eq('id', id)
    .select('id')
    .single();
  if (error || !data) {
    fail('post update', error?.message ?? 'Post not found or permission denied');
  }
}

/** Soft delete: the row stays (comment threads intact), its state becomes `deleted`. */
export async function deletePost(id: string): Promise<void> {
  const client = await dbSession();
  const { error } = await client.from('posts').update({ state: 'deleted', deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) fail('post delete', error.message);
}

// ── Comments ──────────────────────────────────────────────────────────────────────────────────

export async function insertComment(comment: Comment, authorId: string): Promise<void> {
  const client = await dbSession();
  const { error } = await client
    .from('comments')
    .insert({
      id: comment.id,
      post_id: comment.postId,
      author_id: authorId,
      parent_id: isUuid(comment.parentId) ? comment.parentId : null,
      body: comment.body,
      spoiler: comment.spoiler,
      created_at: comment.createdAt,
    });
  if (error) fail('comment insert', error.message);
}

export async function deleteComment(id: string): Promise<void> {
  const client = await dbSession();
  const { error } = await client.from('comments').update({ state: 'deleted', deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) fail('comment delete', error.message);
}

// ── Reactions and saves (explicit, idempotent — the client state is authoritative) ─────────────

/** Set or clear the member's one reaction on a post/comment. `user_id` has no column default. */
export async function setReaction(userId: string, target: { postId?: string; commentId?: string }, kind: ReactionKind | null): Promise<void> {
  const column = target.commentId ? 'comment_id' : 'post_id';
  const targetId = target.commentId ?? target.postId;
  if (!isUuid(userId) || !isUuid(targetId)) return;
  const client = await dbSession();
  // Owner-scoped by RLS: a member can only clear their own reaction.
  const { error } = await client.from('reactions').delete().eq(column, targetId);
  if (error) fail('reaction clear', error.message);
  if (!kind) return;
  const insert = await client.from('reactions').insert({ user_id: userId, [column]: targetId, kind });
  if (insert.error) fail('reaction set', insert.error.message);
}

/** Save/unsave a post. Idempotent on the (user, post) primary key; save rows carry no default user. */
export async function setSaved(userId: string, postId: string, on: boolean): Promise<void> {
  if (!isUuid(userId) || !isUuid(postId)) return;
  const client = await dbSession();
  if (on) {
    const { error } = await client
      .from('saves')
      .upsert({ user_id: userId, post_id: postId }, { ignoreDuplicates: true, onConflict: 'user_id,post_id' });
    if (error) fail('save', error.message);
  } else {
    const { error } = await client.from('saves').delete().eq('post_id', postId);
    if (error) fail('unsave', error.message);
  }
}

// ── Follows, watchlist, preferences ──────────────────────────────────────────────────────────

export type FollowKind = 'user' | 'title' | 'person' | 'collection';

export async function setFollow(kind: FollowKind, targetId: string, on: boolean): Promise<void> {
  const client = await dbSession();
  const target = kind === 'title' ? await resolveTitleUuid(targetId) : kind === 'person' ? await resolvePersonUuid(targetId) : targetId;
  if (!isUuid(target)) return;
  const { error } = await client.rpc('set_follow', { p_kind: kind, p_target_id: target, p_on: on });
  if (error) fail('follow', error.message);
}

export async function upsertWatchlist(dramaId: string, item: { status: string; season: number; currentEpisode: number; note?: string }): Promise<void> {
  const client = await dbSession();
  const titleId = await resolveTitleUuid(dramaId);
  if (!titleId) return;
  const { error } = await client.rpc('upsert_watchlist_item', {
    p_title_id: titleId,
    p_status: item.status,
    p_season: item.season,
    p_episode: item.currentEpisode,
    p_total: null,
    p_note: item.note ?? null,
    p_allow_rewind: true,
  });
  if (error) fail('watchlist upsert', error.message);
}

export async function removeWatchlist(dramaId: string): Promise<void> {
  const client = await dbSession();
  const titleId = await resolveTitleUuid(dramaId);
  if (!titleId) return;
  const { error } = await client.from('watchlist_items').delete().eq('title_id', titleId);
  if (error) fail('watchlist remove', error.message);
}

/** Client `Prefs` keys → the allow-listed `merge_preferences` column names. */
export function prefsPatch(patch: Partial<Prefs>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.protection !== undefined) out.protection = patch.protection;
  if (patch.autoplay !== undefined) out.autoplay = patch.autoplay;
  if (patch.oneTapReactions !== undefined) out.one_tap_reactions = patch.oneTapReactions;
  if (patch.mutedWords !== undefined) out.muted_words = patch.mutedWords;
  if (patch.trueBlack !== undefined) out.true_black = patch.trueBlack;
  if (patch.personalization !== undefined) out.personalization = patch.personalization;
  if (patch.reduceMotion !== undefined) out.reduce_motion = patch.reduceMotion;
  if (patch.dataSaver !== undefined) out.data_saver = patch.dataSaver;
  if (patch.language !== undefined) out.language = patch.language;
  if (patch.termsVersion !== undefined) out.terms_version = patch.termsVersion;
  if (patch.guidelinesAccepted !== undefined) out.guidelines_accepted = patch.guidelinesAccepted;
  const n = patch.notifications;
  if (n) {
    if (n.episodes !== undefined) out.notify_episodes = n.episodes;
    if (n.social !== undefined) out.notify_social = n.social;
    if (n.highlights !== undefined) out.notify_highlights = n.highlights;
    if (n.system !== undefined) out.notify_system = n.system;
    if (n.quietHours !== undefined) out.quiet_hours = n.quietHours;
  }
  return out;
}

export async function mergePreferences(patch: Partial<Prefs>): Promise<void> {
  const body = prefsPatch(patch);
  if (!Object.keys(body).length) return;
  const client = await dbSession();
  const { error } = await client.rpc('merge_preferences', { p_patch: body });
  if (error) fail('preferences merge', error.message);
}

export interface OnboardingPatch {
  worlds?: string[];
  genres?: string[];
  step?: number;
  done?: boolean;
}

export async function completeOnboarding(patch: OnboardingPatch): Promise<void> {
  const client = await dbSession();
  const { error } = await client.rpc('complete_onboarding', {
    p_worlds: patch.worlds ?? [],
    p_genres: patch.genres ?? [],
    p_step: patch.step ?? null,
  });
  if (error) fail('onboarding', error.message);
}

// ── Profile ───────────────────────────────────────────────────────────────────────────────────

/** Update the member's own profile row (RLS: own row only; the id filter pins it further). */
export async function updateProfile(userId: string, patch: Partial<User>): Promise<void> {
  if (!isUuid(userId)) return;
  const client = await dbSession();
  const row: Record<string, unknown> = {};
  if (patch.displayName !== undefined) row.display_name = patch.displayName;
  if (patch.handle !== undefined) row.handle = patch.handle.trim().toLowerCase().replace(/^@/, '');
  if ('bio' in patch) {
    const cleanBio = typeof patch.bio === 'string' ? patch.bio.trim() : '';
    row.bio = cleanBio.length > 0 ? cleanBio : null;
  }
  if (patch.bannerUrl !== undefined) row.banner_url = patch.bannerUrl ?? null;
  if (patch.favoriteGenres !== undefined) row.favorite_genres = patch.favoriteGenres;
  if (patch.isPrivate !== undefined) row.is_private = patch.isPrivate;
  if (patch.fandoms !== undefined) row.worlds = patch.fandoms;
  if (patch.favoriteDramaIds !== undefined) {
    const resolved = await Promise.all(patch.favoriteDramaIds.slice(0, 4).map((id) => resolveTitleUuid(id)));
    row.favorite_title_ids = resolved.filter((id): id is string => Boolean(id));
  }
  if (patch.avatarPath !== undefined) {
    row.avatar_path = patch.avatarPath ?? null;
  } else if (patch.avatarUrl !== undefined) {
    if (!patch.avatarUrl) {
      row.avatar_path = null;
    } else if (/^u\//.test(patch.avatarUrl)) {
      row.avatar_path = patch.avatarUrl;
    } else if (/^(blob:|file:|content:|ph:|data:|assets-library:)/i.test(patch.avatarUrl)) {
      const uploaded = await uploadAvatar(userId, patch.avatarUrl);
      row.avatar_path = uploaded.storagePath;
    }
  }
  if (!Object.keys(row).length) return;
  const { error } = await client.from('profiles').update(row).eq('id', userId);
  if (error) fail('profile update', error.message);
}

/** Enable or disable per-drama airing alerts (`set_title_alert` RPC). */
export async function setTitleAlert(dramaId: string, on: boolean): Promise<void> {
  const client = await dbSession();
  const titleId = await resolveTitleUuid(dramaId);
  if (!titleId) return;
  const { error } = await client.rpc('set_title_alert', { p_title_id: titleId, p_on: on });
  if (error) fail('title alert', error.message);
}

// ── Notification read state ───────────────────────────────────────────────────────────────────

export async function markNotificationsRead(ids?: string[], group?: NotificationGroup): Promise<void> {
  const client = await dbSession();
  const { error } = await client.rpc('mark_notifications_read', {
    p_ids: (ids ?? []).filter(isUuid),
    p_group: group ?? null,
  });
  if (error) fail('notifications read', error.message);
}

// ── Moderation, communities, collections ─────────────────────────────────────────────────────

export async function setBlock(userId: string, on: boolean): Promise<void> {
  if (!isUuid(userId)) return;
  const client = await dbSession();
  const { error } = await client.rpc('set_block', { p_user_id: userId, p_on: on });
  if (error) fail('block', error.message);
}

export async function setMute(kind: 'user' | 'title', targetId: string, on: boolean): Promise<void> {
  const client = await dbSession();
  const target = kind === 'title' ? await resolveTitleUuid(targetId) : targetId;
  if (!isUuid(target)) return;
  const { error } = await client.rpc('set_mute', { p_kind: kind, p_target_id: target, p_on: on });
  if (error) fail('mute', error.message);
}

export async function reportContent(targetType: string, targetId: string, reason: string, detail?: string): Promise<void> {
  if (!isUuid(targetId)) return;
  const client = await dbSession();
  const { error } = await client.rpc('report_content', {
    p_target_type: targetType,
    p_target_id: targetId,
    p_reason: reason,
    p_detail: detail ?? null,
  });
  if (error) fail('report', error.message);
}

export async function joinCommunity(communityId: string, on: boolean): Promise<void> {
  if (!isUuid(communityId)) return;
  const client = await dbSession();
  const { error } = await client.rpc('join_community', { p_community_id: communityId, p_on: on });
  if (error) fail('community membership', error.message);
}

/** Create or update a collection the member owns (title/visibility only — items are separate). */
export async function upsertCollection(collection: Collection, ownerId: string): Promise<void> {
  if (!isUuid(collection.id)) return;
  const client = await dbSession();
  const { error } = await client
    .from('collections')
    .upsert(
      {
        id: collection.id,
        owner_id: ownerId,
        title: collection.title,
        description: collection.description ?? null,
        visibility: collection.visibility,
      },
      { onConflict: 'id' },
    );
  if (error) fail('collection upsert', error.message);
}

export async function deleteCollection(id: string): Promise<void> {
  if (!isUuid(id)) return;
  const client = await dbSession();
  const { error } = await client.from('collections').delete().eq('id', id);
  if (error) fail('collection delete', error.message);
}

export async function setCollectionItem(collectionId: string, dramaId: string, on: boolean, note?: string): Promise<void> {
  if (!isUuid(collectionId)) return;
  const client = await dbSession();
  const titleId = await resolveTitleUuid(dramaId);
  if (!titleId) return;
  if (on) {
    const { error } = await client
      .from('collection_items')
      .upsert({ collection_id: collectionId, title_id: titleId, note: note ?? null }, { onConflict: 'collection_id,title_id' });
    if (error) fail('collection item', error.message);
  } else {
    const { error } = await client.from('collection_items').delete().eq('collection_id', collectionId).eq('title_id', titleId);
    if (error) fail('collection item removal', error.message);
  }
}
