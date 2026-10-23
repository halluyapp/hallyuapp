/**
 * Feed, comment, profile, collection, community and notification reads — the backend side of the
 * read cache.
 *
 * The store (lib/store.tsx) stays the cache every screen renders from; lib/sync.ts adopts these
 * server results into it on sign-in, on public cold start, and when screens pull to refresh.
 */
import { fandomById } from '../fandoms';
import type { Collection, Comment, Community, Drama, FandomId, MediaType, Notification, Post, PostType, SpoilerLevel, User } from '../model';
import type { ServerCollectionBundle } from './bootstrap';
import { getBackendAccessToken, supabase } from './client';
import { fetchPostMedia, signedUrls, type PostMedia } from './media';

function db() {
  if (!supabase) throw new Error('no backend configured');
  return supabase;
}

function sessionDb() {
  if (!supabase || !getBackendAccessToken()) throw new Error('a backend session is required');
  return supabase;
}

// ── Server rows → client shapes ───────────────────────────────────────────────────────────────

export interface ServerPost {
  id: string;
  author_id: string;
  type: PostType;
  title: string | null;
  body: string;
  kind: Post['kind'] | null;
  rating: number | string | null;
  verdict: string | null;
  spoiler: SpoilerLevel;
  state: string;
  world: string | null;
  title_id: string | null;
  secondary_title_id: string | null;
  community_id: string | null;
  season: number | null;
  episode: number | null;
  hashtags: string[] | null;
  mentions: string[] | null;
  loved_count: number;
  cried_count: number;
  screamed_count: number;
  swooned_count: number;
  laughed_count: number;
  furious_count: number;
  comment_count: number;
  save_count: number;
  share_count: number;
  created_at: string;
  edited_at: string | null;
}

export interface ServerComment {
  id: string;
  post_id: string;
  author_id: string;
  parent_id: string | null;
  body: string;
  spoiler: SpoilerLevel;
  state: string;
  loved_count?: number;
  cried_count?: number;
  screamed_count?: number;
  swooned_count?: number;
  laughed_count?: number;
  furious_count?: number;
  created_at: string;
}

export interface ServerTitleRow {
  id: string;
  external_id: string;
  media_type: MediaType;
  world: string;
  title: string;
  original_title?: string | null;
  year: number;
  end_year?: number | null;
  status?: string | null;
  network?: string | null;
  streaming_on?: string[] | null;
  genres?: string[] | null;
  tags?: string[] | null;
  synopsis?: string | null;
  poster_url?: string | null;
  backdrop_url?: string | null;
  trailer_url?: string | null;
  tone?: string | null;
  runtime_minutes?: number | null;
  original_language?: string | null;
  vote_average?: number | null;
  community_rating?: number | null;
  follower_count?: number | null;
  episode_count?: number | null;
  airs_on?: string | null;
  next_episode_at?: string | null;
}

interface ServerProfileRow {
  id: string;
  handle: string;
  display_name: string;
  avatar_path?: string | null;
  banner_url?: string | null;
  bio: string | null;
  worlds: string[] | null;
  favorite_genres: string[] | null;
  favorite_title_ids?: string[] | null;
  follower_count: number;
  following_count: number;
  verified: boolean;
  is_private?: boolean;
  role?: 'member' | 'moderator' | 'admin';
  created_at?: string;
}

export function serverTitleToDrama(row: ServerTitleRow): Drama {
  const mediaType = row.media_type ?? 'tv';
  const format: Drama['format'] =
    row.world === 'kdrama' || row.world === 'cdrama' || row.world === 'anime'
      ? row.world
      : mediaType === 'movie'
        ? 'hollywood-movie'
        : 'hollywood-series';
  const rawStatus = row.status ?? 'completed';
  const status: Drama['status'] = rawStatus === 'airing' || rawStatus === 'upcoming' ? rawStatus : 'completed';
  return {
    id: mediaType === 'movie' ? `tmdb-movie-${row.external_id}` : `tmdb-${row.external_id}`,
    title: row.title,
    originalTitle: row.original_title ?? undefined,
    mediaType,
    format,
    originalLanguage: row.original_language ?? undefined,
    runtime: row.runtime_minutes ?? undefined,
    year: row.year,
    endYear: row.end_year ?? undefined,
    status,
    network: row.network ?? undefined,
    streamingOn: row.streaming_on ?? undefined,
    genres: row.genres ?? [],
    tags: row.tags ?? undefined,
    synopsis: row.synopsis ?? '',
    posterUrl: row.poster_url ?? undefined,
    backdropUrl: row.backdrop_url ?? undefined,
    trailerUrl: row.trailer_url ?? undefined,
    tone: row.tone || fandomById(row.world as FandomId)?.tint || '#1F2430',
    rating: row.community_rating ?? row.vote_average ?? undefined,
    episodeCount: row.episode_count ?? 0,
    seasons: [],
    episodes: [],
    cast: [],
    airsOn: row.airs_on ?? undefined,
    nextEpisodeAt: row.next_episode_at ?? undefined,
    followerCount: Math.round(row.follower_count ?? 0),
    provider: { name: 'tmdb', id: Number(row.external_id), mediaType },
  };
}

