/**
 * The store ↔ backend bridge + Supabase Realtime sync.
 *
 * Two directions, plus live Realtime subscriptions:
 *
 *  mirror   every write the app performs as a store action is forwarded to the Hallyu backend
 *           (lib/api/social.ts). When the backend rejects a write the optimistic cache is rolled
 *           back to the value it held before, and the failure is published so the screen shows an
 *           honest toast instead of pretending the change saved.
 *
 *  adopt    on sign-in/session restore (and on public cold start for anonymous visitors) server
 *           state — profile, preferences, follows, saves, reactions, collections, watchlist,
 *           alerts, feed posts, comments, public shelves, community pulse, and notifications — is
 *           folded cleanly into the local store cache.
 *
 *  realtime subscribes to Postgres changes on `posts`, `comments`, and `notifications` so live
 *           activity from other devices/members lands without manual reloads.
 */
import { reportError } from './analytics';
import { presentServerNotificationBanner } from './reminders';
import { fetchBootstrap, serverProfileToUser } from './api/bootstrap';
import {
  fetchComments,
  fetchCommunityPulse,
  fetchDramasByUuids,
  fetchFeed,
  fetchNotifications,
  fetchPosts,
  fetchPostThread,
  fetchProfileByHandle,
  fetchProfiles,
  fetchPublicCollections,
  hydrateCollectionBundles,
  resolveActorClientIds,
  toComment,
  type ServerComment,
} from './api/feed';
import { signedUrls } from './api/media';
import * as social from './api/social';
import { getBackendAccessToken, supabase } from './api/client';
import type { AppState, Action, Prefs } from './store';
import type { Collection, Comment, Drama, FandomId, Post, ReactionKind, User, WatchlistItem } from './model';

// ── Failed writes ──────────────────────────────────────────────────────────────────────────────

export interface SyncFailure {
  scope: string;
  message: string;
  rolledBack: boolean;
  error: unknown;
}

let failures: readonly SyncFailure[] = [];
const failureListeners = new Set<() => void>();

export function getSyncFailures(): readonly SyncFailure[] {
  return failures;
}

export function subscribeSyncFailures(fn: () => void): () => void {
  failureListeners.add(fn);
  return () => {
    failureListeners.delete(fn);
  };
}

function publishFailure(failure: SyncFailure): void {
  failures = [...failures, failure].slice(-20);
  for (const fn of Array.from(failureListeners)) fn();
}

const FAILURE_COPY: Record<string, string> = {
  addPost: 'Your post was not saved',
  editPost: 'Your edit was not saved',
  deletePost: 'That post was not deleted',
  addComment: 'Your comment was not saved',
  deleteComment: 'That comment was not deleted',
  react: 'That reaction was not saved',
  save: 'That save was not saved',
  follow: 'That follow was not saved',
  dramaNotify: 'That episode alert change was not saved',
  'watch.remove': 'Removing that title was not saved',
  'watch.upsert': 'Updating your watchlist was not saved',
  'watch.progress': 'Updating your progress was not saved',
  prefs: 'Your preferences were not saved',
  profile: 'Your profile was not saved',
  onboarding: 'Finishing setup was not saved',
  readNotifications: 'That was not marked as read',
  block: 'That block was not saved',
  muteUser: 'That mute was not saved',
  muteDrama: 'That mute was not saved',
  report: 'Your report was not sent',
  upsertCollection: 'That collection was not saved',
  deleteCollection: 'That collection was not deleted',
  collectionItem: 'That change to the collection was not saved',
};

// ── Mirror ────────────────────────────────────────────────────────────────────────────────────

let adopting = false;

const sessionReady = (): boolean => Boolean(supabase && getBackendAccessToken());

