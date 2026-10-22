// Hallyu — catalog sync function.
//
// The only thing in the system allowed to talk to the catalog provider. Runs on a schedule and on
// operator request, writes normalized records through `public.catalog_upsert_*`, records every run
// in `public.catalog_sync_runs`, and never runs concurrently with itself (`catalog_begin_run`
// guards run state via idempotency keys).
//
// Invocation (service role only):
//   POST /functions/v1/catalog-sync   { "job": "trending" }
//   POST /functions/v1/catalog-sync   { "job": "discover", "world": "kdrama", "pages": 2 }
//   POST /functions/v1/catalog-sync   { "job": "refresh",  "limit": 48 }
//   POST /functions/v1/catalog-sync   { "job": "detail",   "title_id": "<uuid>" }
//   POST /functions/v1/catalog-sync   { "job": "seasons",  "title_id": "<uuid>", "season": 1 }

import { adminClient, type AdminClient, requireServiceRole } from '../_shared/supabase.ts';
import { corsHeaders, errorResponse, jsonResponse } from '../_shared/cors.ts';
import {
  activeSeasonNumber,
  type CatalogWorld,
  normalizeCredits,
  normalizeSeason,
  normalizeTitle,
  tmdb,
  tmdbConfigured,
  type TmdbCredits,
  type TmdbDetail,
  TmdbError,
  type TmdbListItem,
  type TmdbSeason,
  WORLD_IDS,
  worldFor,
} from '../_shared/tmdb.ts';

type Job = 'trending' | 'discover' | 'refresh' | 'detail' | 'seasons';

interface SyncRequest {
  job?: Job;
  world?: CatalogWorld;
  pages?: number;
  limit?: number;
  title_id?: string;
  season?: number;
}

interface RunResult {
  run_id: string | null;
  job: Job;
  items_seen: number;
  items_written: number;
  items_unchanged: number;
  items_missing: number;
  provider_requests: number;
  duration_ms: number;
  error?: string;
}

function isoOffsetDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Full lifecycle coverage per world across TV & Movies:
 *  - Popular TV & Movies
 *  - Currently On-The-Air TV (active weekly broadcast schedule)
 *  - Upcoming TV Premieres & Upcoming Movie Releases (future release dates)
 *  - Top Rated TV & Movies (Bayesian discovery seed)
 */
