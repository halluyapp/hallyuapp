/**
 * Hallyu Watch — pure response model for the `moviebox` edge function. No I/O and no client imports,
 * so the normalisers can be tested without Supabase. Shapes match the live responses verified on
 * 2026-10-24 and 2026-10-25.
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

/** Stream metadata from the `stream` action. It never carries a URL or headers. */
export interface WatchStream {
  source: string | null;
  quality: string | null;
  qualityValue: number | null;
  format: string | null;
  codec: string | null;
  sizeMb: number | null;
  durationSec: number | null;
}

/** A playable link from the `playback` action. The URLs are proxy links with a sealed token. */
export interface WatchPlayback {
  playbackUrl: string;
  downloadUrl: string;
  quality: string | null;
  format: string | null;
  durationSec: number;
  sizeMb: number | null;
  qualities: string[];
  expiresAt: number | null;
}

export interface WatchStreams {
  season: number | null;
  episode: number | null;
  streams: WatchStream[];
}

/** One upstream candidate, as the server describes it. Metadata only: no URLs, no headers. */
export interface WatchDiagnostic {
  host: string | null;
  source: string | null;
  format: string | null;
  quality: string | null;
  durationSec: number | null;
  sizeMb: number | null;
  hostAllowed: boolean;
  full: boolean;
}

export type WatchResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'offline' | 'signed_out' | 'not_configured' | 'not_found' | 'no_full_stream' | 'timeout' | 'failed'; diagnostics?: WatchDiagnostic[] };

/** Maps the server's diagnostics (snake_case) to the client shape. */
export function normaliseDiagnostics(data: unknown): WatchDiagnostic[] {
  return (Array.isArray(data) ? data : []).map(obj).map((d) => ({
    host: str(d.host),
    source: str(d.source),
    format: str(d.format),
    quality: str(d.quality),
    durationSec: num(d.duration_sec),
    sizeMb: num(d.size_mb),
    hostAllowed: d.host_allowed === true,
    full: d.full === true,
  }));
}

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
 * Full-length rule, shared with the server (supabase/functions/moviebox, isFullCandidate). A stream is
 * dropped when its source is a "Mobile Native" preview, or when it is both short (300 seconds or less) and
 * small (50 MB or less), with an unknown value counting as failing. Quality labels are never trusted.
 */
export function isFullStream(s: Pick<WatchStream, 'source' | 'durationSec' | 'sizeMb'>): boolean {
  if ((s.source ?? '').toLowerCase().includes('mobile native')) return false;
  // Kept when the duration is over 5 minutes OR the size is over 50 MB. Dropped only when both fail.
  const longEnough = s.durationSec !== null && s.durationSec > 300;
  const bigEnough = s.sizeMb !== null && s.sizeMb > 50;
  return longEnough || bigEnough;
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
  const streams = (Array.isArray(d.streams) ? d.streams : []).map(obj).map((s): WatchStream => ({
    source: str(s.source),
    quality: str(s.quality),
    qualityValue: num(s.quality_value),
    format: str(s.format),
    codec: str(s.codec),
    sizeMb: num(s.size_mb),
    durationSec: num(s.duration_sec),
  }));
  return { season: num(d.season), episode: num(d.episode), streams: streams.filter(isFullStream).sort(compareStreams) };
}

/**
 * Validates a `playback` response with the same full-length rule. Anything that is not a proxy link
 * with a full duration (and a size above 50 MB when reported) is rejected, so a short clip never plays.
 */
export function normalisePlayback(data: unknown): WatchPlayback | null {
  const d = obj(data);
  const playbackUrl = str(d.playback_url);
  const downloadUrl = str(d.download_url);
  if (!playbackUrl || !downloadUrl || !playbackUrl.startsWith('https://') || !downloadUrl.startsWith('https://')) return null;
  const durationSec = num(d.duration_sec);
  const sizeMb = num(d.size_mb);
  // The server already removed "Mobile Native" previews. This response carries no source label, so only duration and size are checked here.
  if (!isFullStream({ source: null, durationSec, sizeMb })) return null;
  return {
    playbackUrl,
    downloadUrl,
    quality: str(d.quality),
    format: str(d.format),
    durationSec: durationSec as number,
    sizeMb,
    qualities: (Array.isArray(d.qualities) ? d.qualities : []).filter((q): q is string => typeof q === 'string'),
    expiresAt: num(d.expires_at),
  };
}

/** Default quality on phones and web: 360p, to keep data use and start-up time low. */
export const DEFAULT_QUALITIES = ['360p'];

/**
 * The stream to play: the requested quality when available. Otherwise 360p. If the title has no 360p,
 * its lowest full-length quality. The viewer can pick a higher quality from the quality chips.
 */
export function pickStream(streams: WatchStream[], quality?: string | null): WatchStream | undefined {
  const full = streams.filter(isFullStream).sort(compareStreams);
  const requested = quality ? full.find((s) => s.quality === quality) : undefined;
  if (requested) return requested;
  for (const q of DEFAULT_QUALITIES) {
    const s = full.find((x) => x.quality === q);
    if (s) return s;
  }
  // Lowest available: compareStreams sorts best first, so the last full-length stream is the lowest.
  return full[full.length - 1];
}

/** Distinct qualities offered, best first. */
export function qualityOptions(streams: WatchStream[]): string[] {
  const sorted = streams.filter(isFullStream).sort(compareStreams);
  return [...new Set(sorted.map((s) => s.quality).filter((q): q is string => !!q))];
}

/** Only progressive MP4 can be saved as a file. DASH is never offered as a download. */
export function isDownloadable(s: Pick<WatchStream, 'format'>): boolean {
  return (s.format ?? '').toUpperCase() === 'MP4';
}


