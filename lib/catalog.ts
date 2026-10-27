/**
 * Catalog provider abstraction.
 * The app never talks to "TMDB" directly — it talks to a CatalogProvider. Today that is a
 * TMDB-backed adapter layered over the local catalog; tomorrow it can be the Hallyu ingestion
 * service without touching a single screen.
 *
 * Credentials: constants/keys.ts (v4 read token preferred, sent as a Bearer header; the v3 key is the
 * `?api_key=` fallback). Both are read-only, public-by-design client credentials baked into the app.
 */
import { Platform } from 'react-native';
import { TMDB_ACCESS_TOKEN, TMDB_API_KEY } from '../constants/keys';
import { FANDOMS, Fandom, fandomById, formatFandomOf, inferFormat, isValidWorldDrama } from './fandoms';
import { clearServerCatalogLists, serverProvider } from './api/serverCatalog';
import { Actor, Drama, Episode, FandomId, MediaType } from './model';

// Credentials live in constants/keys.ts (wired into the app; env overrides only when non-empty).
export const TMDB_TOKEN = TMDB_ACCESS_TOKEN;
export const TMDB_KEY = TMDB_API_KEY;
export const TMDB_IMG = 'https://image.tmdb.org/t/p';
export const ATTRIBUTION = 'This product uses the TMDB API but is not endorsed or certified by TMDB.';

/** Korean broadcast slots are date-only in the catalog; we assume the prime-time slot when no time is known. */
const DEFAULT_AIR_TIME_KST = 'T22:00:00+09:00';

export interface ActorDetail {
  actor: Actor;
  /** thin drama records for the filmography (no episodes/cast yet) */
  credits: Drama[];
}

export interface ResolveHint {
  title: string;
  originalTitle?: string;
  year: number;
  providerId?: number;
}

/** A "why you should watch this" card: a title from another world, matched on shared genres. */
export interface CrossWorldPick {
  drama: Drama;
  world: Fandom;
  /** Genres the anchor and this title have in common (may be empty — it is still a world away). */
  shared: string[];
}

export interface CatalogProvider {
  readonly name: string;
  readonly available: boolean;
  /** Search across every world: K-Drama, C-Drama, anime, film and series. */
  searchDramas(query: string, signal?: AbortSignal): Promise<Drama[]>;
  searchActors(query: string, signal?: AbortSignal): Promise<Actor[]>;
  /** Full record: seasons, latest-season episodes, aggregate cast (films: credits + runtime). */
  getDrama(providerId: number, media?: MediaType, signal?: AbortSignal): Promise<Drama | null>;
  /** Fetch all episodes for a specific season of a series on demand. */
  getSeasonEpisodes(providerId: number, seasonNumber: number, dramaId: string, signal?: AbortSignal): Promise<Episode[]>;
  /** Person + credits across film and television. */
  getActor(providerId: number, signal?: AbortSignal): Promise<ActorDetail | null>;
  /** Find the catalog record for a locally-held title (used to attach real art + ids). */
  resolveDrama(hint: ResolveHint, signal?: AbortSignal): Promise<Drama | null>;
  /** Find a person by name (used to attach real headshots). */
  resolveActor(name: string, koreanName?: string, signal?: AbortSignal): Promise<Actor | null>;

  // ---- Editorial lists (Explore, onboarding, genre pages). Thin records, all four worlds. ----
  /** Calculated #1 leader for each of the four Hallyu worlds (K-Drama, C-Drama, Anime, Hollywood). */
  worldLeaders(signal?: AbortSignal): Promise<Drama[]>;
  /** Airing schedule episodes across the next `days` days hydrated with parent series records. */
  scheduleEpisodes(days?: number, signal?: AbortSignal): Promise<Drama[]>;
  /** Most-talked-about titles this week, interleaved so every world is represented. */
  trending(signal?: AbortSignal): Promise<Drama[]>;
  /** Popular titles across all worlds, paged. */
  popular(page?: number, signal?: AbortSignal): Promise<Drama[]>;
  /** Titles with an episode airing in the next `days` days (series only). */
  airingSoon(days?: number, signal?: AbortSignal): Promise<Drama[]>;
  /** Highest-rated titles with a meaningful vote count. */
  topRated(page?: number, signal?: AbortSignal): Promise<Drama[]>;
  /** Premieres from today onwards. */
  upcoming(signal?: AbortSignal): Promise<Drama[]>;
  /** Discover by one of the app's genres, across every world. */
  byGenre(genre: string, page?: number, signal?: AbortSignal, fandom?: FandomId): Promise<Drama[]>;
  /** Titles on a streaming service (TMDB watch-provider id, e.g. 8 = Netflix). */
  onProvider(providerId: number, signal?: AbortSignal, fandom?: FandomId): Promise<Drama[]>;
  /** One world on its own: the K-Drama rail, the Anime rail, the Hollywood film rail. */
  byFandom(fandom: FandomId, sort?: 'trending' | 'popular' | 'top' | 'new', page?: number, signal?: AbortSignal): Promise<Drama[]>;
  /**
   * Cross-fandom discovery — Hallyu's differentiator. Given a title the member just watched, return
   * a few titles from each *other* world, best genre overlap first, so a K-Drama can send you into
   * anime and a Hollywood film can send you into C-Drama.
   */
  crossFandom(anchor: { fandom: FandomId; genres: string[] }, signal?: AbortSignal): Promise<CrossWorldPick[]>;
  /** People trending across every world. */
  trendingPeople(signal?: AbortSignal): Promise<Actor[]>;
  /** "If you liked X" — TMDB recommendations, any world. */
  recommendations(providerId: number, media?: MediaType, signal?: AbortSignal): Promise<Drama[]>;
}

/** Movie genre names land in the same vocabulary as the app's, so filters work across worlds. */
const MOVIE_GENRE_MAP: Record<number, string> = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Melodrama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'Historical',
  27: 'Horror',
  10402: 'Musical',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Sci-fi',
  53: 'Thriller',
  10752: 'Historical',
  37: 'Western',
};

/** Authoritative four-world check: rejects live-action Japanese titles from anime & foreign non-Western titles from Hollywood. */
const hasWorld = (d: Drama): boolean => isValidWorldDrama(d);