const MIRRORED_SLICES: Record<string, (keyof AppState)[]> = {
  addPost: ['posts'],
  editPost: ['posts'],
  deletePost: ['posts'],
  addComment: ['comments', 'posts'],
  deleteComment: ['comments', 'posts'],
  react: ['reactions', 'posts', 'comments'],
  save: ['saves', 'posts'],
  follow: ['follows'],
  dramaNotify: ['dramaNotify'],
  watch: ['watchlist', 'follows'],
  progress: ['watchlist', 'follows'],
  note: ['watchlist'],
  prefs: ['prefs'],
  profile: ['profile'],
  onboarding: ['onboarding'],
  readNotifications: ['notifications'],
  block: ['blockedUsers', 'follows'],
  muteUser: ['mutedUsers'],
  muteDrama: ['mutedDramas'],
  report: ['reported'],
  upsertCollection: ['collections'],
  deleteCollection: ['collections'],
  collectionItem: ['collections'],
};

let applyWithoutMirror: ((action: Action) => void) | null = null;

export function setApplyDispatcher(fn: (action: Action) => void): void {
  applyWithoutMirror = fn;
}

function applyLocal(action: Action): void {
  if (!applyWithoutMirror) return;
  adopting = true;
  try {
    applyWithoutMirror(action);
  } finally {
    adopting = false;
  }
}

function revert(action: Action, prev: AppState): void {
  const keys = MIRRORED_SLICES[action.type];
  if (!keys) return;
  const patch: Partial<AppState> = {};
  for (const key of keys) (patch as Record<string, unknown>)[key] = prev[key];
  applyLocal({ type: 'restore', patch });
}

export function adoptLocal(action: Action): void {
  applyLocal(action);
}

function write(action: Action, prev: AppState, scope: string, work: Promise<unknown>): void {
  void work.catch((e) => {
    revert(action, prev);
    reportError(`sync.${scope}`, e);
    publishFailure({ scope, message: FAILURE_COPY[scope] ?? 'That change was not saved', rolledBack: true, error: e });
  });
}

export function worldOf(state: AppState, dramaId?: string): string | null {
  if (!dramaId) return null;
  const format = state.importedDramas.find((d) => d.id === dramaId)?.format;
  if (!format) return null;
  if (format === 'kdrama' || format === 'cdrama' || format === 'anime') return format;
  return format.startsWith('hollywood') ? 'hollywood' : null;
}

const FOLLOW_KINDS: Record<keyof AppState['follows'], social.FollowKind> = {
  users: 'user',
  dramas: 'title',
  actors: 'person',
  collections: 'collection',
};

