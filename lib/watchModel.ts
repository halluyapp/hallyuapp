/**
 * Hallyu Watch — pure response model for the `moviebox` edge function. No I/O and no client imports,
 * so the normalisers can be tested without Supabase. Shapes match the live responses verified on
 * 2026-10-24.
 */

export interface WatchTitle {
  subjectId: string;
  title: string;
  cover: string | null;
  genre: string | null;
  releaseDate: string | null;
  rating: string | null;
  detailPath: string | null;
  countryName: string | null;
}

export interface WatchRow {
  title: string;
  items: WatchTitle[];
}

export interface WatchSeason {
  se: number;
  maxEp: number;
}

export interface WatchDetail extends WatchTitle {
  description: string | null;
  seasons: WatchSeason[];
}

export interface WatchStream {
  url: string;
  source: string | null;
  quality: string | null;
  qualityValue: number | null;
  format: string | null;
  codec: string | null;
  sizeMb: number | null;
  durationSec: number | null;
  requiredHeaders: Record<string, string>;
}

export interface WatchStreams {
  season: number | null;
  episode: number | null;
  streams: WatchStream[];
}

export type WatchResult<T> = { ok: true; value: T } | { ok: false; reason: 'offline' | 'signed_out' | 'not_configured' | 'not_found' | 'no_full_stream' | 'failed' };

type Raw = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {});

/** A subject record as the catalog returns it (`subject` nested or flat). */
export function normaliseTitle(raw: unknown): WatchTitle | null {
  const r = obj(raw);
  const s = r.subject && typeof r.subject === 'object' ? obj(r.subject) : r;
  const subjectId = str(s.subjectId) ?? str(r.subjectId);
  const title = str(s.title);
  if (!subjectId || !title) return null;
  return {
    subjectId,
    title,
    cover: str(obj(s.cover).url) ?? str(obj(r.image).url),
    genre: str(s.genre),
    releaseDate: str(s.releaseDate),
    rating: str(s.imdbRatingValue),
    detailPath: str(s.detailPath) ?? str(r.detailPath),
    countryName: str(s.countryName),
  };
}

/** Home is a list of operating rows. Banner rows nest their items under banner.items. */
export function normaliseHome(data: unknown): WatchRow[] {
  const list = Array.isArray(obj(data).operatingList) ? (obj(data).operatingList as unknown[]) : [];
  const rows: WatchRow[] = [];
  for (const rawRow of list) {
    const row = obj(rawRow);
    const source = Array.isArray(row.subjects) && row.subjects.length > 0 ? row.subjects : Array.isArray(obj(row.banner).items) ? (obj(row.banner).items as unknown[]) : [];
    const items = source.map(normaliseTitle).filter((t): t is WatchTitle => t !== null);
    const title = str(row.title);
    if (title && items.length > 0) rows.push({ title, items });
  }
  return rows;
}

/** Search returns data.items[] of catalog subjects. */
export function normaliseSearch(data: unknown): WatchTitle[] {
  const items = Array.isArray(obj(data).items) ? (obj(data).items as unknown[]) : [];
  return items.map(normaliseTitle).filter((t): t is WatchTitle => t !== null);
}

export function normaliseDetail(data: unknown): WatchDetail | null {
  const d = obj(data);
  const base = normaliseTitle(d.subject);
  if (!base) return null;
  const seasons = Array.isArray(obj(d.resource).seasons) ? (obj(d.resource).seasons as unknown[]) : [];
  return {
    ...base,
    description: str(obj(d.subject).description),
    seasons: seasons
      .map((s) => ({ se: num(obj(s).se) ?? 0, maxEp: num(obj(s).maxEp) ?? 0 }))
      .filter((s) => s.se > 0 && s.maxEp > 0),
  };
}

/**
 * Full-length rule, shared with the server (supabase/functions/moviebox). A stream is rejected when its
 * source is a "Mobile Native" preview, when its duration is 300 seconds or less or unknown, or when its
 * size is 50 MB or less. Quality labels are not trusted: a 23-second preview can be labelled 1080p.
 */
export function isFullStream(s: Pick<WatchStream, 'source' | 'durationSec' | 'sizeMb'>): boolean {
  if ((s.source ?? '').toLowerCase().includes('mobile native')) return false;
  if (s.durationSec === null || s.durationSec <= 300) return false;
  if (s.sizeMb !== null && s.sizeMb <= 50) return false;
  return true;
}

/** Progressive MP4 first, then the higher quality. */
export function compareStreams(a: WatchStream, b: WatchStream): number {
  const fa = (a.format ?? '').toUpperCase() === 'MP4' ? 0 : 1;
  const fb = (b.format ?? '').toUpperCase() === 'MP4' ? 0 : 1;
  if (fa !== fb) return fa - fb;
  return (b.qualityValue ?? 0) - (a.qualityValue ?? 0);
}

/** Full-length streams only, best first. Never returns previews, and never assumes streams[0] is the title. */
export function normaliseStreams(data: unknown): WatchStreams {
  const d = obj(data);
  const streams = (Array.isArray(d.streams) ? d.streams : []).map(obj).flatMap((s): WatchStream[] => {
    const url = str(s.url);
    if (!url) return [];
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj(s.required_headers))) if (typeof v === 'string') headers[k] = v;
    return [
      {
        url,
        source: str(s.source),
        quality: str(s.quality),
        qualityValue: num(s.quality_value),
        format: str(s.format),
        codec: str(s.codec),
        sizeMb: num(s.size_mb),
        durationSec: num(s.duration_sec),
        requiredHeaders: headers,
      },
    ];
  });
  return { season: num(d.season), episode: num(d.episode), streams: streams.filter(isFullStream).sort(compareStreams) };
}

/** The stream to play: the requested quality when available, otherwise the best full-length stream. */
export function pickStream(streams: WatchStream[], quality?: string | null): WatchStream | undefined {
  const full = streams.filter(isFullStream).sort(compareStreams);
  return (quality ? full.find((s) => s.quality === quality) : undefined) ?? full[0];
}

/** Distinct qualities offered, best first. */
export function qualityOptions(streams: WatchStream[]): string[] {
  const sorted = streams.filter(isFullStream).sort(compareStreams);
  return [...new Set(sorted.map((s) => s.quality).filter((q): q is string => !!q))];
}

/** Only progressive MP4 links can be saved as a file. DASH manifests are never offered as downloads. */
export function isDownloadable(s: WatchStream): boolean {
  return (s.format ?? '').toUpperCase() === 'MP4' && /\.mp4(\?|$)/i.test(s.url);
}