const GENRE_MAP: Record<number, string> = {
  10759: 'Action',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Melodrama',
  10751: 'Family',
  10762: 'Kids',
  9648: 'Mystery',
  10763: 'News',
  10764: 'Reality',
  10765: 'Fantasy',
  10766: 'Slice of life',
  10767: 'Talk',
  10768: 'Historical',
  37: 'Western',
};

const TONES = ['#2A2F3F', '#3B2F4A', '#2F3A2A', '#3A2A2A', '#2A3A3A', '#3F352A', '#2A3340'];
const toneFor = (id: number) => TONES[id % TONES.length]!;
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

// ---- Health: the last thing the catalog said, so screens can explain "why no art" precisely. ----
export interface CatalogHealth {
  state: 'idle' | 'ok' | 'error';
  at?: number;
  latencyMs?: number;
  status?: number;
  message?: string;
}
let health: CatalogHealth = { state: 'idle' };
const healthListeners = new Set<(h: CatalogHealth) => void>();
export function setHealth(next: CatalogHealth) {
  // Throttle "still fine" updates so a busy screen doesn't re-render on every request.
  if (next.state === 'ok' && health.state === 'ok' && next.at && health.at && next.at - health.at < 15_000) return;
  health = next;
  healthListeners.forEach((l) => l(health));
}
export const getCatalogHealth = () => health;

/**
 * What a normal person should read when the live catalog is unavailable. Never the raw error —
 * that lives in Settings → About → Live catalog for whoever needs it.
 */
export function friendlyCatalogCopy(h: CatalogHealth, online = true): { title: string; body: string } {
  if (!online) return { title: 'You’re offline', body: 'Live titles come back with your connection. Tap to retry.' };
  if (h.status === 401 || h.status === 403) return { title: 'The catalog isn’t answering right now', body: 'We’re showing saved titles in the meantime. Tap to try again.' };
  if (h.status === 429) return { title: 'The catalog is busy', body: 'Too many people at once. Give it a moment and tap to retry.' };
  if (h.status && h.status >= 500) return { title: 'The catalog is having a moment', body: 'Their side, not yours. Saved titles are here — tap to try again shortly.' };
  return { title: 'Couldn’t reach the live catalog', body: 'Check your connection or try again in a moment. Saved titles are here meanwhile.' };
}
export function subscribeCatalogHealth(l: (h: CatalogHealth) => void) {
  healthListeners.add(l);
  return () => {
    healthListeners.delete(l);
  };
}

/**
 * Which credential to present. Browsers start with the v3 key as a query param — a "simple" CORS
 * request with no preflight and no custom headers to negotiate; native starts with the v4 read
 * token as a Bearer header. If one is rejected (401) and the other exists, we flip once and retry,
 * so a bad or rotated credential of either kind can't take the catalog down on its own.
 */
type AuthMode = 'key' | 'bearer';
let authMode: AuthMode = Platform.OS === 'web' && TMDB_KEY ? 'key' : TMDB_TOKEN ? 'bearer' : 'key';
const otherMode = (m: AuthMode): AuthMode | null => (m === 'key' ? (TMDB_TOKEN ? 'bearer' : null) : TMDB_KEY ? 'key' : null);

async function tmdb<T>(path: string, params: Record<string, string>, signal?: AbortSignal, retried = false): Promise<T> {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  const mode = authMode;
  if (mode === 'key') url.searchParams.set('api_key', TMDB_KEY);
  url.searchParams.set('language', 'en-US');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (mode === 'bearer') {
    headers.Accept = 'application/json';
    headers.Authorization = `Bearer ${TMDB_TOKEN}`;
  }
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url.toString(), { signal, headers });
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError')
      setHealth({
        state: 'error',
        at: Date.now(),
        message: Platform.OS === 'web' ? 'Network error — the browser could not reach api.themoviedb.org (offline, blocked, or CORS)' : 'Network error — api.themoviedb.org unreachable',
      });
    throw e;
  }
  if (!res.ok) {
    if (res.status === 401 && !retried && otherMode(mode)) {
      authMode = otherMode(mode)!;
      return tmdb<T>(path, params, signal, true);
    }
    const message =
      res.status === 401
        ? 'Catalog credentials rejected (401) — check the TMDB key/token'
        : res.status === 429
          ? 'Catalog rate limit reached (429)'
          : res.status === 404
            ? 'Not found'
            : `Catalog error ${res.status}`;
    if (res.status !== 404) setHealth({ state: 'error', at: Date.now(), status: res.status, message });
    throw new CatalogError(message, res.status);
  }
  setHealth({ state: 'ok', at: Date.now(), latencyMs: Date.now() - started, status: res.status });
  return (await res.json()) as T;
}

interface TmdbEpisode {
  id: number;
  episode_number: number;
  season_number: number;
  name?: string;
  overview?: string;
  air_date?: string | null;
  runtime?: number | null;
  still_path?: string | null;
}

interface TmdbVideo {
  key: string;
  site: string;
  type: string;
  official?: boolean;
  name?: string;
}

interface TmdbWatchProviders {
  results?: Record<
    string,
    {
      flatrate?: { provider_name: string }[];
      free?: { provider_name: string }[];
      ads?: { provider_name: string }[];
    }
  >;
}

interface TmdbTv {
  id: number;
  name: string;
  original_name: string;
  overview: string;
  first_air_date?: string;
  last_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids?: number[];
  genres?: { id: number; name: string }[];
  origin_country?: string[];
  original_language?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  status?: string;
  in_production?: boolean;
  number_of_episodes?: number;
  episode_run_time?: number[];
  networks?: { name: string }[];
  seasons?: { season_number: number; episode_count: number; air_date?: string; name?: string }[];
  next_episode_to_air?: { air_date: string; episode_number: number; season_number: number } | null;
  last_episode_to_air?: { air_date: string; episode_number: number; season_number: number } | null;
  created_by?: { name: string }[];
  aggregate_credits?: { cast: { id: number; name: string; original_name: string; profile_path?: string | null; roles?: { character: string }[]; order: number; popularity?: number }[] };
  videos?: { results?: TmdbVideo[] };
  'watch/providers'?: TmdbWatchProviders;
  /** present when the season was appended (`append_to_response=season/N`) */
  [seasonKey: `season/${number}`]: { episodes?: TmdbEpisode[] } | undefined;
}