export function mirrorAction(action: Action, prev: AppState, next: AppState): void {
  if (adopting || !sessionReady()) return;
  const me = next.profile.id;

  switch (action.type) {
    case 'addPost':
      write(action, prev, 'addPost', social.insertPost(action.post, action.post.authorId ?? me, worldOf(next, action.post.context.dramaId)));
      return;
    case 'editPost':
      write(action, prev, 'editPost', social.updatePost(action.id, action.patch));
      return;
    case 'deletePost':
      write(action, prev, 'deletePost', social.deletePost(action.id));
      return;
    case 'addComment':
      write(action, prev, 'addComment', social.insertComment(action.comment, action.comment.authorId || me));
      return;
    case 'deleteComment':
      write(action, prev, 'deleteComment', social.deleteComment(action.id));
      return;
    case 'react': {
      const target = action.isComment ? { commentId: action.targetId } : { postId: action.targetId };
      write(action, prev, 'react', social.setReaction(me, target, action.kind));
      return;
    }
    case 'save': {
      const on = next.saves.includes(action.postId);
      if (on !== prev.saves.includes(action.postId)) write(action, prev, 'save', social.setSaved(me, action.postId, on));
      return;
    }
    case 'follow': {
      const on = next.follows[action.kind].includes(action.id);
      if (on !== prev.follows[action.kind].includes(action.id)) {
        write(action, prev, 'follow', social.setFollow(FOLLOW_KINDS[action.kind], action.id, on));
      }
      return;
    }
    case 'dramaNotify':
      write(action, prev, 'dramaNotify', social.setTitleAlert(action.id, action.on));
      return;
    case 'watch': {
      if (action.status === null) {
        write(action, prev, 'watch.remove', social.removeWatchlist(action.dramaId));
      } else {
        const item = next.watchlist[action.dramaId];
        if (item) write(action, prev, 'watch.upsert', social.upsertWatchlist(action.dramaId, item));
      }
      return;
    }
    case 'progress':
    case 'note': {
      const item = next.watchlist[action.dramaId];
      if (item) write(action, prev, 'watch.progress', social.upsertWatchlist(action.dramaId, item));
      return;
    }
    case 'prefs':
      write(action, prev, 'prefs', social.mergePreferences(action.patch));
      return;
    case 'profile':
      write(action, prev, 'profile', social.updateProfile(me, action.patch));
      return;
    case 'onboarding':
      if ('done' in action.patch || 'step' in action.patch || 'fandoms' in action.patch || 'genres' in action.patch) {
        write(
          action,
          prev,
          'onboarding',
          social.completeOnboarding({ worlds: next.onboarding.fandoms, genres: next.onboarding.genres, step: next.onboarding.step }),
        );
      }
      return;
    case 'readNotifications': {
      const group = action.group && action.group !== 'all' ? action.group : undefined;
      write(action, prev, 'readNotifications', social.markNotificationsRead(action.id ? [action.id] : undefined, group));
      return;
    }
    case 'block': {
      const on = next.blockedUsers.includes(action.userId);
      if (on !== prev.blockedUsers.includes(action.userId)) write(action, prev, 'block', social.setBlock(action.userId, on));
      return;
    }
    case 'muteUser': {
      const on = next.mutedUsers.includes(action.userId);
      if (on !== prev.mutedUsers.includes(action.userId)) write(action, prev, 'muteUser', social.setMute('user', action.userId, on));
      return;
    }
    case 'muteDrama': {
      const on = next.mutedDramas.includes(action.dramaId);
      if (on !== prev.mutedDramas.includes(action.dramaId)) write(action, prev, 'muteDrama', social.setMute('title', action.dramaId, on));
      return;
    }
    case 'report':
      write(action, prev, 'report', social.reportContent(action.targetType ?? 'post', action.id, action.reason ?? 'other', action.detail));
      return;
    case 'upsertCollection': {
      const collection = next.collections.find((c) => c.id === action.collection.id);
      if (collection) write(action, prev, 'upsertCollection', social.upsertCollection(collection, me));
      return;
    }
    case 'deleteCollection':
      write(action, prev, 'deleteCollection', social.deleteCollection(action.id));
      return;
    case 'collectionItem': {
      const collection = next.collections.find((c) => c.id === action.collectionId);
      const item = collection?.items.find((i) => i.dramaId === action.dramaId);
      write(action, prev, 'collectionItem', social.setCollectionItem(action.collectionId, action.dramaId, action.on, item?.note));
      return;
    }
    default:
      return;
  }
}

// ── Merge helpers ─────────────────────────────────────────────────────────────────────────────

function mergeDramas(existing: Drama[], incoming: Drama[]): Drama[] {
  if (!incoming.length) return existing;
  const byId = new Map(existing.map((d) => [d.id, d]));
  for (const d of incoming) {
    const prev = byId.get(d.id);
    byId.set(d.id, prev ? { ...d, ...prev, synopsis: d.synopsis || prev.synopsis, streamingOn: d.streamingOn?.length ? d.streamingOn : prev.streamingOn, trailerUrl: d.trailerUrl ?? prev.trailerUrl } : d);
  }
  return [...byId.values()];
}

function mergeCollections(existing: Collection[], incoming: Collection[]): Collection[] {
  if (!incoming.length) return existing;
  const byId = new Map(existing.map((c) => [c.id, c]));
  for (const c of incoming) byId.set(c.id, c);
  return [...byId.values()];
}

function mergeUsers(existing: Record<string, User>, incoming: User[]): Record<string, User> {
  if (!incoming.length) return existing;
  const out = { ...existing };
  for (const u of incoming) out[u.id] = { ...out[u.id], ...u };
  return out;
}

// ── Adoption ──────────────────────────────────────────────────────────────────────────────────