/** `titles.id` uuid → the client catalog id the app navigates with. */
export async function resolveDramaClientIds(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uuids = [...new Set(ids.filter(Boolean))];
  if (!uuids.length || !supabase) return out;
  const { data, error } = await supabase.from('titles').select('id, external_id, media_type').in('id', uuids);
  if (error || !data) return out;
  for (const row of data as { id: string; external_id: string; media_type: 'tv' | 'movie' }[]) {
    out.set(row.id, row.media_type === 'movie' ? `tmdb-movie-${row.external_id}` : `tmdb-${row.external_id}`);
  }
  return out;
}

/** Fetch full client Drama models for a set of backend `titles.id` UUIDs so shelves/favorites render posters immediately. */
export async function fetchDramasByUuids(ids: string[]): Promise<{ dramas: Drama[]; idMap: Map<string, string> }> {
  const uuids = [...new Set(ids.filter(Boolean))];
  const idMap = new Map<string, string>();
  if (!uuids.length || !supabase) return { dramas: [], idMap };
  const { data, error } = await supabase.from('titles').select('*').in('id', uuids);
  if (error || !data) return { dramas: [], idMap };
  const dramas: Drama[] = [];
  for (const row of data as ServerTitleRow[]) {
    const drama = serverTitleToDrama(row);
    idMap.set(row.id, drama.id);
    dramas.push(drama);
  }
  return { dramas, idMap };
}

/** `people.id` uuid → the client actor id (`tmdb-<external>`). */
export async function resolveActorClientIds(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uuids = [...new Set(ids.filter(Boolean))];
  if (!uuids.length || !supabase) return out;
  const { data, error } = await supabase.from('people').select('id, external_id').in('id', uuids);
  if (error || !data) return out;
  for (const row of data as { id: string; external_id: string }[]) out.set(row.id, `tmdb-${row.external_id}`);
  return out;
}

export function toPost(row: ServerPost, dramaIds: Map<string, string>): Post {
  return {
    id: row.id,
    type: row.type ?? 'post',
    authorId: row.author_id,
    createdAt: row.created_at ?? new Date().toISOString(),
    editedAt: row.edited_at ?? undefined,
    body: typeof row.body === 'string' ? row.body : '',
    title: row.title ?? undefined,
    kind: row.kind ?? undefined,
    rating: row.rating == null ? undefined : Number(row.rating),
    verdict: row.verdict ?? undefined,
    spoiler: row.spoiler ?? 'none',
    context: {
      dramaId: row.title_id ? dramaIds.get(row.title_id) : undefined,
      secondaryDramaId: row.secondary_title_id ? dramaIds.get(row.secondary_title_id) : undefined,
      communityId: row.community_id ?? undefined,
      season: row.season ?? undefined,
      episode: row.episode ?? undefined,
    },
    hashtags: Array.isArray(row.hashtags) ? row.hashtags : [],
    mentions: Array.isArray(row.mentions) ? row.mentions : [],
    reactions: {
      loved: row.loved_count ?? 0,
      cried: row.cried_count ?? 0,
      screamed: row.screamed_count ?? 0,
      swooned: row.swooned_count ?? 0,
      laughed: row.laughed_count ?? 0,
      furious: row.furious_count ?? 0,
    },
    commentCount: row.comment_count ?? 0,
    saveCount: row.save_count ?? 0,
    shareCount: row.share_count ?? 0,
    state: row.state === 'active' ? undefined : (row.state as Post['state']),
  };
}

/**
 * Fold `post_media` into the client Post shape.
 */
