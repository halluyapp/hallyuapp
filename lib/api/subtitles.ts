/**
 * Subtitle client. Captions come directly from the Zarhosting public API.
 */
import { parseSubtitles, type SubtitleCue } from '../subtitles';

const CALL_TIMEOUT_MS = 20_000;
const ZARHOSTING_BASE = 'https://movieapi.zarhosting.dpdns.org/api/public/v1';

export interface MovieboxCaption {
  language: string;
  label: string;
  format: 'srt' | 'vtt' | null;
  url: string;
}

export type SubtitleResult<T> = { ok: true; value: T } | { ok: false; reason: 'signed_out' | 'not_configured' | 'offline' | 'timeout' | 'empty' | 'failed' };

/** MovieBox captions for a title directly from Zarhosting. The list can be empty; the caller decides what to show. */
export async function fetchMovieboxCaptions(args: { subjectId: string; detailPath: string | null; season?: number; episode?: number }): Promise<SubtitleResult<MovieboxCaption[]>> {
  if (!args.detailPath) return { ok: false, reason: 'failed' };
  try {
    const url = `${ZARHOSTING_BASE}/stream/${args.subjectId}/captions?detail_path=${encodeURIComponent(args.detailPath)}&se=${args.season ?? 0}&ep=${args.episode ?? 0}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'HallyuApp/1.0 (+media client)' },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return { ok: false, reason: 'failed' };
    const data = (await res.json()) as Record<string, unknown>;
    const rawList = Array.isArray(data?.captions) ? data.captions : Array.isArray(data?.data) ? data.data : [];
    const list: MovieboxCaption[] = rawList
      .filter((c): c is Record<string, unknown> => c && typeof c === 'object' && typeof (c as Record<string, unknown>).url === 'string')
      .map((c) => ({
        language: String(c.lan ?? c.language ?? 'en'),
        label: String(c.lanName ?? c.label ?? c.lan ?? 'Caption'),
        format: (String(c.format ?? 'srt').toLowerCase() as 'srt' | 'vtt') || 'srt',
        url: String(c.url),
      }));
    return { ok: true, value: list };
  } catch (e) {
    return { ok: false, reason: e instanceof Error && e.message === 'timeout' ? 'timeout' : 'offline' };
  }
}

/** Fetches a caption file through its CDN link and parses it. A body with no cues is `empty`. */
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