interface ServerPrefs {
  protection?: Prefs['protection'];
  autoplay?: Prefs['autoplay'];
  one_tap_reactions?: boolean;
  muted_words?: string[];
  true_black?: boolean;
  personalization?: boolean;
  reduce_motion?: boolean;
  notify_episodes?: boolean;
  notify_social?: boolean;
  notify_highlights?: boolean;
  notify_system?: boolean;
  quiet_hours?: boolean;
  language?: Prefs['language'];
  guidelines_accepted?: boolean;
  data_saver?: boolean;
  terms_version?: number;
}

function adoptPrefs(server: ServerPrefs | null, current: Prefs): Prefs {
  if (!server) return current;
  return {
    protection: server.protection ?? current.protection,
    autoplay: server.autoplay ?? current.autoplay,
    oneTapReactions: server.one_tap_reactions ?? current.oneTapReactions,
    mutedWords: server.muted_words ?? current.mutedWords,
    trueBlack: server.true_black ?? current.trueBlack,
    personalization: server.personalization ?? current.personalization,
    reduceMotion: server.reduce_motion ?? current.reduceMotion,
    notifications: {
      episodes: server.notify_episodes ?? current.notifications.episodes,
      social: server.notify_social ?? current.notifications.social,
      highlights: server.notify_highlights ?? current.notifications.highlights,
      system: server.notify_system ?? current.notifications.system,
      quietHours: server.quiet_hours ?? current.notifications.quietHours,
    },
    language: server.language ?? current.language,
    guidelinesAccepted: server.guidelines_accepted ?? current.guidelinesAccepted,
    dataSaver: server.data_saver ?? current.dataSaver,
    termsVersion: server.terms_version ?? current.termsVersion,
  };
}

interface ServerWatchlistRow {
  title_id: string;
  status: WatchlistItem['status'];
  season: number;
  current_episode: number;
  note: string | null;
  added_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
}

export interface AdoptionCallbacks {
  getState: () => AppState;
  apply: (patch: Partial<AppState>) => void;
  addPosts: (posts: Post[]) => void;
  isStale?: () => boolean;
}

/**
 * Hydrate public community content (latest feed, public collections, top voices, most discussed
 * dramas) for anonymous / guest sessions as well as signed-in sessions.
 */
export async function adoptPublicState(cb: Pick<AdoptionCallbacks, 'getState' | 'apply' | 'addPosts'>): Promise<void> {
  if (!supabase) return;
  adopting = true;
  try {
    const [feed, pulse, publicCols] = await Promise.all([
      fetchFeed('latest', { limit: 25 }).catch(() => null),
      fetchCommunityPulse(null, 16).catch(() => null),
      fetchPublicCollections(24).catch(() => null),
    ]);

    if (feed?.items.length) cb.addPosts(feed.items);

    const current = cb.getState();
    const authorIds = [...new Set(cb.getState().posts.slice(0, 80).map((p) => p.authorId))].filter((id) => id && !current.users[id]);
    const postAuthors = authorIds.length ? await fetchProfiles(authorIds).catch(() => []) : [];

    const allUsers = [...postAuthors, ...(pulse?.topVoices ?? []), ...(publicCols?.owners ?? [])];
    const allDramas = [...(pulse?.dramas ?? []), ...(publicCols?.dramas ?? [])];
    const allCollections = publicCols?.collections ?? [];

    if (allUsers.length || allDramas.length || allCollections.length) {
      const latest = cb.getState();
      cb.apply({
        users: mergeUsers(latest.users, allUsers),
        importedDramas: mergeDramas(latest.importedDramas, allDramas),
        collections: mergeCollections(latest.collections, allCollections),
      });
    }
  } catch (e) {
    reportError('sync.adoptPublic', e);
  } finally {
    adopting = false;
  }
}

/**
 * Read the member's server state and fold it into the cache.
 */