async function withMedia(posts: Post[], media: Map<string, PostMedia[]>): Promise<Post[]> {
  const wanted = new Set<string>();
  for (const post of posts) {
    for (const m of media.get(post.id) ?? []) {
      if (m.storagePath) wanted.add(m.storagePath);
      if (m.posterPath) wanted.add(m.posterPath);
    }
  }
  if (!wanted.size) return posts;
  let urls = new Map<string, string>();
  try {
    urls = await signedUrls([...wanted]);
  } catch {
    // Transient signing outage: keep `storagePath` entries intact on each post so components can
    // re-sign on mount or user retry instead of permanently dropping media from the post.
    urls = new Map();
  }
  return posts.map((post) => {
    const rows = media.get(post.id);
    if (!rows?.length) return post;
    const imageRows = rows.filter((m) => m.kind === 'image');
    const imagePaths = imageRows.map((m) => m.storagePath);
    const images = imageRows.map((m) => urls.get(m.storagePath) ?? m.storagePath);
    const clip = rows.find((m) => m.kind === 'video');
    if (clip) {
      const videoUrl = urls.get(clip.storagePath) ?? clip.storagePath;
      const poster = clip.posterPath ? urls.get(clip.posterPath) : undefined;
      return {
        ...post,
        images: images.length ? images : undefined,
        imagePaths: images.length ? imagePaths : undefined,
        video: {
          url: videoUrl,
          storagePath: clip.storagePath,
          posterPath: clip.posterPath ?? undefined,
          duration: clip.durationMs ? Math.round(clip.durationMs / 1000) : 15,
          poster,
          width: clip.width ?? undefined,
          height: clip.height ?? undefined,
        },
      };
    }
    return images.length ? { ...post, images, imagePaths } : post;
  });
}

/** Fetch the media and interactive polls for a page of posts and fold them in. Never throws. */
async function attachMedia(posts: Post[]): Promise<Post[]> {
  if (!posts.length) return posts;
  try {
    const ids = posts.map((p) => p.id);
    const [mediaMap, pollsRes] = await Promise.all([
      fetchPostMedia(ids),
      (async () => {
        try {
          const res = await db().rpc('get_post_polls', { p_post_ids: ids });
          return res.error || !res.data
            ? {}
            : (res.data as Record<string, {
                question?: string;
                options?: string[];
                counts?: number[];
                total_votes?: number;
                my_vote?: number | null;
                closes_at?: string | null;
              }>);
        } catch {
          return {};
        }
      })(),
    ]);
    const withMediaPosts = await withMedia(posts, mediaMap);
    return withMediaPosts.map((post) => {
      const rawPoll = pollsRes[post.id];
      if (!rawPoll || !Array.isArray(rawPoll.options) || rawPoll.options.length < 2) {
        return post;
      }
      const counts = rawPoll.options.map((_: string, i: number) => Number(rawPoll.counts?.[i] ?? 0));
      return {
        ...post,
        poll: {
          question: rawPoll.question?.trim() || 'Vote below',
          options: rawPoll.options,
          counts,
          totalVotes:
            typeof rawPoll.total_votes === 'number'
              ? rawPoll.total_votes
              : counts.reduce((sum: number, n: number) => sum + n, 0),
          myVote: typeof rawPoll.my_vote === 'number' ? rawPoll.my_vote : null,
          closesAt: rawPoll.closes_at ?? null,
        },
      };
    });
  } catch {
    return posts;
  }
}

export function toComment(row: ServerComment): Comment {
  return {
    id: row.id,
    postId: row.post_id,
    authorId: row.author_id,
    parentId: row.parent_id ?? undefined,
    body: typeof row.body === 'string' ? row.body : '',
    createdAt: row.created_at ?? new Date().toISOString(),
    spoiler: row.spoiler ?? 'none',
    reactions: {
      loved: row.loved_count ?? 0,
      cried: row.cried_count ?? 0,
      screamed: row.screamed_count ?? 0,
      swooned: row.swooned_count ?? 0,
      laughed: row.laughed_count ?? 0,
      furious: row.furious_count ?? 0,
    },
    state: row.state === 'active' ? undefined : (row.state as Comment['state']),
  };
}