interface TmdbMovie {
  id: number;
  title: string;
  original_title: string;
  overview: string;
  release_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids?: number[];
  genres?: { id: number; name: string }[];
  original_language?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  runtime?: number | null;
  status?: string;
  tagline?: string;
  /** present when `credits` was appended */
  credits?: { cast: { id: number; name: string; original_name?: string; profile_path?: string | null; popularity?: number; character?: string; order?: number }[] };
  videos?: { results?: TmdbVideo[] };
  'watch/providers'?: TmdbWatchProviders;
}

interface TmdbPerson {
  id: number;
  name: string;
  original_name?: string;
  also_known_as?: string[];
  profile_path?: string | null;
  known_for?: (TmdbTv & TmdbMovie & { media_type?: string })[];
  known_for_department?: string;
  popularity?: number;
  biography?: string;
  birthday?: string | null;
  tv_credits?: { cast: (TmdbTv & { character?: string; episode_count?: number })[] };
  movie_credits?: { cast: (TmdbMovie & { character?: string })[] };
}

function airIso(date?: string | null): string | undefined {
  if (!date) return undefined;
  return new Date(`${date}${DEFAULT_AIR_TIME_KST}`).toISOString();
}

function mapGenre(g: string): string {
  if (g === 'Drama') return 'Melodrama';
  if (g === 'Sci-Fi & Fantasy' || g === 'Science Fiction') return 'Sci-fi';
  if (g === 'Action & Adventure') return 'Action';
  if (g === 'War & Politics' || g === 'History' || g === 'War') return 'Historical';
  if (g === 'Soap') return 'Melodrama';
  return g;
}

function mapEpisode(dramaId: string, e: TmdbEpisode): Episode {
  return {
    id: `${dramaId}-s${e.season_number}e${e.episode_number}`,
    dramaId,
    season: e.season_number,
    number: e.episode_number,
    title: e.name && !/^episode \d+$/i.test(e.name) ? e.name : undefined,
    airDate: airIso(e.air_date),
    runtime: e.runtime ?? undefined,
    synopsis: e.overview || undefined,
    stillUrl: e.still_path ? `${TMDB_IMG}/w780${e.still_path}` : undefined,
  };
}

function extractTrailerUrl(videos?: { results?: TmdbVideo[] }): string | undefined {
  const list = (videos?.results ?? []).filter((v) => v.site === 'YouTube' && v.key);
  if (!list.length) return undefined;
  const pick =
    list.find((v) => v.type === 'Trailer' && v.official) ??
    list.find((v) => v.type === 'Trailer') ??
    list.find((v) => v.type === 'Teaser' && v.official) ??
    list.find((v) => v.type === 'Teaser') ??
    list[0];
  return pick ? `https://www.youtube.com/watch?v=${pick.key}` : undefined;
}

function extractStreamingProviders(wp?: TmdbWatchProviders): string[] | undefined {
  const regions = wp?.results;
  if (!regions) return undefined;
  const pick = regions.US ?? regions.KR ?? regions.GB ?? regions.JP ?? Object.values(regions)[0];
  if (!pick) return undefined;
  const names = [...(pick.flatrate ?? []), ...(pick.free ?? []), ...(pick.ads ?? [])].map((p) => p.provider_name);
  const unique = [...new Set(names)].slice(0, 5);
  return unique.length ? unique : undefined;
}

const formatOfTv = (t: TmdbTv) => inferFormat({ media: 'tv', language: t.original_language, countries: t.origin_country, genres: t.genres?.map((g) => g.name) ?? (t.genre_ids ?? []).map((g) => GENRE_MAP[g]).filter((x): x is string => !!x) });

function mapTv(t: TmdbTv): Drama {
  const id = `tmdb-${t.id}`;
  const fmt = formatOfTv(t);
  const year = t.first_air_date ? Number(t.first_air_date.slice(0, 4)) : new Date().getFullYear();
  const notStarted = !t.first_air_date || new Date(t.first_air_date) > new Date();
  const status: Drama['status'] = t.status === 'In Production' || t.status === 'Planned' || notStarted ? 'upcoming' : t.in_production || t.status === 'Returning Series' ? 'airing' : 'completed';
  const genreNames = t.genres?.map((g) => g.name) ?? (t.genre_ids ?? []).map((g) => GENRE_MAP[g]).filter((x): x is string => !!x);
  const seasons = (t.seasons ?? [])
    .filter((s) => s.season_number > 0)
    .map((s) => ({ number: s.season_number, episodeCount: s.episode_count, year: s.air_date ? Number(s.air_date.slice(0, 4)) : undefined, name: s.name }));
  const rawCast = (t.aggregate_credits?.cast ?? []).slice(0, 16);
  const cast = rawCast.map((c, i) => ({ actorId: `tmdb-${c.id}`, role: c.roles?.[0]?.character ?? 'Cast', order: i }));
  const castActors: Actor[] = rawCast.map((c) => ({
    id: `tmdb-${c.id}`,
    name: c.name,
    koreanName: c.original_name && c.original_name !== c.name ? c.original_name : undefined,
    photoUrl: c.profile_path ? `${TMDB_IMG}/w342${c.profile_path}` : undefined,
    knownFor: [id],
    followerCount: Math.round((c.popularity ?? 5) * 30),
    provider: { name: 'tmdb', id: c.id },
  }));
  const episodes: Episode[] = [];
  for (const s of seasons) {
    const appended = t[`season/${s.number}`];
    for (const e of appended?.episodes ?? []) episodes.push(mapEpisode(id, e));
  }
  if (episodes.length === 0) {
    if (t.last_episode_to_air?.air_date) {
      episodes.push(
        mapEpisode(id, {
          id: t.id * 1000 + (t.last_episode_to_air.episode_number || 1),
          season_number: t.last_episode_to_air.season_number || 1,
          episode_number: t.last_episode_to_air.episode_number || 1,
          air_date: t.last_episode_to_air.air_date,
        }),
      );
    }
    if (t.next_episode_to_air?.air_date) {
      episodes.push(
        mapEpisode(id, {
          id: t.id * 1000 + (t.next_episode_to_air.episode_number || 2) + 500,
          season_number: t.next_episode_to_air.season_number || 1,
          episode_number: t.next_episode_to_air.episode_number || 2,
          air_date: t.next_episode_to_air.air_date,
        }),
      );
    }
  }
  const runtime = t.episode_run_time?.[0];
  return {
    id,
    title: t.name,
    originalTitle: t.original_name !== t.name ? t.original_name : undefined,
    mediaType: 'tv',
    format: fmt,
    originalLanguage: t.original_language,
    region: t.origin_country?.[0],
    year,
    endYear: status === 'completed' && t.last_air_date ? Number(t.last_air_date.slice(0, 4)) : undefined,
    status,
    network: t.networks?.[0]?.name,
    streamingOn: extractStreamingProviders(t['watch/providers']),
    genres: genreNames.length ? [...new Set(genreNames.map(mapGenre))] : ['Melodrama'],
    synopsis: t.overview || 'No synopsis yet.',
    posterUrl: t.poster_path ? `${TMDB_IMG}/w342${t.poster_path}` : undefined,
    backdropUrl: t.backdrop_path ? `${TMDB_IMG}/w780${t.backdrop_path}` : undefined,
    trailerUrl: extractTrailerUrl(t.videos),
    tone: toneFor(t.id),
    rating: t.vote_average && (t.vote_count ?? 0) >= 5 ? Math.round(t.vote_average * 10) / 10 : undefined,
    episodeCount: t.number_of_episodes ?? seasons.reduce((a, s) => a + s.episodeCount, 0),
    seasons: seasons.length ? seasons : [{ number: 1, episodeCount: t.number_of_episodes ?? 0, year }],
    episodes: episodes.map((e) => (e.runtime || !runtime ? e : { ...e, runtime })),
    cast,
    castActors: castActors.length ? castActors : undefined,
    creators: t.created_by?.map((c) => c.name),
    nextEpisodeAt: airIso(t.next_episode_to_air?.air_date) ?? (notStarted ? airIso(t.first_air_date) : undefined),
    followerCount: Math.round((t.popularity ?? 10) * 40),
    provider: { name: 'tmdb', id: t.id, mediaType: 'tv' },
  };
}