export async function adoptBackendState(cb: AdoptionCallbacks): Promise<void> {
  if (!sessionReady()) return;
  const stale = cb.isStale ?? (() => false);
  adopting = true;
  try {
    const boot = await fetchBootstrap();
    if (stale()) return;

    const current = cb.getState();
    const watchRows = (boot.watchlist ?? []) as ServerWatchlistRow[];
    const favTitleUuids = boot.profile.favorite_title_ids ?? [];
    const alertTitleUuids = (boot.alerts ?? []).filter((a) => a.episodes).map((a) => a.title_id);
    const mutedTitleUuids = boot.muted_titles ?? [];

    const allTitleUuids = [
      ...boot.follows.titles,
      ...watchRows.map((r) => r.title_id),
      ...favTitleUuids,
      ...alertTitleUuids,
      ...mutedTitleUuids,
    ];

    const [{ dramas: hydratedDramas, idMap: dramaIds }, actorIds, avatarMap, colHydrated] = await Promise.all([
      fetchDramasByUuids(allTitleUuids),
      resolveActorClientIds(boot.follows.people),
      boot.profile.avatar_path ? signedUrls([boot.profile.avatar_path]).catch(() => new Map<string, string>()) : Promise.resolve(new Map<string, string>()),
      hydrateCollectionBundles(boot.collections ?? []),
    ]);
    if (stale()) return;

    const watchlist: Record<string, WatchlistItem> = {};
    for (const row of watchRows) {
      const dramaId = dramaIds.get(row.title_id);
      if (!dramaId) continue;
      watchlist[dramaId] = {
        dramaId,
        status: row.status,
        season: row.season ?? 1,
        currentEpisode: row.current_episode ?? 0,
        note: row.note ?? undefined,
        addedAt: row.added_at ?? new Date().toISOString(),
        updatedAt: row.updated_at ?? new Date().toISOString(),
        completedAt: row.completed_at ?? undefined,
      };
    }

    const reactions: Record<string, ReactionKind> = { ...current.reactions };
    for (const r of boot.reactions ?? []) {
      const targetId = r.comment_id ?? r.post_id;
      if (targetId && r.kind) reactions[targetId] = r.kind;
    }

    const dramaNotify: Record<string, boolean> = { ...current.dramaNotify };
    for (const id of alertTitleUuids) {
      const clientId = dramaIds.get(id);
      if (clientId) dramaNotify[clientId] = true;
    }

    const union = <T,>(local: T[], remote: T[]): T[] => [...new Set([...local, ...remote])];
    const resolvedProfile = serverProfileToUser(boot.profile, {
      avatarUrl: boot.profile.avatar_path ? avatarMap.get(boot.profile.avatar_path) : current.profile.avatarUrl,
      favoriteDramaIds: favTitleUuids.map((id) => dramaIds.get(id)).filter((id): id is string => Boolean(id)),
    });

    cb.apply({
      profile: { ...current.profile, ...resolvedProfile },
      onboarding: {
        ...current.onboarding,
        done: Boolean(boot.profile.onboarding_completed || current.onboarding.done),
        step: Math.max(current.onboarding.step, boot.profile.onboarding_step ?? 0),
        genres: union(current.onboarding.genres, boot.profile.favorite_genres ?? []),
        fandoms: union(current.onboarding.fandoms, (boot.profile.worlds ?? []) as FandomId[]),
      },
      prefs: adoptPrefs((boot.prefs ?? null) as ServerPrefs | null, current.prefs),
      follows: {
        users: union(current.follows.users, boot.follows.users),
        dramas: union(
          current.follows.dramas,
          boot.follows.titles.map((id) => dramaIds.get(id)).filter((id): id is string => Boolean(id)),
        ),
        actors: union(
          current.follows.actors,
          boot.follows.people.map((id) => actorIds.get(id)).filter((id): id is string => Boolean(id)),
        ),
        collections: union(current.follows.collections, boot.follows.collections),
      },
      saves: union(current.saves, boot.saved_post_ids),
      reactions,
      dramaNotify,
      watchlist: { ...current.watchlist, ...watchlist },
      blockedUsers: union(current.blockedUsers, boot.blocks ?? []),
      mutedUsers: union(current.mutedUsers, boot.muted_users ?? []),
      mutedDramas: union(
        current.mutedDramas,
        mutedTitleUuids.map((id) => dramaIds.get(id)).filter((id): id is string => Boolean(id)),
      ),
      collections: mergeCollections(current.collections, colHydrated.collections),
      users: mergeUsers(current.users, colHydrated.owners),
      importedDramas: mergeDramas(current.importedDramas, [...hydratedDramas, ...colHydrated.dramas]),
    });

    const [feed, pulse] = await Promise.all([
      fetchFeed('latest', { limit: 25 }).catch(() => null),
      fetchCommunityPulse(null, 16).catch(() => null),
    ]);
    if (stale()) return;
    if (feed?.items.length) cb.addPosts(feed.items);

    if (boot.saved_post_ids.length) {
      const saved = await fetchPosts(boot.saved_post_ids.slice(0, 50)).catch(() => []);
      if (stale()) return;
      if (saved.length) cb.addPosts(saved);
    }

    const authorIds = [...new Set(cb.getState().posts.slice(0, 100).map((p) => p.authorId))].filter(
      (id) => id && !cb.getState().users[id],
    );
    const profiles = authorIds.length ? await fetchProfiles(authorIds).catch(() => []) : [];
    if (stale()) return;

    const latest = cb.getState();
    cb.apply({
      users: mergeUsers(latest.users, [...profiles, ...(pulse?.topVoices ?? [])]),
      importedDramas: mergeDramas(latest.importedDramas, pulse?.dramas ?? []),
    });

    const notifications = await fetchNotifications();
    if (stale()) return;
    cb.apply({ notifications });
  } catch (e) {
    reportError('sync.adopt', e);
  } finally {
    adopting = false;
  }
}

