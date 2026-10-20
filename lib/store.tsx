import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect } from 'react';
import { create } from 'zustand';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { markBoot } from './boot';
import { mirrorAction, setApplyDispatcher } from './sync';
import { uid } from './format';
import { Actor, Collection, Comment, Draft, Drama, FandomId, Notification, NotificationGroup, Post, ReactionCounts, ReactionKind, SpoilerProtection, User, WatchStatus, WatchlistItem } from './model';

const STORAGE_KEY = 'hallyu.state.v4';

export type Intent = 'discuss' | 'track' | 'discover' | 'reactions' | 'people' | 'actors';

export interface Prefs {
  protection: SpoilerProtection;
  autoplay: 'always' | 'wifi' | 'never';
  oneTapReactions: boolean;
  mutedWords: string[];
  trueBlack: boolean;
  personalization: boolean;
  reduceMotion: boolean;
  notifications: { episodes: boolean; social: boolean; highlights: boolean; system: boolean; quietHours: boolean };
  language: 'en' | 'ko';
  guidelinesAccepted: boolean;
  dataSaver: boolean;
  /** Version of the Terms/Guidelines the member accepted (Play UGC policy); 0 = not yet. */
  termsVersion: number;
}

export interface AppState {
  hydrated: boolean;
  onboarding: { done: boolean; step: number; intent?: Intent; genres: string[]; /** the worlds the member picked — empty means ALL, which is the default */ fandoms: FandomId[] };
  prefs: Prefs;
  profile: User;
  follows: { users: string[]; dramas: string[]; actors: string[]; collections: string[] };
  dramaNotify: Record<string, boolean>;
  watchlist: Record<string, WatchlistItem>;
  reactions: Record<string, ReactionKind>;
  saves: string[];
  revealed: Record<string, true>;
  /** Content created on this device (nothing is fetched from a server). */
  posts: Post[];
  comments: Comment[];
  collections: Collection[];
  notifications: Notification[];
  /** Public profile cards seen in feeds/threads (id → User). */
  users: Record<string, User>;
  drafts: Draft[];
  blockedUsers: string[];
  mutedUsers: string[];
  mutedDramas: string[];
  reported: string[];
  recentSearches: string[];
  /** Live catalog records (TMDB-backed). This is the drama/actor catalog in full. */
  importedDramas: Drama[];
  importedActors: Actor[];
  lastSeenActivity: string;
  /** Device-local, never synced: first-run guides and milestone moments already shown (id → ISO date). */
  seen: Record<string, string>;
}

const defaultPrefs: Prefs = {
  protection: 'balanced',
  autoplay: 'wifi',
  oneTapReactions: true,
  mutedWords: [],
  trueBlack: false,
  personalization: true,
  reduceMotion: false,
  notifications: { episodes: true, social: true, highlights: true, system: true, quietHours: false },
  guidelinesAccepted: false,
  dataSaver: false,
  language: 'en',
  termsVersion: 0,
};

/** An anonymous visitor: empty until the public feeds land. */
export function initialState(): AppState {
  return {
    hydrated: false,
    onboarding: { done: false, step: 0, genres: [], fandoms: [] },
    prefs: defaultPrefs,
    profile: emptyProfile(),
    follows: { users: [], dramas: [], actors: [], collections: [] },
    dramaNotify: {},
    watchlist: {},
    reactions: {},
    saves: [],
    revealed: {},
    posts: [],
    comments: [],
    collections: [],
    notifications: [],
    users: {},
    drafts: [],
    blockedUsers: [],
    mutedUsers: [],
    mutedDramas: [],
    reported: [],
    recentSearches: [],
    importedDramas: [],
    importedActors: [],
    lastSeenActivity: new Date(0).toISOString(),
    seen: {},
  };
}

function emptyProfile(): User {
  return { id: 'local', handle: 'you', displayName: 'You', favoriteGenres: [], favoriteDramaIds: [], followers: 0, following: 0, joinedAt: new Date().toISOString() };
}

/** A brand-new member (after sign-up) starts empty: this is what the first-run states are designed for. */
export function freshMemberState(profile: User): AppState {
  return { ...initialState(), hydrated: true, profile, onboarding: { done: false, step: 0, genres: [], fandoms: [] } };
}

export const GUEST_ID = 'guest';