/** A film: no seasons, no episodes — a runtime, a cast and the same social layer around it. */
function mapMovie(m: TmdbMovie): Drama {
  const id = `tmdb-movie-${m.id}`;
  const year = m.release_date ? Number(m.release_date.slice(0, 4)) : new Date().getFullYear();
  const notYet = !m.release_date || new Date(m.release_date) > new Date();
  const genreNames = m.genres?.map((g) => g.name) ?? (m.genre_ids ?? []).map((g) => MOVIE_GENRE_MAP[g]).filter((x): x is string => !!x);
  const rawCast = (m.credits?.cast ?? []).slice(0, 16);
  const cast = rawCast.map((c, i) => ({ actorId: `tmdb-${c.id}`, role: c.character || 'Cast', order: i }));
  const castActors: Actor[] = rawCast.map((c) => ({
    id: `tmdb-${c.id}`,
    name: c.name,
    koreanName: c.original_name && c.original_name !== c.name ? c.original_name : undefined,
    photoUrl: c.profile_path ? `${TMDB_IMG}/w342${c.profile_path}` : undefined,
    knownFor: [id],
    followerCount: Math.round((c.popularity ?? 5) * 30),
    provider: { name: 'tmdb', id: c.id },
  }));
  return {
    id,
    title: m.title,
    originalTitle: m.original_title !== m.title ? m.original_title : undefined,
    mediaType: 'movie',
    format: inferFormat({ media: 'movie', language: m.original_language, genres: genreNames }),
    originalLanguage: m.original_language,
    year,
    endYear: year,
    status: notYet ? 'upcoming' : 'completed',
    streamingOn: extractStreamingProviders(m['watch/providers']),
    genres: genreNames.length ? [...new Set(genreNames.map(mapGenre))] : ['Melodrama'],
    synopsis: m.overview || 'No synopsis yet.',
    posterUrl: m.poster_path ? `${TMDB_IMG}/w342${m.poster_path}` : undefined,
    backdropUrl: m.backdrop_path ? `${TMDB_IMG}/w780${m.backdrop_path}` : undefined,
    trailerUrl: extractTrailerUrl(m.videos),
    tone: toneFor(m.id),
    runtime: m.runtime ?? undefined,
    rating: m.vote_average && (m.vote_count ?? 0) >= 20 ? Math.round(m.vote_average * 10) / 10 : undefined,
    episodeCount: 0,
    seasons: [],
    episodes: [],
    cast,
    castActors: castActors.length ? castActors : undefined,
    followerCount: Math.round((m.popularity ?? 10) * 40),
    provider: { name: 'tmdb', id: m.id, mediaType: 'movie' },
  };
}

function mapPerson(p: TmdbPerson): Actor {
  const actorId = `tmdb-${p.id}`;
  const koreanName = p.original_name && p.original_name !== p.name ? p.original_name : p.also_known_as?.find((n) => /[\u3131-\uD79D]/.test(n));
  const knownForDramas = (p.known_for ?? [])
    .filter((k) => k.media_type === 'movie' || k.media_type === 'tv' || k.name || k.title)
    .map((k) => {
      const base = k.media_type === 'movie' || (!k.name && k.title) ? mapMovie(k as unknown as TmdbMovie) : mapTv(k as unknown as TmdbTv);
      return { ...base, cast: [{ actorId, role: 'Cast', order: 0 }] };
    })
    .filter(hasWorld);
  return {
    id: actorId,
    name: p.name,
    koreanName,
    photoUrl: p.profile_path ? `${TMDB_IMG}/w342${p.profile_path}` : undefined,
    bio: p.biography || undefined,
    birthDate: p.birthday ?? undefined,
    knownFor: knownForDramas.length ? knownForDramas.map((d) => d.id) : (p.known_for ?? []).map((k) => (k.media_type === 'movie' ? `tmdb-movie-${k.id}` : `tmdb-${k.id}`)),
    knownForDramas: knownForDramas.length ? knownForDramas : undefined,
    followerCount: Math.round((p.popularity ?? 5) * 30),
    provider: { name: 'tmdb', id: p.id },
  };
}

