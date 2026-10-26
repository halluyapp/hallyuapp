/**
 * Hallyu TV — pure rules for the player and downloads. No native imports, so they run under
 * `node --test` (scripts/test-watch.mjs). Keep this file self-contained: the test loader transpiles
 * one file at a time.
 */

export const SKIP_MS = 10_000;
export const DOUBLE_TAP_WINDOW_MS = 300;
export const CONTROLS_AUTO_HIDE_MS = 3_500;
export const SAVE_PROGRESS_EVERY_MS = 10_000;
/** Lowest-data option we will pick automatically, and the default preference order. */
export const AUTO_QUALITY_ORDER = ['480p', '360p'];

/** Formats a position or duration as m:ss, or h:mm:ss past one hour. Negative and NaN values read as 0:00. */
export function formatClock(ms: number | null | undefined): string {
  const total = Number.isFinite(ms) && (ms as number) > 0 ? Math.floor((ms as number) / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Clamps a seek target to [0, duration]. An unknown duration (0) keeps the target at or above zero. */
export function seekTarget(currentMs: number, deltaMs: number, durationMs: number): number {
  const next = Math.max(0, currentMs + deltaMs);
  return durationMs > 0 ? Math.min(next, durationMs) : next;
}

/** Maps a touch x-position to the timeline fraction in [0, 1]. */
export function fractionAt(x: number, width: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return 0;
  return Math.min(1, Math.max(0, x / width));
}

/** Which third of the video a tap landed in. Left and right drive skip gestures; centre toggles controls. */
export function tapZone(x: number, width: number): 'left' | 'centre' | 'right' {
  const f = fractionAt(x, width);
  if (f < 0.35) return 'left';
  if (f > 0.65) return 'right';
  return 'centre';
}

/**
 * Picks the quality to play. A requested quality is used only when the title offers it. Otherwise the
 * preferred one, then the data-conscious defaults (480p, 360p), then the best offered. Never invents a
 * quality that is not in `available`.
 */
export function chooseQuality(available: string[], preferred?: string | null): string | null {
  if (available.length === 0) return null;
  if (preferred && available.includes(preferred)) return preferred;
  for (const q of AUTO_QUALITY_ORDER) if (available.includes(q)) return q;
  return available[0];
}

/** Parses "1080p" → 1080. Unknown labels return null rather than a guessed number. */
export function qualityRank(label: string | null | undefined): number | null {
  const m = /^(\d{3,4})p$/i.exec((label ?? '').trim());
  return m ? Number(m[1]) : null;
}

/** Highest-first ordering of quality labels. Unknown labels sort last, keeping their original order. */
export function sortQualities(labels: string[]): string[] {
  return [...new Set(labels)]
    .map((label, index) => ({ label, index, rank: qualityRank(label) }))
    .sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1) || a.index - b.index)
    .map((x) => x.label);
}

/* ---------- Downloads ---------- */

export type TransferStatus = 'queued' | 'downloading' | 'paused' | 'failed' | 'completed';

export interface TransferSnapshot {
  status: TransferStatus;
  bytesWritten: number;
  totalBytes: number | null;
}

/** A download is complete only when the bytes on disk match the server's length, when that length is known. */
export function transferComplete(bytesOnDisk: number, expectedBytes: number | null): boolean {
  if (!Number.isFinite(bytesOnDisk) || bytesOnDisk <= 0) return false;
  if (expectedBytes === null || expectedBytes <= 0) return true;
  return bytesOnDisk === expectedBytes;
}

/**
 * ISO base media files store "ftyp" at byte 4. This checks the header, not the URL or file name, so an
 * HTML error page or a truncated response cannot pass as a video.
 */
export function isMp4Header(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70; // "ftyp"
}

/** Human size. Returns "Size unavailable" for null, negative, or NaN values. Never guesses a size. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return 'Size unavailable';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Progress fraction, or null when the total is unknown. Never shows a percentage for an unknown total. */
export function progressFraction(bytesWritten: number, totalBytes: number | null): number | null {
  if (totalBytes === null || totalBytes <= 0) return null;
  return Math.min(1, Math.max(0, bytesWritten / totalBytes));
}