/** Sign avatar paths in batch and convert server profile rows + favorite titles to client Users. */
export async function hydrateServerProfiles(rows: ServerProfileRow[]): Promise<{ users: User[]; dramas: Drama[] }> {
  if (!rows.length) return { users: [], dramas: [] };
  const avatarPaths = rows.map((r) => r.avatar_path).filter((p): p is string => Boolean(p));
  const favTitleUuids = rows.flatMap((r) => r.favorite_title_ids ?? []).filter(Boolean);

  let avatars = new Map<string, string>();
  if (avatarPaths.length) {
    try {
      avatars = await signedUrls(avatarPaths);
    } catch {
      avatars = new Map();
    }
  }
  const { dramas, idMap } = await fetchDramasByUuids(favTitleUuids);

  const users: User[] = rows.map((r) => ({
    id: r.id,
    handle: r.handle,
    displayName: r.display_name,
    avatarUrl: r.avatar_path ? avatars.get(r.avatar_path) : undefined,
    avatarPath: r.avatar_path ?? undefined,
    bannerUrl: r.banner_url ?? undefined,
    bio: r.bio ?? undefined,
    fandoms: (r.worlds ?? []) as User['fandoms'],
    favoriteGenres: r.favorite_genres ?? [],
    favoriteDramaIds: (r.favorite_title_ids ?? []).map((id) => idMap.get(id)).filter((id): id is string => Boolean(id)),
    followers: r.follower_count ?? 0,
    following: r.following_count ?? 0,
    joinedAt: r.created_at ?? new Date().toISOString(),
    verified: r.verified,
    isPrivate: Boolean(r.is_private),
    role: r.role ?? undefined,
  }));
  return { users, dramas };
}

/** Convert server collection bundles into client Collection + owner User + referenced Dramas. */
export async function hydrateCollectionBundles(
  bundles: ServerCollectionBundle[],
): Promise<{ collections: Collection[]; owners: User[]; dramas: Drama[] }> {
  if (!bundles.length) return { collections: [], owners: [], dramas: [] };
  const titleUuids = bundles.flatMap((b) => b.items.map((i) => i.title_id));
  const { dramas, idMap } = await fetchDramasByUuids(titleUuids);
  const ownerRows: ServerProfileRow[] = bundles
    .map((b) => b.owner)
    .filter((o): o is NonNullable<ServerCollectionBundle['owner']> => Boolean(o))
    .map((o) => ({
      id: o.id,
      handle: o.handle,
      display_name: o.display_name,
      avatar_path: o.avatar_path,
      bio: null,
      worlds: o.worlds,
      favorite_genres: [],
      favorite_title_ids: [],
      follower_count: 0,
      following_count: 0,
      verified: o.verified,
    }));
  const { users: owners } = await hydrateServerProfiles(ownerRows);

  const collections: Collection[] = bundles.map((b) => ({
    id: b.collection.id,
    ownerId: b.collection.owner_id,
    title: b.collection.title,
    description: b.collection.description ?? undefined,
    visibility: b.collection.visibility,
    followerCount: b.collection.follower_count ?? 0,
    updatedAt: b.collection.updated_at ?? b.collection.created_at,
    items: b.items
      .map((item): Collection['items'][number] | null => {
        const dramaId = idMap.get(item.title_id);
        return dramaId ? { dramaId, note: item.note ?? undefined, addedAt: item.added_at } : null;
      })
      .filter((x): x is Collection['items'][number] => x !== null),
  }));
  return { collections, owners, dramas };
}

// ── Feed ──────────────────────────────────────────────────────────────────────────────────────

export type FeedScope = 'latest' | 'following' | 'for_you' | 'title' | 'world';

export interface FeedPage {
  scope: FeedScope;
  items: Post[];
  hasMore: boolean;
  nextCursor: string | null;
}

export async function fetchFeed(
  scope: FeedScope = 'latest',
  options: { world?: string; titleId?: string; communityId?: string; limit?: number; cursor?: string | null } = {},
): Promise<FeedPage> {
  const { data, error } = await db().rpc('feed_page', {
    p_scope: scope,
    p_world: options.world ?? null,
    p_title_id: options.titleId ?? null,
    p_limit: options.limit ?? 20,
    p_cursor: options.cursor ?? null,
    p_community_id: options.communityId ?? null,
  });
  if (error) throw new Error(`feed_page failed: ${error.message}`);
  const payload = (data ?? {}) as { scope?: FeedScope; items?: ServerPost[]; has_more?: boolean; next_cursor?: string | null };
  const items = payload.items ?? [];
  const dramaIds = await resolveDramaClientIds(
    items.flatMap((p) => [p.title_id, p.secondary_title_id]).filter((x): x is string => Boolean(x)),
  );
  return {
    scope: payload.scope ?? scope,
    items: await attachMedia(items.map((p) => toPost(p, dramaIds))),
    hasMore: Boolean(payload.has_more),
    nextCursor: payload.next_cursor ?? null,
  };
}