/** Fetch a post + its full comment thread + authors from the backend and fold into the cache. */
export async function adoptPostThread(
  postId: string,
  cb: Pick<AdoptionCallbacks, 'getState' | 'apply' | 'addPosts'>,
): Promise<{ post: Post | null; comments: Comment[] }> {
  if (!supabase || !social.isUuid(postId)) return { post: null, comments: [] };
  adopting = true;
  try {
    const thread = await fetchPostThread(postId);
    if (thread.post) cb.addPosts([thread.post]);
    const current = cb.getState();
    const byId = new Map(current.comments.map((c) => [c.id, c]));
    for (const comment of thread.comments) byId.set(comment.id, comment);
    cb.apply({
      comments: [...byId.values()],
      users: mergeUsers(current.users, thread.users),
      importedDramas: mergeDramas(current.importedDramas, thread.dramas),
    });
    return { post: thread.post, comments: thread.comments };
  } catch (e) {
    reportError('sync.adoptPostThread', e);
    return { post: null, comments: [] };
  } finally {
    adopting = false;
  }
}

/** Backwards-compatible comment thread hydrator. */
export async function adoptComments(postId: string, cb: Pick<AdoptionCallbacks, 'getState' | 'apply'>): Promise<Comment[]> {
  if (!supabase || !social.isUuid(postId)) return [];
  const page = await fetchComments(postId);
  if (!page.items.length) return [];
  const authorIds = [...new Set(page.items.map((c) => c.authorId))].filter((id) => id && !cb.getState().users[id]);
  const authors = authorIds.length ? await fetchProfiles(authorIds).catch(() => []) : [];
  const current = cb.getState();
  const byId = new Map(current.comments.map((c) => [c.id, c]));
  for (const comment of page.items) byId.set(comment.id, comment);
  cb.apply({
    comments: [...byId.values()],
    users: mergeUsers(current.users, authors),
  });
  return page.items;
}

/** Hydrate a public profile by handle into the cache. */
export async function adoptProfileByHandle(
  handle: string,
  cb: Pick<AdoptionCallbacks, 'getState' | 'apply' | 'addPosts'>,
): Promise<User | null> {
  if (!supabase) return null;
  adopting = true;
  try {
    const res = await fetchProfileByHandle(handle);
    if (!res) return null;
    if (res.posts.length) cb.addPosts(res.posts);
    const current = cb.getState();
    cb.apply({
      users: mergeUsers(current.users, [res.user]),
      collections: mergeCollections(current.collections, res.collections),
      importedDramas: mergeDramas(current.importedDramas, res.dramas),
    });
    return res.user;
  } catch (e) {
    reportError('sync.adoptProfileByHandle', e);
    return null;
  } finally {
    adopting = false;
  }
}

