/**
 * Hallyu Watch — client for the server-side `moviebox` edge function.
 *
 * The app never holds the Megan key and never calls Megan or the CDN directly. Every playable or
 * downloadable link is a proxy link issued by the `playback` action, with a sealed token that expires
 * after 4 hours. Mobile and web use the same rule, so a stream that plays on web also plays natively.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ensureBackendSessionToken, supabase } from './client';
import { normaliseDetail, normaliseDiagnostics, normaliseHome, normalisePlayback, normaliseSearch, normaliseStreams, type WatchDetail, type WatchPlayback, type WatchResult, type WatchRow, type WatchStreams, type WatchTitle } from '../watchModel';
import { ttlGet, ttlPut, type TtlEntry } from '../watchRules';
import { beginWatch, endWatch } from '../watchPerf';

export * from '../watchModel';

type Body = Record<string, unknown>;
type Raw = Record<string, unknown>;
type CallError = Extract<WatchResult<never>, { ok: false }>;

const CALL_TIMEOUT_MS = 25_000;
const SESSION_TIMEOUT_MS = 10_000;
const HOME_CACHE_KEY = 'watch.home.cache.v1';
const HOME_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DETAIL_TTL_MS = 10 * 60_000;
/** Matches the server's own 10-minute metadata cache, so a repeat open inside it costs nothing. */
const STREAM_TTL_MS = 10 * 60_000;
/** A title with nothing playable is remembered briefly, so re-opening it does not re-ask upstream. */
const STREAM_EMPTY_TTL_MS = 30_000;
/** A stream metadata response, or the "nothing full-length here" answer, during its window. */
type EmptyStream = { ok: false; reason: 'no_full_stream'; diagnostics?: ReturnType<typeof normaliseDiagnostics> };

let homeMemory: { rows: WatchRow[]; savedAt: number } | null = null;
const detailCache = new Map<string, TtlEntry<WatchDetail>>();
const streamCache = new Map<string, TtlEntry<WatchStreams>>();
const streamEmptyCache = new Map<string, TtlEntry<EmptyStream>>();
const inFlight = new Map<string, Promise<WatchResult<Raw>>>();

