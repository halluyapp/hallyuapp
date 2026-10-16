import { Fandom, fandomById, formatFandomOf, toFandoms } from './fandoms';
import { now } from './format';
import { Actor, Collection, Comment, Drama, Episode, FandomId, Post, ReactionKind, User, WatchlistItem } from './model';
import { isVeiled, Viewer } from './spoiler';
import { AppState, allActors, allDramas } from './store';

const score = (p: Post) => Object.values(p.reactions).reduce((a, b) => a + b, 0) + p.commentCount * 3 + p.saveCount * 2;
const ageHours = (iso: string) => (now().getTime() - new Date(iso).getTime()) / 3_600_000;
/** Hot ranking: engagement decays with age. */
const hot = (p: Post) => score(p) / Math.pow(ageHours(p.createdAt) + 2, 1.4);

/**
 * How long a member's own post is lifted in their own For You feed.
 *
 * The down-weight below exists so the feed is about other people, and it stays. But `hot()` is
 * engagement over age, and a post seconds old has no engagement at all — so the two rules together
 * put the post a member has *just* written at the bottom of the feed they land on, which reads as
 * "my post disappeared". For a quarter of an hour it gets a bump that decays to nothing instead.
 */
const OWN_POST_GRACE_HOURS = 0.25;
const OWN_POST_LIFT = 20;

export function getUser(s: AppState, id: string): User | undefined {
  if (id === s.profile.id) return s.profile;
  return s.users[id];
}
export function getUserByHandle(s: AppState, handle: string): User | undefined {
  if (handle.toLowerCase() === s.profile.handle.toLowerCase()) return s.profile;
  const needle = handle.toLowerCase();
  return Object.values(s.users).find((u) => u.handle.toLowerCase() === needle);
}
export function getDrama(s: AppState, id?: string): Drama | undefined {
  return id ? allDramas(s).find((d) => d.id === id) : undefined;
}
export function getActor(s: AppState, id?: string): Actor | undefined {
  return id ? allActors(s).find((a) => a.id === id) : undefined;
}
export function getPost(s: AppState, id?: string): Post | undefined {
  return id ? s.posts.find((p) => p.id === id) : undefined;
}
export function getCollection(s: AppState, id?: string): Collection | undefined {
  return id ? s.collections.find((c) => c.id === id) : undefined;
}
export function getEpisode(d: Drama, season: number, number: number): Episode | undefined {
  return d.episodes.find((e) => e.season === season && e.number === number);
}

export function viewer(s: AppState): Viewer {
  return { protection: s.prefs.protection, watchlist: s.watchlist, revealed: s.revealed };
}

export function isPostVeiled(s: AppState, p: Post): boolean {
  return isVeiled(p, p.context.dramaId, viewer(s), getDrama(s, p.context.dramaId), p.id);
}
export function isCommentVeiled(s: AppState, c: Comment, post?: Post): boolean {
  const dramaId = post?.context.dramaId;
  return isVeiled({ spoiler: c.spoiler, context: post?.context ?? {} }, dramaId, viewer(s), getDrama(s, dramaId), c.id);
}

/** Active for everyone; a post only ever hides for this viewer when it is deleted or moderated. */
export function isLive(s: Pick<AppState, 'profile'>, p: { state?: Post['state']; authorId: string }): boolean {
  return (p.state ?? 'active') === 'active';
}

/** Posts that should never appear for this viewer (blocked/muted/deleted/hidden). */
export function visiblePosts(s: AppState, posts: Post[] = s.posts): Post[] {
  const mutedWords = s.prefs.mutedWords.map((w) => w.toLowerCase());
  return posts.filter(
    (p) =>
      isLive(s, p) &&
      !s.blockedUsers.includes(p.authorId) &&
      !s.mutedUsers.includes(p.authorId) &&
      !(p.context.dramaId && s.mutedDramas.includes(p.context.dramaId)) &&
      !mutedWords.some((w) => `${p.title ?? ''} ${p.body}`.toLowerCase().includes(w)),
  );
}

// ---------------------------------------------------------------------------------------------
// Feed ordering
// ---------------------------------------------------------------------------------------------

export interface Ranked {
  post: Post;
  reason?: string;
}

