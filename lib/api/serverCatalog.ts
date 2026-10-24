/**
 * The Hallyu server catalog — a CatalogProvider backed entirely by the backend.
 *
 * This is the production catalog path: the client never talks to TMDB here. Ingestion,
 * normalization, freshness, lifecycle, ranking, discovery and recommendations are owned by the
 * Hallyu backend (migrations 20-26 + the catalog-sync Edge Function); this adapter only speaks the
 * backend's RPC + PostgREST surface and maps rows onto the app's Drama/Actor models.
 *
 * Identifiers stay byte-compatible with the device-local adapter: a series is `tmdb-{tmdbId}`, a
 * film is `tmdb-movie-{tmdbId}`, a person is `tmdb-{tmdbId}` — so posts, watchlist rows and the
 * store's maps written before (and after) the switch keep resolving. Slim discovery rows carry the
 * backend's UUID, so lists batch-resolve the provider id in one extra read, memoised together with
 * the list itself.
 *
 * When the build has no backend (device-local mode), `available` is false and lib/catalog.ts keeps
 * the TMDB adapter — that is the honest "local mode" build, not a production fallback: connected
 * builds never fall back to TMDB, and failures here surface as catalog errors, not empty success.
 */
import { CatalogError, setHealth, type CatalogProvider } from '../catalog';
import { supabase, isBackendConfigured } from './client';
import { FANDOMS, fandomById, isValidWorldDrama } from '../fandoms';
import type { Actor, Drama, Episode, FandomId, MediaType } from '../model';

// ── Row shapes (as returned by the backend surface) ─────────────────────────────────────────────

/** Full `titles` row — returned by search_titles and direct table reads. */
interface TitleRow {
  id: string;
  external_id: string;
  media_type: MediaType;
  world: string;
  title: string;
  original_title: string | null;
  year: number;
  end_year?: number | null;
  status: string;
  network?: string | null;
  streaming_on?: string[] | null;
  genres: string[];
  tags?: string[] | null;
  synopsis: string | null;
  poster_url: string | null;
  backdrop_url: string | null;
  trailer_url?: string | null;
  tone?: string | null;
  runtime_minutes?: number | null;
  original_language?: string | null;
  origin_country?: string[] | null;
  vote_average?: number | null;
  community_rating?: number | null;
  popularity?: number | null;
  follower_count?: number | null;
  episode_count: number;
  season_count?: number | null;
  first_air_date?: string | null;
  last_air_date?: string | null;
  next_episode_at?: string | null;
  airs_on?: string | null;
}

/** Slim discovery row (trending/airing/upcoming/recent/recommended) — UUID keyed, no external id. */
export interface SlimTitleRow {
  id: string;
  media_type: MediaType;
  world: string;
  title: string;
  original_title?: string | null;
  year: number;
  status?: string;
  lifecycle?: string;
  genres: string[];
  synopsis: string | null;
  poster_url: string | null;
  backdrop_url: string | null;
  vote_average?: number | null;
  follower_count?: number | null;
  episode_count?: number;
  season_count?: number | null;
  network?: string | null;
  first_air_date?: string | null;
  next_episode_at?: string | null;
  airs_on?: string | null;
  episodes_this_week?: number | null;
}

interface PersonRow {
  id: string;
  name: string;
  korean_name?: string | null;
  photo_url?: string | null;
  bio?: string | null;
  birth_date?: string | null;
  follower_count?: number | null;
  known_for?: unknown;
  known_for_count?: number | null;
  external_id?: string;
}

/** title_people row with the title embedded (PostgREST relationship). */
interface CreditRow {
  character: string | null;
  order_index: number | null;
  titles: TitleRow | TitleRow[] | null;
}

interface DiscoveryEpisode {
  season: number;
  number: number;
  title?: string | null;
  air_date?: string | null;
  runtime_minutes?: number | null;
  synopsis?: string | null;
  still_url?: string | null;
}

