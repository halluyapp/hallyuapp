// Hallyu Watch — Moviebox proxy (server-side only).
//
// Secrets (Supabase project secrets, never sent to the client):
//   MEGAN_API_KEY        upstream API key
//   WATCH_PLAYBACK_KEY   32+ char secret; derives the AES-GCM key that seals playback tokens
//
// Deployed with verify_jwt = false, because <video> elements cannot send an Authorization header.
// Therefore every POST action checks the caller's session itself (requireUser), and the media proxy
// accepts only a sealed playback token issued by the playback action.
//
// Actions (POST JSON, signed-in user or the service role):
//   { action: "home" | "trending" | "ranking" }
//   { action: "search", q, page }
//   { action: "detail", detailPath }
//   { action: "stream", subjectId, se?, ep? }        metadata only, no URLs
//   { action: "playback", subjectId, se?, ep?, quality? }
//        -> { playback_url, download_url, quality, format, duration_sec, size_mb, qualities, expires_at, ... }
// Media (GET): ?action=proxy&t=<sealed token>   (Range is forwarded; no other auth)

const BASE = 'https://apis.megan.qzz.io';
// Exact hosts only. bcdnxw.hakunaymatata.com serves the full-length Web CDN MP4s (verified 2026-10-25).
const ALLOWED_MEDIA_HOSTS = ['macdn.aoneroom.com', 'pbcdn.aoneroom.com', 'pbcdnw.aoneroom.com', 'bcdnxw.hakunaymatata.com'];
const ALLOWED_MEDIA_SUFFIX = '.aoneroom.com';
const TOKEN_TTL_SEC = 4 * 60 * 60;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, range',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'content-range, content-length, accept-ranges, content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

/** Removes upstream secrets and signed links from anything that goes back to the client. */
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

// ---------- session check ----------

async function requireUser(req: Request): Promise<boolean> {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7).trim();
  const serviceKey = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
  if (serviceKey && token === serviceKey) return true; // server-side callers only
  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anon) return false;
  try {
    const r = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: auth, apikey: anon } });
    return r.ok;
  } catch {
    return false;
  }
}

// ---------- sealed playback tokens (AES-GCM) ----------

const enc = new TextEncoder();
const dec = new TextDecoder();

async function aesKey(): Promise<CryptoKey | null> {
  const secret = (Deno.env.get('WATCH_PLAYBACK_KEY') ?? '').trim();
  if (secret.length < 32) return null;
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function b64uEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

interface TokenPayload {
  u: string; // upstream media URL (allowlisted)
  dl: boolean; // download mode
  exp: number; // unix seconds
}

async function sealToken(p: TokenPayload): Promise<string | null> {
  const key = await aesKey();
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(p))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64uEncode(out);
}

async function openToken(t: string): Promise<TokenPayload | null> {
  const key = await aesKey();
  if (!key || !t || t.length > 4096) return null;
  try {
    const raw = b64uDecode(t);
    const iv = raw.slice(0, 12);
    const ct = raw.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    const p = JSON.parse(dec.decode(pt)) as TokenPayload;
    if (typeof p.u !== 'string' || typeof p.exp !== 'number' || typeof p.dl !== 'boolean') return null;
    return p;
  } catch {
    return null; // tampered or wrong key
  }
}

// ---------- upstream ----------

async function upstream(path: string, params: Record<string, string>, key: string): Promise<{ ok: true; body: any } | { ok: false; status: number }> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('api_key', key);
  // One retry for network errors and 5xx responses.
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.ok || res.status < 500) break;
    } catch {
      res = null;
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }
  if (!res) return { ok: false, status: 502 };
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

/**
 * Full-length test. A stream qualifies only when it is not a "Mobile Native" preview, its duration is
 * known and over 5 minutes, and its size (when reported) is over 50 MB. Quality labels are not trusted.
 */