/** Guests browse the public world with no personal layer: nothing followed, nothing tracked, nothing unread. */
export function guestState(): AppState {
  return {
    ...freshMemberState({ ...emptyProfile(), id: GUEST_ID, handle: 'guest', displayName: 'Guest' }),
    onboarding: { done: true, step: 0, genres: [], fandoms: [] },
  };
}

export type Action =
  | { type: 'hydrate'; state: Partial<AppState> }
  /**
   * Put named slices back to an earlier value. This is how a failed backend write is undone
   * (lib/sync.ts): the optimistic cache is only allowed to keep showing a change the server
   * actually accepted, so a rejected mutation is reverted rather than left on screen. It is a
   * plain merge and is never mirrored back to the backend.
   */
  | { type: 'restore'; patch: Partial<AppState> }
  | { type: 'replace'; state: AppState }
  | { type: 'onboarding'; patch: Partial<AppState['onboarding']> }
  | { type: 'seen'; id: string }
  | { type: 'prefs'; patch: Partial<Prefs> }
  | { type: 'profile'; patch: Partial<User> }
  | { type: 'follow'; kind: keyof AppState['follows']; id: string; on?: boolean }
  | { type: 'dramaNotify'; id: string; on: boolean }
  | { type: 'watch'; dramaId: string; status: WatchStatus | null; season?: number }
  | { type: 'progress'; dramaId: string; season: number; episode: number; total: number }
  | { type: 'note'; dramaId: string; note: string }
  | { type: 'react'; targetId: string; kind: ReactionKind | null; isComment?: boolean }
  | { type: 'save'; postId: string; on?: boolean }
  | { type: 'reveal'; id: string }
  | { type: 'addPost'; post: Post }
  | { type: 'editPost'; id: string; patch: Partial<Post> }
  | { type: 'deletePost'; id: string }
  | { type: 'addComment'; comment: Comment }
  | { type: 'deleteComment'; id: string }
  | { type: 'upsertCollection'; collection: Collection }
  | { type: 'deleteCollection'; id: string }
  | { type: 'collectionItem'; collectionId: string; dramaId: string; on: boolean; note?: string }
  | { type: 'readNotifications'; group?: NotificationGroup | 'all'; id?: string }
  | { type: 'draft'; draft: Draft }
  | { type: 'deleteDraft'; id: string }
  | { type: 'block'; userId: string; on: boolean }
  | { type: 'muteUser'; userId: string; on: boolean }
  | { type: 'muteDrama'; dramaId: string; on: boolean }
  | { type: 'report'; id: string; targetType?: 'post' | 'comment' | 'user' | 'drama' | 'collection'; reason?: string; detail?: string }
  | { type: 'recentSearch'; q?: string; clear?: boolean }
  | { type: 'import'; dramas?: Drama[]; actors?: Actor[] }
  | { type: 'votePoll'; postId: string; optionIndex: number; serverPoll?: Post['poll'] }
  | { type: 'rateDrama'; dramaId: string; rating: number }
  | { type: 'seenActivity' };

function toggle(list: string[], id: string, on?: boolean): string[] {
  const has = list.includes(id);
  const want = on ?? !has;
  if (want && !has) return [...list, id];
  if (!want && has) return list.filter((x) => x !== id);
  return list;
}

function bump(counts: ReactionCounts, kind: ReactionKind, delta: number): ReactionCounts {
  return { ...counts, [kind]: Math.max(0, counts[kind] + delta) };
}