interface DiscoveryPayload {
  title?: Partial<TitleRow> & { id: string };
  episodes?: DiscoveryEpisode[];
  cast?: {
    id?: string;
    external_id?: string | null;
    name: string;
    korean_name?: string | null;
    character?: string | null;
    order_index?: number | null;
    photo_url?: string | null;
  }[];
  similar?: SlimTitleRow[];
}

// ── Model mapping ───────────────────────────────────────────────────────────────────────────────

const dramaIdOf = (externalId: string, mediaType: MediaType): string =>
  mediaType === 'movie' ? `tmdb-movie-${externalId}` : `tmdb-${externalId}`;

const formatOf = (world: string, mediaType: MediaType): Drama['format'] => {
  if (world === 'kdrama' || world === 'cdrama' || world === 'anime') return world;
  return mediaType === 'movie' ? 'hollywood-movie' : 'hollywood-series';
};

const statusOf = (
  row: { status?: string; lifecycle?: string },
  fallback: Drama['status'] = 'completed',
): Drama['status'] => {
  const raw = row.status ?? row.lifecycle;
  if (raw === 'airing' || raw === 'upcoming' || raw === 'canceled' || raw === 'completed') return raw;
  return fallback;
};

function toDrama(row: TitleRow): Drama {
  const mediaType = row.media_type ?? 'tv';
  const nextOrPremiere =
    row.next_episode_at ??
    (row.status === 'upcoming' && row.first_air_date ? `${row.first_air_date}T00:00:00Z` : undefined);
  return {
    id: dramaIdOf(row.external_id, mediaType),
    title: row.title,
    originalTitle: row.original_title ?? undefined,
    mediaType,
    format: formatOf(row.world, mediaType),
    originalLanguage: row.original_language ?? undefined,
    region: row.origin_country?.[0] ?? undefined,
    runtime: row.runtime_minutes ?? undefined,
    year: row.year,
    endYear: row.end_year ?? undefined,
    status: statusOf(row),
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
    nextEpisodeAt: nextOrPremiere,
    followerCount: Math.round(row.follower_count ?? 0),
    provider: { name: 'tmdb', id: Number(row.external_id), mediaType },
  };
}

interface HydratedTitleMeta {
  id: string;
  external_id: string;
  media_type: MediaType;
  original_language?: string | null;
  origin_country?: string[] | null;
  status?: string | null;
  first_air_date?: string | null;
  vote_average?: number | null;
}

function slimToDrama(
  row: SlimTitleRow,
  meta: HydratedTitleMeta,
  statusHint?: Drama['status'],
): Drama {
  const mediaType = row.media_type ?? meta.media_type ?? 'tv';
  const resolvedStatus = statusOf(
    { status: row.status ?? meta.status ?? undefined, lifecycle: row.lifecycle },
    statusHint ?? 'completed',
  );
  const premiereDate = row.first_air_date ?? meta.first_air_date ?? undefined;
  const nextEpisodeAt =
    row.next_episode_at ?? (premiereDate ? `${premiereDate}T00:00:00Z` : undefined);
  return {
    id: dramaIdOf(meta.external_id, mediaType),
    title: row.title,
    originalTitle: row.original_title ?? undefined,
    mediaType,
    format: formatOf(row.world, mediaType),
    originalLanguage: meta.original_language ?? undefined,
    region: meta.origin_country?.[0] ?? undefined,
    year: row.year,
    status: resolvedStatus,
    network: row.network ?? undefined,
    genres: row.genres ?? [],
    synopsis: row.synopsis ?? '',
    posterUrl: row.poster_url ?? undefined,
    backdropUrl: row.backdrop_url ?? undefined,
    tone: fandomById(row.world as FandomId)?.tint || '#1F2430',
    rating: row.vote_average ?? meta.vote_average ?? undefined,
    episodeCount: row.episode_count ?? 0,
    seasons: [],
    episodes: [],
    cast: [],
    airsOn: row.airs_on ?? undefined,
    nextEpisodeAt,
    followerCount: Math.round(row.follower_count ?? 0),
    provider: { name: 'tmdb', id: Number(meta.external_id), mediaType },
  };
}