/**
 * Order by local ranking over the posts held on this device. There is no server page: the ranking
 * composes each member's own follows, watchlist and genres.
 */
export function forYou(s: AppState): Ranked[] {
  return localForYou(s);
}

export function following(s: AppState): Ranked[] {
  return visiblePosts(s)
    .filter((p) => s.follows.users.includes(p.authorId) || (p.context.dramaId && s.follows.dramas.includes(p.context.dramaId)) || p.context.actorIds?.some((a) => s.follows.actors.includes(a)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((post) => ({
      post,
      reason: s.follows.users.includes(post.authorId)
        ? undefined
        : post.context.dramaId && s.follows.dramas.includes(post.context.dramaId)
          ? `${getDrama(s, post.context.dramaId)?.title} fandom`
          : `${
              getActor(
                s,
                post.context.actorIds?.find((a) => s.follows.actors.includes(a)),
              )?.name
            } fandom`,
    }));
}

/** The ranking behind For You: engagement, recency and the member's own taste. */
function localForYou(s: AppState): Ranked[] {
  const posts = visiblePosts(s);
  const genres = new Set([...s.onboarding.genres, ...s.profile.favoriteGenres]);
  return posts
    .map((post) => {
      let w = hot(post);
      let reason: string | undefined;
      const d = getDrama(s, post.context.dramaId);
      const wl = post.context.dramaId ? s.watchlist[post.context.dramaId] : undefined;
      if (post.authorId === s.profile.id) {
        const ownAge = ageHours(post.createdAt);
        if (ownAge <= OWN_POST_GRACE_HOURS) w += OWN_POST_LIFT * (1 - ownAge / OWN_POST_GRACE_HOURS);
        else w *= 0.6;
      }
      if (post.context.dramaId && s.follows.dramas.includes(post.context.dramaId)) {
        w *= 1.8;
        reason = `Because you follow ${d?.title}`;
      }
      if (wl?.status === 'watching') {
        w *= 2.2;
        reason = `You're watching ${d?.title}`;
      }
      if (s.follows.users.includes(post.authorId)) {
        w *= 1.6;
        reason = reason ?? `From ${getUser(s, post.authorId)?.displayName}`;
      }
      if (post.context.actorIds?.some((a) => s.follows.actors.includes(a))) {
        w *= 1.5;
        reason =
          reason ??
          `Because you follow ${
            getActor(
              s,
              post.context.actorIds.find((a) => s.follows.actors.includes(a)),
            )?.name
          }`;
      }
      if (d && s.prefs.personalization && d.genres.some((g) => genres.has(g))) {
        w *= 1.25;
        reason = reason ?? `Popular in ${d.genres.find((g) => genres.has(g))}`;
      }
      // The worlds the member chose get lifted, never the others hidden — cross-fandom discovery is
      // the point of Hallyu, it should just take second place to your own fandoms.
      const mine = myWorlds(s);
      if (d && mine.length && mine.includes(formatFandomOf(d))) {
        w *= 1.35;
        reason = reason ?? `In your ${fandomById(formatFandomOf(d)).short} world`;
      }
      if (d?.status === 'airing') w *= 1.3;
      if (!reason && score(post) > 300) reason = 'Trending in the community';
      return { post, reason, w };
    })
    .sort((a, b) => b.w - a.w)
    .map(({ post, reason }) => ({ post, reason }));
}

export function shorts(s: AppState): Post[] {
  return visiblePosts(s)
    .filter((p) => p.type === 'short')
    .sort((a, b) => hot(b) - hot(a));
}

export function postsForDrama(s: AppState, dramaId: string, sort: 'top' | 'latest' = 'top'): Post[] {
  const list = visiblePosts(s).filter((p) => p.context.dramaId === dramaId || p.context.secondaryDramaId === dramaId);
  return sort === 'top' ? list.sort((a, b) => hot(b) - hot(a)) : list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function postsForEpisode(s: AppState, dramaId: string, season: number, episode: number): Post[] {
  return visiblePosts(s)
    .filter((p) => p.context.dramaId === dramaId && (p.context.season ?? 1) === season && p.context.episode === episode)
    .sort((a, b) => hot(b) - hot(a));
}

export function postsForActor(s: AppState, actorId: string): Post[] {
  const actor = getActor(s, actorId);
  return visiblePosts(s)
    .filter(
      (p) =>
        p.context.actorIds?.includes(actorId) || (p.context.dramaId && actor?.knownFor.includes(p.context.dramaId) && p.body.toLowerCase().includes((actor?.name ?? '').toLowerCase().split(' ')[0]!)),
    )
    .sort((a, b) => hot(b) - hot(a));
}

export function postsByUser(s: AppState, userId: string): Post[] {
  return s.posts.filter((p) => p.authorId === userId && isLive(s, p)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function commentsFor(s: AppState, postId: string): Comment[] {
  return s.comments.filter((c) => c.postId === postId && !s.blockedUsers.includes(c.authorId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function reactionTotal(p: { reactions: Record<ReactionKind, number> }): number {
  return Object.values(p.reactions).reduce((a, b) => a + b, 0);
}
export function topReactions(p: { reactions: Record<ReactionKind, number> }, n = 3): ReactionKind[] {
  return (Object.entries(p.reactions) as [ReactionKind, number][])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

/** Episodes airing within the given window (default: today ±), computed from the local catalog. */
export function airingEpisodes(s: AppState, fromHours = -30, toHours = 30): { drama: Drama; episode: Episode }[] {
  const t = now().getTime();
  const out: { drama: Drama; episode: Episode }[] = [];
  for (const drama of allDramas(s)) {
    if (drama.status === 'completed') continue;
    for (const episode of drama.episodes) {
      if (!episode.airDate) continue;
      const dt = (new Date(episode.airDate).getTime() - t) / 3_600_000;
      if (dt >= fromHours && dt <= toHours) out.push({ drama, episode });
    }
  }
  return out.sort((a, b) => a.episode.airDate!.localeCompare(b.episode.airDate!));
}

export function scheduleByDay(s: AppState, days = 7): { day: string; items: { drama: Drama; episode: Episode }[] }[] {
  const items = airingEpisodes(s, -24, days * 24);
  const groups = new Map<string, { drama: Drama; episode: Episode }[]>();
  for (const it of items) {
    const key = new Date(it.episode.airDate!).toDateString();
    groups.set(key, [...(groups.get(key) ?? []), it]);
  }
  return [...groups.entries()].map(([day, list]) => ({ day, items: list }));
}

export function trendingDramas(s: AppState, n = 10): Drama[] {
  const all = allDramas(s);
  const activity = new Map<string, number>();
  for (const p of visiblePosts(s)) if (p.context.dramaId) activity.set(p.context.dramaId, (activity.get(p.context.dramaId) ?? 0) + hot(p));
  return all
    .map((d) => ({ d, w: (activity.get(d.id) ?? 0) * 1000 + d.followerCount / 10_000 + (d.status === 'airing' ? 50 : 0) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, n)
    .map((x) => x.d);
}

export function trendingDiscussions(s: AppState, n = 6): Post[] {
  return visiblePosts(s)
    .filter((p) => p.type === 'discussion')
    .sort((a, b) => hot(b) - hot(a))
    .slice(0, n);
}

export function trendingPosts(s: AppState, n = 20): Post[] {
  return visiblePosts(s)
    .filter((p) => ageHours(p.createdAt) < 48)
    .sort((a, b) => hot(b) - hot(a))
    .slice(0, n);
}

/** Hashtags ranked by recent engagement across the loaded posts. */
export function trendingHashtags(s: AppState, n = 12): { tag: string; weight: number }[] {
  const m = new Map<string, { tag: string; weight: number }>();
  for (const p of visiblePosts(s)) {
    if (ageHours(p.createdAt) > 96) continue;
    for (const t of p.hashtags) {
      const cur = m.get(t) ?? { tag: t, weight: 0 };
      cur.weight += score(p) / Math.pow(ageHours(p.createdAt) + 6, 1.2);
      m.set(t, cur);
    }
  }
  return [...m.values()].sort((a, b) => b.weight - a.weight).slice(0, n);
}

export function recommendedDramas(s: AppState, n = 10): { drama: Drama; reason: string }[] {
  const genres = new Set([...s.onboarding.genres, ...s.profile.favoriteGenres]);
  const seen = new Set(Object.keys(s.watchlist));
  return allDramas(s)
    .filter((d) => !seen.has(d.id))
    .map((d) => {
      const g = d.genres.find((x) => genres.has(x));
      const rec = visiblePosts(s).find((p) => p.type === 'recommendation' && p.context.dramaId === d.id && p.context.secondaryDramaId && seen.has(p.context.secondaryDramaId));
      const reason = rec ? `Because you watched ${getDrama(s, rec.context.secondaryDramaId)?.title}` : g ? `Because you like ${g}` : d.status === 'airing' ? 'Airing now' : 'Loved by the community';
      const w = (rec ? 3 : 0) + (g ? 2 : 0) + (d.rating ?? 7) / 10 + (d.status === 'airing' ? 1 : 0);
      return { drama: d, reason, w };
    })
    .sort((a, b) => b.w - a.w)
    .slice(0, n);
}

export function recommendedPeople(s: AppState, n = 6): { user: User; reason: string }[] {
  const myGenres = new Set([...s.onboarding.genres, ...s.profile.favoriteGenres]);
  const myDramas = new Set([...Object.keys(s.watchlist), ...s.follows.dramas]);
  const pool = Object.values(s.users).filter((u) => u.id !== s.profile.id && !s.follows.users.includes(u.id) && !s.blockedUsers.includes(u.id) && !u.isPrivate);
  return pool
    .map((u) => {
      const shared = u.favoriteDramaIds.filter((d) => myDramas.has(d));
      const g = u.favoriteGenres.find((x) => myGenres.has(x));
      const reason = shared.length ? `Also loves ${getDrama(s, shared[0])?.title}` : g ? `Into ${g} too` : 'Active this week';
      return { user: u, reason, w: shared.length * 2 + (g ? 1 : 0) + u.followers / 5000 };
    })
    .sort((a, b) => b.w - a.w)
    .slice(0, n);
}

export function relatedDramas(s: AppState, d: Drama, n = 8): Drama[] {
  return allDramas(s)
    .filter((x) => x.id !== d.id)
    .map((x) => ({
      x,
      w:
        x.genres.filter((g) => d.genres.includes(g)).length * 2 +
        (x.tags ?? []).filter((t) => (d.tags ?? []).includes(t)).length * 3 +
        (x.cast.some((c) => d.cast.some((c2) => c2.actorId === c.actorId)) ? 2 : 0) +
        (x.network === d.network ? 0.5 : 0) +
        (formatFandomOf(x) === formatFandomOf(d) ? 1.5 : 0),
    }))
    .filter((r) => r.w > 0)
    .sort((a, b) => b.w - a.w)
    .slice(0, n)
    .map((r) => r.x);
}

export function relatedActors(s: AppState, a: Actor, n = 8): Actor[] {
  const co = new Map<string, number>();
  for (const dId of a.knownFor) {
    const d = getDrama(s, dId);
    d?.cast.forEach((c) => c.actorId !== a.id && co.set(c.actorId, (co.get(c.actorId) ?? 0) + 1));
  }
  const direct = [...co.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, n)
    .map(([id]) => getActor(s, id)!)
    .filter(Boolean);
  if (direct.length >= n) return direct;
  const seen = new Set([a.id, ...direct.map((x) => x.id)]);
  const actorWorlds = new Set(
    [...a.knownFor.map((id) => getDrama(s, id)).filter(Boolean), ...(a.knownForDramas ?? [])].map((d) => formatFandomOf(d!)),
  );
  const more = allActors(s).filter((other) => {
    if (seen.has(other.id)) return false;
    const otherWorlds = [...other.knownFor.map((id) => getDrama(s, id)).filter(Boolean), ...(other.knownForDramas ?? [])].map((d) => formatFandomOf(d!));
    return otherWorlds.some((w) => actorWorlds.has(w));
  });
  return [...direct, ...more].slice(0, n);
}

export function fandomSize(d: Drama): number {
  return d.followerCount;
}

export function watchlistByStatus(s: AppState, status: WatchlistItem['status']): WatchlistItem[] {
  return Object.values(s.watchlist)
    .filter((w) => w.status === status)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Next episode the viewer can watch, for "Up next". */
export function upNext(s: AppState): { item: WatchlistItem; drama: Drama; episode: Episode; airedAgo: boolean }[] {
  const t = now().getTime();
  return watchlistByStatus(s, 'watching')
    .map((item) => {
      const drama = getDrama(s, item.dramaId);
      if (!drama) return null;
      const nextNum = item.currentEpisode + 1;
      const rawTotal = drama.seasons.find((sec) => sec.number === item.season)?.episodeCount ?? drama.episodeCount;
      const total = rawTotal || (drama.mediaType === 'movie' ? 1 : 16);
      const episode =
        getEpisode(drama, item.season, nextNum) ??
        (nextNum <= total
          ? {
              id: `${drama.id}-s${item.season}e${nextNum}`,
              dramaId: drama.id,
              season: item.season,
              number: nextNum,
              title: drama.mediaType === 'movie' ? drama.title : `Episode ${nextNum}`,
              runtime: drama.runtime ?? 60,
            }
          : undefined);
      if (!episode) return null;
      const aired = episode.airDate ? new Date(episode.airDate).getTime() <= t : drama.status !== 'upcoming';
      return { item, drama, episode, airedAgo: aired };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => Number(b.airedAgo) - Number(a.airedAgo));
}

export function unreadCount(s: AppState): number {
  return s.notifications.filter((n) => !n.read).length;
}

export function collectionsContaining(s: AppState, dramaId: string): Collection[] {
  return s.collections.filter((c) => c.ownerId === s.profile.id && c.items.some((i) => i.dramaId === dramaId));
}

export function myCollections(s: AppState): Collection[] {
  return s.collections
    .filter((c) => c.ownerId === s.profile.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function publicCollections(s: AppState): Collection[] {
  const pool = s.collections.filter((c) => c.visibility === 'public' && !s.blockedUsers.includes(c.ownerId));
  return pool.sort((a, b) => b.followerCount - a.followerCount);
}

export function currentlyWatching(s: AppState, userId: string): Drama[] {
  if (userId === s.profile.id)
    return watchlistByStatus(s, 'watching')
      .map((w) => getDrama(s, w.dramaId)!)
      .filter(Boolean);
  const u = getUser(s, userId);
  return (u?.favoriteDramaIds ?? [])
    .slice(0, 2)
    .map((id) => getDrama(s, id)!)
    .filter(Boolean);
}

export interface SearchResults {
  dramas: Drama[];
  actors: Actor[];
  people: User[];
  posts: Post[];
  episodes: { drama: Drama; episode: Episode }[];
  collections: Collection[];
}

/** Instant local pass over everything held on the device. */
export function searchLocal(s: AppState, q: string): SearchResults {
  const needle = q.trim().toLowerCase();
  const empty: SearchResults = { dramas: [], actors: [], people: [], posts: [], episodes: [], collections: [] };
  if (!needle) return empty;
  const has = (...fields: (string | undefined)[]) => fields.some((f) => f?.toLowerCase().includes(needle));
  const tag = needle.startsWith('#') ? needle.slice(1) : undefined;
  const postHits = visiblePosts(s)
    .filter((p) => (tag ? p.hashtags.some((h) => h.toLowerCase() === tag) : has(p.title, p.body, p.verdict, ...p.hashtags.map((h) => `#${h}`))))
    .slice(0, 20);
  const people = Object.values(s.users)
    .filter((u) => u.id !== s.profile.id && has(u.displayName, u.handle, u.bio))
    .slice(0, 12);
  return {
    dramas: allDramas(s)
      .filter((d) => has(d.title, d.originalTitle, ...d.genres, ...(d.tags ?? []), d.network))
      .slice(0, 12),
    actors: allActors(s)
      .filter((a) => has(a.name, a.koreanName))
      .slice(0, 12),
    people,
    posts: postHits,
    episodes: allDramas(s)
      .flatMap((d) => d.episodes.filter((e) => e.title && has(e.title)).map((episode) => ({ drama: d, episode })))
      .slice(0, 8),
    collections: publicCollections(s)
      .filter((c) => has(c.title, c.description))
      .slice(0, 8),
  };
}

export function dramasByGenre(s: AppState, genre: string): Drama[] {
  return allDramas(s)
    .filter((d) => d.genres.some((g) => g.toLowerCase() === genre.toLowerCase()))
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
}

/** Does this viewer follow whoever authored the post (for the Following-tab empty state). */
export function followsAnyone(s: AppState): boolean {
  return s.follows.users.length + s.follows.dramas.length + s.follows.actors.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Fandoms — the four worlds, as identity and as discovery
// ---------------------------------------------------------------------------------------------

/**
 * The worlds the member belongs to. Profile wins over the onboarding answer, because the profile is
 * what they can come back and change later; an empty list means ALL, which is the default Hallyu
 * experience — never a filter that hides three quarters of the app.
 */
export function myWorlds(s: AppState): FandomId[] {
  return toFandoms(s.profile.fandoms?.length ? s.profile.fandoms : s.onboarding.fandoms);
}

/** True when the member asked for this world (or for all of them). */
export function followsWorld(s: AppState, id: FandomId): boolean {
  const mine = myWorlds(s);
  return mine.length === 0 || mine.includes(id);
}

/** How many titles of each world the device holds — rails hide a world they have nothing for. */
export function worldCounts(s: AppState): Record<FandomId, number> {
  const out = { kdrama: 0, cdrama: 0, anime: 0, hollywood: 0 } as Record<FandomId, number>;
  for (const d of allDramas(s)) out[formatFandomOf(d)] += 1;
  return out;
}

/** Titles on the device that belong to one world, best first (the offline half of the world page). */
export function dramasInWorld(s: AppState, id: FandomId, n = 12): Drama[] {
  const weight = (d: Drama) => (d.rating ?? 0) * 10 + d.followerCount / 500 + (d.status === 'airing' ? 2 : 0);
  return allDramas(s)
    .filter((d) => formatFandomOf(d) === id)
    .sort((a, b) => weight(b) - weight(a))
    .slice(0, n);
}

/**
 * The title the member touched most recently: the last thing they tracked, or failing that the
 * first drama they follow. This is what "Because you like…" is anchored on.
 */
export function anchorDrama(s: AppState): Drama | undefined {
  const items = Object.values(s.watchlist).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const w of items) {
    const d = getDrama(s, w.dramaId);
    if (d) return d;
  }
  for (const id of s.follows.dramas) {
    const d = getDrama(s, id);
    if (d) return d;
  }
  return undefined;
}

/**
 * Cross-fandom discovery, offline: from every world other than the anchor's, the titles that share
 * the most genres with it. With a network the live catalog version (catalog.crossFandom) is used
 * instead — this is what keeps the rail meaningful with no connection at all.
 */
export function crossWorldLocal(s: AppState, n = 9): { drama: Drama; world: Fandom; shared: string[] }[] {
  const anchor = anchorDrama(s);
  if (!anchor) return [];
  const mine = formatFandomOf(anchor);
  return allDramas(s)
    .filter((d) => d.id !== anchor.id && formatFandomOf(d) !== mine)
    .map((d) => ({ drama: d, shared: d.genres.filter((g) => anchor.genres.includes(g)) }))
    .sort((a, b) => b.shared.length - a.shared.length || b.drama.followerCount - a.drama.followerCount)
    .slice(0, n)
    .map((x) => ({ ...x, world: fandomById(formatFandomOf(x.drama)) }));
}

/** Community posts attached to titles in one world, newest first (the world page's social half). */
export function postsInWorld(s: AppState, id: FandomId, n = 6): Post[] {
  const ids = new Set(allDramas(s).filter((d) => formatFandomOf(d) === id).map((d) => d.id));
  return visiblePosts(s)
    .filter((p) => !!p.context.dramaId && ids.has(p.context.dramaId) && p.type !== 'short')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, n);
}

/** The worlds the member actually has titles for — used to build the "Your worlds" rail. */
export function activeWorlds(s: AppState): Fandom[] {
  const counts = worldCounts(s);
  const mine = myWorlds(s);
  const ids: FandomId[] = mine.length ? mine : (['kdrama', 'cdrama', 'anime', 'hollywood'] as FandomId[]);
  return ids.map(fandomById).filter((f) => (counts[f.id] ?? 0) > 0);
}