function isFullStream(s: { source: string | null; duration_sec: number | null; size_mb: number | null }): boolean {
  if ((s.source ?? '').toLowerCase().includes('mobile native')) return false;
  if (s.duration_sec === null || s.duration_sec <= 300) return false;
  if (s.size_mb !== null && s.size_mb <= 50) return false;
  return true;
}

/** Progressive MP4 before DASH, then higher quality first. */
function compareStreams(a: { format: string | null; quality_value: number | null }, b: { format: string | null; quality_value: number | null }): number {
  const fa = (a.format ?? '').toUpperCase() === 'MP4' ? 0 : 1;
  const fb = (b.format ?? '').toUpperCase() === 'MP4' ? 0 : 1;
  if (fa !== fb) return fa - fb;
  return (b.quality_value ?? 0) - (a.quality_value ?? 0);
}

interface Candidate {
  url: string;
  source: string | null;
  quality: string | null;
  format: string | null;
  codec: string | null;
  size_mb: number | null;
  duration_sec: number | null;
  quality_value: number | null;
}

type StreamLoad = { ok: true; subject_id: string; season: number | null; episode: number | null; available_formats: unknown; diagnostics: unknown[]; candidates: Candidate[] } | { ok: false; status: number; body: unknown };

/** Loads upstream streams for a subject and applies the full-length rule. Shared by stream and playback. */
async function loadStreams(input: Record<string, unknown>, key: string): Promise<StreamLoad> {
  const subjectId = validId(input.subjectId);
  if (!subjectId) return { ok: false, status: 400, body: { error: 'bad_request' } };
  const params: Record<string, string> = { subjectId };
  if (input.se !== undefined) params.se = String(intParam(input.se, 0, 99, 0));
  if (input.ep !== undefined) params.ep = String(intParam(input.ep, 0, 999, 0));
  const r = await upstream('/api/v2/moviebox/stream', params, key);
  if (!r.ok) return { ok: false, status: r.status, body: { error: 'upstream_error', status: r.status } };
  const sd = r.body?.data;
  const data = sd && typeof sd === 'object' && sd.status === true ? (sd as Record<string, unknown>) : undefined;
  if (!data) return { ok: false, status: 502, body: { error: 'unexpected_shape' } };
  const raw = (Array.isArray(data.streams) ? data.streams : []).map((s) => (s && typeof s === 'object' ? (s as Record<string, unknown>) : {}));
  // Metadata for every upstream candidate, including ones on hosts we do not play from. No URLs or headers.
  const diagnostics = raw.map((s) => {
    const url = typeof s.url === 'string' ? s.url : '';
    let host: string | null = null;
    try {
      host = url ? new URL(url).hostname : null;
    } catch {
      host = null;
    }
    const row = {
      host,
      source: typeof s.source === 'string' ? s.source : null,
      format: typeof s.format === 'string' ? s.format : null,
      quality: typeof s.quality === 'string' ? s.quality : null,
      duration_sec: typeof s.duration_sec === 'number' ? s.duration_sec : null,
      size_mb: typeof s.size_mb === 'number' ? s.size_mb : null,
      host_allowed: url ? isAllowedMediaUrl(url) !== null : false,
    };
    return { ...row, full: isFullStream(row) };
  });
  const candidates: Candidate[] = raw
    .filter((s) => typeof s.url === 'string' && isAllowedMediaUrl(s.url as string) !== null)
    .map((s) => ({
      url: s.url as string,
      source: typeof s.source === 'string' ? s.source : null,
      quality: typeof s.quality === 'string' ? s.quality : null,
      format: typeof s.format === 'string' ? s.format : null,
      codec: typeof s.codec === 'string' ? s.codec : null,
      size_mb: typeof s.size_mb === 'number' ? s.size_mb : null,
      duration_sec: typeof s.duration_sec === 'number' ? s.duration_sec : null,
      quality_value: typeof s.quality_value === 'number' ? s.quality_value : null,
    }))
    .filter(isFullStream)
    .sort(compareStreams);
  if (candidates.length === 0) {
    return { ok: false, status: 404, body: { error: 'no_full_stream', subject_id: subjectId, diagnostics } };
  }
  return {
    ok: true,
    subject_id: subjectId,
    season: typeof data.season === 'number' ? data.season : null,
    episode: typeof data.episode === 'number' ? data.episode : null,
    available_formats: scrub(data.available_formats ?? []),
    diagnostics,
    candidates,
  };
}