export async function fetchComments(
  postId: string,
  limit = 50,
  cursor?: string | null,
): Promise<{ items: Comment[]; hasMore: boolean; nextCursor: string | null }> {
  const { data, error } = await db().rpc('comment_page', { p_post_id: postId, p_limit: limit, p_cursor: cursor ?? null });
  if (error) throw new Error(`comment_page failed: ${error.message}`);
  const payload = (data ?? {}) as { items?: ServerComment[]; has_more?: boolean; next_cursor?: string | null };
  return { items: (payload.items ?? []).map(toComment), hasMore: Boolean(payload.has_more), nextCursor: payload.next_cursor ?? null };
}

/** Fetch a post, its comments, media, and all referenced authors in one round trip (`get_post_thread`). */
export async function fetchPostThread(postId: string): Promise<{ post: Post | null; comments: Comment[]; users: User[]; dramas: Drama[] }> {
  const { data, error } = await db().rpc('get_post_thread', { p_post_id: postId });
  if (error || !data) {
    const [posts, commentPage] = await Promise.all([fetchPosts([postId]), fetchComments(postId)]);
    const authorIds = [...posts.map((p) => p.authorId), ...commentPage.items.map((c) => c.authorId)];
    const users = await fetchProfiles(authorIds);
    return { post: posts[0] ?? null, comments: commentPage.items, users, dramas: [] };
  }
  const raw = data as {
    post: ServerPost | null;
    author?: ServerProfileRow | null;
    authors?: ServerProfileRow[];
    title?: ServerTitleRow | null;
    secondary_title?: ServerTitleRow | null;
    titles?: ServerTitleRow[];
    comments?: (ServerComment | { comment?: ServerComment; author?: ServerProfileRow | null })[];
  };

  const titleRows: ServerTitleRow[] = [
    ...(raw.titles ?? []),
    ...(raw.title ? [raw.title] : []),
    ...(raw.secondary_title ? [raw.secondary_title] : []),
  ];
  const dramas = titleRows.map(serverTitleToDrama);
  const dramaIds = new Map<string, string>();
  for (const row of titleRows) {
    dramaIds.set(row.id, row.media_type === 'movie' ? `tmdb-movie-${row.external_id}` : `tmdb-${row.external_id}`);
  }
  if (raw.post?.title_id && !dramaIds.has(raw.post.title_id)) {
    const extra = await resolveDramaClientIds([raw.post.title_id, raw.post.secondary_title_id].filter((x): x is string => Boolean(x)));
    for (const [k, v] of extra) dramaIds.set(k, v);
  }

  const commentRows: ServerComment[] = [];
  const commentAuthors: ServerProfileRow[] = [];
  for (const entry of raw.comments ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const wrapped = entry as { comment?: ServerComment; author?: ServerProfileRow | null };
    const c = wrapped.comment ?? (entry as ServerComment);
    if (c && typeof c.id === 'string') commentRows.push(c);
    if (wrapped.author && typeof wrapped.author.id === 'string') commentAuthors.push(wrapped.author);
  }

  const allAuthorRows: ServerProfileRow[] = [
    ...(raw.authors ?? []),
    ...(raw.author ? [raw.author] : []),
    ...commentAuthors,
  ];
  const uniqueAuthors = [...new Map(allAuthorRows.map((a) => [a.id, a])).values()];

  const posts = raw.post && typeof raw.post.id === 'string' ? await attachMedia([toPost(raw.post, dramaIds)]) : [];
  const { users, dramas: favDramas } = await hydrateServerProfiles(uniqueAuthors);
  return {
    post: posts[0] ?? null,
    comments: commentRows.map(toComment),
    users,
    dramas: [...dramas, ...favDramas],
  };
}

