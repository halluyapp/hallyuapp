// TMDB client and payload normaliser for the catalog ingest Edge Function.
//
// Everything TMDB-specific lives here so the function itself deals only in Hallyu's own payload
// shapes (the ones `catalog_upsert_*` in migration 24 accept). A second provider later means a
// second file next to this one, not a rewrite of the sync job.

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

const DEFAULT_PUBLIC_READ_TOKEN =
  'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJmZjAxZjI4ZmM1YzQ3NzkxZTI4MDM4MzQ5NDQ1YmY1OCIsIm5iZiI6MTc4OTAyMDA1Ny43NzksInN1YiI6IjZhYTI0Nzk5OGQ1YWFjZTczMzY2ODJkMyIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.ETon7kqWQjj7jtJJOXyRgAWme9Sh9B7OUrdAI61uuH8';

const ACCESS_TOKEN = (Deno.env.get('TMDB_ACCESS_TOKEN') ?? '').trim() || DEFAULT_PUBLIC_READ_TOKEN;
const API_KEY = (Deno.env.get('TMDB_API_KEY') ?? '').trim();

export class TmdbError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

export function tmdbConfigured(): boolean {
  return Boolean(ACCESS_TOKEN || API_KEY);
}

export interface RequestOptions {
  path: string;
  query?: Record<string, string | number | undefined>;
}

/** One GET against TMDB, with a timeout and structured error reporting. */
export async function tmdb<T>({ path, query = {} }: RequestOptions): Promise<T> {
  if (!tmdbConfigured()) {
    throw new TmdbError('TMDB credentials are not configured', 503);
  }

  const url = new URL(`${TMDB_BASE}/${path.replace(/^\//, '')}`);
  url.searchParams.set('language', 'en-US');
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  if (!ACCESS_TOKEN && API_KEY) url.searchParams.set('api_key', API_KEY);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (ACCESS_TOKEN) headers.Authorization = `Bearer ${ACCESS_TOKEN}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: controller.signal });
  } catch (error) {
    throw new TmdbError(`network error talking to TMDB: ${(error as Error).message}`, 502);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after'));
    throw new TmdbError('TMDB rate limit reached', 429, Number.isFinite(retry) ? retry : 60);
  }

  if (!response.ok) {
    const snippet = (await response.text().catch(() => '')).slice(0, 200);
    throw new TmdbError(`TMDB ${response.status} on ${path}: ${snippet}`, response.status);
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------------------------
// Genre, streaming provider and world mapping
// ---------------------------------------------------------------------------------------------

const TMDB_GENRE_NAMES: Record<number, string[]> = {
  12: ['Adventure'],
  14: ['Fantasy'],
  16: ['Animation'],
  18: ['Drama'],
  27: ['Horror'],
  28: ['Action'],
  35: ['Comedy'],
  36: ['Historical'],
  37: ['Western'],
  53: ['Thriller'],
  80: ['Crime'],
  99: ['Documentary'],
  878: ['Sci-Fi'],
  9648: ['Mystery'],
  10402: ['Music'],
  10749: ['Romance'],
  10751: ['Family'],
  10752: ['War'],
  10759: ['Action', 'Adventure'],
  10762: ['Kids'],
  10764: ['Reality'],
  10765: ['Sci-Fi', 'Fantasy'],
  10766: ['Melodrama'],
  10768: ['Historical', 'Politics'],
};

function expandGenreName(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed === 'Sci-Fi & Fantasy' || trimmed === 'Science Fiction') return trimmed === 'Science Fiction' ? ['Sci-Fi'] : ['Sci-Fi', 'Fantasy'];
  if (trimmed === 'Action & Adventure') return ['Action', 'Adventure'];
  if (trimmed === 'War & Politics') return ['Historical', 'Politics'];
  if (trimmed === 'History') return ['Historical'];
  if (trimmed === 'Soap') return ['Melodrama'];
  return [trimmed];
}

function normalizeGenres(
  genres?: { id: number; name: string }[],
  genreIds?: number[],
): string[] {
  const seen = new Set<string>();
  const add = (label: string) => {
    for (const part of expandGenreName(label)) {
      if (part && seen.size < 8) seen.add(part);
    }
  };
  for (const g of genres ?? []) add(g.name);
  for (const id of genreIds ?? []) {
    for (const label of TMDB_GENRE_NAMES[id] ?? []) add(label);
  }
  return [...seen];
}

const CANONICAL_PROVIDERS: [RegExp, string][] = [
  [/netflix/i, 'Netflix'],
  [/rakuten viki|^viki$/i, 'Viki'],
  [/disney/i, 'Disney+'],
  [/amazon prime|prime video/i, 'Prime Video'],
  [/crunchyroll/i, 'Crunchyroll'],
  [/apple tv/i, 'Apple TV+'],
  [/\bmax\b|hbo max/i, 'Max'],
  [/\bhulu\b/i, 'Hulu'],
  [/iqiyi/i, 'iQIYI'],
  [/wetv|tencent/i, 'WeTV'],
  [/youku/i, 'Youku'],
  [/kocowa/i, 'KOCOWA+'],
  [/paramount/i, 'Paramount+'],
  [/peacock/i, 'Peacock'],
  [/tvn|tving/i, 'TVING'],
  [/wavve/i, 'Wavve'],
  [/coupang/i, 'Coupang Play'],
  [/bilibili/i, 'Bilibili'],
  [/tubi/i, 'Tubi'],
];

function canonicalProviderName(raw: string): string | null {
  const clean = raw.trim();
  if (!clean) return null;
  for (const [pattern, target] of CANONICAL_PROVIDERS) {
    if (pattern.test(clean)) return target;
  }
  return clean.length <= 28 ? clean : null;
}

export interface WatchProviderRegion {
  flatrate?: { provider_name: string }[];
  ads?: { provider_name: string }[];
  free?: { provider_name: string }[];
}

const PRIORITY_REGIONS = ['US', 'KR', 'GB', 'NG', 'JP', 'SG', 'CA', 'AU', 'TW'];

function extractStreamingProviders(
  watchProviders?: { results?: Record<string, WatchProviderRegion> },
  networks?: { name: string }[],
): string[] {
  const found = new Set<string>();
  const results = watchProviders?.results ?? {};

  for (const region of PRIORITY_REGIONS) {
    const entry = results[region];
    if (!entry) continue;
    for (const p of [...(entry.flatrate ?? []), ...(entry.free ?? []), ...(entry.ads ?? [])]) {
      const canonical = canonicalProviderName(p.provider_name);
      if (canonical && found.size < 6) found.add(canonical);
    }
  }

  for (const net of networks ?? []) {
    const canonical = canonicalProviderName(net.name);
    if (canonical && found.size < 6 && /^(Netflix|Disney\+|Prime Video|Apple TV\+|Max|Hulu|Crunchyroll|iQIYI|WeTV|TVING|Wavve)$/i.test(canonical)) {
      found.add(canonical);
    }
  }

  return [...found];
}

function extractTrailerUrl(videos?: { results?: { site?: string; type?: string; official?: boolean; key?: string }[] }): string | null {
  const list = videos?.results ?? [];
  const best =
    list.find((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official && v.key) ??
    list.find((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.key) ??
    list.find((v) => v.site === 'YouTube' && v.type === 'Teaser' && v.key);
  return best?.key ? `https://www.youtube.com/watch?v=${best.key}` : null;
}

