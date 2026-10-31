// Hallyu Watch — Moviebox proxy (server-side only). Upstream: the public zarhosting Moviebox API.
//
// Secrets (Supabase project secrets, never sent to the client):
//   WATCH_PLAYBACK_KEY   32+ char secret; derives the AES-GCM key that seals playback and caption links
//
// No provider key is needed for the upstream.
//
// Deployed with verify_jwt = false, because <video> elements cannot send an Authorization header.
// Therefore every POST action checks the caller's session itself (requireUser), and the media proxy
// accepts only a sealed token that this function minted from a URL returned by the upstream.
//
// Actions (POST JSON, signed-in user or the service role):
//   { action: "home" }                                     catalog rows
//   { action: "search", q, page? }                         catalog search
//   { action: "detail", detailPath }                       title + seasons
//   { action: "stream", subjectId, detailPath, se?, ep? }  metadata only, no URLs
//   { action: "playback", subjectId, detailPath, se?, ep?, quality?, fresh? }
//        -> { playback_url, download_url, quality, format, duration_sec, size_mb, qualities, expires_at, ... }
//   { action: "captions", subjectId, detailPath, se?, ep? } -> { data: [{ language, label, format, url }] }
//        (each caption url is a proxy link, so the app never talks to the CDN directly)
// Media (GET): ?action=proxy&t=<sealed token>   (Range is forwarded; no other auth)
//
// Movies use se=0 and ep=0. Series use the season and episode numbers. detail_path is required upstream.

const ZAR_BASE = 'https://movieapi.zarhosting.dpdns.org/api/public/v1';
const TOKEN_TTL_SEC = 4 * 60 * 60;
const META_TIMEOUT_MS = 8_000;
const MEDIA_TIMEOUT_MS = 15_000;
const MB = 1024 * 1024;
// Full-length rule: a source is kept when its duration is over 5 minutes OR its size is over 50 MB.
// A source that is short AND small (a preview) is dropped. Quality labels are never trusted on their own.
const FULL_MIN_SEC = 300;
const FULL_MIN_MB = 50;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, range',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'content-range, content-length, accept-ranges, content-type, content-disposition',
};

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

/** Exact https URL without credentials or a non-standard port. Anything else is refused. */
function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (u.port && u.port !== '443') return null;
    return u.toString();
  } catch {
    return null;
  }
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

/** Movies are requested as season 0, episode 0. Series pass their own season and episode. */
function seasonEpisode(input: Raw): { se: number; ep: number } | null {
  if (input.se === undefined && input.ep === undefined) return { se: 0, ep: 0 };
  const se = intParam(input.se, 0, 99, -1);
  const ep = intParam(input.ep, 0, 999, -1);
  return se < 0 || ep < 0 ? null : { se, ep };
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

// ---------- sealed tokens (AES-GCM) ----------

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
  u: string; // media URL, minted only from an upstream response
  dl: boolean; // download mode (sent as an attachment)
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
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    const p = JSON.parse(dec.decode(pt)) as TokenPayload;
    if (typeof p.u !== 'string' || typeof p.exp !== 'number' || typeof p.dl !== 'boolean') return null;
    return p;
  } catch {
    return null; // tampered or wrong key
  }
}

function proxyLink(token: string): string | null {
  const origin = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
  return origin ? `${origin}/functions/v1/moviebox?action=proxy&t=${token}` : null;
}

// ---------- caches ----------

// Catalog answers are short-lived; playback links are never cached beyond their own token.
const META_TTL_MS = 5 * 60_000;
const META_MAX_ENTRIES = 300;
const metaCache = new Map<string, { until: number; body: unknown }>();

function metaGet(key: string): unknown | undefined {
  const hit = metaCache.get(key);
  if (!hit) return undefined;
  if (hit.until <= Date.now()) {
    metaCache.delete(key);
    return undefined;
  }
  return hit.body;
}

function metaPut(key: string, body: unknown): void {
  if (metaCache.size >= META_MAX_ENTRIES) {
    const oldest = metaCache.keys().next().value;
    if (oldest !== undefined) metaCache.delete(oldest);
  }
  metaCache.set(key, { until: Date.now() + META_TTL_MS, body });
}

