// The Movie Database (TMDB) — the catalog data source.
//
// Everything provider-specific lives here so the rest of Hallyu never mentions TMDB by shape: the
// sync function feeds normalized objects into `public.catalog_upsert_title` and
// `public.catalog_upsert_people`, which know nothing about where the data came from. Adding a
// second provider means adding a sibling module that emits the same normalized shapes.

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

const ACCESS_TOKEN = (Deno.env.get('TMDB_ACCESS_TOKEN') ?? '').trim();
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

interface RequestOptions {
  path: string;
  query?: Record<string, string | number | undefined>;
}

/**
 * One request against TMDB, with a timeout and structured error reporting. Never retries on its
 * own — the caller owns backoff so it can write a run row and stop cleanly on a 429.
 */
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
// Genre, streaming provider & trailer mapping
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
  if (trimmed === 'Sci-Fi & Fantasy' || trimmed === 'Science Fiction') {
    return trimmed === 'Science Fiction' ? ['Sci-Fi'] : ['Sci-Fi', 'Fantasy'];
  }
  if (trimmed === 'Action & Adventure') return ['Action', 'Adventure'];
  if (trimmed === 'War & Politics') return ['Historical', 'Politics'];
  if (trimmed === 'History') return ['Historical'];
  if (trimmed === 'Soap') return ['Melodrama'];
  return [trimmed];
}

export function normalizeGenres(
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

interface WatchProviderRegion {
  flatrate?: { provider_name: string }[];
  ads?: { provider_name: string }[];
  free?: { provider_name: string }[];
}

const PRIORITY_REGIONS = ['US', 'KR', 'GB', 'NG', 'JP', 'SG', 'CA', 'AU', 'TW'];

export function extractStreamingProviders(
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
    if (
      canonical &&
      found.size < 6 &&
      /^(Netflix|Disney\+|Prime Video|Apple TV\+|Max|Hulu|Crunchyroll|iQIYI|WeTV|TVING|Wavve)$/i.test(canonical)
    ) {
      found.add(canonical);
    }
  }

  return [...found];
}

