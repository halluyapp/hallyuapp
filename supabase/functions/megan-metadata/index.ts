// Hallyu — Megan metadata proxy (server-side only).
//
// Metadata for search, title details and season/episode runtimes, used as a cross-check against the
// primary catalog (TMDB). This function is the ONLY place the Megan key is used. The key lives in the
// MEGAN_API_KEY secret and never reaches the app bundle.
//
// Scope is deliberately narrow. Only these upstream paths are ever requested:
//   movies/search, movies/movie/{id}, movies/tv/{id}, movies/tv/{id}/season/{n}
// Stream and download endpoints are never called, and no request path is built from client input
// except validated numeric ids and the search query.
//
// Requires a signed-in user (verify_jwt = true at deploy time).
//
// Requests (POST JSON):
//   { "action": "search", "q": "pachinko" }
//   { "action": "movie", "id": 12345 }
//   { "action": "tv", "id": 12345 }
//   { "action": "season", "id": 12345, "season": 1 }
//   { "action": "runtime_check", "id": 12345, "season": 1, "tmdb": [{ "episode": 1, "runtime": 60 }] }

const BASE = 'https://apis.megan.qzz.io/api/v2/movies';
const TOLERANCE_MINUTES = 2;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function validId(value: unknown): number | null {
  const n = num(value);
  return n !== null && Number.isInteger(n) && n > 0 && n < 1e10 ? n : null;
}

async function megan(path: string, params: Record<string, string>, key: string): Promise<{ ok: true; data: unknown } | { ok: false; status: number }> {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('api_key', key);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return { ok: false, status: res.status };
  const body = (await res.json()) as { data?: unknown };
  return { ok: true, data: body.data ?? body };
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Season episodes with runtime, tolerant of the envelope shape. */
function episodesOf(data: unknown): { episode: number; runtime: number | null; air_date: string | null }[] {
  const root = (data ?? {}) as Record<string, unknown>;
  const list = Array.isArray(root.episodes) ? root.episodes : Array.isArray((root.season as Record<string, unknown>)?.episodes) ? ((root.season as Record<string, unknown>).episodes as unknown[]) : [];
  return list
    .map((e) => e as Record<string, unknown>)
    .map((e) => ({
      episode: num(e.episode_number ?? e.episode) ?? 0,
      runtime: num(e.runtime),
      air_date: typeof e.air_date === 'string' ? e.air_date : null,
    }))
    .filter((e) => e.episode > 0);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const key = (Deno.env.get('MEGAN_API_KEY') ?? '').trim();
  if (!key) return json({ error: 'not_configured', detail: 'MEGAN_API_KEY secret is not set' }, 503);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  try {
    switch (body.action) {
      case 'search': {
        const q = typeof body.q === 'string' ? body.q.trim().slice(0, 120) : '';
        if (q.length < 2) return json({ error: 'query_too_short' }, 400);
        const r = await megan('search', { q }, key);
        if (!r.ok) return json({ error: 'upstream', status: r.status }, 502);
        const items = Array.isArray(r.data) ? r.data : Array.isArray((r.data as Record<string, unknown>)?.results) ? ((r.data as Record<string, unknown>).results as unknown[]) : [];
        return json({
          results: items.map((i) => pick(i as Record<string, unknown>, ['id', 'slug', 'title', 'year', 'rating', 'poster'])),
        });
      }
      case 'movie':
      case 'tv': {
        const id = validId(body.id);
        if (!id) return json({ error: 'invalid_id' }, 400);
        const r = await megan(body.action === 'movie' ? `movie/${id}` : `tv/${id}`, {}, key);
        if (!r.ok) return json({ error: 'upstream', status: r.status }, 502);
        return json({ title: pick((r.data ?? {}) as Record<string, unknown>, ['id', 'slug', 'title', 'year', 'rating', 'genres', 'runtime', 'seasons', 'imdb_id']) });
      }
      case 'season': {
        const id = validId(body.id);
        const season = validId(body.season);
        if (!id || !season || season > 100) return json({ error: 'invalid_id' }, 400);
        const r = await megan(`tv/${id}/season/${season}`, {}, key);
        if (!r.ok) return json({ error: 'upstream', status: r.status }, 502);
        return json({ season, episodes: episodesOf(r.data) });
      }
      case 'runtime_check': {
        const id = validId(body.id);
        const season = validId(body.season);
        if (!id || !season || season > 100) return json({ error: 'invalid_id' }, 400);
        const tmdbRows = Array.isArray(body.tmdb) ? (body.tmdb as Record<string, unknown>[]).slice(0, 300) : [];
        const r = await megan(`tv/${id}/season/${season}`, {}, key);
        if (!r.ok) return json({ error: 'upstream', status: r.status }, 502);
        const meganByEpisode = new Map(episodesOf(r.data).map((e) => [e.episode, e.runtime]));
        const mismatches: { episode: number; tmdb: number; megan: number }[] = [];
        let compared = 0;
        for (const row of tmdbRows) {
          const ep = num(row.episode);
          const tmdbRuntime = num(row.runtime);
          const meganRuntime = ep !== null ? meganByEpisode.get(ep) : undefined;
          if (ep === null || tmdbRuntime === null || meganRuntime === undefined || meganRuntime === null) continue;
          compared += 1;
          if (Math.abs(tmdbRuntime - meganRuntime) > TOLERANCE_MINUTES) mismatches.push({ episode: ep, tmdb: tmdbRuntime, megan: meganRuntime });
        }
        return json({ compared, tolerance_minutes: TOLERANCE_MINUTES, agrees: mismatches.length === 0, mismatches });
      }
      default:
        return json({ error: 'unknown_action' }, 400);
    }
  } catch {
    return json({ error: 'upstream_unreachable' }, 502);
  }
});