/** Only one active transfer per title and quality. A finished copy must be removed before downloading again. */
export function canStartDownload(
  existing: { key: string; quality: string | null; status: TransferStatus }[],
  completed: { key: string; quality: string | null }[],
  key: string,
  quality: string | null,
): { ok: true } | { ok: false; reason: 'already_downloading' | 'already_downloaded' } {
  if (existing.some((t) => t.key === key && t.quality === quality && (t.status === 'downloading' || t.status === 'paused' || t.status === 'queued'))) {
    return { ok: false, reason: 'already_downloading' };
  }
  if (completed.some((c) => c.key === key && c.quality === quality)) return { ok: false, reason: 'already_downloaded' };
  return { ok: true };
}

/** Legal state changes for a transfer. Prevents, for example, a completed download from being paused. */
export function canTransition(from: TransferStatus, to: TransferStatus): boolean {
  const table: Record<TransferStatus, TransferStatus[]> = {
    queued: ['downloading', 'failed'],
    downloading: ['paused', 'failed', 'completed'],
    paused: ['downloading', 'failed'],
    failed: ['downloading', 'queued'],
    completed: [],
  };
  return table[from].includes(to);
}

/** Largest number of automatic continuations for one transfer before it is reported as failed. */
export const MAX_AUTO_CONTINUES = 6;

export type AfterTransfer =
  | { action: 'complete' }
  | { action: 'continue'; fromBytes: number }
  | { action: 'restart' }
  | { action: 'fail'; reason: 'link_expired' | 'http_error' | 'network' | 'unknown' };

/**
 * Decides what to do after one HTTP transfer ends. A transfer that stops early (the connection closed
 * before the server's content-length) is continued with a Range request from the bytes already on disk.
 * If the server ignores Range on a continuation (answers 200 with the whole file), the appended file is
 * corrupt, so it is restarted from zero. Expired links and HTTP errors are never retried silently.
 */
export function decideAfterTransfer(input: {
  status: number;
  /** Bytes already on disk when this request began (0 for a fresh download). */
  startBytes: number;
  /** Bytes on disk now. */
  bytesOnDisk: number;
  /** The server's content-length total, or null when unknown. */
  expectedBytes: number | null;
  /** Automatic continuations already used for this transfer. */
  continues: number;
}): AfterTransfer {
  const { status, startBytes, bytesOnDisk, expectedBytes, continues } = input;
  if (status === 401 || status === 403) return { action: 'fail', reason: 'link_expired' };
  if (status < 200 || status >= 300) return { action: 'fail', reason: 'http_error' };

  // A continuation answered 200 instead of 206: the server ignored Range and the file is now corrupt.
  if (startBytes > 0 && status === 200) {
    return continues < MAX_AUTO_CONTINUES ? { action: 'restart' } : { action: 'fail', reason: 'network' };
  }
  if (expectedBytes !== null && expectedBytes > 0) {
    if (bytesOnDisk === expectedBytes) return { action: 'complete' };
    if (bytesOnDisk > expectedBytes) {
      return continues < MAX_AUTO_CONTINUES ? { action: 'restart' } : { action: 'fail', reason: 'network' };
    }
    // Short: the connection stopped early. Continue from the bytes on disk.
    if (bytesOnDisk > 0 && continues < MAX_AUTO_CONTINUES) return { action: 'continue', fromBytes: bytesOnDisk };
    return { action: 'fail', reason: 'network' };
  }
  // Length unknown: the file cannot be verified as whole, so it is never marked complete.
  return { action: 'fail', reason: 'unknown' };
}

/** Reads the full file length from a `Range: bytes=0-0` response: `Content-Range: bytes 0-0/12345`. */
export function totalFromContentRange(contentRange: string | null | undefined): number | null {
  const m = /\/(\d+)\s*$/.exec(contentRange ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Failure text for the Downloads screen. It says where the transfer stopped, so the user can tell a short file from a bad link. */
export function stoppedMessage(bytes: number, total: number | null, status: number): string {
  const where = total ? `${formatBytes(bytes)} of ${formatBytes(total)}` : `${formatBytes(bytes)} (total size unknown)`;
  return `Stopped at ${where} (server status ${status}). Tap resume to continue.`;
}