/** Hydrate specific posts by id (e.g. the saved list bootstrap returns). */
export async function fetchPosts(ids: string[]): Promise<Post[]> {
  const uuids = [...new Set(ids.filter(Boolean))];
  if (!uuids.length) return [];
  const { data, error } = await db()
    .from('posts')
    .select('*')
    .in('id', uuids)
    .eq('state', 'active');
  if (error) throw new Error(`post lookup failed: ${error.message}`);
  const rows = (data ?? []) as ServerPost[];
  const dramaIds = await resolveDramaClientIds(
    rows.flatMap((p) => [p.title_id, p.secondary_title_id]).filter((x): x is string => Boolean(x)),
  );
  return attachMedia(rows.map((p) => toPost(p, dramaIds)));
}

// ── Profiles, Collections, Community Pulse ───────────────────────────────────────────────────

/** Hydrate raw ServerPost rows (such as `boot.my_posts`) with title mappings, signed media, and polls. */
export async function hydrateServerPosts(rows: ServerPost[]): Promise<Post[]> {
  if (!rows.length) return [];
  const dramaIds = await resolveDramaClientIds(
    rows.flatMap((p) => [p.title_id, p.secondary_title_id]).filter((x): x is string => Boolean(x)),
  );
  return attachMedia(rows.map((p) => toPost(p, dramaIds)));
}

/** Public profile rows for the users a page references (RLS: visible profiles only). */
export async function fetchProfiles(ids: string[]): Promise<User[]> {
  const uuids = [...new Set(ids.filter(Boolean))];
  if (!uuids.length) return [];
  const { data, error } = await db()
    .from('profiles')
    .select('id, handle, display_name, avatar_path, banner_url, bio, worlds, favorite_genres, favorite_title_ids, follower_count, following_count, verified, is_private, role, created_at')
    .in('id', uuids);
  if (error) throw new Error(`profile lookup failed: ${error.message}`);
  const { users } = await hydrateServerProfiles((data ?? []) as ServerProfileRow[]);
  return users;
}

/** Full profile page bundle by handle (`get_profile_by_handle`). */
export async function fetchProfileByHandle(
  handle: string,
): Promise<{ user: User; posts: Post[]; collections: Collection[]; dramas: Drama[] } | null> {
  const clean = handle.trim().replace(/^@/, '');
  if (!clean) return null;
  const { data, error } = await db().rpc('get_profile_by_handle', { p_handle: clean });
  if (error || !data) return null;
  const raw = data as {
    profile: ServerProfileRow | null;
    favorites?: ServerTitleRow[];
    watching?: { item?: unknown; title?: ServerTitleRow | null }[];
    posts?: (
      | ServerPost
      | {
          post?: ServerPost | null;
          title?: ServerTitleRow | null;
          secondary_title?: ServerTitleRow | null;
        }
    )[];
    collections?: ServerCollectionBundle[];
  };
  if (!raw.profile) return null;
  const { users, dramas: favDramas } = await hydrateServerProfiles([raw.profile]);
  const user = users[0];
  if (!user) return null;

  const serverPosts: ServerPost[] = [];
  const inlineTitles: ServerTitleRow[] = [...(raw.favorites ?? [])];
  for (const w of raw.watching ?? []) {
    if (w?.title && typeof w.title.id === 'string') inlineTitles.push(w.title);
  }
  for (const entry of raw.posts ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const wrapped = entry as {
      post?: ServerPost | null;
      title?: ServerTitleRow | null;
      secondary_title?: ServerTitleRow | null;
    };
    const p = wrapped.post ?? (entry as ServerPost);
    if (p && typeof p.id === 'string' && typeof p.author_id === 'string') {
      serverPosts.push(p);
    }
    if (wrapped.title && typeof wrapped.title.id === 'string') inlineTitles.push(wrapped.title);
    if (wrapped.secondary_title && typeof wrapped.secondary_title.id === 'string') inlineTitles.push(wrapped.secondary_title);
  }

  const inlineDramas = inlineTitles.map(serverTitleToDrama);
  const preMap = new Map<string, string>();
  for (const t of inlineTitles) {
    preMap.set(t.id, t.media_type === 'movie' ? `tmdb-movie-${t.external_id}` : `tmdb-${t.external_id}`);
  }

  const postTitleIds = serverPosts
    .flatMap((p) => [p.title_id, p.secondary_title_id])
    .filter((x): x is string => typeof x === 'string' && Boolean(x) && !preMap.has(x));
  const { dramas: postDramas, idMap } = await fetchDramasByUuids(postTitleIds);
  const mergedMap = new Map<string, string>([...preMap, ...idMap]);

  const posts = await attachMedia(serverPosts.map((p) => toPost(p, mergedMap)));
  const colHydrated = await hydrateCollectionBundles(raw.collections ?? []);

  return {
    user,
    posts,
    collections: colHydrated.collections,
    dramas: [...favDramas, ...inlineDramas, ...postDramas, ...colHydrated.dramas],
  };
}