function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    case 'hydrate':
      return { ...s, ...a.state, hydrated: true };
    case 'restore':
      return { ...s, ...a.patch };
    case 'replace':
      // Caches that are not account-specific (catalog art, public profiles) survive guest ↔ member switches.
      return {
        ...a.state,
        hydrated: true,
        importedDramas: a.state.importedDramas.length ? a.state.importedDramas : s.importedDramas,
        importedActors: a.state.importedActors.length ? a.state.importedActors : s.importedActors,
        users: { ...s.users, ...a.state.users },
      };
    case 'onboarding':
      return { ...s, onboarding: { ...s.onboarding, ...a.patch } };
    case 'prefs':
      return { ...s, prefs: { ...s.prefs, ...a.patch } };
    case 'profile':
      return { ...s, profile: { ...s.profile, ...a.patch } };
    case 'follow':
      return { ...s, follows: { ...s.follows, [a.kind]: toggle(s.follows[a.kind], a.id, a.on) } };
    case 'dramaNotify':
      return { ...s, dramaNotify: { ...s.dramaNotify, [a.id]: a.on } };
    case 'watch': {
      const nowIso = new Date().toISOString();
      const next = { ...s.watchlist };
      if (a.status === null) {
        delete next[a.dramaId];
        return { ...s, watchlist: next };
      }
      const prev = next[a.dramaId];
      const drama = allDramas(s).find((d) => d.id === a.dramaId);
      const season = a.season ?? prev?.season ?? 1;
      const total = drama?.seasons.find((x) => x.number === season)?.episodeCount ?? drama?.episodeCount ?? 0;
      next[a.dramaId] = {
        dramaId: a.dramaId,
        season,
        currentEpisode: a.status === 'completed' ? total : a.status === 'want' ? 0 : (prev?.currentEpisode ?? 0),
        note: prev?.note,
        addedAt: prev?.addedAt ?? nowIso,
        updatedAt: nowIso,
        completedAt: a.status === 'completed' ? nowIso : undefined,
        status: a.status,
      };
      return { ...s, watchlist: next, follows: { ...s.follows, dramas: toggle(s.follows.dramas, a.dramaId, true) } };
    }
    case 'progress': {
      const nowIso = new Date().toISOString();
      const prev = s.watchlist[a.dramaId];
      const episode = Math.max(0, Math.min(a.total, a.episode));
      const completed = a.total > 0 && episode >= a.total;
      const item: WatchlistItem = {
        dramaId: a.dramaId,
        season: a.season,
        currentEpisode: episode,
        note: prev?.note,
        addedAt: prev?.addedAt ?? nowIso,
        updatedAt: nowIso,
        status: completed ? 'completed' : 'watching',
        completedAt: completed ? nowIso : undefined,
      };
      return { ...s, watchlist: { ...s.watchlist, [a.dramaId]: item }, follows: { ...s.follows, dramas: toggle(s.follows.dramas, a.dramaId, true) } };
    }
    case 'note': {
      const prev = s.watchlist[a.dramaId];
      if (!prev) return s;
      return { ...s, watchlist: { ...s.watchlist, [a.dramaId]: { ...prev, note: a.note, updatedAt: new Date().toISOString() } } };
    }
    case 'react': {
      const prevKind = s.reactions[a.targetId];
      const reactions = { ...s.reactions };
      if (a.kind) reactions[a.targetId] = a.kind;
      else delete reactions[a.targetId];
      const apply = <T extends { id: string; reactions: ReactionCounts }>(items: T[]): T[] =>
        items.map((it) => {
          if (it.id !== a.targetId) return it;
          let c = it.reactions;
          if (prevKind) c = bump(c, prevKind, -1);
          if (a.kind) c = bump(c, a.kind, 1);
          return { ...it, reactions: c };
        });
      return { ...s, reactions, posts: a.isComment ? s.posts : apply(s.posts), comments: a.isComment ? apply(s.comments) : s.comments };
    }
    case 'save': {
      const had = s.saves.includes(a.postId);
      const on = a.on ?? !had;
      if (on === had) return s;
      return {
        ...s,
        saves: toggle(s.saves, a.postId, on),
        posts: s.posts.map((p) => (p.id === a.postId ? { ...p, saveCount: Math.max(0, p.saveCount + (on ? 1 : -1)) } : p)),
      };
    }
    case 'reveal':
      return { ...s, revealed: { ...s.revealed, [a.id]: true } };
    case 'seen':
      return s.seen[a.id] ? s : { ...s, seen: { ...s.seen, [a.id]: new Date().toISOString() } };
    case 'addPost': {
      // upsert by id so re-dispatching the same local post merges instead of duplicating
      const exists = s.posts.some((p) => p.id === a.post.id);
      return { ...s, posts: exists ? s.posts.map((p) => (p.id === a.post.id ? { ...p, ...a.post } : p)) : [a.post, ...s.posts] };
    }
    case 'editPost':
      return { ...s, posts: s.posts.map((p) => (p.id === a.id ? { ...p, ...a.patch, editedAt: new Date().toISOString() } : p)) };
    case 'deletePost':
      return { ...s, posts: s.posts.map((p) => (p.id === a.id ? { ...p, state: 'deleted' } : p)) };
    case 'addComment': {
      const exists = s.comments.some((c) => c.id === a.comment.id);
      return {
        ...s,
        comments: exists ? s.comments.map((c) => (c.id === a.comment.id ? { ...c, ...a.comment } : c)) : [...s.comments, a.comment],
        posts: exists ? s.posts : s.posts.map((p) => (p.id === a.comment.postId ? { ...p, commentCount: p.commentCount + 1 } : p)),
      };
    }
    case 'deleteComment': {
      const c = s.comments.find((x) => x.id === a.id);
      return {
        ...s,
        comments: s.comments.map((x) => (x.id === a.id ? { ...x, state: 'deleted' } : x)),
        posts: c ? s.posts.map((p) => (p.id === c.postId ? { ...p, commentCount: Math.max(0, p.commentCount - 1) } : p)) : s.posts,
      };
    }
    case 'upsertCollection': {
      const exists = s.collections.some((c) => c.id === a.collection.id);
      return { ...s, collections: exists ? s.collections.map((c) => (c.id === a.collection.id ? a.collection : c)) : [a.collection, ...s.collections] };
    }
    case 'deleteCollection':
      return { ...s, collections: s.collections.filter((c) => c.id !== a.id) };
    case 'collectionItem':
      return {
        ...s,
        collections: s.collections.map((c) => {
          if (c.id !== a.collectionId) return c;
          const has = c.items.some((i) => i.dramaId === a.dramaId);
          const items = a.on
            ? has
              ? c.items.map((i) => (i.dramaId === a.dramaId ? { ...i, note: a.note ?? i.note } : i))
              : [...c.items, { dramaId: a.dramaId, note: a.note, addedAt: new Date().toISOString() }]
            : c.items.filter((i) => i.dramaId !== a.dramaId);
          return { ...c, items, updatedAt: new Date().toISOString() };
        }),
      };
    case 'readNotifications':
      return {
        ...s,
        notifications: s.notifications.map((n) => (a.id ? (n.id === a.id ? { ...n, read: true } : n) : !a.group || a.group === 'all' || n.group === a.group ? { ...n, read: true } : n)),
      };
    case 'draft': {
      const exists = s.drafts.some((d) => d.id === a.draft.id);
      return { ...s, drafts: exists ? s.drafts.map((d) => (d.id === a.draft.id ? a.draft : d)) : [a.draft, ...s.drafts] };
    }
    case 'deleteDraft':
      return { ...s, drafts: s.drafts.filter((d) => d.id !== a.id) };
    case 'block':
      return { ...s, blockedUsers: toggle(s.blockedUsers, a.userId, a.on), follows: { ...s.follows, users: a.on ? s.follows.users.filter((u) => u !== a.userId) : s.follows.users } };
    case 'muteUser':
      return { ...s, mutedUsers: toggle(s.mutedUsers, a.userId, a.on) };
    case 'muteDrama':
      return { ...s, mutedDramas: toggle(s.mutedDramas, a.dramaId, a.on) };
    case 'report':
      return { ...s, reported: toggle(s.reported, a.id, true) };
    case 'recentSearch':
      if (a.clear) return { ...s, recentSearches: [] };
      if (!a.q) return s;
      return { ...s, recentSearches: [a.q, ...s.recentSearches.filter((x) => x !== a.q)].slice(0, 8) };
    case 'import': {
      const normName = (n?: string) => (n ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim();
      const rawDramas = [...(a.dramas ?? []), ...(a.actors ?? []).flatMap((ac) => ac.knownForDramas ?? [])];
      const rawActors = [...(a.actors ?? []), ...rawDramas.flatMap((d) => d.castActors ?? [])];

      let actors = [...s.importedActors];
      const actorIdMap = new Map<string, string>();
      if (rawActors.length) {
        const byId = new Map(actors.map((x) => [x.id, x]));
        const byProvider = new Map(actors.filter((x) => x.provider).map((x) => [x.provider!.id, x]));
        const byName = new Map(actors.map((x) => [normName(x.name), x]));
        for (const inc of rawActors) {
          const existing =
            byId.get(inc.id) ??
            (inc.provider ? byProvider.get(inc.provider.id) : undefined) ??
            (normName(inc.name) ? byName.get(normName(inc.name)) : undefined);
          const targetId = existing?.id ?? inc.id;
          if (inc.id !== targetId) actorIdMap.set(inc.id, targetId);
          const merged: Actor = existing
            ? {
                ...existing,
                name: existing.name || inc.name,
                koreanName: existing.koreanName ?? inc.koreanName,
                photoUrl: inc.photoUrl ?? existing.photoUrl,
                birthDate: inc.birthDate ?? existing.birthDate,
                bio: inc.bio && inc.bio.length > (existing.bio?.length ?? 0) ? inc.bio : existing.bio,
                knownFor: [...new Set([...existing.knownFor, ...inc.knownFor])],
                followerCount: Math.max(existing.followerCount, inc.followerCount),
                provider: existing.provider ?? inc.provider,
              }
            : {
                id: inc.id,
                name: inc.name,
                koreanName: inc.koreanName,
                photoUrl: inc.photoUrl,
                birthDate: inc.birthDate,
                bio: inc.bio,
                knownFor: [...new Set(inc.knownFor)],
                followerCount: inc.followerCount,
                provider: inc.provider,
              };
          byId.set(targetId, merged);
          if (merged.provider) byProvider.set(merged.provider.id, merged);
          if (normName(merged.name)) byName.set(normName(merged.name), merged);
        }
        actors = [...byId.values()];
      }

      const mergeDrama = (prev: Drama | undefined, next: Drama): Drama => {
        const remapCast = (list: Drama['cast']) =>
          list.map((c, i) => ({ ...c, actorId: actorIdMap.get(c.actorId) ?? c.actorId, order: i }));
        const nextCast = remapCast(next.cast);
        if (!prev) {
          const { castActors: _ca, ...clean } = next;
          return { ...clean, cast: nextCast };
        }
        const prevCast = remapCast(prev.cast);
        const seenCast = new Set<string>();
        const combinedCast = [...prevCast, ...nextCast]
          .filter((c) => (seenCast.has(c.actorId) ? false : (seenCast.add(c.actorId), true)))
          .map((c, i) => ({ ...c, order: i }));
        const nextEps = next.episodes.map((e) => ({
          ...e,
          dramaId: prev.id,
          id: e.id.startsWith(prev.id) ? e.id : `${prev.id}-s${e.season}e${e.number}`,
        }));
        const epMap = new Map(prev.episodes.map((e) => [`${e.season}:${e.number}`, e]));
        for (const e of nextEps) {
          const k = `${e.season}:${e.number}`;
          const existingEp = epMap.get(k);
          if (prev.status === 'airing' && existingEp?.airDate) {
            epMap.set(k, { ...e, id: existingEp.id, airDate: existingEp.airDate });
          } else {
            epMap.set(k, e);
          }
        }
        const combinedEps = [...epMap.values()].sort((x, y) => x.season - y.season || x.number - y.number);
        const combinedStreaming = [...new Set([...(prev.streamingOn ?? []), ...(next.streamingOn ?? [])])];
        return {
          ...prev,
          posterUrl: next.posterUrl ?? prev.posterUrl,
          posterLocal: prev.posterLocal ?? next.posterLocal,
          backdropUrl: next.backdropUrl ?? prev.backdropUrl,
          trailerUrl: next.trailerUrl ?? prev.trailerUrl,
          runtime: next.runtime ?? prev.runtime,
          rating: next.rating ?? prev.rating,
          status: prev.status === 'airing' ? 'airing' : next.status,
          synopsis: next.synopsis && next.synopsis !== 'No synopsis yet.' && next.synopsis.length > prev.synopsis.length ? next.synopsis : prev.synopsis,
          episodeCount: Math.max(prev.episodeCount, next.episodeCount),
          seasons: next.seasons.length > prev.seasons.length || (next.seasons.length && !prev.seasons.length) ? next.seasons : prev.seasons,
          episodes: combinedEps,
          cast: combinedCast,
          creators: next.creators?.length ? next.creators : prev.creators,
          network: next.network ?? prev.network,
          streamingOn: combinedStreaming.length ? combinedStreaming : undefined,
          tags: prev.tags?.length ? prev.tags : next.tags,
          airsOn: prev.airsOn ?? next.airsOn,
          nextEpisodeAt: next.nextEpisodeAt ?? prev.nextEpisodeAt,
          followerCount: Math.max(prev.followerCount, next.followerCount),
          provider: prev.provider ?? next.provider,
        };
      };

      let dramas = [...s.importedDramas];
      const dramaIdMap = new Map<string, string>();
      if (rawDramas.length) {
        const pKey = (d: Pick<Drama, 'provider' | 'mediaType'>) => (d.provider ? `${d.provider.name}:${d.provider.mediaType ?? d.mediaType ?? 'tv'}:${d.provider.id}` : null);
        const byId = new Map(dramas.map((d) => [d.id, d]));
        const byProvider = new Map(dramas.filter((d) => pKey(d)).map((d) => [pKey(d)!, d]));
        for (const inc of rawDramas) {
          const pk = pKey(inc);
          const existing = byId.get(inc.id) ?? (pk ? byProvider.get(pk) : undefined);
          const targetId = existing?.id ?? inc.id;
          if (inc.id !== targetId) dramaIdMap.set(inc.id, targetId);
          const merged = mergeDrama(existing, { ...inc, id: targetId });
          byId.set(targetId, merged);
          const mpk = pKey(merged);
          if (mpk) byProvider.set(mpk, merged);
        }
        dramas = [...byId.values()];
        // Keep the persisted cache bounded: evict the oldest thin records nobody tracks or follows.
        const MAX = 400;
        if (dramas.length > MAX) {
          const pinned = new Set([...Object.keys(s.watchlist), ...s.follows.dramas, ...(s.users[s.profile.id]?.favoriteDramaIds ?? [])]);
          const evictable = dramas.filter((d) => !pinned.has(d.id) && d.episodes.length === 0 && d.cast.length === 0);
          const drop = new Set(evictable.slice(0, dramas.length - MAX).map((d) => d.id));
          dramas = dramas.filter((d) => !drop.has(d.id));
        }
      }
      if (dramaIdMap.size) {
        actors = actors.map((ac) => ({
          ...ac,
          knownFor: [...new Set(ac.knownFor.map((k) => dramaIdMap.get(k) ?? k))],
        }));
      }
      return { ...s, importedDramas: dramas, importedActors: actors };
    }
    case 'votePoll': {
      const idx = s.posts.findIndex((p) => p.id === a.postId);
      if (idx < 0) return s;
      const target = s.posts[idx]!;
      if (!target.poll) return s;
      const nextPoll =
        a.serverPoll ??
        (() => {
          const prevVote = target.poll.myVote;
          const counts = target.poll.options.map((_, i) => {
            let n = target.poll!.counts[i] ?? 0;
            if (prevVote === i) n = Math.max(0, n - 1);
            if (a.optionIndex === i) n += 1;
            return n;
          });
          return {
            ...target.poll,
            counts,
            totalVotes: counts.reduce((sum, n) => sum + n, 0),
            myVote: a.optionIndex,
          };
        })();
      const posts = [...s.posts];
      posts[idx] = { ...target, poll: nextPoll };
      return { ...s, posts };
    }
    case 'rateDrama': {
      const importedDramas = s.importedDramas.map((d) =>
        d.id === a.dramaId ? { ...d, rating: Math.round(a.rating * 10) / 10 } : d,
      );
      return { ...s, importedDramas };
    }
    case 'seenActivity':
      return { ...s, lastSeenActivity: new Date().toISOString() };
    default:
      return s;
  }
}