function publicCandidate(c: Candidate) {
  return { source: c.source, quality: c.quality, format: c.format, codec: c.codec, size_mb: c.size_mb, duration_sec: c.duration_sec };
}

async function handlePlayback(input: Record<string, unknown>, baseUrl: string): Promise<Response> {
  if (!(await aesKey())) return json({ error: 'not_configured', detail: 'WATCH_PLAYBACK_KEY secret is not set' }, 503);
  const set = await loadStreams(input, (Deno.env.get('MEGAN_API_KEY') ?? '').trim());
  if (!set.ok) return json(set.body, set.status);
  const want = typeof input.quality === 'string' ? input.quality : null;
  const pick = (want ? set.candidates.find((c) => c.quality === want) : undefined) ?? set.candidates[0];
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const playToken = await sealToken({ u: pick.url, dl: false, exp });
  const dlToken = await sealToken({ u: pick.url, dl: true, exp });
  if (!playToken || !dlToken) return json({ error: 'not_configured' }, 503);
  const qualities = [...new Set(set.candidates.map((c) => c.quality).filter((q): q is string => !!q))];
  return json({
    subject_id: set.subject_id,
    season: set.season,
    episode: set.episode,
    playback_url: `${baseUrl}?action=proxy&t=${playToken}`,
    download_url: `${baseUrl}?action=proxy&t=${dlToken}`,
    quality: pick.quality,
    format: pick.format,
    duration_sec: pick.duration_sec,
    size_mb: pick.size_mb,
    qualities,
    expires_at: exp * 1000,
  });
}

async function handleMedia(req: Request): Promise<Response> {
  const t = new URL(req.url).searchParams.get('t') ?? '';
  const p = await openToken(t);
  if (!p) return json({ error: 'bad_token' }, 403);
  if (p.exp * 1000 < Date.now()) return json({ error: 'expired' }, 401);
  const target = isAllowedMediaUrl(p.u);
  if (!target) return json({ error: 'host_not_allowed' }, 403);
  const key = (Deno.env.get('MEGAN_API_KEY') ?? '').trim();
  if (!key) return json({ error: 'not_configured' }, 503);

  const upstreamUrl = new URL(`${BASE}/api/v2/moviebox/proxy`);
  upstreamUrl.searchParams.set('url', target.toString());
  if (p.dl) upstreamUrl.searchParams.set('download', 'true');
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

  if (req.method === 'GET' && new URL(req.url).searchParams.get('action') === 'proxy') return handleMedia(req);
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  if (!(await requireUser(req))) return json({ error: 'unauthorized' }, 401);

  const key = (Deno.env.get('MEGAN_API_KEY') ?? '').trim();
  if (!key) return json({ error: 'not_configured', detail: 'MEGAN_API_KEY secret is not set' }, 503);

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
      const set = await loadStreams(input, key);
      if (!set.ok) return json(set.body, set.status);
      return json({
        subject_id: set.subject_id,
        season: set.season,
        episode: set.episode,
        available_formats: set.available_formats,
        preview_streams_dropped: set.diagnostics.length - set.candidates.length,
        diagnostics: set.diagnostics,
        streams: set.candidates.map(publicCandidate),
      });
    }

    case 'playback': {
      // Built from SUPABASE_URL: inside the runtime req.url is not the public URL (no /functions/v1 prefix).
      const origin = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
      if (!origin) return json({ error: 'not_configured' }, 503);
      return handlePlayback(input, `${origin}/functions/v1/moviebox`);
    }

    default:
      return json({ error: 'unknown_action' }, 400);
  }
});