export function worldFor(language: string | null | undefined, countries: string[] | undefined): string {
  const lang = (language ?? '').toLowerCase();
  const origin = new Set((countries ?? []).map((c) => c.toUpperCase()));

  if (lang === 'ko' || origin.has('KR')) return 'kdrama';
  if (lang === 'zh' || lang === 'cn' || origin.has('CN') || origin.has('TW') || origin.has('HK')) {
    return 'cdrama';
  }
  if (lang === 'ja' || origin.has('JP')) return 'anime';
  return 'hollywood';
}

function statusFor(raw: string | undefined, releaseDate: string | null): string {
  const s = (raw ?? '').toLowerCase();
  if (s === 'canceled' || s === 'cancelled') return 'canceled';
  if (s === 'ended') return 'completed';
  if (s === 'returning series') return 'airing';
  if (s.includes('production') || s === 'planned' || s === 'rumored' || s === 'pilot') {
    return 'upcoming';
  }
  if (s === 'released') {
    if (releaseDate && releaseDate > new Date().toISOString().slice(0, 10)) return 'upcoming';
    return 'completed';
  }
  if (releaseDate && releaseDate > new Date().toISOString().slice(0, 10)) return 'upcoming';
  return 'airing';
}

function image(path: string | null | undefined, size: string): string | null {
  return path ? `${IMAGE_BASE}/${size}${path}` : null;
}

export interface TmdbTitle {
  id: number;
  media_type?: 'tv' | 'movie';
  name?: string;
  title?: string;
  original_name?: string;
  original_title?: string;
  original_language?: string;
  origin_country?: string[];
  production_countries?: { iso_3166_1: string }[];
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  first_air_date?: string;
  last_air_date?: string;
  release_date?: string;
  status?: string;
  number_of_episodes?: number;
  number_of_seasons?: number;
  episode_run_time?: number[];
  runtime?: number;
  genres?: { id: number; name: string }[];
  genre_ids?: number[];
  networks?: { name: string }[];
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  next_episode_to_air?: { air_date?: string } | null;
  credits?: { cast?: TmdbCastMember[]; crew?: TmdbCrewMember[] };
  videos?: { results?: { site?: string; type?: string; official?: boolean; key?: string }[] };
  'watch/providers'?: { results?: Record<string, WatchProviderRegion> };
  [key: `season/${number}`]: TmdbSeason | undefined;
}

export interface TmdbSeason {
  season_number: number;
  episodes?: {
    episode_number: number;
    name?: string;
    overview?: string;
    air_date?: string | null;
    runtime?: number | null;
    still_path?: string | null;
    episode_type?: string;
  }[];
}