/** Which seasons to fetch episodes for: the latest one (airing) plus season 1 (most K-dramas have exactly one). */
function seasonsToAppend(t: TmdbTv): number[] {
  const nums = (t.seasons ?? []).filter((s) => s.season_number > 0).map((s) => s.season_number);
  if (!nums.length) return [1];
  const latest = Math.max(...nums);
  return [...new Set([latest, Math.min(...nums)])].slice(0, 2);
}

/**
 * The app's editorial genres → TMDB discover filters, per medium: films and series use different
 * genre ids (Romance is 10749 for films and not a TV genre at all), so each genre carries both —
 * and TV's gaps lean on keywords, looked up once by name so the ids never go stale.
 */
const GENRE_QUERY: Record<string, { tv?: number[]; movie?: number[]; keywords?: string[] }> = {
  Romance: { movie: [10749], keywords: ['romance', 'love'] },
  Thriller: { movie: [53], keywords: ['thriller', 'suspense'] },
  Fantasy: { tv: [10765], movie: [14] },
  Comedy: { tv: [35], movie: [35] },
  Melodrama: { tv: [18], movie: [18], keywords: ['melodrama'] },
  Crime: { tv: [80], movie: [80] },
  Historical: { movie: [36], keywords: ['joseon dynasty', 'historical drama', 'sageuk'] },
  'Slice of life': { keywords: ['slice of life'] },
  Mystery: { tv: [9648], movie: [9648] },
  Action: { tv: [10759], movie: [28] },
  Medical: { keywords: ['hospital', 'doctor', 'medical drama'] },
  Legal: { keywords: ['lawyer', 'legal drama', 'prosecutor'] },
  Youth: { keywords: ['high school', 'coming of age', 'youth'] },
  Family: { tv: [10751], movie: [10751] },
  Horror: { movie: [27], keywords: ['horror', 'zombie', 'ghost'] },
  'Sci-fi': { tv: [10765], movie: [878], keywords: ['science fiction', 'time travel'] },
};

const isoDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

type DiscoverMode = 'popular' | 'top' | 'new' | 'airing';

/**
 * Per-medium discover parameters. TMDB names its date fields differently for films and series
 * (`primary_release_date` vs `first_air_date`), and a 7.5-rated film needs many more votes than a
 * 7.5-rated series to be worth showing, so the thresholds differ too.
 */
function modeParams(mode: DiscoverMode, media: MediaType, days = 7): Record<string, string> {
  const dateKey = media === 'movie' ? 'primary_release_date' : 'first_air_date';
  switch (mode) {
    case 'top':
      return { sort_by: 'vote_average.desc', 'vote_count.gte': media === 'movie' ? '500' : '150' };
    case 'new':
      return { [`${dateKey}.gte`]: isoDay(1), [`${dateKey}.lte`]: isoDay(120), sort_by: 'popularity.desc' };
    case 'airing':
      return { [`${dateKey}.gte`]: isoDay(0), [`${dateKey}.lte`]: isoDay(days), sort_by: 'popularity.desc' };
    default:
      return { sort_by: 'popularity.desc' };
  }
}

/** Round-robin N lists, so a mixed rail leads with every world instead of one of them. */
function interleave<T>(lists: T[][], perList = 8): T[] {
  const out: T[] = [];
  for (let i = 0; i < perList; i++) for (const l of lists) if (l[i] !== undefined) out.push(l[i]!);
  return out;
}

/** Tiny TTL memo so Explore/onboarding don't re-hit TMDB on every mount. */
const memoStore = new Map<string, { at: number; value: Promise<unknown> }>();
function memo<T>(key: string, ttlMs: number, run: () => Promise<T>): Promise<T> {
  const hit = memoStore.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = run().catch((e) => {
    memoStore.delete(key); // don't cache failures
    throw e;
  });
  memoStore.set(key, { at: Date.now(), value });
  return value;
}
const TEN_MIN = 10 * 60_000;
/** Drop memoised editorial lists (pull-to-refresh) — server and device-local adapters both. */
export function invalidateCatalogLists() {
  memoStore.clear();
  clearServerCatalogLists();
}

const keywordIds = new Map<string, Promise<number | null>>();
function keywordId(name: string, signal?: AbortSignal): Promise<number | null> {
  let p = keywordIds.get(name);
  if (!p) {
    p = tmdb<{ results: { id: number; name: string }[] }>('/search/keyword', { query: name }, signal)
      .then((r) => r.results.find((k) => k.name.toLowerCase() === name.toLowerCase())?.id ?? r.results[0]?.id ?? null)
      .catch(() => {
        keywordIds.delete(name);
        return null;
      });
    keywordIds.set(name, p);
  }
  return p;
}

/** One world, read from the one or two TMDB endpoints it lives on. */
async function discoverWorld(f: Fandom, paramsFor: (media: MediaType) => Record<string, string>, signal?: AbortSignal): Promise<Drama[]> {
  const lists = await Promise.all(
    f.queries.map(async (q) => {
      const data = await tmdb<{ results: (TmdbTv & TmdbMovie)[] }>(`/discover/${q.media}`, { include_adult: 'false', ...q.params, ...paramsFor(q.media) }, signal);
      return data.results.map((r) => (q.media === 'movie' ? mapMovie(r as unknown as TmdbMovie) : mapTv(r as unknown as TmdbTv)));
    }),
  );
  const seen = new Set<string>();
  return lists
    .flat()
    .filter(hasWorld)
    .filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
}

/**
 * Every world at once — the default Hallyu list. The four are read in parallel (Hollywood twice,
 * film and series) and interleaved, so the first four cards can be a K-Drama, a C-Drama, an anime
 * and a film. `seriesOnly` skips the film endpoints for episode-schedule lists.
 */