/** Public community shelves (`get_public_collections`). */
export async function fetchPublicCollections(limit = 40): Promise<{ collections: Collection[]; owners: User[]; dramas: Drama[] }> {
  const { data, error } = await db().rpc('get_public_collections', { p_limit: limit });
  if (error || !data) return { collections: [], owners: [], dramas: [] };
  const raw = data as { collections?: ServerCollectionBundle[] };
  return hydrateCollectionBundles(raw.collections ?? []);
}

/** Community pulse across worlds (`get_community_pulse`). */
export async function fetchCommunityPulse(
  world?: string | null,
  limit = 12,
): Promise<{
  communities: Community[];
  joinedCommunityIds: string[];
  topVoices: User[];
  dramas: Drama[];
}> {
  const { data, error } = await db().rpc('get_community_pulse', { p_world: world ?? null, p_limit: limit });
  if (error || !data) return { communities: [], joinedCommunityIds: [], topVoices: [], dramas: [] };
  const raw = data as {
    communities?: {
      community: {
        id: string;
        name: string;
        fandom: FandomId;
        description: string | null;
        cover_tone: string | null;
        cover_url: string | null;
        drama_id: string | null;
        member_count: number;
        post_count: number;
        created_at: string;
      };
      is_member: boolean;
    }[];
    most_discussed?: { title: ServerTitleRow; post_count: number; watchlist_count: number }[];
    top_voices?: ServerProfileRow[];
  };

  const communityRows = raw.communities ?? [];
  const dramaMap = await resolveDramaClientIds(
    communityRows.map((c) => c.community.drama_id).filter((x): x is string => Boolean(x)),
  );
  const communities: Community[] = communityRows.map(({ community: c }) => ({
    id: c.id,
    name: c.name,
    fandom: c.fandom,
    description: c.description ?? '',
    coverTone: c.cover_tone ?? fandomById(c.fandom)?.tint ?? '#1F2430',
    coverUrl: c.cover_url ?? undefined,
    dramaId: c.drama_id ? dramaMap.get(c.drama_id) : undefined,
    memberCount: c.member_count ?? 0,
    postCount: c.post_count ?? 0,
    createdAt: c.created_at,
  }));
  const joinedCommunityIds = communityRows.filter((c) => c.is_member).map((c) => c.community.id);
  const { users: topVoices, dramas: favDramas } = await hydrateServerProfiles(raw.top_voices ?? []);
  const discussedDramas = (raw.most_discussed ?? []).map((d) => serverTitleToDrama(d.title));
  return {
    communities,
    joinedCommunityIds,
    topVoices,
    dramas: [...discussedDramas, ...favDramas],
  };
}

// ── Notifications ─────────────────────────────────────────────────────────────────────────────

export async function fetchNotifications(limit = 50): Promise<Notification[]> {
  const { data, error } = await sessionDb()
    .from('notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`notification lookup failed: ${error.message}`);
  const rows = (data ?? []) as {
    id: string;
    kind: Notification['kind'];
    group: Notification['group'];
    actor_ids: string[] | null;
    post_id: string | null;
    comment_id: string | null;
    title_id: string | null;
    community_id: string | null;
    collection_id: string | null;
    episode: number | null;
    title: string | null;
    body: string | null;
    deep_link: string | null;
    read_at: string | null;
    created_at: string;
  }[];
  const dramaIds = await resolveDramaClientIds(rows.map((r) => r.title_id).filter((x): x is string => Boolean(x)));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    group: r.group,
    actorIds: r.actor_ids ?? [],
    postId: r.post_id ?? undefined,
    commentId: r.comment_id ?? undefined,
    dramaId: r.title_id ? dramaIds.get(r.title_id) : undefined,
    communityId: r.community_id ?? undefined,
    collectionId: r.collection_id ?? undefined,
    episode: r.episode ?? undefined,
    title: r.title ?? undefined,
    body: r.body ?? undefined,
    deepLink: r.deep_link ?? undefined,
    createdAt: r.created_at,
    read: Boolean(r.read_at),
  }));
}