export interface TmdbCastMember {
  id: number;
  name: string;
  original_name?: string;
  character?: string;
  order?: number;
  profile_path?: string | null;
  popularity?: number;
}

export interface TmdbCrewMember {
  id: number;
  name: string;
  original_name?: string;
  job?: string;
  profile_path?: string | null;
  popularity?: number;
}

/** Shape `catalog_upsert_title` expects (migration 24). */
export function normalizeTitle(raw: TmdbTitle, mediaType: 'tv' | 'movie'): Record<string, unknown> {
  const countries =
    raw.origin_country ?? raw.production_countries?.map((c) => c.iso_3166_1) ?? [];
  const firstAir = (mediaType === 'tv' ? raw.first_air_date : raw.release_date) || null;
  const lastAir = (mediaType === 'tv' ? raw.last_air_date : raw.release_date) || null;
  const year = firstAir ? Number(firstAir.slice(0, 4)) : new Date().getUTCFullYear();
  const runtime =
    mediaType === 'tv'
      ? raw.episode_run_time?.[0] ?? null
      : raw.runtime ?? null;

  const streamingOn = extractStreamingProviders(raw['watch/providers'], raw.networks);
  const trailerUrl = extractTrailerUrl(raw.videos);

  return {
    external_id: String(raw.id),
    media_type: mediaType,
    world: worldFor(raw.original_language, countries),
    title: (raw.name ?? raw.title ?? 'Untitled').trim(),
    original_title: (raw.original_name ?? raw.original_title ?? '').trim() || null,
    original_language: raw.original_language ?? null,
    origin_country: countries,
    year: Number.isFinite(year) && year > 1880 ? year : new Date().getUTCFullYear(),
    end_year: lastAir ? Number(lastAir.slice(0, 4)) || null : null,
    first_air_date: firstAir,
    last_air_date: lastAir,
    next_episode_at: raw.next_episode_to_air?.air_date
      ? `${raw.next_episode_to_air.air_date}T21:00:00Z`
      : null,
    status: statusFor(raw.status, firstAir),
    episode_count: mediaType === 'tv' ? raw.number_of_episodes ?? 0 : 1,
    season_count: mediaType === 'tv' ? Math.max(1, raw.number_of_seasons ?? 1) : 1,
    runtime_minutes: runtime && runtime > 0 ? runtime : null,
    synopsis: (raw.overview ?? '').trim() || null,
    poster_url: image(raw.poster_path, 'w500'),
    backdrop_url: image(raw.backdrop_path, 'w1280'),
    trailer_url: trailerUrl,
    genres: normalizeGenres(raw.genres, raw.genre_ids),
    streaming_on: streamingOn,
    network: raw.networks?.[0]?.name ?? null,
    vote_average: typeof raw.vote_average === 'number' ? Math.round(raw.vote_average * 100) / 100 : null,
    vote_count: raw.vote_count ?? 0,
    popularity: raw.popularity ?? null,
    provider_data: { status: raw.status ?? null },
  };
}

/** Shape `catalog_upsert_episodes` expects. */
export function normalizeSeason(season: TmdbSeason): Record<string, unknown>[] {
  return (season.episodes ?? [])
    .filter((ep) => ep.episode_number >= 1)
    .map((ep) => ({
      number: ep.episode_number,
      title: ep.name?.trim() || null,
      synopsis: ep.overview?.trim() || null,
      air_date: ep.air_date || null,
      runtime_minutes: ep.runtime && ep.runtime > 0 ? ep.runtime : null,
      still_url: image(ep.still_path, 'w500'),
      episode_type: ep.episode_type === 'finale' ? 2 : 0,
    }));
}

const CREW_JOBS: Record<string, string> = {
  Director: 'director',
  'Series Director': 'director',
  Writer: 'writer',
  Screenplay: 'writer',
  'Series Composition': 'writer',
  'Original Story': 'creator',
  Producer: 'producer',
  'Executive Producer': 'producer',
  Creator: 'creator',
};

/** Shape `catalog_upsert_title_people` expects. */
export function normalizeCredits(credits: TmdbTitle['credits']): Record<string, unknown>[] {
  if (!credits) return [];
  const out: Record<string, unknown>[] = [];

  for (const member of (credits.cast ?? []).slice(0, 18)) {
    out.push({
      external_id: String(member.id),
      name: member.name,
      korean_name: member.original_name && member.original_name !== member.name ? member.original_name : null,
      photo_url: image(member.profile_path, 'w300'),
      popularity: member.popularity ?? null,
      job: 'actor',
      character: member.character?.trim() || null,
      order_index: member.order ?? 0,
    });
  }

  for (const member of credits.crew ?? []) {
    const job = CREW_JOBS[member.job ?? ''];
    if (!job) continue;
    out.push({
      external_id: String(member.id),
      name: member.name,
      korean_name: member.original_name && member.original_name !== member.name ? member.original_name : null,
      photo_url: image(member.profile_path, 'w300'),
      popularity: member.popularity ?? null,
      job,
      character: null,
      order_index: 0,
    });
  }

  return out;
}
