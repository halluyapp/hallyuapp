/**
 * Hallyu Watch — client for the server-side `moviebox` edge function.
 *
 * The app never holds the Megan key and never calls Megan or the CDN hosts through the proxy. It
 * receives normalised records, plus direct stream links whose required headers the player must send.
 */
import { ensureBackendSessionToken, supabase } from './client';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../../constants/keys';
import { normaliseDetail, normaliseDiagnostics, normaliseHome, normaliseSearch, normaliseStreams, type WatchDetail, type WatchResult, type WatchRow, type WatchStreams, type WatchTitle } from '../watchModel';

export * from '../watchModel';

type Body = Record<string, unknown>;
type Raw = Record<string, unknown>;

async function call(body: Body): Promise<WatchResult<{ data?: unknown } & Raw>> {
  if (!supabase) return { ok: false, reason: 'offline' };
  if (!(await ensureBackendSessionToken())) return { ok: false, reason: 'signed_out' };
  const { data, error } = await supabase.functions.invoke<Raw>('moviebox', { body });
  if (error || !data) return { ok: false, reason: 'failed' };
  const err = (data as Raw).error;
  if (err === 'not_configured') return { ok: false, reason: 'not_configured' };
  if (err === 'unexpected_shape' || err === 'upstream_error') return { ok: false, reason: 'failed' };
  if (err === 'no_full_stream') return { ok: false, reason: 'no_full_stream', diagnostics: normaliseDiagnostics((data as Raw).diagnostics) };
  if (err) return { ok: false, reason: 'failed' };
  return { ok: true, value: data as { data?: unknown } & Raw };
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

export async function fetchWatchStreams(subjectId: string, se?: number, ep?: number): Promise<WatchResult<WatchStreams>> {
  const body: Body = { action: 'stream', subjectId };
  if (se !== undefined) body.se = se;
  if (ep !== undefined) body.ep = ep;
  const r = await call(body);
  if (!r.ok) return r;
  const value = normaliseStreams(r.value);
  // Playback and download share the full-length rule. If the server returned only previews, say so.
  return value.streams.length > 0 ? { ok: true, value } : { ok: false, reason: 'no_full_stream', diagnostics: normaliseDiagnostics(r.value.diagnostics) };
}

/**
 * Fallback playback source: the same full-length stream, routed through the allowlisted proxy with the
 * signed-in session token. Used only when the direct link fails; the direct link is tried first.
 */
export async function watchProxySource(streamUrl: string): Promise<{ uri: string; headers: Record<string, string> } | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const token = await ensureBackendSessionToken();
  if (!token) return null;
  return {
    uri: `${SUPABASE_URL}/functions/v1/moviebox?action=proxy&u=${encodeURIComponent(streamUrl)}`,
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
  };
}
