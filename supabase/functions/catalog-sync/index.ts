// catalog-sync — the TMDB ingest job across all four Hallyu worlds (K-Drama, C-Drama, Anime, Hollywood).
//
// Jobs supported (`{"job": "<name>", ...}`):
//
//   trending    discover current + upcoming + popular TV/movies across all 4 worlds, enrich due
//               titles with cast/episodes/streaming providers, and refresh Hallyu trending snapshots
//   discover    seed all 4 worlds from TMDB discover/tv, discover/movie and trending/all/week
//   refresh     enrich due records in parallel batches (credits -> people & title_people, seasons ->
//               title_episodes, watch/providers -> streaming_on, videos -> trailer_url)
//   detail      enrich one title's full record, seasons and cast
//   seasons     upsert the episode list for one season of a TV title

import { adminClient, requireServiceRole } from '../_shared/supabase.ts';
import { corsHeaders, errorResponse, jsonResponse } from '../_shared/cors.ts';
import {
  TmdbError,
  normalizeCredits,
  normalizeSeason,
  normalizeTitle,
  tmdb,
  tmdbConfigured,
  type TmdbSeason,
  type TmdbTitle,
} from '../_shared/tmdb.ts';

const DEFAULT_PROVIDER = Deno.env.get('CATALOG_PROVIDER_ID') ?? 'tmdb';
const WORLD_IDS = ['kdrama', 'cdrama', 'anime', 'hollywood'] as const;

interface PagedResult {
  page: number;
  results: TmdbTitle[];
  total_pages: number;
  total_results: number;
}

interface JobResult {
  job: string;
  provider: string;
  run_id: string;
  items_seen: number;
  items_written: number;
  items_unchanged: number;
  items_missing: number;
  provider_requests: number;
  duration_ms: number;
  error?: string;
}

function isoDaysFromToday(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;

  const runner = async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      out[idx] = await worker(items[idx]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runner()));
  return out;
}

interface WorldFeedSpec {
  path: string;
  mediaType?: 'tv' | 'movie';
  query: Record<string, string | number>;
}

function feedsForWorld(world: string): WorldFeedSpec[] {
  const recentWindow = isoDaysFromToday(-45);
  const futureWindow = isoDaysFromToday(180);

  switch (world) {
    case 'kdrama':
      return [
        {
          path: 'discover/tv',
          mediaType: 'tv',
          query: { with_original_language: 'ko', sort_by: 'popularity.desc', 'vote_count.gte': 5 },
        },
        {
          path: 'discover/tv',
          mediaType: 'tv',
          query: {
            with_original_language: 'ko',
            sort_by: 'popularity.desc',
            'air_date.gte': recentWindow,
            'air_date.lte': futureWindow,
          },
        },
        {
          path: 'discover/movie',
          mediaType: 'movie',
          query: { with_original_language: 'ko', sort_by: 'popularity.desc', 'vote_count.gte': 15 },
        },
      ];
    case 'cdrama':
      return [
        {
          path: 'discover/tv',
          mediaType: 'tv',
          query: { with_original_language: 'zh', sort_by: 'popularity.desc', 'vote_count.gte': 3 },
        },
        {
          path: 'discover/tv',
          mediaType: 'tv',
          query: {
            with_original_language: 'zh',
            sort_by: 'popularity.desc',
            'air_date.gte': recentWindow,
            'air_date.lte': futureWindow,
          },
        },
        {
          path: 'discover/movie',
          mediaType: 'movie',
          query: { with_original_language: 'zh', sort_by: 'popularity.desc', 'vote_count.gte': 10 },
        },
      ];
    case 'anime':
      return [
        {
          path: 'discover/tv',
          mediaType: 'tv',
          query: {
            with_original_language: 'ja',
            with_genres: '16',
            sort_by: 'popularity.desc',
            'vote_count.gte': 5,
          },
        },
        {
          path: 'discover/tv',
          mediaType: 'tv',
          query: {
            with_original_language: 'ja',
            with_genres: '16',
            sort_by: 'popularity.desc',
            'air_date.gte': recentWindow,
            'air_date.lte': futureWindow,
          },
        },
        {
          path: 'discover/movie',
          mediaType: 'movie',
          query: {
            with_original_language: 'ja',
            with_genres: '16',
            sort_by: 'popularity.desc',
            'vote_count.gte': 15,
          },
        },
      ];
    default:
      return [
        { path: 'trending/all/week', query: {} },
        {
          path: 'discover/tv',
          mediaType: 'tv',
          query: { with_original_language: 'en', sort_by: 'popularity.desc', 'vote_count.gte': 25 },
        },
        {
          path: 'discover/tv',
          mediaType: 'tv',
          query: {
            with_original_language: 'en',
            sort_by: 'popularity.desc',
            'air_date.gte': recentWindow,
            'air_date.lte': futureWindow,
          },
        },
      ];
  }
}

