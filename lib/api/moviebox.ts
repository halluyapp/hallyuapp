/**
 * Hallyu Watch — client for the server-side `moviebox` edge function.
 *
 * The app never holds the Megan key and never calls Megan or the CDN directly. Every playable or
 * downloadable link is a proxy link issued by the `playback` action, with a sealed token that expires
 * after 4 hours. Mobile and web use the same rule, so a stream that plays on web also plays natively.
 */
import { ensureBackendSessionToken, supabase } from './client';
import { normaliseDetail, normaliseDiagnostics, normaliseHome, normalisePlayback, normaliseSearch, normaliseStreams, type WatchDetail, type WatchPlayback, type WatchResult, type WatchRow, type WatchStreams, type WatchTitle } from '../watchModel';

export * from '../watchModel';

type Body = Record<string, unknown>;
type Raw = Record<string, unknown>;
type CallError = Extract<WatchResult<never>, { ok: false }>;

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

async function call(body: Body): Promise<WatchResult<Raw>> {
  if (!supabase) return { ok: false, reason: 'offline' };
  if (!(await ensureBackendSessionToken())) return { ok: false, reason: 'signed_out' };
  const { data, error } = await supabase.functions.invoke<Raw>('moviebox', { body });
  if (error) return mapError(await errorBody(error));
  if (!data) return { ok: false, reason: 'failed' };
  if (data.error) return mapError(data);
  return { ok: true, value: data };
}

export async function fetchWatchHome(): Promise<WatchResult<WatchRow[]>> {
  const r = await call({ action: 'home' });
  return r.ok ? { ok: true, value: normaliseHome(r.value.data) } : r;
}

export async function searchWatch(q: string, page = 1): Promise<WatchResult<WatchTitle[]>> {
  const r = await call({ action: 'search', q, page });
  return r.ok ? { ok: true, value: normaliseSearch(r.value.data) } : r;
}

export async function fetchWatchDetail(detailPath: string): Promise<WatchResult<WatchDetail>> {
  const r = await call({ action: 'detail', detailPath });
  if (!r.ok) return r;
  const detail = normaliseDetail(r.value.data);
  return detail ? { ok: true, value: detail } : { ok: false, reason: 'not_found' };
}

/** Full-length stream metadata (quality list, availability). No URLs. */
export async function fetchWatchStreams(subjectId: string, se?: number, ep?: number): Promise<WatchResult<WatchStreams>> {
  const body: Body = { action: 'stream', subjectId };
  if (se !== undefined) body.se = se;
  if (ep !== undefined) body.ep = ep;
  const r = await call(body);
  if (!r.ok) return r;
  const value = normaliseStreams(r.value);
  return value.streams.length > 0 ? { ok: true, value } : { ok: false, reason: 'no_full_stream', diagnostics: normaliseDiagnostics(r.value.diagnostics) };
}

/**
 * Proxy playback and download links for one full-length stream. Retries once on a transient failure
 * (for example a 502 from upstream). A short clip or a missing link is never returned as success.
 */
export async function fetchWatchPlayback(subjectId: string, se: number | undefined, ep: number | undefined, quality: string | null): Promise<WatchResult<WatchPlayback>> {
  const body: Body = { action: 'playback', subjectId };
  if (se !== undefined) body.se = se;
  if (ep !== undefined) body.ep = ep;
  if (quality) body.quality = quality;
  let last: WatchResult<WatchPlayback> = { ok: false, reason: 'failed' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await call(body);
    if (r.ok) {
      const playback = normalisePlayback(r.value);
      return playback ? { ok: true, value: playback } : { ok: false, reason: 'no_full_stream' };
    }
    last = r;
    // Only transient failures are retried. A missing stream or a sign-in problem will not change on retry.
    if (r.reason !== 'failed') break;
  }
  return last;
}

/** A fresh download link for one full-length stream. Returns null when no valid link exists. */
export async function fetchWatchDownloadUrl(subjectId: string, se: number | undefined, ep: number | undefined, quality: string | null): Promise<string | null> {
  const r = await fetchWatchPlayback(subjectId, se, ep, quality);
  return r.ok ? r.value.downloadUrl : null;
}