/**
 * Catalog view: every drama/actor the app knows about comes from TMDB through the client catalog
 * (lib/catalog.ts). Screens treat these lists as the whole catalog.
 */
export function allDramas(s: Pick<AppState, 'importedDramas'>): Drama[] {
  return s.importedDramas;
}
export function allActors(s: Pick<AppState, 'importedActors'>): Actor[] {
  return s.importedActors;
}

export interface StoreValue {
  state: AppState;
  dispatch: (action: Action) => void;
  /** Replace the whole persisted state (used by auth on sign-up / sign-out) */
  reset: (next: AppState) => void;
  clearPersisted: () => Promise<void>;
}

const PERSISTED_KEYS: (keyof AppState)[] = [
  'onboarding',
  'prefs',
  'profile',
  'follows',
  'dramaNotify',
  'watchlist',
  'reactions',
  'saves',
  'revealed',
  'posts',
  'comments',
  'collections',
  'notifications',
  'users',
  'drafts',
  'blockedUsers',
  'mutedUsers',
  'mutedDramas',
  'reported',
  'recentSearches',
  'importedDramas',
  'importedActors',
  'lastSeenActivity',
  'seen',
];

function serialise(s: AppState): string {
  const out: Record<string, unknown> = {};
  for (const k of PERSISTED_KEYS) out[k] = s[k];
  // keep the payload small: freshest content only
  out.posts = (s.posts as Post[]).slice(0, 250);
  out.comments = (s.comments as Comment[]).slice(0, 500);
  return JSON.stringify(out);
}

