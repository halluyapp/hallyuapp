// Hallyu Watch — Moviebox proxy (server-side only).
//
// The Megan key lives in the MEGAN_API_KEY secret and is used only here. It is never returned to the
// client, never logged, and every response is scrubbed of api_key and upstream proxy_url fields.
//
// Upstream routes used (verified against the live API before this function was written):
//   /api/v2/moviebox/home, /trending, /ranking, /detail?detailPath=, /stream?subjectId=&se=&ep=,
//   /proxy?url=&download=, and /api/v2/search/moviebox?q=
//
// The media proxy is an allowlist, not an open proxy: the target must be https and on a trusted
// Moviebox CDN host. Any other host is refused with 403 before any upstream request is made.
//
// Requires a signed-in user (verify_jwt = true at deploy time).
//
// Requests:
//   POST JSON { "action": "home" | "trending" | "ranking" }
//   POST JSON { "action": "search", "q": "squid game", "page": 1 }
//   POST JSON { "action": "detail", "detailPath": "lupin-english-UqNLZqu3DD" }
//   POST JSON { "action": "stream", "subjectId": "536473933005177184", "se": 1, "ep": 1 }
//   GET  ?action=proxy&u=<https url>&download=0|1   (Range header forwarded; allowlisted hosts only)

const BASE = 'https://apis.megan.qzz.io';
const ALLOWED_MEDIA_HOSTS = ['macdn.aoneroom.com', 'pbcdn.aoneroom.com', 'pbcdnw.aoneroom.com'];
const ALLOWED_MEDIA_SUFFIX = '.aoneroom.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, range',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'content-range, content-length, accept-ranges, content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

/** Removes upstream secrets and signed proxy links from anything that goes back to the client. */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'proxy_url' || k === 'api_key' || k === 'apiKey') continue;
      out[k] = scrub(v);
    }
    return out;
  }
  if (typeof value === 'string' && /api_key=/i.test(value)) return undefined;
  return value;
}

function isAllowedMediaUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || (url.port && url.port !== '443')) return null;
  const host = url.hostname.toLowerCase();
  const ok = ALLOWED_MEDIA_HOSTS.includes(host) || (host.endsWith(ALLOWED_MEDIA_SUFFIX) && host.length > ALLOWED_MEDIA_SUFFIX.length);
  return ok ? url : null;
}

async function upstream(path: string, params: Record<string, string>, key: string): Promise<{ ok: true; body: any } | { ok: false; status: number }> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('api_key', key);
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    return { ok: false, status: 502 };
  }
  if (!res.ok) return { ok: false, status: res.status === 429 ? 429 : 502 };
  try {
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false, status: 502 };
  }
}

/** The verified envelope is body.data.result.data. Everything else is an error. */
function envelopeData(body: any): unknown {
  const ok = body?.data?.status === true && body?.data?.result?.code === 0;
  return ok ? body.data.result.data : undefined;
}

function validId(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9]{6,25}$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

function validDetailPath(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9-]{3,120}$/.test(value) ? value : null;
}

