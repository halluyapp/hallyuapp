/**
 * Subtitle client. Two sources, MovieBox first and OpenSubtitles second, both reached only through the
 * `moviebox` edge function, so no provider key ever ships in the app.
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

export interface OpenSubtitleResult {
  id: string;
  fileId: number;
  release: string;
  fileName: string | null;
  language: string | null;
  downloadCount: number;
  hearingImpaired: boolean;
  fromTrusted: boolean;
  machineTranslated: boolean;
  season: number | null;
  episode: number | null;
}

export type SubtitleResult<T> = { ok: true; value: T } | { ok: false; reason: 'signed_out' | 'not_configured' | 'quota' | 'offline' | 'timeout' | 'empty' | 'failed' };

async function invoke(body: Record<string, unknown>): Promise<SubtitleResult<Record<string, unknown>>> {
  if (!supabase) return { ok: false, reason: 'offline' };
  try {
    const hasSession = await ensureBackendSessionToken();
    if (!hasSession) return { ok: false, reason: 'signed_out' };
    const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), CALL_TIMEOUT_MS));
    const { data, error } = await Promise.race([supabase.functions.invoke<Record<string, unknown>>('moviebox', { body }), timer]);
    if (error) {
      const status = (error as { context?: { status?: number } }).context?.status;
      if (status === 429) return { ok: false, reason: 'quota' };
      if (status === 503) return { ok: false, reason: 'not_configured' };
      return { ok: false, reason: 'failed' };
    }
    if (!data) return { ok: false, reason: 'failed' };
    if (data.error === 'quota_exceeded') return { ok: false, reason: 'quota' };
    if (data.error === 'not_configured') return { ok: false, reason: 'not_configured' };
    if (data.error) return { ok: false, reason: 'failed' };
    return { ok: true, value: data };
  } catch (e) {
    return { ok: false, reason: e instanceof Error && e.message === 'timeout' ? 'timeout' : 'offline' };
  }
}

/** MovieBox captions for a title. `usable` is false when the list has no entry with a clean https URL. */
export async function fetchMovieboxCaptions(args: { subjectId: string; season?: number; episode?: number; streamId?: string }): Promise<SubtitleResult<MovieboxCaption[]>> {
  const res = await invoke({
    action: 'captions',
    subjectId: args.subjectId,
    ...(args.season !== undefined ? { se: args.season, ep: args.episode ?? 0 } : {}),
    ...(args.streamId ? { streamId: args.streamId } : {}),
  });
  if (!res.ok) return res;
  const list = Array.isArray(res.value.data) ? (res.value.data as MovieboxCaption[]) : [];
  return { ok: true, value: list };
}

/** OpenSubtitles results. Series results already match the requested season and episode on the server. */
export async function searchOpenSubtitles(args: { query: string; imdbId?: string | null; season?: number; episode?: number; language?: string }): Promise<SubtitleResult<OpenSubtitleResult[]>> {
  const res = await invoke({
    action: 'subtitle_search',
    query: args.query,
    ...(args.imdbId ? { imdbId: args.imdbId } : {}),
    ...(args.season !== undefined ? { season: args.season, episode: args.episode ?? 0 } : {}),
    language: args.language ?? 'en',
  });
  if (!res.ok) return res;
  const rows = Array.isArray(res.value.data) ? (res.value.data as Record<string, unknown>[]) : [];
  return {
    ok: true,
    value: rows.map((r) => ({
      id: String(r.id ?? ''),
      fileId: Number(r.file_id),
      release: String(r.release ?? ''),
      fileName: typeof r.file_name === 'string' ? r.file_name : null,
      language: typeof r.language === 'string' ? r.language : null,
      downloadCount: Number(r.download_count ?? 0),
      hearingImpaired: r.hearing_impaired === true,
      fromTrusted: r.from_trusted === true,
      machineTranslated: r.machine_translated === true,
      season: typeof r.season === 'number' ? r.season : null,
      episode: typeof r.episode === 'number' ? r.episode : null,
    })),
  };
}

/**
 * Downloads one subtitle file and parses it. A body that is not SRT or WebVTT, or has no cues, is reported
 * as `empty` so the player never shows a wrong or broken file as a subtitle.
 */
export async function fetchOpenSubtitleCues(fileId: number): Promise<SubtitleResult<{ cues: SubtitleCue[]; text: string }>> {
  const res = await invoke({ action: 'subtitle_fetch', fileId });
  if (!res.ok) return res;
  const data = res.value.data as { text?: unknown } | undefined;
  const text = typeof data?.text === 'string' ? data.text : '';
  return cuesOrEmpty(text);
}

/** Fetches a MovieBox caption file (public subtitle URL) and parses it. */
export async function fetchCaptionCues(url: string): Promise<SubtitleResult<{ cues: SubtitleCue[]; text: string }>> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) return { ok: false, reason: 'failed' };
    const text = await res.text();
    return cuesOrEmpty(text);
  } catch {
    return { ok: false, reason: 'offline' };
  }
}

function cuesOrEmpty(text: string): SubtitleResult<{ cues: SubtitleCue[]; text: string }> {
  const cues = parseSubtitles(text);
  return cues.length > 0 ? { ok: true, value: { cues, text } } : { ok: false, reason: 'empty' };
}
