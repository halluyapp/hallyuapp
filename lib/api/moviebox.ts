/**
 * Hallyu Watch — client for the server-side `moviebox` edge function.
 *
 * The app never calls the upstream or its CDN directly. Every playable or
 * downloadable link is a proxy link issued by the `playback` action, with a sealed token that expires
 * after 4 hours. Mobile and web use the same rule, so a stream that plays on web also plays natively.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { normaliseDetail, normaliseHome, normaliseSearch, normaliseStreams, pickStream, qualityOptions, type WatchDetail, type WatchPlayback, type WatchResult, type WatchRow, type WatchStreams, type WatchTitle } from '../watchModel';
import { ttlGet, ttlPut, type TtlEntry } from '../watchRules';
import { beginWatch, endWatch } from '../watchPerf';

export * from '../watchModel';

type Raw = Record<string, unknown>;

const CALL_TIMEOUT_MS = 25_000;
const HOME_CACHE_KEY = 'watch.home.cache.v1';
const HOME_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DETAIL_TTL_MS = 10 * 60_000;
const STREAM_TTL_MS = 10 * 60_000;
const STREAM_EMPTY_TTL_MS = 30_000;

const ZARHOSTING_BASE = 'https://movieapi.zarhosting.dpdns.org/api/public/v1';

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

async function callDirect(endpoint: string): Promise<WatchResult<Raw>> {
  try {
    const url = `${ZARHOSTING_BASE}${endpoint}`;
    const res = await withTimeout(
      fetch(url, {
        headers: {
          'User-Agent': 'HallyuApp/1.0 (+media client)',
          Accept: 'application/json',
        },
      }),
      CALL_TIMEOUT_MS,
    );
    if (!res.ok) return { ok: false, reason: 'failed' };
    const data = (await res.json()) as Raw;
    if (!data) return { ok: false, reason: 'failed' };
    return { ok: true, value: data };
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.message === 'watch_timeout' ? 'timeout' : 'offline' };
  }
}

/** Identical in-flight actions share one bounded request. */
function callKeyed(endpoint: string): Promise<WatchResult<Raw>> {
  const existing = inFlight.get(endpoint);
  if (existing) return existing;
  const pending = callDirect(endpoint).finally(() => inFlight.delete(endpoint));
  inFlight.set(endpoint, pending);
  return pending;
}

export async function fetchWatchHome(): Promise<WatchResult<WatchRow[]>> {
  beginWatch('watch:home');
  const r = await callKeyed('/home');
  endWatch('watch:home');
  if (!r.ok) return r;
  const rows = normaliseHome(r.value);
  if (rows.length > 0) void saveWatchHomeCache(rows);
  return { ok: true, value: rows };
}

export async function searchWatch(q: string, page = 1): Promise<WatchResult<WatchTitle[]>> {
  const endpoint = `/search?q=${encodeURIComponent(q)}&page=${page}`;
  const r = await callKeyed(endpoint);
  return r.ok ? { ok: true, value: normaliseSearch(r.value) } : r;
}

export async function fetchWatchDetail(detailPath: string): Promise<WatchResult<WatchDetail>> {
  const hit = ttlGet(detailCache, detailPath);
  if (hit) return { ok: true, value: hit };
  beginWatch('watch:detail');
  const r = await callKeyed(`/detail/${encodeURIComponent(detailPath)}`);
  endWatch('watch:detail');
  if (!r.ok) return r;
  const detail = normaliseDetail(r.value);
  if (!detail) return { ok: false, reason: 'not_found' };
  ttlPut(detailCache, detailPath, detail, DETAIL_TTL_MS);
  return { ok: true, value: detail };
}