function intParam(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

async function handleMedia(req: Request, key: string): Promise<Response> {
  const u = new URL(req.url).searchParams;
  const target = isAllowedMediaUrl(u.get('u') ?? '');
  if (!target) return json({ error: 'host_not_allowed' }, 403);

  const params: Record<string, string> = { url: target.toString() };
  if (u.get('download') === '1') params.download = 'true';
  const upstreamUrl = new URL(`${BASE}/api/v2/moviebox/proxy`);
  for (const [k, v] of Object.entries(params)) upstreamUrl.searchParams.set(k, v);
  upstreamUrl.searchParams.set('api_key', key);

  const headers: Record<string, string> = {};
  const range = req.headers.get('range');
  if (range && /^bytes=\d*-\d*$/.test(range)) headers.Range = range;

  let res: Response;
  try {
    res = await fetch(upstreamUrl, { headers });
  } catch {
    return json({ error: 'upstream_unreachable' }, 502);
  }
  if (!res.ok && res.status !== 206) return json({ error: 'upstream_error', status: res.status }, res.status === 429 ? 429 : 502);

  const out: Record<string, string> = { ...corsHeaders };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition']) {
    const v = res.headers.get(h);
    if (v) out[h] = v;
  }
  return new Response(res.body, { status: res.status, headers: out });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const key = (Deno.env.get('MEGAN_API_KEY') ?? '').trim();
  if (!key) return json({ error: 'not_configured', detail: 'MEGAN_API_KEY secret is not set' }, 503);

  if (req.method === 'GET' && new URL(req.url).searchParams.get('action') === 'proxy') return handleMedia(req, key);
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let input: Record<string, unknown>;
  try {
    input = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  switch (input.action) {
    case 'home':
    case 'trending':
    case 'ranking': {
      const r = await upstream(`/api/v2/moviebox/${input.action}`, {}, key);
      if (!r.ok) return json({ error: 'upstream_error', status: r.status }, r.status);
      const data = envelopeData(r.body);
      return data === undefined ? json({ error: 'unexpected_shape' }, 502) : json({ data: scrub(data) });
    }

    case 'search': {
      const q = typeof input.q === 'string' ? input.q.trim().slice(0, 120) : '';
      if (q.length < 2) return json({ error: 'query_too_short' }, 400);
      const r = await upstream('/api/v2/search/moviebox', { q, page: String(intParam(input.page, 1, 50, 1)) }, key);
      if (!r.ok) return json({ error: 'upstream_error', status: r.status }, r.status);
      const data = envelopeData(r.body);
      return data === undefined ? json({ error: 'unexpected_shape' }, 502) : json({ data: scrub(data) });
    }

    case 'detail': {
      const detailPath = validDetailPath(input.detailPath);
      if (!detailPath) return json({ error: 'bad_request' }, 400);
      const r = await upstream('/api/v2/moviebox/detail', { detailPath }, key);
      if (!r.ok) return json({ error: 'upstream_error', status: r.status }, r.status);
      const data = envelopeData(r.body);
      return data === undefined ? json({ error: 'unexpected_shape' }, 502) : json({ data: scrub(data) });
    }

    case 'stream': {
      const subjectId = validId(input.subjectId);
      if (!subjectId) return json({ error: 'bad_request' }, 400);
      const params: Record<string, string> = { subjectId };
      if (input.se !== undefined) params.se = String(intParam(input.se, 0, 99, 0));
      if (input.ep !== undefined) params.ep = String(intParam(input.ep, 0, 999, 0));
      const r = await upstream('/api/v2/moviebox/stream', params, key);
      if (!r.ok) return json({ error: 'upstream_error', status: r.status }, r.status);
      // Stream payloads sit directly at body.data (streams[], available_formats[], status boolean).
      const sd = r.body?.data;
      const data = sd && typeof sd === 'object' && sd.status === true ? (sd as Record<string, unknown>) : undefined;
      if (!data) return json({ error: 'unexpected_shape' }, 502);
      // Only direct links on allowlisted hosts are returned. Anything else is dropped.
      const streams = (Array.isArray(data.streams) ? data.streams : [])
        .map((s) => s as Record<string, unknown>)
        .filter((s) => typeof s.url === 'string' && isAllowedMediaUrl(s.url as string) !== null)
        .map((s) => ({
          url: s.url as string,
          quality: typeof s.quality === 'string' ? s.quality : null,
          format: typeof s.format === 'string' ? s.format : null,
          codec: typeof s.codec === 'string' ? s.codec : null,
          size_mb: typeof s.size_mb === 'number' ? s.size_mb : null,
          duration_sec: typeof s.duration_sec === 'number' ? s.duration_sec : null,
          quality_value: typeof s.quality_value === 'number' ? s.quality_value : null,
          required_headers: scrub(s.required_headers ?? {}),
        }));
      return json({
        subject_id: subjectId,
        season: typeof data.season === 'number' ? data.season : null,
        episode: typeof data.episode === 'number' ? data.episode : null,
        available_formats: scrub(data.available_formats ?? []),
        streams,
      });
    }

    default:
      return json({ error: 'unknown_action' }, 400);
  }
});