async function upsertTitle(
  supabase: ReturnType<typeof adminClient>,
  raw: TmdbTitle,
  mediaType: 'tv' | 'movie',
): Promise<{ id: string | null; written: boolean }> {
  const payload = normalizeTitle(raw, mediaType);
  const { data, error } = await supabase.rpc('catalog_upsert_title', {
    p_provider_id: DEFAULT_PROVIDER,
    p_payload: payload,
  });
  if (error) throw new Error(`catalog_upsert_title failed: ${error.message}`);
  const first = Array.isArray(data) ? data[0] : null;
  return { id: first?.id ?? null, written: Boolean(first?.written) };
}

async function syncWorldLists(
  supabase: ReturnType<typeof adminClient>,
  world: string,
  perFeedPages: number,
  counter: { requests: number },
): Promise<{ seen: number; written: number }> {
  const seen = new Set<string>();
  const toUpsert: { raw: TmdbTitle; mediaType: 'tv' | 'movie' }[] = [];

  for (const spec of feedsForWorld(world)) {
    for (let page = 1; page <= perFeedPages; page += 1) {
      counter.requests += 1;
      const response = await tmdb<PagedResult>({
        path: spec.path,
        query: { page, ...spec.query },
      });

      for (const raw of response.results ?? []) {
        if (!raw.poster_path && !raw.backdrop_path) continue;
        const mediaType = spec.mediaType ?? (raw.media_type === 'movie' ? 'movie' : 'tv');
        const key = `${mediaType}:${raw.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        toUpsert.push({ raw, mediaType });
      }

      if (page >= (response.total_pages ?? 1)) break;
    }
  }

  let written = 0;
  await mapConcurrent(toUpsert, 8, async ({ raw, mediaType }) => {
    const res = await upsertTitle(supabase, raw, mediaType);
    if (res.written) written += 1;
  });

  return { seen: seen.size, written };
}

async function syncSeason(
  supabase: ReturnType<typeof adminClient>,
  titleId: string,
  seasonNumber: number,
  counter: { requests: number },
): Promise<number> {
  const { data: row, error: readError } = await supabase
    .from('titles')
    .select('external_id')
    .eq('id', titleId)
    .single();

  if (readError || !row) throw new Error(`title ${titleId} not found: ${readError?.message}`);

  counter.requests += 1;
  const season = await tmdb<TmdbSeason>({
    path: `tv/${row.external_id}/season/${seasonNumber}`,
  });

  const { data, error } = await supabase.rpc('catalog_upsert_episodes', {
    p_title_id: titleId,
    p_season: seasonNumber,
    p_episodes: normalizeSeason(season),
  });
  if (error) throw new Error(`catalog_upsert_episodes failed: ${error.message}`);
  return typeof data === 'number' ? data : 0;
}

async function enrichOneRecord(
  supabase: ReturnType<typeof adminClient>,
  row: { title_id: string; external_id: string; media_type: 'tv' | 'movie' },
  counter: { requests: number },
  allSeasons = false,
): Promise<number> {
  counter.requests += 1;
  const append =
    row.media_type === 'tv'
      ? 'credits,watch/providers,videos,season/1'
      : 'credits,watch/providers,videos';

  const detail = await tmdb<TmdbTitle>({
    path: row.media_type === 'tv' ? `tv/${row.external_id}` : `movie/${row.external_id}`,
    query: { append_to_response: append },
  });

  let written = 0;
  const upserted = await upsertTitle(supabase, detail, row.media_type);
  if (upserted.written) written += 1;

  const creditItems = normalizeCredits(detail.credits);
  if (creditItems.length > 0) {
    const { data: creditRows, error: creditError } = await supabase.rpc(
      'catalog_upsert_title_people',
      {
        p_title_id: row.title_id,
        p_credits: creditItems,
      },
    );
    if (creditError) throw new Error(`catalog_upsert_title_people failed: ${creditError.message}`);
    written += typeof creditRows === 'number' ? creditRows : 0;
  }

  if (row.media_type === 'tv') {
    const embeddedSeason1 = detail['season/1'];
    if (embeddedSeason1?.episodes?.length) {
      const { data: epCount, error: epError } = await supabase.rpc('catalog_upsert_episodes', {
        p_title_id: row.title_id,
        p_season: 1,
        p_episodes: normalizeSeason(embeddedSeason1),
      });
      if (!epError && typeof epCount === 'number') written += epCount;
    }

    const totalSeasons = Math.min(detail.number_of_seasons ?? 1, allSeasons ? 12 : 2);
    if (allSeasons) {
      for (let season = 2; season <= totalSeasons; season += 1) {
        written += await syncSeason(supabase, row.title_id, season, counter);
      }
    } else if ((detail.number_of_seasons ?? 1) > 1) {
      const latestSeason = Math.min(detail.number_of_seasons ?? 2, 20);
      try {
        written += await syncSeason(supabase, row.title_id, latestSeason, counter);
      } catch {
        // Non-fatal if a future empty season returns 404.
      }
    }
  }

  return written;
}

async function syncDetail(
  supabase: ReturnType<typeof adminClient>,
  titleId: string,
  counter: { requests: number },
): Promise<number> {
  const { data: title, error: readError } = await supabase
    .from('titles')
    .select('id, external_id, media_type')
    .eq('id', titleId)
    .single();

  if (readError || !title) throw new Error(`title ${titleId} not found: ${readError?.message}`);

  return enrichOneRecord(
    supabase,
    {
      title_id: title.id as string,
      external_id: title.external_id as string,
      media_type: title.media_type as 'tv' | 'movie',
    },
    counter,
    true,
  );
}

async function syncDueRecords(
  supabase: ReturnType<typeof adminClient>,
  world: string | null,
  limit: number,
  counter: { requests: number },
): Promise<{ seen: number; written: number; missing: number }> {
  const { data: due, error } = await supabase.rpc('titles_needing_refresh', {
    p_world: world,
    p_limit: limit,
  });

  if (error) throw new Error(`titles_needing_refresh failed: ${error.message}`);

  // Also grab any titles that still have zero credits or zero episodes so recently discovered
  // rows get enriched immediately even when `catalog_synced_at` was set during list discovery.
  const rows = [...((due ?? []) as Array<{
    title_id: string;
    external_id: string;
    media_type: 'tv' | 'movie';
  }>)];

  if (rows.length < limit) {
    let query = supabase
      .from('titles')
      .select('id, external_id, media_type')
      .is('catalog_unavailable_at', null)
      .eq('streaming_on', '{}')
      .order('popularity', { ascending: false, nullsFirst: false })
      .limit(limit - rows.length);
    if (world) query = query.eq('world', world);
    const { data: unenriched } = await query;
    const existing = new Set(rows.map((r) => r.title_id));
    for (const u of unenriched ?? []) {
      const tid = u.id as string;
      if (existing.has(tid)) continue;
      existing.add(tid);
      rows.push({
        title_id: tid,
        external_id: u.external_id as string,
        media_type: u.media_type as 'tv' | 'movie',
      });
    }
  }

  let written = 0;
  let missing = 0;
  const missingByType: Record<'tv' | 'movie', string[]> = { tv: [], movie: [] };

  await mapConcurrent(rows, 6, async (row) => {
    try {
      written += await enrichOneRecord(supabase, row, counter, false);
    } catch (tmdbError) {
      if (tmdbError instanceof TmdbError && tmdbError.status === 404) {
        missingByType[row.media_type].push(row.external_id);
        missing += 1;
        return;
      }
      throw tmdbError;
    }
  });

  for (const mediaType of ['tv', 'movie'] as const) {
    if (missingByType[mediaType].length === 0) continue;
    const { error: markError } = await supabase.rpc('catalog_mark_missing', {
      p_provider_id: DEFAULT_PROVIDER,
      p_media_type: mediaType,
      p_external_ids: missingByType[mediaType],
    });
    if (markError) throw new Error(`catalog_mark_missing failed: ${markError.message}`);
  }

  return { seen: rows.length, written, missing };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const guard = requireServiceRole(request);
  if (!guard.ok) return guard.response;

  let body: {
    job?: string;
    world?: string;
    title_id?: string;
    season?: number;
    limit?: number;
    pages?: number;
  } = {};

  if (request.method === 'POST') {
    try {
      body = await request.json();
    } catch {
      // Empty body defaults to 'trending'.
    }
  }

  const job = body.job ?? 'trending';
  const started = Date.now();
  const counter = { requests: 0 };

  const supabase = adminClient();

  const { data: usable } = await supabase.rpc('catalog_provider_is_usable', {
    p_provider_id: DEFAULT_PROVIDER,
  });
  if (usable === false) {
    return errorResponse(`catalog provider ${DEFAULT_PROVIDER} is in backoff; skipping this run`, 429);
  }

  if (!tmdbConfigured()) {
    return errorResponse(
      'TMDB_ACCESS_TOKEN (or TMDB_API_KEY) must be set as a function secret before the catalog can be synced',
      503,
    );
  }

  const runKey = `${job}:${body.world ?? 'all'}:${new Date().toISOString().slice(0, 16)}`;

  const { data: runId, error: beginError } = await supabase.rpc('catalog_begin_run', {
    p_job: job,
    p_provider_id: DEFAULT_PROVIDER,
    p_idempotency_key: runKey,
  });
  if (beginError) return errorResponse(`could not start the run: ${beginError.message}`, 500);

  const result: JobResult = {
    job,
    provider: DEFAULT_PROVIDER,
    run_id: String(runId ?? ''),
    items_seen: 0,
    items_written: 0,
    items_unchanged: 0,
    items_missing: 0,
    provider_requests: 0,
    duration_ms: 0,
  };

  try {
    switch (job) {
      case 'trending': {
        const pages = Math.min(Math.max(body.pages ?? 1, 1), 3);
        const worlds = body.world ? [body.world] : [...WORLD_IDS];
        for (const world of worlds) {
          if (!WORLD_IDS.includes(world as (typeof WORLD_IDS)[number])) {
            throw new Error(`unknown world ${world}`);
          }
          const outcome = await syncWorldLists(supabase, world, pages, counter);
          result.items_seen += outcome.seen;
          result.items_written += outcome.written;
        }
        const enriched = await syncDueRecords(
          supabase,
          body.world ?? null,
          Math.min(Math.max(body.limit ?? 24, 1), 60),
          counter,
        );
        result.items_written += enriched.written;
        result.items_missing += enriched.missing;
        break;
      }

      case 'discover': {
        const pages = Math.min(Math.max(body.pages ?? 2, 1), 4);
        const worlds = body.world ? [body.world] : [...WORLD_IDS];
        for (const world of worlds) {
          if (!WORLD_IDS.includes(world as (typeof WORLD_IDS)[number])) {
            throw new Error(`unknown world ${world}`);
          }
          const outcome = await syncWorldLists(supabase, world, pages, counter);
          result.items_seen += outcome.seen;
          result.items_written += outcome.written;
        }
        break;
      }

      case 'refresh': {
        const outcome = await syncDueRecords(
          supabase,
          body.world ?? null,
          Math.min(Math.max(body.limit ?? 48, 1), 80),
          counter,
        );
        result.items_seen = outcome.seen;
        result.items_written = outcome.written;
        result.items_missing = outcome.missing;
        break;
      }

      case 'detail': {
        if (!body.title_id) throw new Error('detail requires a title_id');
        result.items_seen = 1;
        result.items_written = await syncDetail(supabase, body.title_id, counter);
        break;
      }

      case 'seasons': {
        if (!body.title_id) throw new Error('seasons requires a title_id');
        result.items_seen = 1;
        result.items_written = await syncSeason(supabase, body.title_id, body.season ?? 1, counter);
        break;
      }

      default:
        return errorResponse(`unknown job ${job}`, 400);
    }

    await supabase.rpc('refresh_trending', { p_window: '7 days', p_world: null });
    await supabase.rpc('job_reconcile_catalog_status', { p_limit: 500 });
    await supabase.rpc('job_reconcile_episode_schedule', { p_limit: 500 });

    result.items_unchanged = Math.max(0, result.items_seen - result.items_written);
    result.provider_requests = counter.requests;
    result.duration_ms = Date.now() - started;

    await supabase.rpc('catalog_finish_run', {
      p_run_id: result.run_id,
      p_status: 'succeeded',
      p_items_seen: result.items_seen,
      p_items_written: result.items_written,
      p_items_unchanged: result.items_unchanged,
      p_items_missing: result.items_missing,
    });

    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof TmdbError ? error.status : 500;

    result.error = message.slice(0, 400);
    result.duration_ms = Date.now() - started;
    result.provider_requests = counter.requests;

    await supabase.rpc('catalog_finish_run', {
      p_run_id: result.run_id,
      p_status: 'failed',
      p_items_seen: result.items_seen,
      p_items_written: result.items_written,
      p_items_unchanged: result.items_unchanged,
      p_items_missing: result.items_missing,
      p_error: message.slice(0, 400),
    });

    return jsonResponse(result, status === 429 ? 429 : 502);
  }
});