function feedsForWorld(
  world: CatalogWorld,
): { path: string; mediaType: 'tv' | 'movie'; query: Record<string, string | number> }[] {
  const airingStart = isoOffsetDays(-14);
  const airingEnd = isoOffsetDays(21);
  const today = isoOffsetDays(0);
  const tomorrow = isoOffsetDays(1);
  const upcomingHorizon = isoOffsetDays(270);
  const scriptedTvFilter = '10763,10764,10767,10766';
  const liveActionTvFilter = '16,10763,10764,10767,10766';

  switch (world) {
    case 'kdrama':
      return [
        { path: 'discover/tv', mediaType: 'tv', query: { with_origin_country: 'KR', with_original_language: 'ko', without_genres: liveActionTvFilter, sort_by: 'popularity.desc' } },
        { path: 'discover/tv', mediaType: 'tv', query: { with_origin_country: 'KR', with_original_language: 'ko', without_genres: liveActionTvFilter, 'air_date.gte': airingStart, 'air_date.lte': airingEnd, 'first_air_date.lte': today, sort_by: 'popularity.desc' } },
        { path: 'discover/tv', mediaType: 'tv', query: { with_origin_country: 'KR', with_original_language: 'ko', without_genres: liveActionTvFilter, 'first_air_date.gte': tomorrow, 'first_air_date.lte': upcomingHorizon, sort_by: 'popularity.desc' } },
        { path: 'discover/tv', mediaType: 'tv', query: { with_origin_country: 'KR', with_original_language: 'ko', without_genres: liveActionTvFilter, sort_by: 'vote_average.desc', 'vote_count.gte': 100 } },
        { path: 'discover/movie', mediaType: 'movie', query: { with_origin_country: 'KR', with_original_language: 'ko', sort_by: 'popularity.desc' } },
        { path: 'discover/movie', mediaType: 'movie', query: { with_origin_country: 'KR', with_original_language: 'ko', 'primary_release_date.gte': tomorrow, 'primary_release_date.lte': upcomingHorizon, sort_by: 'popularity.desc' } },
        { path: 'discover/movie', mediaType: 'movie', query: { with_origin_country: 'KR', with_original_language: 'ko', sort_by: 'vote_average.desc', 'vote_count.gte': 150 } },
      ];
    case 'cdrama':
      return [
        { path: 'discover/tv', mediaType: 'tv', query: { with_origin_country: 'CN|TW|HK', with_original_language: 'zh', without_genres: liveActionTvFilter, sort_by: 'popularity.desc' } },
        { path: 'discover/tv', mediaType: 'tv', query: { with_origin_country: 'CN|TW|HK', with_original_language: 'zh', without_genres: liveActionTvFilter, 'air_date.gte': airingStart, 'air_date.lte': airingEnd, 'first_air_date.lte': today, sort_by: 'popularity.desc' } },
        { path: 'discover/tv', mediaType: 'tv', query: { with_origin_country: 'CN|TW|HK', with_original_language: 'zh', without_genres: liveActionTvFilter, 'first_air_date.gte': tomorrow, 'first_air_date.lte': upcomingHorizon, sort_by: 'popularity.desc' } },
        { path: 'discover/tv', mediaType: 'tv', query: { with_origin_country: 'CN|TW|HK', with_original_language: 'zh', without_genres: liveActionTvFilter, sort_by: 'vote_average.desc', 'vote_count.gte': 50 } },
        { path: 'discover/movie', mediaType: 'movie', query: { with_origin_country: 'CN|HK|TW', sort_by: 'popularity.desc' } },
        { path: 'discover/movie', mediaType: 'movie', query: { with_origin_country: 'CN|HK|TW', 'primary_release_date.gte': tomorrow, 'primary_release_date.lte': upcomingHorizon, sort_by: 'popularity.desc' } },
        { path: 'discover/movie', mediaType: 'movie', query: { with_origin_country: 'CN|HK|TW', sort_by: 'vote_average.desc', 'vote_count.gte': 100 } },
      ];
    case 'anime':
      return [
        { path: 'discover/tv', mediaType: 'tv', query: { with_origin_country: 'JP', with_genres: '16', without_genres: scriptedTvFilter, sort_by: 'popularity.desc' } },
        { path: 'discover/tv', mediaType: 'tv', query: { with_origin_country: 'JP', with_genres: '16', without_genres: scriptedTvFilter, 'air_date.gte': airingStart, 'air_date.lte': airingEnd, 'first_air_date.lte': today, sort_by: 'popularity.desc' } },
        { path: 'discover/tv', mediaType: 'tv', query: { with_origin_country: 'JP', with_genres: '16', without_genres: scriptedTvFilter, 'first_air_date.gte': tomorrow, 'first_air_date.lte': upcomingHorizon, sort_by: 'popularity.desc' } },
        { path: 'discover/tv', mediaType: 'tv', query: { with_origin_country: 'JP', with_genres: '16', without_genres: scriptedTvFilter, sort_by: 'vote_average.desc', 'vote_count.gte': 150 } },
        { path: 'discover/movie', mediaType: 'movie', query: { with_origin_country: 'JP', with_genres: '16', sort_by: 'popularity.desc' } },
        { path: 'discover/movie', mediaType: 'movie', query: { with_origin_country: 'JP', with_genres: '16', 'primary_release_date.gte': tomorrow, 'primary_release_date.lte': upcomingHorizon, sort_by: 'popularity.desc' } },
        { path: 'discover/movie', mediaType: 'movie', query: { with_origin_country: 'JP', with_genres: '16', sort_by: 'vote_average.desc', 'vote_count.gte': 200 } },
      ];
    case 'hollywood':
      return [
        { path: 'discover/tv', mediaType: 'tv', query: { with_origin_country: 'US|GB|CA|AU', with_original_language: 'en', without_genres: liveActionTvFilter, sort_by: 'popularity.desc' } },
        { path: 'discover/tv', mediaType: 'tv', query: { with_origin_country: 'US|GB|CA|AU', with_original_language: 'en', without_genres: liveActionTvFilter, 'air_date.gte': airingStart, 'air_date.lte': airingEnd, 'first_air_date.lte': today, sort_by: 'popularity.desc' } },
        { path: 'discover/tv', mediaType: 'tv', query: { with_origin_country: 'US|GB|CA|AU', with_original_language: 'en', without_genres: liveActionTvFilter, 'first_air_date.gte': tomorrow, 'first_air_date.lte': upcomingHorizon, sort_by: 'popularity.desc' } },
        { path: 'discover/tv', mediaType: 'tv', query: { with_origin_country: 'US|GB|CA|AU', with_original_language: 'en', without_genres: liveActionTvFilter, sort_by: 'vote_average.desc', 'vote_count.gte': 300 } },
        { path: 'discover/movie', mediaType: 'movie', query: { with_origin_country: 'US|GB|CA|AU', with_original_language: 'en', sort_by: 'popularity.desc' } },
        { path: 'discover/movie', mediaType: 'movie', query: { with_origin_country: 'US|GB|CA|AU', with_original_language: 'en', 'primary_release_date.gte': tomorrow, 'primary_release_date.lte': upcomingHorizon, sort_by: 'popularity.desc' } },
        { path: 'discover/movie', mediaType: 'movie', query: { with_origin_country: 'US|GB|CA|AU', with_original_language: 'en', sort_by: 'vote_average.desc', 'vote_count.gte': 500 } },
      ];
  }
}