async function discoverMixed(paramsFor: (media: MediaType) => Record<string, string>, opts: { perWorld?: number; seriesOnly?: boolean } = {}, signal?: AbortSignal): Promise<Drama[]> {
  const worlds = FANDOMS.map((f) => ({ f, queries: opts.seriesOnly ? f.queries.filter((q) => q.media === 'tv') : f.queries })).filter((x) => x.queries.length);
  const results = await Promise.allSettled(worlds.map((w) => discoverWorld({ ...w.f, queries: w.queries }, paramsFor, signal)));
  const lists = results.map((r) => (r.status === 'fulfilled' ? r.value : []));
  if (!lists.some((l) => l.length)) {
    const first = results.find((r) => r.status === 'rejected');
    if (first?.status === 'rejected' && (first.reason as Error)?.name === 'AbortError') throw first.reason;
    throw new CatalogError('Catalog unavailable', 0);
  }
  return interleave(lists, opts.perWorld ?? 8);
}

/** Genre filters for one medium, keywords included. */
async function genreParams(genre: string, media: MediaType, signal?: AbortSignal): Promise<Record<string, string>> {
  const q = GENRE_QUERY[genre] ?? (media === 'movie' ? { movie: [18] } : { tv: [18] });
  const params: Record<string, string> = { sort_by: 'popularity.desc' };
  const ids = (media === 'movie' ? q.movie : q.tv) ?? [];
  if (ids.length) params.with_genres = ids.join(',');
  if (q.keywords?.length) {
    const kids = (await Promise.all(q.keywords.map((k) => keywordId(k, signal)))).filter((x): x is number => !!x);
    if (kids.length) params.with_keywords = kids.join('|'); // OR across keywords
  }
  return params;
}

const isAbort = (e: unknown) => (e as Error)?.name === 'AbortError';
/**
 * Called when a live request failed and the provider falls back to an empty list. It must NOT mark
 * the catalog healthy: doing that turned a rejected credential or an unreachable host into an
 * empty-but-"fine" Explore rail, which is exactly the "TMDB never loads" experience — no titles and
 * no explanation. `tmdb()` already recorded the precise reason (status + message); keep it when it
 * is recent, otherwise record a plain connectivity failure so the UI can show its retry copy.
 */
const markDegraded = () => {
  if (health.state === 'error' && Date.now() - (health.at ?? 0) < 30_000) return;
  setHealth({ state: 'error', at: Date.now(), message: 'Couldn’t reach the live catalog' });
};