function deserialise(raw: string): Partial<AppState> | null {
  try {
    const data = JSON.parse(raw) as Partial<AppState>;
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * The store lives outside React (zustand) so components can subscribe to exactly the slice they read.
 * `dispatch` runs the reducer and replaces the whole state; persistence is a debounced subscriber.
 * When the build is connected and a session exists, the action is also mirrored to the Hallyu
 * backend (lib/sync.ts) — the store is the optimistic cache, the backend is the record.
 */
export const useHallyu = create<AppState>()(() => initialState());

/** Apply an action: run the reducer, replace the state, and mirror the write to the backend. */
export function dispatch(action: Action): void {
  const prev = useHallyu.getState();
  const next = reducer(prev, action);
  useHallyu.setState(next, true);
  mirrorAction(action, prev, next);
}

/**
 * lib/sync.ts needs to apply cache writes that must NOT be mirrored back — the rollback of a
 * rejected write, and the composer's adoption of a post it has already sent itself — but importing
 * `dispatch` from there would close a runtime cycle (this module already imports the mirror from
 * sync). So the dispatcher is handed over once, here, and sync keeps only the reference.
 */
setApplyDispatcher((action) => dispatch(action));

export function getState(): AppState {
  return useHallyu.getState();
}

export const reset = (next: AppState): void => dispatch({ type: 'replace', state: next });
export const clearPersisted = (): Promise<void> => AsyncStorage.removeItem(STORAGE_KEY);

/** Subscribe to a derived value; re-renders only when it changes (Object.is, or `shallow` for arrays/objects). */
export function useSlice<T>(selector: (s: AppState) => T, equality?: (a: T, b: T) => boolean): T {
  return useStoreWithEqualityFn(useHallyu, selector, equality);
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let hydrationStarted = false;

function startPersistence() {
  useHallyu.subscribe((s) => {
    if (!s.hydrated) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      AsyncStorage.setItem(STORAGE_KEY, serialise(useHallyu.getState())).catch(() => {});
    }, 400);
  });
}

/** Hydrates once from AsyncStorage and turns on persistence. Renders children immediately (screens gate on `hydrated`). */
export function StoreProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (hydrationStarted) return;
    hydrationStarted = true;

    // Hard failsafe ceiling: AsyncStorage must never hang hydration and freeze the app.
    const failsafe = setTimeout(() => {
      if (!getState().hydrated) {
        markBoot('store:hydrate-failsafe');
        dispatch({ type: 'hydrate', state: {} });
        startPersistence();
      }
    }, 1200);

    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        clearTimeout(failsafe);
        const parsed = raw ? deserialise(raw) : null;
        markBoot('store:hydrated');
        dispatch({ type: 'hydrate', state: parsed ?? {} });
      })
      .catch(() => {
        clearTimeout(failsafe);
        markBoot('store:hydrate-error');
        dispatch({ type: 'hydrate', state: {} });
      })
      .finally(() => {
        clearTimeout(failsafe);
        startPersistence();
      });
  }, []);
  return <>{children}</>;
}

/**
 * Compatibility hook: `state` is the whole store (re-renders on any change) — prefer `useSlice`
 * or the tracked getters in `useApp()` for list items.
 */
export function useStore(): StoreValue {
  const state = useHallyu();
  return { state, dispatch, reset, clearPersisted };
}

/** Convenience: a fresh Post skeleton authored by me (the id is a client-generated UUID). */
export function newPost(authorId: string, partial: Partial<Post> & Pick<Post, 'type' | 'body'>): Post {
  return {
    id: uid('p'),
    authorId,
    createdAt: new Date().toISOString(),
    spoiler: 'none',
    context: {},
    hashtags: [],
    mentions: [],
    reactions: { loved: 0, cried: 0, screamed: 0, swooned: 0, laughed: 0, furious: 0 },
    commentCount: 0,
    saveCount: 0,
    shareCount: 0,
    ...partial,
  };
}

export { initialState as emptyInitialState };