async function syncWorldLists(
  supabase: AdminClient,
  world: CatalogWorld,
  pages: number,
  counter: { requests: number },
): Promise<{ seen: number; written: number }> {
  let seen = 0;
  let written = 0;

  for (const feed of feedsForWorld(world)) {
    for (let page = 1; page <= pages; page += 1) {
      counter.requests += 1;
      const list = await tmdb<{ results: TmdbListItem[] }>({
        path: feed.path,
        query: { ...feed.query, include_adult: 'false', page },
      });

      for (const item of list.results ?? []) {
        const mediaType =
          item.media_type === 'movie' || item.media_type === 'tv'
            ? item.media_type
            : feed.mediaType;
        if (!(item.name ?? item.title)) continue;

        const classified = worldFor(item, mediaType);
        if (!classified) continue;

        const payload = normalizeTitle(item as TmdbDetail, mediaType, classified);
        if (!payload.year) continue;

        seen += 1;
        const { data, error } = await supabase.rpc('catalog_upsert_title', {
          p_provider_id: 'tmdb',
          p_payload: payload,
        });
        if (error) throw new Error(`catalog_upsert_title: ${error.message}`);
        const row = Array.isArray(data) ? data[0] : data;
        if ((row as { written?: boolean } | null)?.written) written += 1;
      }
    }
  }

  return { seen, written };
}

type DueRow = { id: string; external_id: string; media_type: 'tv' | 'movie' };

const DETAIL_CONCURRENCY = 8;