/** UUID-keyed slim rows → Dramas, resolving provider ids + authoritative world/status metadata in one batched read. */
export async function hydrateSlim(
  rows: SlimTitleRow[],
  signal?: AbortSignal,
  statusHint?: Drama['status'],
): Promise<Drama[]> {
  if (!rows.length) return [];
  const uuids = rows.map((r) => r.id);
  const { data, error } = await supabase!
    .from('titles')
    .select('id, external_id, media_type, original_language, origin_country, status, first_air_date, vote_average')
    .in('id', uuids)
    .abortSignal(signal!);
  if (error) throw new CatalogError(`title lookup failed: ${error.message}`, 500);
  const byUuid = new Map<string, HydratedTitleMeta>();
  for (const row of (data ?? []) as HydratedTitleMeta[]) {
    byUuid.set(row.id, row);
  }
  return rows
    .map((row) => {
      const resolved = byUuid.get(row.id);
      return resolved ? slimToDrama(row, resolved, statusHint) : null;
    })
    .filter((d): d is Drama => d !== null && isValidWorldDrama(d));
}

function toActor(row: PersonRow, externalId: string): Actor {
  return {
    id: `tmdb-${externalId}`,
    name: row.name,
    koreanName: row.korean_name ?? undefined,
    photoUrl: row.photo_url ?? undefined,
    bio: row.bio ?? undefined,
    birthDate: row.birth_date ?? undefined,
    knownFor: [],
    followerCount: Math.round(row.follower_count ?? 0),
    provider: { name: 'tmdb', id: Number(externalId) },
  };
}

// ── Small utilities ─────────────────────────────────────────────────────────────────────────────

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const memoStore = new Map<string, { at: number; value: Promise<unknown> }>();
const TEN_MIN = 10 * 60_000;
/** Drop the memoised server lists (pull-to-refresh). */
export function clearServerCatalogLists(): void {
  memoStore.clear();
}
function memo<T>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = memoStore.get(key);
  if (hit && Date.now() - hit.at < TEN_MIN) return hit.value as Promise<T>;
  const value = run().catch((e) => {
    memoStore.delete(key);
    throw e;
  });
  memoStore.set(key, { at: Date.now(), value });
  return value;
}

/** TMDB watch-provider id → the streaming label the backend stores on titles.streaming_on. */
const PROVIDER_NAMES: Record<number, string> = {
  8: 'Netflix',
  1796: 'Netflix',
  9: 'Prime Video',
  119: 'Prime Video',
  15: 'Hulu',
  337: 'Disney+',
  350: 'Apple TV+',
  1899: 'Max',
  384: 'Max',
  283: 'Crunchyroll',
  1968: 'Crunchyroll',
  344: 'Viki',
  444: 'Viki',
  581: 'iQIYI',
  623: 'WeTV',
  158: 'Viu',
  97: 'Watcha',
  356: 'Wavve',
  1715: 'TVING',
};

/** Find the title UUID behind a TMDB provider id (the direct table read the hub screens use). */
async function titleRowByProviderId(providerId: number, media: MediaType, signal?: AbortSignal): Promise<TitleRow | null> {
  const { data, error } = await supabase!
    .from('titles')
    .select('*')
    .eq('provider_id', 'tmdb')
    .eq('external_id', String(providerId))
    .eq('media_type', media)
    .limit(1)
    .abortSignal(signal!);
  if (error) throw new CatalogError(`title lookup failed: ${error.message}`, 500);
  return ((data ?? []) as TitleRow[])[0] ?? null;
}