export const tmdbProvider: CatalogProvider = {
  name: 'TMDB',
  available: TMDB_TOKEN.length > 0 || TMDB_KEY.length > 0,

  async searchDramas(query, signal) {
    try {
      // One request searches all four worlds: /search/multi returns series and films together.
      const data = await tmdb<{ results: (TmdbTv & TmdbMovie & { media_type?: string })[] }>('/search/multi', { query, include_adult: 'false' }, signal);
      return data.results
        .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
        .map((r) => (r.media_type === 'movie' ? mapMovie(r) : mapTv(r)))
        .filter(hasWorld)
        .sort((a, b) => b.followerCount - a.followerCount)
        .slice(0, 20);
    } catch (e) {
      if (isAbort(e)) throw e;
      markDegraded();
      return []; // offline: no mock rows — the UI shows its degraded/offline copy
    }
  },

  async searchActors(query, signal) {
    try {
      const data = await tmdb<{ results: TmdbPerson[] }>('/search/person', { query, include_adult: 'false' }, signal);
      return data.results
        .filter((p) => (p.known_for_department ?? 'Acting') === 'Acting')
        .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
        .slice(0, 10)
        .map(mapPerson);
    } catch (e) {
      if (isAbort(e)) throw e;
      markDegraded();
      return []; // offline: no mock rows — the UI shows its degraded/offline copy
    }
  },

  async getDrama(providerId, media = 'tv', signal) {
    try {
      if (media === 'movie') {
        const full = await tmdb<TmdbMovie>(`/movie/${providerId}`, { append_to_response: 'credits,videos,watch/providers' }, signal);
        return mapMovie(full);
      }
      const base = await tmdb<TmdbTv>(`/tv/${providerId}`, {}, signal);
      const append = ['aggregate_credits', 'videos', 'watch/providers', ...seasonsToAppend(base).map((n) => `season/${n}`)].join(',');
      const full = await tmdb<TmdbTv>(`/tv/${providerId}`, { append_to_response: append }, signal);
      return mapTv(full);
    } catch (e) {
      if (isAbort(e)) throw e;
      markDegraded();
      return null; // offline: no mock rows
    }
  },

  async getSeasonEpisodes(providerId, seasonNumber, dramaId, signal) {
    try {
      const data = await tmdb<{ episodes?: TmdbEpisode[] }>(`/tv/${providerId}/season/${seasonNumber}`, {}, signal);
      return (data.episodes ?? []).map((e) => mapEpisode(dramaId, e));
    } catch (e) {
      if (isAbort(e)) throw e;
      markDegraded();
      return []; // offline: no mock rows
    }
  },

  async getActor(providerId, signal) {
    try {
      const p = await tmdb<TmdbPerson>(`/person/${providerId}`, { append_to_response: 'tv_credits,movie_credits' }, signal);
      const actorId = `tmdb-${p.id}`;
      const tvCredits = (p.tv_credits?.cast ?? [])
        .filter((c) => (c.episode_count ?? 1) > 0 && !!c.first_air_date)
        .map((c) => ({ ...mapTv(c), cast: [{ actorId, role: c.character || 'Cast', order: 0 }] }));
      const movieCredits = (p.movie_credits?.cast ?? [])
        .filter((c) => !!c.release_date)
        .map((c) => ({ ...mapMovie(c), cast: [{ actorId, role: c.character || 'Cast', order: 0 }] }));
      const seen = new Set<string>();
      const credits = [...tvCredits, ...movieCredits]
        .filter((d) => hasWorld(d) && !seen.has(d.id) && (seen.add(d.id), true))
        .sort((a, b) => b.year - a.year || b.followerCount - a.followerCount)
        .slice(0, 40);
      const actor = mapPerson(p);
      return {
        actor: {
          ...actor,
          knownFor: credits.slice(0, 8).map((d) => d.id),
          knownForDramas: credits.slice(0, 12),
        },
        credits,
      };
    } catch (e) {
      if (isAbort(e)) throw e;
      markDegraded();
      return null; // offline: no mock rows
    }
  },

  async resolveDrama(hint, signal) {
    const wanted = [hint.title, hint.originalTitle].filter((x): x is string => !!x).map(norm);
    const yearOf = (t: TmdbTv) => (t.first_air_date ? Number(t.first_air_date.slice(0, 4)) : undefined);
    const yearNear = (t: TmdbTv) => yearOf(t) === undefined || Math.abs(yearOf(t)! - hint.year) <= 1;
    const exact = (t: TmdbTv) => yearNear(t) && [t.name, t.original_name].map(norm).some((n) => wanted.includes(n));
    // "The Scandal" ↔ "Scandal", "Goblin" ↔ "…도깨비": same year and one title contains the other.
    const loose = (t: TmdbTv) => yearOf(t) === hint.year && [t.name, t.original_name].map(norm).some((n) => wanted.some((w) => w.length >= 4 && (n.includes(w) || w.includes(n))));
    if (hint.providerId) {
      try {
        const t = await tmdb<TmdbTv>(`/tv/${hint.providerId}`, {}, signal);
        if (exact(t) || yearNear(t)) return mapTv(t);
      } catch (e) {
        if (isAbort(e)) throw e;
      }
    }
    const queries: Record<string, string>[] = [
      { query: hint.title, first_air_date_year: String(hint.year), include_adult: 'false' },
      { query: hint.title, include_adult: 'false' },
    ];
    if (hint.originalTitle) queries.push({ query: hint.originalTitle, include_adult: 'false' });
    try {
      for (const params of queries) {
        const data = await tmdb<{ results: TmdbTv[] }>('/search/tv', params, signal);
        const hit = data.results.find(exact) ?? data.results.find(loose);
        if (hit) return mapTv(hit);
      }
    } catch (e) {
      if (isAbort(e)) throw e;
      markDegraded();
    }
    return null; // offline: no mock rows
  },

  async resolveActor(name, koreanName, signal) {
    try {
      const data = await tmdb<{ results: TmdbPerson[] }>('/search/person', { query: name, include_adult: 'false' }, signal);
      const acting = data.results.filter((p) => (p.known_for_department ?? 'Acting') === 'Acting');
      const pick = acting.find((p) => norm(p.name) === norm(name) || (koreanName && (p.original_name === koreanName || p.also_known_as?.includes(koreanName)))) ?? acting[0];
      return pick ? mapPerson(pick) : null;
    } catch (e) {
      if (isAbort(e)) throw e;
      markDegraded();
      return null; // offline: no mock rows
    }
  },

  trending(signal) {
    return memo('trending', TEN_MIN, async () => {
      try {
        // /trending/all/week is already global and already mixed (series and films in one list), so
        // bucket it by world and interleave: no single world can swallow the rail. Thin worlds top up
        // from their own discover list.
        const pages = await Promise.all(
          [1, 2].map((page) => tmdb<{ results: (TmdbTv & TmdbMovie & { media_type?: string })[] }>('/trending/all/week', { page: String(page) }, signal).catch(() => ({ results: [] }))),
        );
        const seen = new Set<string>();
        const buckets = new Map<FandomId, Drama[]>();
        for (const r of pages.flatMap((p) => p.results)) {
          const d = r.media_type === 'movie' ? mapMovie(r) : mapTv(r);
          if (seen.has(d.id) || !hasWorld(d)) continue;
          seen.add(d.id);
          const world = formatFandomOf(d);
          buckets.set(world, [...(buckets.get(world) ?? []), d]);
        }
        const ordered = interleave(FANDOMS.map((f) => (buckets.get(f.id) ?? []).slice(0, 6)));
        if (ordered.length >= 12) return ordered.slice(0, 20);
        const topUp = await discoverMixed((media) => modeParams('popular', media), { perWorld: 5 }, signal).catch(() => [] as Drama[]);
        const have = new Set(ordered.map((d) => d.id));
        const merged = [...ordered, ...topUp.filter((d) => !have.has(d.id))].slice(0, 20);
        if (merged.length) return merged;
      } catch (e) {
        if (isAbort(e)) throw e;
      }
      markDegraded();
      return []; // offline: no mock rows — the UI shows its degraded/offline copy
    });
  },

  popular(page = 1, signal) {
    return memo(`popular:${page}`, TEN_MIN, async () => {
      try {
        return await discoverMixed((media) => ({ ...modeParams('popular', media), page: String(page) }), {}, signal);
      } catch (e) {
        if (isAbort(e)) throw e;
        markDegraded();
        return []; // offline: no mock rows
      }
    });
  },

  airingSoon(days = 7, signal) {
    return memo(`airing:${days}`, TEN_MIN, async () => {
      try {
        return await discoverMixed((media) => modeParams('airing', media, days), { seriesOnly: true }, signal);
      } catch (e) {
        if (isAbort(e)) throw e;
        markDegraded();
        return []; // offline: no mock rows
      }
    });
  },

  topRated(page = 1, signal) {
    return memo(`top:${page}`, TEN_MIN, async () => {
      try {
        return await discoverMixed((media) => ({ ...modeParams('top', media), page: String(page) }), { perWorld: 6 }, signal);
      } catch (e) {
        if (isAbort(e)) throw e;
        markDegraded();
        return []; // offline: no mock rows
      }
    });
  },

  upcoming(signal) {
    return memo('upcoming', TEN_MIN, async () => {
      try {
        return await discoverMixed((media) => modeParams('new', media), {}, signal);
      } catch (e) {
        if (isAbort(e)) throw e;
        markDegraded();
        return []; // offline: no mock rows
      }
    });
  },

  byGenre(genre, page = 1, signal, fandom) {
    return memo(`genre:${genre}:${page}:${fandom ?? 'all'}`, TEN_MIN, async () => {
      try {
        const fetchMedia = async (media: MediaType) => {
          const params = { include_adult: 'false', ...(await genreParams(genre, media, signal)), page: String(page) };
          const data = await tmdb<{ results: (TmdbTv & TmdbMovie)[] }>(`/discover/${media}`, params, signal);
          return data.results.map((r) => (media === 'movie' ? mapMovie(r as unknown as TmdbMovie) : mapTv(r as unknown as TmdbTv)));
        };
        if (fandom) {
          const f = fandomById(fandom);
          const lists = await Promise.all(f.queries.map((q) => fetchMedia(q.media)));
          return lists.flat();
        }
        const [tv, movie] = await Promise.all([fetchMedia('tv'), fetchMedia('movie')]);
        return interleave([tv, movie], page === 1 ? 10 : 20);
      } catch (e) {
        if (isAbort(e)) throw e;
        markDegraded();
        return []; // offline: no mock rows
      }
    });
  },

  onProvider(providerId, signal, fandom) {
    return memo(`provider:${providerId}:${fandom ?? 'all'}`, TEN_MIN, async () => {
      try {
        const params = (media: MediaType) => ({ with_watch_providers: String(providerId), watch_region: 'US', ...modeParams('popular', media) });
        return fandom ? await discoverWorld(fandomById(fandom), params, signal) : await discoverMixed(params, {}, signal);
      } catch (e) {
        if (isAbort(e)) throw e;
        markDegraded();
        return []; // offline: no mock rows
      }
    });
  },

  /**
   * One world on its own. "Trending" inside a world ranks by popularity with a floor on votes —
   * TMDB's global trend list is not split by world, and a title nobody has rated being #1 for
   * K-Dramas would read as broken.
   */
  byFandom(fandom, sort = 'trending', page = 1, signal) {
    return memo(`world:${fandom}:${sort}:${page}`, TEN_MIN, async () => {
      try {
        return await discoverWorld(
          fandomById(fandom),
          (media) => ({ ...(sort === 'trending' ? { sort_by: 'popularity.desc', 'vote_count.gte': media === 'movie' ? '100' : '40' } : modeParams(sort === 'new' ? 'new' : sort === 'top' ? 'top' : 'popular', media)), page: String(page) }),
          signal,
        );
      } catch (e) {
        if (isAbort(e)) throw e;
        markDegraded();
        return []; // offline: no mock rows
      }
    });
  },

  crossFandom(anchor, signal) {
    return memo(`cross:${anchor.fandom}:${anchor.genres.slice(0, 3).join('|')}`, TEN_MIN, async () => {
      const others = FANDOMS.filter((f) => f.id !== anchor.fandom);
      const picks = await Promise.all(
        others.map(async (world) => {
          let items = await discoverWorld(world, (media) => modeParams('top', media), signal).catch(() => [] as Drama[]);
          if (!items.length) markDegraded();
          const overlap = (d: Drama) => d.genres.filter((g) => anchor.genres.includes(g)).length;
          return [...items]
            .sort((a, b) => overlap(b) - overlap(a) || b.followerCount - a.followerCount)
            .slice(0, 3)
            .map((drama) => ({ drama, world, shared: drama.genres.filter((g) => anchor.genres.includes(g)) }));
        }),
      );
      return picks.flat();
    });
  },

  trendingPeople(signal) {
    return memo('people', TEN_MIN, async () => {
      try {
        const pages = await Promise.all([1, 2, 3].map((page) => tmdb<{ results: TmdbPerson[] }>('/trending/person/week', { page: String(page) }, signal).catch(() => ({ results: [] as TmdbPerson[] }))));
        const seen = new Set<number>();
        const list = pages
          .flatMap((p) => p.results)
          .filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
          .filter((p) => (p.known_for_department ?? 'Acting') === 'Acting')
          .map(mapPerson)
          .slice(0, 16);
        if (list.length) return list;
      } catch (e) {
        if (isAbort(e)) throw e;
      }
      markDegraded();
      return []; // offline: no mock rows
    });
  },

  recommendations(providerId, media = 'tv', signal) {
    return memo(`recs:${media}:${providerId}`, TEN_MIN, async () => {
      try {
        const data = await tmdb<{ results: (TmdbTv & TmdbMovie)[] }>(`/${media}/${providerId}/recommendations`, {}, signal);
        return data.results
          .map((r) => (media === 'movie' ? mapMovie(r as unknown as TmdbMovie) : mapTv(r as unknown as TmdbTv)))
          .filter(hasWorld)
          .slice(0, 12);
      } catch (e) {
        if (isAbort(e)) throw e;
        markDegraded();
        return []; // offline: no mock rows
      }
    });
  },

  worldLeaders(signal) {
    return memo('world-leaders', TEN_MIN, async () => {
      const lists = await Promise.all(
        FANDOMS.map((f) => tmdbProvider.byFandom(f.id, 'trending', 1, signal).catch(() => [] as Drama[])),
      );
      return lists.map((items) => items[0]).filter((d): d is Drama => Boolean(d));
    });
  },

  scheduleEpisodes(days = 7, signal) {
    return memo(`schedule:${days}`, TEN_MIN, async () => {
      const airing = await tmdbProvider.airingSoon(days, signal);
      const hydrated = await Promise.all(
        airing.slice(0, 12).map((d) =>
          d.provider?.id ? tmdbProvider.getDrama(d.provider.id, d.mediaType ?? 'tv', signal).catch(() => d) : Promise.resolve(d),
        ),
      );
      return hydrated.filter((d): d is Drama => Boolean(d));
    });
  },
};

// ── The active catalog ──────────────────────────────────────────────────────────────────────────
//
// Production (connected) builds talk to the Hallyu backend ONLY — ingest, freshness, ranking and
// recommendations are server-owned, and a backend failure surfaces as a catalog error, never as a
// silent TMDB retry. The TMDB adapter answers exclusively in device-local builds (no backend env
// baked in — the connection gate says "local mode"), which is the honest pre-connection behaviour.
//
// The indirection is a lazy proxy, not a plain const: it keeps the module cycle between this file
// and lib/api/serverCatalog.ts safe no matter which module a bundler evaluates first.
function activeProvider(): CatalogProvider {
  return serverProvider.available ? serverProvider : tmdbProvider;
}
export const catalog: CatalogProvider = new Proxy({} as CatalogProvider, {
  get(_target, prop) {
    const provider = activeProvider();
    const value = Reflect.get(provider as object, prop);
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(provider) : value;
  },
});
