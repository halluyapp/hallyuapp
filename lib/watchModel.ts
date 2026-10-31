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

/** A subject record as the catalog returns it (`subject` nested or flat, zarhosting or legacy). */
export function normaliseTitle(raw: unknown): WatchTitle | null {
  const r = obj(raw);
  const s = r.subject && typeof r.subject === 'object' ? obj(r.subject) : r;
  const subjectId = str(s.subjectId) ?? str(r.subjectId) ?? str(s.subject_id) ?? str(r.subject_id);
  const title = str(s.title) ?? str(r.title) ?? str(s.name) ?? str(r.name) ?? str(s.base_title) ?? str(r.base_title);
  if (!subjectId || !title) return null;
  const coverUrl = str(obj(s.cover).url) ?? str(obj(r.cover).url) ?? str(obj(r.image).url) ?? str(s.poster_url) ?? str(r.poster_url);
  const releaseDate = str(s.releaseDate) ?? str(r.releaseDate) ?? str(s.release_date) ?? str(r.release_date) ?? str(s.year) ?? str(r.year);
  const rating = str(s.imdbRatingValue) ?? str(r.imdbRatingValue) ?? str(s.imdbRate) ?? str(r.imdbRate) ?? str(s.rating) ?? str(r.rating);
  const detailPath = str(s.detailPath) ?? str(r.detailPath) ?? str(s.detail_path) ?? str(r.detail_path) ?? str(s.slug) ?? str(r.slug);
  const countryName = str(s.countryName) ?? str(r.countryName) ?? str(s.country) ?? str(r.country);
  return {
    subjectId,
    title,
    cover: coverUrl,
    genre: str(s.genre) ?? str(r.genre),
    releaseDate,
    rating,
    detailPath,
    countryName,
  };
}

/** Home is a list of operating rows or zarhosting sections. */
export function normaliseHome(data: unknown): WatchRow[] {
  const d = obj(data);
  const rows: WatchRow[] = [];

  if (Array.isArray(d.sections)) {
    for (const rawSec of d.sections) {
      const sec = obj(rawSec);
      const title = str(sec.section) ?? str(sec.title);
      const items = (Array.isArray(sec.items) ? sec.items : []).map(normaliseTitle).filter((t): t is WatchTitle => t !== null);
      if (title && items.length > 0) rows.push({ title, items });
    }
    if (rows.length > 0) return rows;
  }

  const list = Array.isArray(d.operatingList) ? (d.operatingList as unknown[]) : [];
  for (const rawRow of list) {
    const row = obj(rawRow);
    const source = Array.isArray(row.subjects) && row.subjects.length > 0 ? row.subjects : Array.isArray(obj(row.banner).items) ? (obj(row.banner).items as unknown[]) : [];
    const items = source.map(normaliseTitle).filter((t): t is WatchTitle => t !== null);
    const title = str(row.title);
    if (title && items.length > 0) rows.push({ title, items });
  }
  return rows;
}

/** Search returns items array of catalog subjects. */
export function normaliseSearch(data: unknown): WatchTitle[] {
  const d = obj(data);
  const items = Array.isArray(d.items) ? d.items : Array.isArray(obj(d.data).items) ? (obj(d.data).items as unknown[]) : [];
  return items.map(normaliseTitle).filter((t): t is WatchTitle => t !== null);
}

export function normaliseDetail(data: unknown): WatchDetail | null {
  const d = obj(data);
  const source = obj(d.data).subject ? obj(d.data) : d;
  const base = normaliseTitle(source.subject ?? source);
  if (!base) return null;
  const seasons = Array.isArray(obj(source.resource).seasons) ? (obj(source.resource).seasons as unknown[]) : [];
  return {
    ...base,
    description: str(obj(source.subject ?? source).description),
    seasons: seasons
      .map((s) => ({ se: num(obj(s).se) ?? 0, maxEp: num(obj(s).maxEp) ?? 0 }))
      .filter((s) => s.se > 0 && s.maxEp > 0),
  };
}

/**
 * Full-length rule. A stream is dropped when its source is a "Mobile Native" preview, or when it is
 * both short (300 seconds or less) and small (50 MB or less).
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

/** Full-length streams only, best first. */
export function normaliseStreams(data: unknown): WatchStreams {
  const d = obj(data);
  const rawList = Array.isArray(d.sources) ? d.sources : Array.isArray(d.streams) ? d.streams : [];
  const streams = rawList.map(obj).map((s): WatchStream => {
    const quality = str(s.resolution) ?? str(s.quality);
    const qualityValue = num(s.quality_value) ?? (quality ? parseInt(quality, 10) || null : null);
    const rawSize = s.size_mb ?? s.size;
    const sizeMb = typeof rawSize === 'number'
      ? (rawSize > 50000 ? rawSize / (1024 * 1024) : rawSize)
      : typeof rawSize === 'string'
      ? parseFloat(rawSize) > 50000 ? parseFloat(rawSize) / (1024 * 1024) : parseFloat(rawSize)
      : null;
    const durationSec = num(s.duration_sec) ?? num(s.duration) ?? (typeof s.duration === 'string' ? parseFloat(s.duration) : null);
    return {
      source: str(s.source) ?? 'Zarhosting CDN',
      quality,
      qualityValue,
      format: str(s.format) ?? 'MP4',
      codec: str(s.codec),
      sizeMb: sizeMb !== null && Number.isFinite(sizeMb) ? Math.round(sizeMb * 10) / 10 : null,
      durationSec,
    };
  });
  return {
    season: num(d.season) ?? num(d.se),
    episode: num(d.episode) ?? num(d.ep),
    streams: streams.filter(isFullStream).sort(compareStreams),
  };
}

/** Validates a `playback` response or direct CDN source with full-length checks. */
export function normalisePlayback(data: unknown): WatchPlayback | null {
  const d = obj(data);
  const playbackUrl = str(d.playback_url) ?? str(d.url);
  const downloadUrl = str(d.download_url) ?? str(d.url);
  if (!playbackUrl || !downloadUrl || !playbackUrl.startsWith('https://') || !downloadUrl.startsWith('https://')) return null;
  const durationSec = num(d.duration_sec) ?? num(d.duration) ?? (typeof d.duration === 'string' ? parseFloat(d.duration) : null);
  const rawSize = d.size_mb ?? d.size;
  const sizeMb = typeof rawSize === 'number'
    ? (rawSize > 50000 ? rawSize / (1024 * 1024) : rawSize)
    : typeof rawSize === 'string'
    ? parseFloat(rawSize) > 50000 ? parseFloat(rawSize) / (1024 * 1024) : parseFloat(rawSize)
    : null;
  if (!isFullStream({ source: str(d.source), durationSec, sizeMb })) return null;
  return {
    playbackUrl,
    downloadUrl,
    quality: str(d.quality) ?? str(d.resolution),
    format: str(d.format) ?? 'MP4',
    durationSec: (durationSec ?? 0) as number,
    sizeMb: sizeMb !== null && Number.isFinite(sizeMb) ? Math.round(sizeMb * 10) / 10 : null,
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