/** Returns the last successful Hallyu TV home snapshot for an immediate first paint. */
export async function readWatchHomeCache(): Promise<WatchRow[] | null> {
  if (homeMemory && Date.now() - homeMemory.savedAt < HOME_CACHE_MAX_AGE_MS) return homeMemory.rows;
  try {
    const raw = await AsyncStorage.getItem(HOME_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { rows?: unknown; savedAt?: unknown };
    if (!Array.isArray(parsed.rows) || typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > HOME_CACHE_MAX_AGE_MS) return null;
    const rows = parsed.rows as WatchRow[];
    homeMemory = { rows, savedAt: parsed.savedAt };
    return rows;
  } catch {
    return null;
  }
}

async function saveWatchHomeCache(rows: WatchRow[]): Promise<void> {
  const savedAt = Date.now();
  homeMemory = { rows, savedAt };
  try {
    await AsyncStorage.setItem(HOME_CACHE_KEY, JSON.stringify({ rows, savedAt }));
  } catch {
    // The in-memory cache still provides first paint for the current app session.
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('watch_timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** supabase-js returns non-2xx responses as `error`, and the JSON body sits on `error.context`. */
async function errorBody(error: unknown): Promise<Raw | null> {
  const ctx = (error as { context?: unknown } | null)?.context as { json?: () => Promise<unknown> } | undefined;
  if (!ctx || typeof ctx.json !== 'function') return null;
  try {
    const body = await ctx.json();
    return body && typeof body === 'object' ? (body as Raw) : null;
  } catch {
    return null;
  }
}

function mapError(body: Raw | null): CallError {
  const err = body?.error;
  if (err === 'no_full_stream') return { ok: false, reason: 'no_full_stream', diagnostics: normaliseDiagnostics(body?.diagnostics) };
  if (err === 'not_configured') return { ok: false, reason: 'not_configured' };
  if (err === 'unauthorized') return { ok: false, reason: 'signed_out' };
  return { ok: false, reason: 'failed' };
}

async function callOnce(body: Body): Promise<WatchResult<Raw>> {
  if (!supabase) return { ok: false, reason: 'offline' };
  try {
    const hasSession = await withTimeout(ensureBackendSessionToken(), SESSION_TIMEOUT_MS);
    if (!hasSession) return { ok: false, reason: 'signed_out' };
    const { data, error } = await withTimeout(supabase.functions.invoke<Raw>('moviebox', { body }), CALL_TIMEOUT_MS);
    if (error) {
      const body = await withTimeout(errorBody(error), 4_000).catch(() => null);
      return mapError(body);
    }
    if (!data) return { ok: false, reason: 'failed' };
    if (data.error) return mapError(data);
    return { ok: true, value: data };
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.message === 'watch_timeout' ? 'timeout' : 'offline' };
  }
}

/** Identical in-flight actions share one bounded request. */
function call(body: Body): Promise<WatchResult<Raw>> {
  const key = JSON.stringify(body);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = callOnce(body).finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

export async function fetchWatchHome(): Promise<WatchResult<WatchRow[]>> {
  beginWatch('watch:home');
  const r = await call({ action: 'home' });
  endWatch('watch:home');
  if (!r.ok) return r;
  const rows = normaliseHome(r.value.data);
  if (rows.length > 0) void saveWatchHomeCache(rows);
  return { ok: true, value: rows };
}

export async function searchWatch(q: string, page = 1): Promise<WatchResult<WatchTitle[]>> {
  const r = await call({ action: 'search', q, page });
  return r.ok ? { ok: true, value: normaliseSearch(r.value.data) } : r;
}

export async function fetchWatchDetail(detailPath: string): Promise<WatchResult<WatchDetail>> {
  const hit = ttlGet(detailCache, detailPath);
  if (hit) return { ok: true, value: hit };
  beginWatch('watch:detail');
  const r = await call({ action: 'detail', detailPath });
  endWatch('watch:detail');
  if (!r.ok) return r;
  const detail = normaliseDetail(r.value.data);
  if (!detail) return { ok: false, reason: 'not_found' };
  ttlPut(detailCache, detailPath, detail, DETAIL_TTL_MS);
  return { ok: true, value: detail };
}

/** Full-length stream metadata (quality list, availability). No URLs. */
export async function fetchWatchStreams(subjectId: string, se?: number, ep?: number): Promise<WatchResult<WatchStreams>> {
  const cacheKey = `${subjectId}|${se ?? ''}|${ep ?? ''}`;
  const hit = ttlGet(streamCache, cacheKey);
  if (hit) return { ok: true, value: hit };
  // A negative answer is cached too (briefly): a title whose first episode has no full-length stream is
  // a normal outcome, and re-asking upstream for it on every open is a duplicate lookup.
  const negative = ttlGet(streamEmptyCache, cacheKey);
  if (negative) return negative;
  const body: Body = { action: 'stream', subjectId };
  if (se !== undefined) body.se = se;
  if (ep !== undefined) body.ep = ep;
  beginWatch('watch:streams');
  const r = await call(body);
  endWatch('watch:streams');
  if (!r.ok) {
    if (r.reason === 'no_full_stream') ttlPut(streamEmptyCache, cacheKey, r as EmptyStream, STREAM_EMPTY_TTL_MS);
    return r;
  }
  const value = normaliseStreams(r.value);
  if (value.streams.length === 0) {
    const empty: EmptyStream = { ok: false, reason: 'no_full_stream', diagnostics: normaliseDiagnostics(r.value.diagnostics) };
    ttlPut(streamEmptyCache, cacheKey, empty, STREAM_EMPTY_TTL_MS);
    return empty;
  }
  ttlPut(streamCache, cacheKey, value, STREAM_TTL_MS);
  return { ok: true, value };
}

/**
 * Proxy playback and download links for one full-length stream. Retries once on a transient failure
 * (for example a 502 from upstream). A short clip or a missing link is never returned as success.
 */
/**
 * Playback links are cached per title, episode and quality until shortly before their token expires,
 * so reopening the same episode does not repeat the lookup. `fresh` skips the cache (used after a failure).
 */
const playbackCache = new Map<string, TtlEntry<WatchPlayback>>();
const PLAYBACK_CACHE_MARGIN_MS = 10 * 60 * 1000;

export async function fetchWatchPlayback(subjectId: string, se: number | undefined, ep: number | undefined, quality: string | null, fresh = false): Promise<WatchResult<WatchPlayback>> {
  const cacheKey = `${subjectId}|${se ?? ''}|${ep ?? ''}|${quality ?? ''}`;
  if (!fresh) {
    const hit = ttlGet(playbackCache, cacheKey);
    if (hit) return { ok: true, value: hit };
  }
  const body: Body = { action: 'playback', subjectId };
  if (se !== undefined) body.se = se;
  if (ep !== undefined) body.ep = ep;
  if (quality) body.quality = quality;
  let last: WatchResult<WatchPlayback> = { ok: false, reason: 'failed' };
  for (let attempt = 0; attempt < 2; attempt++) {
    beginWatch('watch:playback');
    const r = await call(body);
    endWatch('watch:playback');
    if (r.ok) {
      const playback = normalisePlayback(r.value);
      if (!playback) return { ok: false, reason: 'no_full_stream' };
      const ttl = playback.expiresAt ? playback.expiresAt - PLAYBACK_CACHE_MARGIN_MS - Date.now() : 0;
      if (ttl > 0) ttlPut(playbackCache, cacheKey, playback, ttl);
      return { ok: true, value: playback };
    }
    last = r;
    // Only transient failures are retried. A missing stream or a sign-in problem will not change on retry.
    if (r.reason !== 'failed') break;
  }
  return last;
}

/** A fresh download link for one full-length stream. Returns null when no valid link exists. */
export async function fetchWatchDownloadUrl(subjectId: string, se: number | undefined, ep: number | undefined, quality: string | null): Promise<string | null> {
  const r = await fetchWatchPlayback(subjectId, se, ep, quality, true);
  return r.ok ? r.value.downloadUrl : null;
}

/**
 * Pre-warms playback cache in background so clicking Play starts immediately with zero network delay.
 */
export function prewarmWatchPlayback(subjectId: string, se: number | undefined, ep: number | undefined, quality: string | null): void {
  const cacheKey = `${subjectId}|${se ?? ''}|${ep ?? ''}|${quality ?? ''}`;
  if (ttlGet(playbackCache, cacheKey)) return;
  void fetchWatchPlayback(subjectId, se, ep, quality).catch(() => {});
}