// Stream candidates hold their media URL, so they are kept only briefly and never sent to the client.
const CANDIDATE_TTL_MS = 60_000;
const CANDIDATE_MAX_ENTRIES = 100;
const candidateCache = new Map<string, { until: number; value: StreamSet }>();
const candidateInflight = new Map<string, Promise<StreamLoad>>();

// ---------- upstream (zarhosting) ----------

type ZarResult = { ok: true; body: any } | { ok: false; status: number };

/** One call with a bounded deadline. A transient failure is retried once; a 4xx is final. */
async function zar(path: string, params: Record<string, string>): Promise<ZarResult> {
  const url = new URL(`${ZAR_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let status = 502;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      status = res.status;
      if (res.ok) {
        try {
          return { ok: true, body: await res.json() };
        } catch {
          status = 502;
        }
      } else if (res.status < 500) {
        return { ok: false, status: res.status };
      }
    } catch {
      status = 502;
    } finally {
      clearTimeout(timer);
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: false, status };
}

/** A catalog item (home, search) in the shape the app reads: subjectId, title, cover.url, detailPath, ... */
function catalogItem(r: Raw): Raw | null {
  const subjectId = str(r.subject_id) ?? (typeof r.subject_id === 'number' ? String(r.subject_id) : null);
  const title = str(r.name) ?? str(r.base_title);
  if (!subjectId || !title) return null;
  const poster = safeHttpsUrl(r.poster_url);
  return {
    subjectId,
    title,
    cover: poster ? { url: poster } : null,
    genre: str(r.genre),
    releaseDate: str(r.release_date),
    imdbRatingValue: str(r.rating),
    detailPath: str(r.slug),
    countryName: str(r.country),
    type: str(r.type),
  };
}

// ---------- catalog actions ----------

async function actionHome(): Promise<Response> {
  const hit = metaGet('home');
  if (hit !== undefined) return json(hit);
  const r = await zar('/home', {});
  if (!r.ok) return json({ error: 'upstream_error', status: r.status }, 502);
  const sections = Array.isArray(r.body?.sections) ? r.body.sections : null;
  if (!sections) return json({ error: 'unexpected_shape' }, 502);
  const operatingList = sections
    .map((sec: unknown) => {
      const s = obj(sec);
      const subjects = (Array.isArray(s.items) ? s.items : []).map((it) => catalogItem(obj(it))).filter((x: Raw | null): x is Raw => x !== null);
      return { title: str(s.section), subjects };
    })
    .filter((row: { title: string | null; subjects: Raw[] }) => row.title !== null && row.subjects.length > 0);
  const body = { data: { operatingList } };
  metaPut('home', body);
  return json(body);
}

async function actionSearch(input: Raw): Promise<Response> {
  const q = typeof input.q === 'string' ? input.q.trim().slice(0, 120) : '';
  if (q.length < 2) return json({ error: 'query_too_short' }, 400);
  const page = intParam(input.page, 1, 50, 1);
  const cacheKey = `search|${q}|${page}`;
  const hit = metaGet(cacheKey);
  if (hit !== undefined) return json(hit);
  const r = await zar('/search', { q, page: String(page) });
  if (!r.ok) return json({ error: 'upstream_error', status: r.status }, 502);
  const items = (Array.isArray(r.body?.items) ? r.body.items : []).map((it: unknown) => catalogItem(obj(it))).filter((x: Raw | null): x is Raw => x !== null);
  const body = { data: { items, hasMore: r.body?.has_more === true } };
  metaPut(cacheKey, body);
  return json(body);
}

async function actionDetail(input: Raw): Promise<Response> {
  const detailPath = validDetailPath(input.detailPath);
  if (!detailPath) return json({ error: 'bad_request' }, 400);
  const cacheKey = `detail|${detailPath}`;
  const hit = metaGet(cacheKey);
  if (hit !== undefined) return json(hit);
  const r = await zar(`/detail/${detailPath}`, {});
  if (!r.ok) return json({ error: r.status === 404 ? 'not_found' : 'upstream_error', status: r.status }, r.status === 404 ? 404 : 502);
  const d = obj(r.body?.data);
  const s = obj(d.subject);
  const subjectId = str(s.subjectId);
  if (!subjectId || !str(s.title)) return json({ error: 'not_found' }, 404);
  const cover = safeHttpsUrl(obj(s.cover).url);
  const seasons = (Array.isArray(obj(d.resource).seasons) ? (obj(d.resource).seasons as unknown[]) : []).map((x) => ({
    se: num(obj(x).se) ?? 0,
    maxEp: num(obj(x).maxEp) ?? 0,
  }));
  const body = {
    data: {
      subject: {
        subjectId,
        title: str(s.title),
        description: str(s.description),
        releaseDate: str(s.releaseDate),
        genre: str(s.genre),
        countryName: str(s.countryName),
        imdbRatingValue: str(s.imdbRate),
        detailPath: str(s.detailPath) ?? detailPath,
        cover: cover ? { url: cover } : null,
      },
      resource: { seasons },
    },
  };
  metaPut(cacheKey, body);
  return json(body);
}

// ---------- stream resolution ----------

interface Candidate {
  url: string;
  source: string;
  quality: string | null;
  qualityValue: number | null;
  format: string | null;
  codec: string | null;
  sizeMb: number | null;
  durationSec: number | null;
}

interface StreamSet {
  subjectId: string;
  se: number;
  ep: number;
  diagnostics: Raw[];
  candidates: Candidate[];
}

type StreamLoad = { ok: true; value: StreamSet } | { ok: false; status: number; body: unknown };

/** Full-length rule, shared with the app's watchModel.ts. Keep the two in step. */
function isFullCandidate(durationSec: number | null, sizeMb: number | null): boolean {
  const longEnough = durationSec !== null && durationSec > FULL_MIN_SEC;
  const bigEnough = sizeMb !== null && sizeMb > FULL_MIN_MB;
  return longEnough || bigEnough;
}

/** Progressive MP4 first, then the higher quality. */
function compareCandidates(a: Candidate, b: Candidate): number {
  const fa = (a.format ?? '').toUpperCase() === 'MP4' ? 0 : 1;
  const fb = (b.format ?? '').toUpperCase() === 'MP4' ? 0 : 1;
  if (fa !== fb) return fa - fb;
  return (b.qualityValue ?? 0) - (a.qualityValue ?? 0);
}

function candidateFrom(src: Raw): Candidate | null {
  const url = safeHttpsUrl(src.url);
  if (!url) return null;
  const resolution = str(src.resolution);
  const qualityValue = resolution ? parseInt(resolution, 10) : NaN;
  const bytes = num(src.size);
  return {
    url,
    source: 'Moviebox',
    quality: resolution,
    qualityValue: Number.isFinite(qualityValue) ? qualityValue : null,
    format: str(src.format)?.toUpperCase() ?? null,
    codec: str(src.codec),
    sizeMb: bytes !== null ? Math.round((bytes / MB) * 100) / 100 : null,
    durationSec: num(src.duration),
  };
}

async function loadStreams(subjectId: string, detailPath: string, se: number, ep: number): Promise<StreamLoad> {
  const r = await zar(`/stream/${subjectId}`, { detail_path: detailPath, se: String(se), ep: String(ep) });
  if (!r.ok) return { ok: false, status: 502, body: { error: 'upstream_error', status: r.status } };
  const body = obj(r.body);
  if (body.has_resource !== true || !Array.isArray(body.sources)) {
    return { ok: false, status: 404, body: { error: 'no_full_stream', subject_id: subjectId, diagnostics: [] } };
  }
  const all = (body.sources as unknown[]).map((s) => candidateFrom(obj(s)));
  const sources = all.filter((c): c is Candidate => c !== null);
  // Metadata only: no host, no URL, no signature. The app learns what exists, never where it is served from.
  const diagnostics = sources.map((c) => {
    return {
      source: c.source,
      format: c.format,
      quality: c.quality,
      duration_sec: c.durationSec,
      size_mb: c.sizeMb,
      full: isFullCandidate(c.durationSec, c.sizeMb),
    };
  });
  const candidates = sources.filter((c) => isFullCandidate(c.durationSec, c.sizeMb)).sort(compareCandidates);
  if (candidates.length === 0) {
    return { ok: false, status: 404, body: { error: 'no_full_stream', subject_id: subjectId, diagnostics } };
  }
  return { ok: true, value: { subjectId, se, ep, diagnostics, candidates } };
}

async function loadStreamsCached(subjectId: string, detailPath: string, se: number, ep: number, fresh: boolean): Promise<StreamLoad> {
  const key = `${subjectId}|${detailPath}|${se}|${ep}`;
  if (!fresh) {
    const hit = candidateCache.get(key);
    if (hit && hit.until > Date.now()) return { ok: true, value: hit.value };
  }
  candidateCache.delete(key);
  const pending = candidateInflight.get(key);
  if (pending && !fresh) return pending;
  const request = loadStreams(subjectId, detailPath, se, ep)
    .then((result) => {
      if (result.ok) {
        if (candidateCache.size >= CANDIDATE_MAX_ENTRIES) {
          const oldest = candidateCache.keys().next().value;
          if (oldest !== undefined) candidateCache.delete(oldest);
        }
        candidateCache.set(key, { until: Date.now() + CANDIDATE_TTL_MS, value: result.value });
      }
      return result;
    })
    .finally(() => candidateInflight.delete(key));
  candidateInflight.set(key, request);
  return request;
}

function publicCandidate(c: Candidate) {
  return { source: c.source, quality: c.quality, quality_value: c.qualityValue, format: c.format, codec: c.codec, size_mb: c.sizeMb, duration_sec: c.durationSec };
}

async function actionStream(input: Raw): Promise<Response> {
  const subjectId = validId(input.subjectId);
  const detailPath = validDetailPath(input.detailPath);
  const se = seasonEpisode(input);
  if (!subjectId || !detailPath || !se) return json({ error: 'bad_request' }, 400);
  const set = await loadStreamsCached(subjectId, detailPath, se.se, se.ep, false);
  if (!set.ok) return json(set.body, set.status);
  return json({
    subject_id: set.value.subjectId,
    season: se.se,
    episode: se.ep,
    diagnostics: set.value.diagnostics,
    streams: set.value.candidates.map(publicCandidate),
  });
}

async function actionPlayback(input: Raw): Promise<Response> {
  const origin = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
  if (!origin) return json({ error: 'not_configured' }, 503);
  if (!(await aesKey())) return json({ error: 'not_configured', detail: 'WATCH_PLAYBACK_KEY secret is not set' }, 503);
  const subjectId = validId(input.subjectId);
  const detailPath = validDetailPath(input.detailPath);
  const se = seasonEpisode(input);
  if (!subjectId || !detailPath || !se) return json({ error: 'bad_request' }, 400);
  const set = await loadStreamsCached(subjectId, detailPath, se.se, se.ep, input.fresh === true);
  if (!set.ok) return json(set.body, set.status);
  const candidates = set.value.candidates;
  // Requested quality, then 360p (the data-saving default), then the lowest full-length quality.
  const want = typeof input.quality === 'string' ? input.quality : null;
  const pick =
    (want ? candidates.find((c) => c.quality === want) : undefined) ??
    candidates.find((c) => c.quality === '360p') ??
    candidates[candidates.length - 1];
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const playToken = await sealToken({ u: pick.url, dl: false, exp });
  const dlToken = await sealToken({ u: pick.url, dl: true, exp });
  const playUrl = playToken ? proxyLink(playToken) : null;
  const dlUrl = dlToken ? proxyLink(dlToken) : null;
  if (!playUrl || !dlUrl) return json({ error: 'not_configured' }, 503);
  const qualities = [...new Set(candidates.map((c) => c.quality).filter((q): q is string => !!q))];
  return json({
    subject_id: set.value.subjectId,
    season: se.se,
    episode: se.ep,
    playback_url: playUrl,
    download_url: dlUrl,
    quality: pick.quality,
    format: pick.format,
    duration_sec: pick.durationSec,
    size_mb: pick.sizeMb,
    qualities,
    expires_at: exp * 1000,
  });
}

// ---------- captions ----------

async function actionCaptions(input: Raw): Promise<Response> {
  const subjectId = validId(input.subjectId);
  const detailPath = validDetailPath(input.detailPath);
  const se = seasonEpisode(input);
  if (!subjectId || !detailPath || !se) return json({ error: 'bad_request' }, 400);
  const r = await zar(`/stream/${subjectId}/captions`, { detail_path: detailPath, se: String(se.se), ep: String(se.ep) });
  if (!r.ok) return json({ error: 'upstream_error', status: r.status }, 502);
  const list = Array.isArray(obj(r.body).captions) ? (obj(r.body).captions as unknown[]) : [];
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const data: Array<{ language: string; label: string; format: string; url: string }> = [];
  for (const raw of list.slice(0, 40)) {
    const c = obj(raw);
    const src = safeHttpsUrl(c.url);
    if (!src) continue;
    const lan = str(c.lan) ?? 'und';
    const ext = /\.(srt|vtt)$/i.exec(new URL(src).pathname)?.[1]?.toLowerCase() ?? 'srt';
    const token = await sealToken({ u: src, dl: false, exp });
    const link = token ? proxyLink(token) : null;
    if (!link) continue;
    data.push({ language: lan.slice(0, 24), label: (str(c.lanName) ?? lan).slice(0, 60), format: ext, url: link });
  }
  return json({ data, usable: data.length > 0 });
}

// ---------- media proxy (GET) ----------

// What the media host sees from this proxy: the app's own identity, no impersonated player Referer or Origin.
// The CDN's access rules are not bypassed here. Identity encoding keeps byte offsets and Content-Length
// describing the file itself.
const MEDIA_HEADERS = {
  'User-Agent': 'HallyuApp/1.0 (+media proxy)',
  Accept: '*/*',
  'Accept-Encoding': 'identity',
};

/** One media request with a bounded deadline. A 429 or 5xx is retried twice with a short, capped backoff. */
async function mediaFetch(target: string, range: string | null): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const headers: Record<string, string> = { ...MEDIA_HEADERS };
    if (range) headers.Range = range;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEDIA_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(target, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt === 2) return res;
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 3000) : 700 * (attempt + 1);
    res.body?.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error('unreachable');
}

/** The total length of the file, read from a one-byte ranged probe. Null when the host does not say. */
async function probeTotal(target: string): Promise<number | null> {
  const res = await mediaFetch(target, 'bytes=0-0');
  res.body?.cancel().catch(() => {});
  const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
  return m ? Number(m[1]) : null;
}

async function handleMedia(req: Request): Promise<Response> {
  const t = new URL(req.url).searchParams.get('t') ?? '';
  const p = await openToken(t);
  if (!p) return json({ error: 'bad_token' }, 403);
  if (p.exp * 1000 < Date.now()) return json({ error: 'expired' }, 401);
  const target = safeHttpsUrl(p.u);
  if (!target) return json({ error: 'host_not_allowed' }, 403);

  const range = req.headers.get('range');
  const wantRange = range && /^bytes=\d*-\d*$/.test(range) ? range : null;
  let res: Response;
  try {
    res = await mediaFetch(target, wantRange);
  } catch {
    return json({ error: 'upstream_unreachable' }, 502);
  }
  if (!res.ok && res.status !== 206 && res.status !== 416) {
    res.body?.cancel().catch(() => {});
    return json({ error: 'upstream_error', status: res.status }, res.status === 429 ? 429 : 502);
  }

  const out: Record<string, string> = { ...corsHeaders, 'Cache-Control': 'no-store' };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = res.headers.get(h);
    if (v) out[h] = v;
  }
  // A whole-file answer with no stated length: learn the total from a probe, so the client can verify it.
  if (!wantRange && res.status === 200 && !out['content-length']) {
    const total = await probeTotal(target);
    if (total !== null) out['content-length'] = String(total);
  }
  if (p.dl) out['Content-Disposition'] = 'attachment; filename="hallyu-video.mp4"';
  return new Response(res.body, { status: res.status, headers: out });
}

// ---------- router ----------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  if (req.method === 'GET' && new URL(req.url).searchParams.get('action') === 'proxy') return handleMedia(req);
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  if (!(await requireUser(req))) return json({ error: 'unauthorized' }, 401);

  let input: Raw;
  try {
    input = obj(await req.json());
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  const action = typeof input.action === 'string' ? input.action : 'unknown';
  const started = Date.now();
  try {
    switch (action) {
      case 'home':
        return await actionHome();
      case 'search':
        return await actionSearch(input);
      case 'detail':
        return await actionDetail(input);
      case 'stream':
        return await actionStream(input);
      case 'playback':
        return await actionPlayback(input);
      case 'captions':
        return await actionCaptions(input);
      default:
        return json({ error: 'unknown_action' }, 400);
    }
  } finally {
    // Operational timing only; never log user identifiers, upstream URLs, tokens, or secrets.
    console.log(JSON.stringify({ event: 'moviebox_action', action, duration_ms: Date.now() - started }));
  }
});