/** Full-length stream metadata (quality list, availability). Direct CDN URLs included in items. */
export async function fetchWatchStreams(subjectId: string, se?: number, ep?: number, detailPath?: string | null): Promise<WatchResult<WatchStreams>> {
  if (!detailPath) return { ok: false, reason: 'not_found' };
  const cacheKey = `${subjectId}|${se ?? ''}|${ep ?? ''}`;
  const hit = ttlGet(streamCache, cacheKey);
  if (hit) return { ok: true, value: hit };
  const negative = ttlGet(streamEmptyCache, cacheKey);
  if (negative) return negative;

  const endpoint = `/stream/${subjectId}?detail_path=${encodeURIComponent(detailPath)}&se=${se ?? 0}&ep=${ep ?? 0}`;
  beginWatch('watch:streams');
  const r = await callKeyed(endpoint);
  endWatch('watch:streams');
  if (!r.ok) return r;

  const value = normaliseStreams(r.value);
  if (value.streams.length === 0) {
    const empty: EmptyStream = { ok: false, reason: 'no_full_stream' };
    ttlPut(streamEmptyCache, cacheKey, empty, STREAM_EMPTY_TTL_MS);
    return empty;
  }
  ttlPut(streamCache, cacheKey, value, STREAM_TTL_MS);
  return { ok: true, value };
}

const playbackCache = new Map<string, TtlEntry<WatchPlayback>>();
const PLAYBACK_CACHE_MARGIN_MS = 10 * 60 * 1000;

export async function fetchWatchPlayback(subjectId: string, se: number | undefined, ep: number | undefined, quality: string | null, fresh = false, detailPath: string | null = null): Promise<WatchResult<WatchPlayback>> {
  if (!detailPath) return { ok: false, reason: 'not_found' };
  const cacheKey = `${subjectId}|${se ?? ''}|${ep ?? ''}|${quality ?? ''}`;
  if (!fresh) {
    const hit = ttlGet(playbackCache, cacheKey);
    if (hit) return { ok: true, value: hit };
  }

  const endpoint = `/stream/${subjectId}?detail_path=${encodeURIComponent(detailPath)}&se=${se ?? 0}&ep=${ep ?? 0}`;
  const r = await callKeyed(endpoint);
  if (!r.ok) return r;

  const streams = normaliseStreams(r.value);
  const chosenMeta = pickStream(streams.streams, quality);
  if (!chosenMeta) return { ok: false, reason: 'no_full_stream' };

  const rawList = (Array.isArray(r.value.sources) ? r.value.sources : Array.isArray(r.value.streams) ? r.value.streams : []) as Record<string, unknown>[];
  const matchedRaw = rawList.find((s) => (s.resolution ?? s.quality) === chosenMeta.quality) ?? rawList[0];
  const rawUrl = typeof matchedRaw?.url === 'string' ? matchedRaw.url : typeof matchedRaw?.playback_url === 'string' ? (matchedRaw.playback_url as string) : null;

  if (!rawUrl || !rawUrl.startsWith('https://')) return { ok: false, reason: 'no_full_stream' };

  const playback: WatchPlayback = {
    playbackUrl: rawUrl,
    downloadUrl: rawUrl,
    quality: chosenMeta.quality,
    format: chosenMeta.format ?? 'MP4',
    durationSec: chosenMeta.durationSec ?? 0,
    sizeMb: chosenMeta.sizeMb,
    qualities: qualityOptions(streams.streams),
    expiresAt: Date.now() + 4 * 60 * 60 * 1000,
  };

  ttlPut(playbackCache, cacheKey, playback, 3 * 60 * 60 * 1000);
  return { ok: true, value: playback };
}

/** A fresh download link for one full-length stream. Returns null when no valid link exists. */
export async function fetchWatchDownloadUrl(subjectId: string, se: number | undefined, ep: number | undefined, quality: string | null, detailPath: string | null = null): Promise<string | null> {
  const r = await fetchWatchPlayback(subjectId, se, ep, quality, true, detailPath);
  return r.ok ? r.value.downloadUrl : null;
}

/** Pre-warms playback cache in background so clicking Play starts immediately with zero network delay. */
export function prewarmWatchPlayback(subjectId: string, se: number | undefined, ep: number | undefined, quality: string | null, detailPath: string | null = null): void {
  if (!detailPath) return;
  const cacheKey = `${subjectId}|${se ?? ''}|${ep ?? ''}|${quality ?? ''}`;
  if (ttlGet(playbackCache, cacheKey)) return;
  void fetchWatchPlayback(subjectId, se, ep, quality, false, detailPath).catch(() => {});
}