/** Hydrate public community shelves into the cache. */
export async function adoptPublicCollections(cb: Pick<AdoptionCallbacks, 'getState' | 'apply'>): Promise<Collection[]> {
  if (!supabase) return [];
  adopting = true;
  try {
    const res = await fetchPublicCollections(40);
    const current = cb.getState();
    cb.apply({
      collections: mergeCollections(current.collections, res.collections),
      users: mergeUsers(current.users, res.owners),
      importedDramas: mergeDramas(current.importedDramas, res.dramas),
    });
    return res.collections;
  } catch (e) {
    reportError('sync.adoptPublicCollections', e);
    return [];
  } finally {
    adopting = false;
  }
}

/** Refresh notification inbox on pull-to-refresh or Realtime push. */
export async function adoptNotifications(cb: Pick<AdoptionCallbacks, 'getState' | 'apply'>): Promise<void> {
  if (!sessionReady()) return;
  try {
    const notifications = await fetchNotifications();
    const missingActors = [...new Set(notifications.flatMap((n) => n.actorIds ?? []))].filter(
      (id) => id && !cb.getState().users[id],
    );
    const profiles = missingActors.length ? await fetchProfiles(missingActors).catch(() => []) : [];
    const current = cb.getState();
    cb.apply({
      notifications,
      users: mergeUsers(current.users, profiles),
    });
  } catch (e) {
    reportError('sync.adoptNotifications', e);
  }
}

/**
 * Subscribe to live Postgres Changes on `posts`, `comments`, and `notifications` so multi-user
 * posts, replies, reaction counts, and notifications update live without polling.
 */
export function subscribeBackendRealtime(
  cb: Pick<AdoptionCallbacks, 'getState' | 'apply' | 'addPosts'>,
  userId?: string | null,
): () => void {
  if (!supabase) return () => {};
  const channelName = `hallyu-live-${userId ?? 'anon'}-${Date.now()}`;
  const channel = supabase
    .channel(channelName)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'posts' }, (payload) => {
      const row = payload.new as { id?: string; state?: string } | undefined;
      if (!row?.id) return;
      if (payload.eventType === 'DELETE' || row.state === 'deleted') {
        const current = cb.getState();
        if (current.posts.some((p) => p.id === row.id)) {
          adoptLocal({ type: 'deletePost', id: row.id });
        }
        return;
      }
      void fetchPosts([row.id])
        .then(async (posts) => {
          if (!posts.length) return;
          cb.addPosts(posts);
          const authorId = posts[0]!.authorId;
          if (authorId && !cb.getState().users[authorId]) {
            const profiles = await fetchProfiles([authorId]).catch(() => []);
            if (profiles.length) cb.apply({ users: mergeUsers(cb.getState().users, profiles) });
          }
        })
        .catch(() => {});
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, (payload) => {
      const row = payload.new as ServerComment | undefined;
      if (!row?.id) return;
      const comment = toComment(row);
      const current = cb.getState();
      const byId = new Map(current.comments.map((c) => [c.id, c]));
      byId.set(comment.id, comment);
      cb.apply({ comments: [...byId.values()] });
      if (comment.authorId && !current.users[comment.authorId]) {
        void fetchProfiles([comment.authorId])
          .then((profiles) => {
            if (profiles.length) cb.apply({ users: mergeUsers(cb.getState().users, profiles) });
          })
          .catch(() => {});
      }
    });

  if (userId && social.isUuid(userId)) {
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` },
      (payload) => {
        void adoptNotifications(cb);
        if (payload.eventType === 'INSERT') {
          const row = payload.new as {
            id?: string;
            group?: string;
            title?: string | null;
            body?: string | null;
            deep_link?: string | null;
          } | undefined;
          if (row?.id) {
            void presentServerNotificationBanner({
              id: row.id,
              group: row.group,
              title: row.title,
              body: row.body,
              deepLink: row.deep_link,
            });
          }
        }
      },
    );
  }

  channel.subscribe();
  return () => {
    void supabase?.removeChannel(channel);
  };
}

export function isAdopting(): boolean {
  return adopting;
}