export function extractTrailerUrl(videos?: {
  results?: { site?: string; type?: string; official?: boolean; key?: string }[];
}): string | null {
  const yt = (videos?.results ?? []).filter(
    (v) => v.site === 'YouTube' && Boolean(v.key) && /^(Trailer|Teaser)$/i.test(v.type ?? ''),
  );
  if (yt.length === 0) return null;
  const pick =
    yt.find((v) => v.official && /^Trailer$/i.test(v.type ?? '')) ??
    yt.find((v) => /^Trailer$/i.test(v.type ?? '')) ??
    yt[0];
  return pick?.key ? `https://www.youtube.com/watch?v=${pick.key}` : null;
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

export const WORLD_IDS = ['kdrama', 'cdrama', 'anime', 'hollywood'] as const;
export type CatalogWorld = (typeof WORLD_IDS)[number];

const WESTERN_ORIGINS = ['US', 'GB', 'CA', 'AU', 'NZ', 'IE'];

/**
 * Authoritative world classification for Hallyu's four worlds:
 *  - kdrama: Korean language or South Korean production (non-Japanese-animation)
 *  - cdrama: Chinese-language / Greater China production
 *  - anime: Japanese animation strictly (genre 16 / Animation required so live-action Japanese
 *           dramas & films are never misclassified as Anime)
 *  - hollywood: English-language or Western studio production (US/GB/CA/AU/NZ/IE), excluding
 *               non-English international titles so unrelated foreign films never land in Hollywood
 *  - null: outside Hallyu's four canonical worlds (skipped cleanly during ingestion)
 */
export function worldFor(raw: TmdbListItem, _mediaType: 'tv' | 'movie'): CatalogWorld | null {
  const origin = new Set(
    (raw.origin_country ?? raw.production_countries?.map((c) => c.iso_3166_1) ?? []).map((c) =>
      c.toUpperCase(),
    ),
  );
  const lang = (raw.original_language ?? '').toLowerCase();
  const isAnimated =
    Boolean(raw.genres?.some((g) => g.id === 16 || /animation/i.test(g.name))) ||
    Boolean(raw.genre_ids?.includes(16));

  if ((lang === 'ja' || origin.has('JP')) && isAnimated) return 'anime';
  if (lang === 'ko' || origin.has('KR')) return 'kdrama';
  if (
    lang === 'zh' ||
    lang === 'cn' ||
    lang === 'yue' ||
    lang === 'nan' ||
    lang === 'bo' ||
    lang === 'wuu' ||
    origin.has('CN') ||
    origin.has('TW') ||
    origin.has('HK')
  ) {
    return 'cdrama';
  }
  if (lang === 'ja' || (origin.has('JP') && !WESTERN_ORIGINS.some((c) => origin.has(c)))) {
    return null;
  }
  if (lang === 'en' || WESTERN_ORIGINS.some((c) => origin.has(c))) {
    return 'hollywood';
  }
  return null;
}

function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function statusFor(
  raw: TmdbDetail,
  mediaType: 'tv' | 'movie',
): 'airing' | 'completed' | 'upcoming' | 'canceled' {
  const s = (raw.status ?? '').trim().toLowerCase();
  const today = new Date().toISOString().slice(0, 10);

  if (s === 'canceled' || s === 'cancelled') return 'canceled';

  const premiere = (mediaType === 'movie' ? raw.release_date : raw.first_air_date) || null;
  const lastAir = raw.last_air_date || raw.last_episode_to_air?.air_date || null;
  const nextAir = raw.next_episode_to_air?.air_date || null;

  if (mediaType === 'movie') {
    if (
      (premiere && premiere > today) ||
      s === 'rumored' ||
      s === 'planned' ||
      s === 'in production' ||
      s === 'post production'
    ) {
      return 'upcoming';
    }
    return 'completed';
  }

  // TV series
  if (
    (premiere && premiere > today) ||
    (!premiere &&
      (s === 'rumored' ||
        s === 'planned' ||
        s === 'pilot' ||
        s === 'in production' ||
        s === 'post production'))
  ) {
    return 'upcoming';
  }

  if (s === 'ended') return 'completed';

  const recentFloor = addDaysIso(today, -45);
  const activeCeiling = addDaysIso(today, 60);

  if (
    (nextAir && nextAir >= addDaysIso(today, -7) && nextAir <= activeCeiling) ||
    (s === 'returning series' &&
      ((lastAir && lastAir >= recentFloor) || (!lastAir && premiere && premiere >= addDaysIso(today, -60))))
  ) {
    return 'airing';
  }

  if (nextAir && nextAir > activeCeiling) {
    return 'upcoming';
  }

  if (!s && premiere && premiere >= addDaysIso(today, -45)) {
    return 'airing';
  }

  return 'completed';
}

export function activeSeasonNumber(detail: TmdbDetail): number {
  const next = detail.next_episode_to_air?.season_number;
  if (next && next >= 1) return next;
  const last = detail.last_episode_to_air?.season_number;
  if (last && last >= 1) return last;
  const count = detail.number_of_seasons ?? 1;
  return count >= 1 ? count : 1;
}

// ---------------------------------------------------------------------------------------------
// Raw shapes (only the fields Hallyu reads)
// ---------------------------------------------------------------------------------------------

export interface TmdbListItem {
  id: number;
  media_type?: 'tv' | 'movie' | 'person';
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
  release_date?: string;
  genre_ids?: number[];
  genres?: { id: number; name: string }[];
  popularity?: number;
  vote_average?: number;
  vote_count?: number;
}

export interface TmdbDetail extends TmdbListItem {
  status?: string;
  last_air_date?: string;
  number_of_episodes?: number;
  number_of_seasons?: number;
  episode_run_time?: number[];
  runtime?: number;
  networks?: { name: string }[];
  production_companies?: { name: string }[];
  homepage?: string;
  in_production?: boolean;
  last_episode_to_air?: { air_date?: string; season_number?: number; episode_number?: number } | null;
  next_episode_to_air?: { air_date?: string; season_number?: number; episode_number?: number } | null;
  videos?: { results?: { site?: string; type?: string; official?: boolean; key?: string }[] };
  'watch/providers'?: { results?: Record<string, WatchProviderRegion> };
}

export interface TmdbSeason {
  season_number: number;
  episodes?: {
    id: number;
    episode_number: number;
    name?: string;
    overview?: string;
    air_date?: string | null;
    runtime?: number | null;
    still_path?: string | null;
    vote_average?: number | null;
  }[];
}

export interface TmdbCredits {
  cast?: {
    id: number;
    name: string;
    original_name?: string;
    profile_path?: string | null;
    character?: string;
    order?: number;
    roles?: { character?: string; episode_count?: number }[];
  }[];
  crew?: {
    id: number;
    name: string;
    original_name?: string;
    profile_path?: string | null;
    job?: string;
    jobs?: { job?: string }[];
  }[];
}

// ---------------------------------------------------------------------------------------------
// Normalizers — produce the exact JSON shapes the `catalog_upsert_*` functions accept
// ---------------------------------------------------------------------------------------------

const image = (path: string | null | undefined, size: string) =>
  path ? `${IMAGE_BASE}/${size}${path}` : null;

export function normalizeTitle(
  raw: TmdbDetail,
  mediaType: 'tv' | 'movie',
  world: CatalogWorld,
): Record<string, unknown> {
  const title = (raw.name ?? raw.title ?? '').trim();
  const original = (raw.original_name ?? raw.original_title ?? '').trim();
  const firstAir = (raw.first_air_date ?? raw.release_date ?? '') || null;
  const lastAir = (raw.last_air_date || raw.last_episode_to_air?.air_date || null);
  const year = firstAir ? Number.parseInt(firstAir.slice(0, 4), 10) : null;
  const computedStatus = statusFor(raw, mediaType);
  const endYearParsed =
    computedStatus === 'completed' && mediaType === 'tv' && lastAir
      ? Number.parseInt(lastAir.slice(0, 4), 10)
      : null;
  const runtime =
    mediaType === 'movie'
      ? (raw.runtime ?? null)
      : (raw.episode_run_time && raw.episode_run_time.length > 0 ? raw.episode_run_time[0] : null);
  const streaming = extractStreamingProviders(raw['watch/providers'], raw.networks);
  const trailerUrl = extractTrailerUrl(raw.videos);

  return {
    provider_id: 'tmdb',
    external_id: String(raw.id),
    media_type: mediaType,
    world,
    title,
    original_title: original && original !== title ? original : null,
    year: Number.isFinite(year) ? year : null,
    end_year: endYearParsed && Number.isFinite(endYearParsed) ? endYearParsed : null,
    status: computedStatus,
    synopsis: raw.overview?.trim() || null,
    poster_url: image(raw.poster_path, 'w500'),
    backdrop_url: image(raw.backdrop_path, 'w780'),
    genres: normalizeGenres(raw.genres, raw.genre_ids),
    network: raw.networks?.[0]?.name ?? raw.production_companies?.[0]?.name ?? null,
    streaming_on: streaming,
    runtime_minutes: runtime,
    episode_count: mediaType === 'tv' ? (raw.number_of_episodes ?? 0) : 0,
    season_count: mediaType === 'tv' ? Math.max(1, raw.number_of_seasons ?? 1) : 1,
    first_air_date: firstAir,
    last_air_date: lastAir,
    next_episode_at: raw.next_episode_to_air?.air_date
      ? `${raw.next_episode_to_air.air_date}T00:00:00Z`
      : null,
    trailer_url: trailerUrl,
    original_language: raw.original_language ?? null,
    origin_country:
      raw.origin_country ?? raw.production_countries?.map((c) => c.iso_3166_1) ?? [],
    popularity: raw.popularity ?? null,
    vote_average: raw.vote_average ?? null,
    vote_count: raw.vote_count ?? 0,
    provider_data: {
      homepage: raw.homepage ?? null,
      status: raw.status ?? null,
      in_production: raw.in_production ?? null,
    },
  };
}

export function normalizeSeason(season: TmdbSeason): Record<string, unknown>[] {
  return (season.episodes ?? []).map((e) => ({
    season: season.season_number,
    number: e.episode_number,
    title: e.name?.trim() || null,
    synopsis: e.overview?.trim() || null,
    air_date: e.air_date || null,
    runtime_minutes: e.runtime ?? null,
    still_url: image(e.still_path, 'w300'),
    vote_average: e.vote_average ?? null,
    external_id: String(e.id),
  }));
}

const RELEVANT_JOBS = new Map<string, string>([
  ['Director', 'director'],
  ['Writer', 'writer'],
  ['Screenplay', 'writer'],
  ['Creator', 'creator'],
  ['Executive Producer', 'producer'],
]);

export function normalizeCredits(credits: TmdbCredits): {
  external_id: string;
  name: string;
  korean_name: string | null;
  photo_url: string | null;
  job: string;
  character: string | null;
  order_index: number;
}[] {
  const out: {
    external_id: string;
    name: string;
    korean_name: string | null;
    photo_url: string | null;
    job: string;
    character: string | null;
    order_index: number;
  }[] = [];

  for (const member of (credits.cast ?? []).slice(0, 20)) {
    const extId = String(member.id);
    const role = (member.character ?? member.roles?.[0]?.character ?? '').trim() || null;
    const isEastAsianOriginal =
      member.original_name &&
      member.original_name !== member.name &&
      /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(member.original_name);

    out.push({
      external_id: extId,
      name: member.name,
      korean_name: isEastAsianOriginal ? member.original_name! : null,
      photo_url: image(member.profile_path, 'w185'),
      job: 'actor',
      character: role,
      order_index: member.order ?? out.length,
    });
  }

  for (const member of credits.crew ?? []) {
    const jobs = member.jobs?.map((j) => j.job ?? '') ?? (member.job ? [member.job] : []);
    const matched = jobs.find((j) => RELEVANT_JOBS.has(j));
    if (!matched) continue;

    out.push({
      external_id: String(member.id),
      name: member.name,
      korean_name: null,
      photo_url: image(member.profile_path, 'w185'),
      job: RELEVANT_JOBS.get(matched) ?? 'director',
      character: null,
      order_index: out.length,
    });
  }

  return out;
}
