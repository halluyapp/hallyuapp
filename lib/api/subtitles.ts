/**
 * Subtitle client. Captions come only from the Moviebox source, through the `moviebox` edge function.
 * Each caption link is a proxy link issued by the function, so the app never talks to the CDN directly.
 */
import { ensureBackendSessionToken, supabase } from './client';
import { parseSubtitles, type SubtitleCue } from '../subtitles';

const CALL_TIMEOUT_MS = 20_000;

export interface MovieboxCaption {
  language: string;
  label: string;
  format: 'srt' | 'vtt' | null;
  url: string;
}

export type SubtitleResult<T> = { ok: true; value: T } | { ok: false; reason: 'signed_out' | 'not_configured' | 'offline' | 'timeout' | 'empty' | 'failed' };

async function invoke(body: Record<string, unknown>): Promise<SubtitleResult<Record<string, unknown>>> {
  if (!supabase) return { ok: false, reason: 'offline' };
  try {
    const hasSession = await ensureBackendSessionToken();
    if (!hasSession) return { ok: false, reason: 'signed_out' };
    const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), CALL_TIMEOUT_MS));
    const { data, error } = await Promise.race([supabase.functions.invoke<Record<string, unknown>>('moviebox', { body }), timer]);
    if (error) {
      const status = (error as { context?: { status?: number } }).context?.status;
      if (status === 503) return { ok: false, reason: 'not_configured' };
      return { ok: false, reason: 'failed' };
    }
    if (!data) return { ok: false, reason: 'failed' };
    if (data.error === 'not_configured') return { ok: false, reason: 'not_configured' };
    if (data.error) return { ok: false, reason: 'failed' };
    return { ok: true, value: data };
  } catch (e) {
    return { ok: false, reason: e instanceof Error && e.message === 'timeout' ? 'timeout' : 'offline' };
  }
}

/** MovieBox captions for a title. The list can be empty; the caller decides what to show. */
export async function fetchMovieboxCaptions(args: { subjectId: string; detailPath: string | null; season?: number; episode?: number }): Promise<SubtitleResult<MovieboxCaption[]>> {
  if (!args.detailPath) return { ok: false, reason: 'failed' };
  const res = await invoke({
    action: 'captions',
    subjectId: args.subjectId,
    detailPath: args.detailPath,
    ...(args.season !== undefined ? { se: args.season, ep: args.episode ?? 0 } : {}),
  });
  if (!res.ok) return res;
  const list = Array.isArray(res.value.data) ? (res.value.data as MovieboxCaption[]) : [];
  return { ok: true, value: list };
}

/** Fetches a caption file through its proxy link and parses it. A body with no cues is `empty`. */
export async function fetchCaptionCues(url: string): Promise<SubtitleResult<{ cues: SubtitleCue[]; text: string }>> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) return { ok: false, reason: 'failed' };
    const text = await res.text();
    const cues = parseSubtitles(text);
    return cues.length > 0 ? { ok: true, value: { cues, text } } : { ok: false, reason: 'empty' };
  } catch {
    return { ok: false, reason: 'offline' };
  }
}