async function enrichOneRecord(
  supabase: AdminClient,
  row: DueRow,
  counter: { requests: number },
): Promise<{ written: number; missing: number }> {
  let written = 0;

  try {
    counter.requests += 1;
    const creditsField = row.media_type === 'tv' ? 'aggregate_credits' : 'credits';
    const append =
      row.media_type === 'tv'
        ? `${creditsField},videos,watch/providers,season/1`
        : `${creditsField},videos,watch/providers`;

    const detail = await tmdb<
      TmdbDetail & {
        credits?: TmdbCredits;
        aggregate_credits?: TmdbCredits;
        'season/1'?: TmdbSeason;
      }
    >({
      path: `${row.media_type}/${row.external_id}`,
      query: { append_to_response: append },
    });

    const classified = worldFor(detail, row.media_type);
    if (!classified) {
      await supabase
        .from('titles')
        .update({ catalog_unavailable_at: new Date().toISOString() })
        .eq('id', row.id);
      return { written: 0, missing: 1 };
    }

    const payload = normalizeTitle(detail, row.media_type, classified);
    if (!payload.year) return { written: 0, missing: 0 };

    const { data, error } = await supabase.rpc('catalog_upsert_title', {
      p_provider_id: 'tmdb',
      p_payload: payload,
    });
    if (error) throw new Error(`catalog_upsert_title: ${error.message}`);
    const upserted = Array.isArray(data) ? data[0] : data;
    if ((upserted as { written?: boolean } | null)?.written) written += 1;

    const credits = normalizeCredits(detail.aggregate_credits ?? detail.credits ?? {});
    if (credits.length > 0) {
      const { error: creditError } = await supabase.rpc('catalog_upsert_title_people', {
        p_title_id: row.id,
        p_credits: credits,
      });
      if (creditError) throw new Error(`catalog_upsert_title_people: ${creditError.message}`);
    }

    if (row.media_type === 'tv') {
      const seasonOne = detail['season/1'];
      if (seasonOne?.episodes && seasonOne.episodes.length > 0) {
        const episodes = normalizeSeason(seasonOne);
        const { data: count, error: epError } = await supabase.rpc('catalog_upsert_episodes', {
          p_title_id: row.id,
          p_season: seasonOne.season_number ?? 1,
          p_episodes: episodes,
        });
        if (epError) throw new Error(`catalog_upsert_episodes: ${epError.message}`);
        written += Number(count ?? 0);
      }

      const activeSeason = activeSeasonNumber(detail);
      if (activeSeason > 1 && activeSeason <= 40) {
        try {
          counter.requests += 1;
          const active = await tmdb<TmdbSeason>({
            path: `tv/${row.external_id}/season/${activeSeason}`,
          });
          const episodes = normalizeSeason(active);
          if (episodes.length > 0) {
            const { data: count, error: epError } = await supabase.rpc('catalog_upsert_episodes', {
              p_title_id: row.id,
              p_season: activeSeason,
              p_episodes: episodes,
            });
            if (!epError) written += Number(count ?? 0);
          }
        } catch {
          // Best-effort if provider has no episode payload yet for an unscheduled future season.
        }
      }
    }

    return { written, missing: 0 };
  } catch (error) {
    if (error instanceof TmdbError && error.status === 404) {
      await supabase.rpc('catalog_mark_missing', {
        p_provider_id: 'tmdb',
        p_media_type: row.media_type,
        p_external_ids: [row.external_id],
      });
      return { written: 0, missing: 1 };
    }
    throw error;
  }
}

async function syncDetail(
  supabase: AdminClient,
  titleId: string,
  counter: { requests: number },
): Promise<number> {
  const { data: row, error } = await supabase
    .from('titles')
    .select('id, external_id, media_type')
    .eq('id', titleId)
    .single();
  if (error || !row) throw new Error(`title ${titleId} does not exist`);

  const outcome = await enrichOneRecord(supabase, row as DueRow, counter);
  return outcome.written;
}

async function syncSeason(
  supabase: AdminClient,
  titleId: string,
  seasonNumber: number,
  counter: { requests: number },
): Promise<number> {
  const { data: row, error } = await supabase
    .from('titles')
    .select('id, external_id, media_type')
    .eq('id', titleId)
    .single();
  if (error || !row) throw new Error(`title ${titleId} does not exist`);
  if ((row as { media_type: string }).media_type !== 'tv') return 0;

  counter.requests += 1;
  const season = await tmdb<TmdbSeason>({
    path: `tv/${(row as { external_id: string }).external_id}/season/${seasonNumber}`,
  });
  const episodes = normalizeSeason(season);
  const { data: count, error: upsertError } = await supabase.rpc('catalog_upsert_episodes', {
    p_title_id: titleId,
    p_season: seasonNumber,
    p_episodes: episodes,
  });
  if (upsertError) throw new Error(`catalog_upsert_episodes: ${upsertError.message}`);
  return Number(count ?? 0);
}