async function personRowByProviderId(providerId: number, signal?: AbortSignal): Promise<(PersonRow & { external_id: string }) | null> {
  const { data, error } = await supabase!
    .from('people')
    .select('*')
    .eq('external_id', String(providerId))
    .limit(1)
    .abortSignal(signal!);
  if (error) throw new CatalogError(`person lookup failed: ${error.message}`, 500);
  return ((data ?? []) as (PersonRow & { external_id: string })[])[0] ?? null;
}

/** Bounded call wrapper: records catalog health and normalises failures into CatalogError. */
async function call<T>(label: string, run: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const started = Date.now();
  try {
    const result = await run(signal);
    setHealth({ state: 'ok', at: Date.now(), latencyMs: Date.now() - started });
    return result;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    const message = e instanceof Error ? e.message : String(e);
    setHealth({ state: 'error', at: Date.now(), message: `Couldn’t reach the Hallyu catalog (${label})` });
    throw e instanceof CatalogError ? e : new CatalogError(message, 0);
  }
}

// ── The provider ────────────────────────────────────────────────────────────────────────────────

export const serverProvider: CatalogProvider = {
  name: 'Hallyu',
  available: isBackendConfigured() && !!supabase,

  async searchDramas(query, signal) {
    return call('search', async (abort) => {
      const { data, error } = await supabase!
        .rpc('search_titles', { p_query: query, p_limit: 24 })
        .abortSignal(abort!);
      if (error) throw new CatalogError(`search failed: ${error.message}`, 500);
      return ((data ?? []) as TitleRow[]).map(toDrama).filter(isValidWorldDrama).slice(0, 20);
    }, signal);
  },

  async searchActors(query, signal) {
    return call('people-search', async (signal) => {
      const { data, error } = await supabase!.rpc('search_people', { p_query: query, p_limit: 10 }).abortSignal(signal!);
      if (error) throw new CatalogError(`people search failed: ${error.message}`, 500);
      const rows = (data ?? []) as PersonRow[];
      const { data: ids, error: idError } = await supabase!
        .from('people')
        .select('id, external_id')
        .in('id', rows.map((r) => r.id))
        .abortSignal(signal!);
      if (idError) throw new CatalogError(`person lookup failed: ${idError.message}`, 500);
      const external = new Map((ids ?? []).map((r: { id: string; external_id: string }) => [r.id, r.external_id]));
      return rows
        .filter((r) => external.has(r.id))
        .map((r) => toActor(r, external.get(r.id)!));
    }, signal);
  },

  async getDrama(providerId, media = 'tv', signal) {
    return call('title', async (signal) => {
      const row = await titleRowByProviderId(providerId, media, signal);
      if (!row) return null;
      const { data, error } = await supabase!.rpc('get_title_discovery', { p_title_id: row.id }).abortSignal(signal!);
      if (error) throw new CatalogError(`title discovery failed: ${error.message}`, 500);
      const payload = (data ?? {}) as DiscoveryPayload;
      const drama = toDrama(row);

      drama.episodes = (payload.episodes ?? []).map((e) => ({
        id: `${drama.id}-s${e.season}e${e.number}`,
        dramaId: drama.id,
        season: e.season,
        number: e.number,
        title: e.title ?? undefined,
        airDate: e.air_date ?? undefined,
        runtime: e.runtime_minutes ?? undefined,
        synopsis: e.synopsis ?? undefined,
        stillUrl: e.still_url ?? undefined,
      }));
      const seasons = new Map<number, number>();
      for (const e of drama.episodes) seasons.set(e.season, (seasons.get(e.season) ?? 0) + 1);
      drama.seasons = Array.from(seasons.entries())
        .sort(([a], [b]) => a - b)
        .map(([number, count]) => ({ number, episodeCount: count, year: drama.year }));

      const castActors: Actor[] = [];
      drama.cast = (payload.cast ?? [])
        .filter((c) => Boolean(c.external_id))
        .map((c, index) => {
          const extId = String(c.external_id);
          const actorId = `tmdb-${extId}`;
          castActors.push({
            id: actorId,
            name: c.name,
            koreanName: c.korean_name ?? undefined,
            photoUrl: c.photo_url ?? undefined,
            knownFor: [],
            followerCount: 0,
            provider: { name: 'tmdb', id: Number(extId) },
          });
          return { actorId, role: c.character || 'Cast', order: c.order_index ?? index };
        });
      if (castActors.length) drama.castActors = castActors;
      return drama;
    }, signal);
  },

  async getSeasonEpisodes(providerId, seasonNumber, dramaId, signal) {
    return call('season', async (signal) => {
      const row = await titleRowByProviderId(providerId, 'tv', signal);
      if (!row) return [];
      const { data, error } = await supabase!.rpc('get_title_discovery', { p_title_id: row.id }).abortSignal(signal!);
      if (error) throw new CatalogError(`episodes failed: ${error.message}`, 500);
      const payload = (data ?? {}) as DiscoveryPayload;
      return (payload.episodes ?? [])
        .filter((e) => e.season === seasonNumber)
        .map((e) => ({
          id: `${dramaId}-s${e.season}e${e.number}`,
          dramaId,
          season: e.season,
          number: e.number,
          title: e.title ?? undefined,
          airDate: e.air_date ?? undefined,
          runtime: e.runtime_minutes ?? undefined,
          synopsis: e.synopsis ?? undefined,
          stillUrl: e.still_url ?? undefined,
        }));
    }, signal);
  },

  async getActor(providerId, signal) {
    return call('actor', async (signal) => {
      const person = await personRowByProviderId(providerId, signal);
      if (!person) return null;
      const { data, error } = await supabase!
        .from('title_people')
        .select('character, order_index, titles(*)')
        .eq('person_id', person.id)
        .order('order_index', { ascending: true })
        .limit(40)
        .abortSignal(signal!);
      if (error) throw new CatalogError(`credits failed: ${error.message}`, 500);
      const seen = new Set<string>();
      const credits: Drama[] = [];
      for (const credit of (data ?? []) as CreditRow[]) {
        const title = Array.isArray(credit.titles) ? credit.titles[0] : credit.titles;
        if (!title) continue;
        const drama = toDrama(title);
        if (seen.has(drama.id)) continue;
        seen.add(drama.id);
        drama.cast = [{ actorId: `tmdb-${person.external_id}`, role: credit.character || 'Cast', order: credit.order_index ?? 0 }];
        credits.push(drama);
      }
      credits.sort((a, b) => b.year - a.year || b.followerCount - a.followerCount);
      const actor = toActor(person, person.external_id);
      actor.knownFor = credits.slice(0, 8).map((d) => d.id);
      actor.knownForDramas = credits.slice(0, 12);
      return { actor, credits };
    }, signal);
  },

  async resolveDrama(hint, signal) {
    return call('resolve', async (signal) => {
      if (hint.providerId) {
        for (const media of ['tv', 'movie'] as MediaType[]) {
          const row = await titleRowByProviderId(hint.providerId, media, signal);
          if (row) return toDrama(row);
        }
      }
      const { data, error } = await supabase!.rpc('search_titles', { p_query: hint.title, p_limit: 10 }).abortSignal(signal!);
      if (error) return null;
      const wanted = [hint.title, hint.originalTitle].filter((x): x is string => !!x).map(norm);
      const rows = (data ?? []) as TitleRow[];
      const exact = rows.find((r) => Math.abs(r.year - hint.year) <= 1 && [r.title, r.original_title ?? ''].map(norm).some((n) => wanted.includes(n)));
      const loose = rows.find((r) => r.year === hint.year && wanted.some((w) => w.length >= 4 && (norm(r.title).includes(w) || w.includes(norm(r.title)))));
      const hit = exact ?? loose;
      return hit ? toDrama(hit) : null;
    }, signal);
  },

  async resolveActor(name, koreanName, signal) {
    return call('resolve-actor', async (signal) => {
      const { data, error } = await supabase!.rpc('search_people', { p_query: name, p_limit: 5 }).abortSignal(signal!);
      if (error) return null;
      const rows = (data ?? []) as PersonRow[];
      const { data: ids, error: idError } = await supabase!
        .from('people')
        .select('id, external_id')
        .in('id', rows.map((r) => r.id))
        .abortSignal(signal!);
      if (idError) return null;
      const external = new Map((ids ?? []).map((r: { id: string; external_id: string }) => [r.id, r.external_id]));
      const hit =
        rows.find((r) => external.has(r.id) && (norm(r.name) === norm(name) || (koreanName ? r.korean_name === koreanName : false))) ??
        rows.find((r) => external.has(r.id));
      return hit ? toActor(hit, external.get(hit.id)!) : null;
    }, signal);
  },

  worldLeaders(signal) {
    return call('world-leaders', (signal) =>
      memo('world-leaders', async () => {
        const { data, error } = await supabase!.rpc('world_leaders').abortSignal(signal!);
        if (error) throw new CatalogError(`world leaders failed: ${error.message}`, 500);
        return hydrateSlim((data ?? []) as SlimTitleRow[], signal);
      }),
    );
  },

  scheduleEpisodes(days = 7, signal) {
    return call('schedule', (signal) =>
      memo(`schedule:${days}`, async () => {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start.getTime() + days * 86_400_000);
        const fromIso = start.toISOString().slice(0, 10);
        const toIso = end.toISOString().slice(0, 10);

        const { data, error } = await supabase!
          .from('title_episodes')
          .select('season, number, title, air_date, runtime_minutes, synopsis, still_url, titles!inner(*)')
          .gte('air_date', fromIso)
          .lte('air_date', toIso)
          .order('air_date', { ascending: true })
          .order('number', { ascending: true })
          .limit(160)
          .abortSignal(signal!);
        if (error) throw new CatalogError(`schedule failed: ${error.message}`, 500);

        interface ScheduleJoinRow {
          season: number;
          number: number;
          title: string | null;
          air_date: string | null;
          runtime_minutes: number | null;
          synopsis: string | null;
          still_url: string | null;
          titles: TitleRow | TitleRow[] | null;
        }

        const byDramaId = new Map<string, Drama>();
        for (const raw of (data ?? []) as ScheduleJoinRow[]) {
          const titleRow = Array.isArray(raw.titles) ? raw.titles[0] : raw.titles;
          if (!titleRow || !raw.air_date) continue;
          const base = toDrama({ ...titleRow, status: 'airing' });
          if (!isValidWorldDrama(base)) continue;
          let target = byDramaId.get(base.id);
          if (!target) {
            target = { ...base, episodes: [] };
            byDramaId.set(base.id, target);
          }
          const ep: Episode = {
            id: `${target.id}-s${raw.season}e${raw.number}`,
            dramaId: target.id,
            season: raw.season,
            number: raw.number,
            title: raw.title ?? undefined,
            airDate: `${raw.air_date}T21:00:00Z`,
            runtime: raw.runtime_minutes ?? undefined,
            synopsis: raw.synopsis ?? undefined,
            stillUrl: raw.still_url ?? undefined,
          };
          if (!target.episodes.some((existing) => existing.id === ep.id)) {
            target.episodes.push(ep);
          }
        }
        return [...byDramaId.values()];
      }),
    );
  },

  trending(signal) {
    return call('trending', (signal) =>
      memo('trending', async () => {
        const { data, error } = await supabase!.rpc('trending_titles', { p_limit: 32 }).abortSignal(signal!);
        if (error) throw new CatalogError(`trending failed: ${error.message}`, 500);
        return hydrateSlim((data ?? []) as SlimTitleRow[], signal);
      }),
    );
  },

  popular(page = 1, signal) {
    return call('popular', (signal) =>
      memo(`popular:${page}`, async () => {
        const { data, error } = await supabase!
          .rpc('browse_titles', {
            p_genre: null,
            p_provider: null,
            p_world: null,
            p_sort: 'popular',
            p_limit: 24,
            p_offset: (page - 1) * 24,
          })
          .abortSignal(signal!);
        if (error) throw new CatalogError(`popular failed: ${error.message}`, 500);
        return ((data ?? []) as TitleRow[]).map(toDrama).filter(isValidWorldDrama);
      }),
    );
  },

  airingSoon(days = 7, signal) {
    return call('airing', (signal) =>
      memo(`airing:${days}`, async () => {
        const { data, error } = await supabase!.rpc('airing_titles', { p_limit: 32 }).abortSignal(signal!);
        if (error) throw new CatalogError(`airing failed: ${error.message}`, 500);
        return hydrateSlim((data ?? []) as SlimTitleRow[], signal, 'airing');
      }),
    );
  },

  topRated(page = 1, signal) {
    return call('top', (signal) =>
      memo(`top:${page}`, async () => {
        const { data, error } = await supabase!
          .rpc('top_rated_titles', { p_world: null, p_limit: page * 24 })
          .abortSignal(signal!);
        if (error) throw new CatalogError(`top rated failed: ${error.message}`, 500);
        const items = ((data ?? []) as TitleRow[]).map(toDrama).filter(isValidWorldDrama);
        const start = (page - 1) * 24;
        return items.slice(start, start + 24);
      }),
    );
  },

  upcoming(signal) {
    return call('upcoming', (signal) =>
      memo('upcoming', async () => {
        const { data, error } = await supabase!.rpc('upcoming_titles', { p_limit: 32 }).abortSignal(signal!);
        if (error) throw new CatalogError(`upcoming failed: ${error.message}`, 500);
        return hydrateSlim((data ?? []) as SlimTitleRow[], signal, 'upcoming');
      }),
    );
  },

  byGenre(genre, page = 1, signal, fandom) {
    return call('genre', (signal) =>
      memo(`genre:${genre}:${page}:${fandom ?? 'all'}`, async () => {
        // One ranking for the whole app (migration 38). This used to read `titles` and sort on the
        // raw provider `popularity` column, which is a different ordering from Trending and the
        // world rails — the same title could be #1 in one and last in the other.
        const { data, error } = await supabase!
          .rpc('browse_titles', {
            p_genre: genre,
            p_provider: null,
            p_world: fandom ?? null,
            p_sort: 'relevance',
            p_limit: 24,
            p_offset: (page - 1) * 24,
          })
          .abortSignal(signal!);
        if (error) throw new CatalogError(`genre browse failed: ${error.message}`, 500);
        return ((data ?? []) as TitleRow[]).map(toDrama);
      }),
    );
  },

  onProvider(providerId, signal, fandom) {
    return call('provider', (signal) =>
      memo(`provider:${providerId}:${fandom ?? 'all'}`, async () => {
        const name = PROVIDER_NAMES[providerId];
        if (!name) return []; // unknown watch provider — no honest server-side equivalent
        const { data, error } = await supabase!
          .rpc('browse_titles', {
            p_genre: null,
            p_provider: name,
            p_world: fandom ?? null,
            p_sort: 'relevance',
            p_limit: 24,
            p_offset: 0,
          })
          .abortSignal(signal!);
        if (error) throw new CatalogError(`provider browse failed: ${error.message}`, 500);
        return ((data ?? []) as TitleRow[]).map(toDrama);
      }),
    );
  },

  byFandom(fandom, sort = 'trending', page = 1, signal) {
    return call('world', (signal) =>
      memo(`world:${fandom}:${sort}:${page}`, async () => {
        if (sort === 'trending') {
          const { data, error } = await supabase!.rpc('trending_titles', { p_world: fandom, p_limit: 24 }).abortSignal(signal!);
          if (error) throw new CatalogError(`world trending failed: ${error.message}`, 500);
          return hydrateSlim((data ?? []) as SlimTitleRow[], signal);
        }
        if (sort === 'new') {
          const { data, error } = await supabase!.rpc('upcoming_titles', { p_world: fandom, p_limit: 24 }).abortSignal(signal!);
          if (error) throw new CatalogError(`world premieres failed: ${error.message}`, 500);
          return hydrateSlim((data ?? []) as SlimTitleRow[], signal, 'upcoming');
        }
        if (sort === 'top') {
          const { data, error } = await supabase!.rpc('top_rated_titles', { p_world: fandom, p_limit: page * 24 }).abortSignal(signal!);
          if (error) throw new CatalogError(`world top rated failed: ${error.message}`, 500);
          const items = ((data ?? []) as TitleRow[]).map(toDrama).filter(isValidWorldDrama);
          const from = (page - 1) * 24;
          return items.slice(from, from + 24);
        }
        const { data, error } = await supabase!
          .rpc('browse_titles', {
            p_genre: null,
            p_provider: null,
            p_world: fandom,
            p_sort: 'popular',
            p_limit: 24,
            p_offset: (page - 1) * 24,
          })
          .abortSignal(signal!);
        if (error) throw new CatalogError(`world browse failed: ${error.message}`, 500);
        return ((data ?? []) as TitleRow[]).map(toDrama).filter(isValidWorldDrama);
      }),
    );
  },

  crossFandom(anchor, signal) {
    return call('cross-fandom', (signal) =>
      memo(`cross:${anchor.fandom}:${anchor.genres.slice(0, 3).join('|')}`, async () => {
        const others = FANDOMS.filter((f) => f.id !== anchor.fandom);
        const picks = await Promise.all(
          others.map(async (world) => {
            const { data, error } = await supabase!
              .rpc('browse_titles', {
                p_genre: null,
                p_provider: null,
                p_world: world.id,
                p_sort: 'popular',
                p_limit: 24,
                p_offset: 0,
              })
              .abortSignal(signal!);
            if (error) return [];
            const overlap = (d: Drama) => d.genres.filter((g) => anchor.genres.includes(g)).length;
            return ((data ?? []) as TitleRow[])
              .map(toDrama)
              .filter(isValidWorldDrama)
              .sort((a, b) => overlap(b) - overlap(a) || b.followerCount - a.followerCount)
              .slice(0, 3)
              .map((drama) => ({ drama, world, shared: drama.genres.filter((g) => anchor.genres.includes(g)) }));
          }),
        );
        return picks.flat();
      }),
    );
  },

  trendingPeople(signal) {
    return call('trending-people', (signal) =>
      memo('people', async () => {
        const { data, error } = await supabase!
          .from('people')
          .select('*')
          .not('photo_url', 'is', null)
          .order('follower_count', { ascending: false, nullsFirst: false })
          .order('known_for_count', { ascending: false, nullsFirst: false })
          .limit(20)
          .abortSignal(signal!);
        if (error) throw new CatalogError(`people failed: ${error.message}`, 500);
        return ((data ?? []) as (PersonRow & { external_id: string })[]).map((r) => toActor(r, r.external_id));
      }),
    );
  },

  recommendations(providerId, media = 'tv', signal) {
    return call('recommendations', (signal) =>
      memo(`recs:${media}:${providerId}`, async () => {
        const row = await titleRowByProviderId(providerId, media, signal);
        if (!row) return [];
        const { data, error } = await supabase!.rpc('get_title_discovery', { p_title_id: row.id }).abortSignal(signal!);
        if (error) throw new CatalogError(`recommendations failed: ${error.message}`, 500);
        return hydrateSlim(((data as DiscoveryPayload | null)?.similar ?? []) as SlimTitleRow[], signal);
      }),
    );
  },
};