async function syncDueRecords(
  supabase: AdminClient,
  world: CatalogWorld | null,
  limit: number,
  counter: { requests: number },
): Promise<{ seen: number; written: number; missing: number }> {
  const { data: due, error: dueError } = await supabase.rpc('titles_needing_refresh', {
    p_world: world,
    p_limit: limit * 2,
  });
  if (dueError) throw new Error(`titles_needing_refresh: ${dueError.message}`);

  const dueRows = ((due ?? []) as { title_id: string; external_id: string; media_type: 'tv' | 'movie' }[])
    .map((d) => ({ id: d.title_id, external_id: d.external_id, media_type: d.media_type }));

  // Prioritize un-enriched rows missing provider status alongside stalest due rows.
  let unenrichedQuery = supabase
    .from('titles')
    .select('id, external_id, media_type, provider_data')
    .is('catalog_unavailable_at', null)
    .order('popularity', { ascending: false, nullsFirst: false })
    .limit(limit * 3);
  if (world) unenrichedQuery = unenrichedQuery.eq('world', world);
  const { data: extraRows } = await unenrichedQuery;

  const missingStatus = ((extraRows ?? []) as (DueRow & { provider_data?: { status?: string | null } | null })[])
    .filter((r) => !r.provider_data?.status)
    .map(({ id, external_id, media_type }) => ({ id, external_id, media_type }));

  const seenIds = new Set<string>();
  const candidates: DueRow[] = [];
  for (const r of [...missingStatus, ...dueRows]) {
    if (seenIds.has(r.id)) continue;
    seenIds.add(r.id);
    candidates.push(r);
    if (candidates.length >= limit) break;
  }

  let written = 0;
  let missing = 0;

  for (let i = 0; i < candidates.length; i += DETAIL_CONCURRENCY) {
    const batch = candidates.slice(i, i + DETAIL_CONCURRENCY);
    const results = await Promise.all(
      batch.map((row) => enrichOneRecord(supabase, row, counter)),
    );
    for (const r of results) {
      written += r.written;
      missing += r.missing;
    }
  }

  return { seen: candidates.length, written, missing };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return errorResponse('POST required', 405);

  const guard = requireServiceRole(request);
  if (!guard.ok) return guard.response;

  if (!tmdbConfigured()) {
    return jsonResponse(
      {
        configured: false,
        reason: 'TMDB_ACCESS_TOKEN or TMDB_API_KEY is not set in function secrets',
      },
      503,
    );
  }

  let body: SyncRequest;
  try {
    body = (await request.json()) as SyncRequest;
  } catch {
    body = {};
  }

  const job: Job = body.job ?? 'trending';
  const started = Date.now();
  const counter = { requests: 0 };
  const supabase = adminClient();

  const { data: runId, error: startError } = await supabase.rpc('catalog_begin_run', {
    p_job: job,
    p_provider_id: 'tmdb',
    p_idempotency_key: `${job}:${body.world ?? 'all'}:${new Date().toISOString().slice(0, 19)}`,
  });
  if (startError) return errorResponse(startError.message, 409);

  const result: RunResult = {
    run_id: (runId as string | null) ?? null,
    job,
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
          if (!WORLD_IDS.includes(world)) throw new Error(`unknown world ${world}`);
          const outcome = await syncWorldLists(supabase, world, pages, counter);
          result.items_seen += outcome.seen;
          result.items_written += outcome.written;
        }
        const enriched = await syncDueRecords(
          supabase,
          body.world ?? null,
          Math.min(Math.max(body.limit ?? 24, 1), 80),
          counter,
        );
        result.items_written += enriched.written;
        result.items_missing += enriched.missing;
        break;
      }

      case 'discover': {
        const pages = Math.min(Math.max(body.pages ?? 1, 1), 3);
        const worlds = body.world ? [body.world] : [...WORLD_IDS];
        for (const world of worlds) {
          if (!WORLD_IDS.includes(world)) throw new Error(`unknown world ${world}`);
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

    await supabase.rpc('job_reconcile_episode_schedule', { p_limit: 1000 });
    await supabase.rpc('job_reconcile_catalog_status', { p_limit: 1000 });
    await supabase.rpc('refresh_trending', { p_world: null });

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
