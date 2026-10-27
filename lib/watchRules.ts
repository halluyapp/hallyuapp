/**
 * Hallyu TV — pure rules for the player and downloads. No native imports, so they run under
 * `node --test` (scripts/test-watch.mjs). Keep this file self-contained: the test loader transpiles
 * one file at a time.
 */

export const SKIP_MS = 10_000;
export const DOUBLE_TAP_WINDOW_MS = 300;
export const CONTROLS_AUTO_HIDE_MS = 3_500;
export const SAVE_PROGRESS_EVERY_MS = 10_000;
/** A transfer with no forward progress for this long is reported as an error, never an endless spinner. */
export const BUFFER_STALL_MS = 20_000;
/**
 * The one data-conscious quality rule, in step with `DEFAULT_QUALITIES` in lib/watchModel.ts:
 * 360p first, else the lowest quality the title actually offers.
 */
export const DEFAULT_QUALITY_ORDER = ['360p'];

/** Drops opaque Expo resume state from legacy persisted records; it may contain a signed URL. */
export function withoutPersistedResumeData<T extends { resumeData?: unknown }>(entry: T): Omit<T, 'resumeData'> {
  const { resumeData: _legacy, ...safe } = entry;
  return safe;
}

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
 * Picks the quality to play. A requested quality is used only when the title offers it. Otherwise 360p,
 * then the lowest quality offered. Never invents a quality that is not in `available`, and never picks
 * a higher quality than the viewer asked for.
 */
export function chooseQuality(available: string[], preferred?: string | null): string | null {
  if (available.length === 0) return null;
  if (preferred && available.includes(preferred)) return preferred;
  for (const q of DEFAULT_QUALITY_ORDER) if (available.includes(q)) return q;
  return [...available].sort((a, b) => (qualityRank(a) ?? Number.MAX_SAFE_INTEGER) - (qualityRank(b) ?? Number.MAX_SAFE_INTEGER))[0];
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

/** Stable file/task identity for a title, episode, and quality; distinct encodings prevent path collisions. */
export function qualityDownloadKey(subjectId: string, season: number | null, episode: number | null, quality: string | null): string {
  const encodedQuality = Array.from(quality || 'auto', (c) => (c.codePointAt(0) ?? 0).toString(16)).join('-');
  return `${subjectId}:${season ?? 0}:${episode ?? 0}:q:${encodedQuality}`;
}

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
    paused: ['downloading', 'queued', 'failed'],
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
  /** The first byte the server says it sent (from Content-Range), or null when the response gave none. */
  contentRangeStart?: number | null;
}): AfterTransfer {
  const { status, startBytes, bytesOnDisk, expectedBytes, continues, contentRangeStart = null } = input;
  // 416 on a continuation means the requested offset is already the end of the file: the file is whole.
  if (status === 416 && expectedBytes !== null && bytesOnDisk === expectedBytes) return { action: 'complete' };
  if (status === 401 || status === 403) return { action: 'fail', reason: 'link_expired' };
  if (status < 200 || status >= 300) return { action: 'fail', reason: 'http_error' };

  // A continuation answered 200 instead of 206: the server ignored Range and the file is now corrupt.
  if (startBytes > 0 && status === 200) {
    return continues < MAX_AUTO_CONTINUES ? { action: 'restart' } : { action: 'fail', reason: 'network' };
  }
  // A 206 that starts somewhere other than the requested byte would be appended at the wrong offset.
  if (startBytes > 0 && status === 206 && contentRangeStart !== null && contentRangeStart !== startBytes) {
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

/** Failure text when the connection drops mid-transfer and the exact server status is unknown. */
export function lostMessage(bytes: number, total: number | null): string {
  const where = total ? `${formatBytes(bytes)} of ${formatBytes(total)}` : formatBytes(bytes);
  return `Connection lost at ${where}. Tap retry to start a fresh transfer safely.`;
}

/** Failure text for the Downloads screen. It says where the transfer stopped, so the user can tell a short file from a bad link. */
export function stoppedMessage(bytes: number, total: number | null, status: number): string {
  const where = total ? `${formatBytes(bytes)} of ${formatBytes(total)}` : `${formatBytes(bytes)} (total size unknown)`;
  return `Stopped at ${where} (server status ${status}). Tap retry to restart safely.`;
}

/** Text for a download notification. Progress shows a percentage; failures and pauses show the reason. */
export type NoticeKind = 'progress' | 'paused' | 'failed' | 'done';

export function progressNotice(kind: NoticeKind, title: string, percent: number, message: string | null): { title: string; body: string } {
  const name = title.trim() || 'Download';
  if (kind === 'done') return { title: 'Download complete', body: `${name} is saved on this device.` };
  if (kind === 'failed') return { title: 'Download stopped', body: message ?? `${name} stopped. Open Downloads to retry.` };
  if (kind === 'paused') return { title: 'Download paused', body: `${name} · ${percent}%` };
  return { title: 'Downloading', body: `${name} · ${percent}%` };
}

/**
 * New volume (0 to 1) after a vertical swipe on the player. Swiping up the full height of the player raises
 * the volume by a full range. The result is clamped and rounded to whole percent.
 */
export function volumeAfterSwipe(startVolume: number, dy: number, height: number): number {
  if (!Number.isFinite(startVolume) || !Number.isFinite(dy) || !(height > 0)) return clamp01(startVolume);
  const next = clamp01(startVolume - dy / (height * 0.8));
  return Math.round(next * 100) / 100;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
}

/**
 * A transfer loaded from storage, after the app restarted. Storage may say "downloading" or "queued" for work
 * that is no longer running. `running` and `queued` say what is still alive in memory.
 */
export function repairTransfer<T extends { status: TransferStatus; error: string | null }>(
  t: T,
  live: { running: boolean; queued: boolean },
): T {
  if (t.status === 'downloading' && !live.running) return { ...t, status: 'paused', error: null };
  if (t.status === 'queued' && !live.queued) {
    return { ...t, status: 'failed', error: 'This download was waiting in the queue when the app closed. Tap retry to start it.' };
  }
  return t;
}

/* ---------- Deterministic player states ---------- */

/**
 * The six states the player can be in, and exactly one is displayed:
 *   loading      a stream link is being fetched, or the video has not reported a frame yet
 *   buffering    the player is running but has no data to show yet (bounded by BUFFER_STALL_MS)
 *   playing      frames are advancing
 *   paused       ready, not advancing
 *   error        something recoverable broke (a stall, a dropped link, a failed load) — retry applies
 *   unavailable  there is nothing to play at all (no full-length stream, not signed in, not configured)
 * `unavailable` is deliberately separate from `error`: it is never retried, because retrying cannot help.
 */
export type PlayerState = 'loading' | 'buffering' | 'playing' | 'paused' | 'error' | 'unavailable';

/** Milliseconds without forward progress while buffering. Always 0 when the player is not buffering. */
export function stalledForMs(nowMs: number, lastProgressAtMs: number, isBuffering: boolean): number {
  if (!isBuffering || !Number.isFinite(nowMs) || !Number.isFinite(lastProgressAtMs)) return 0;
  return Math.max(0, nowMs - lastProgressAtMs);
}

/** Resolves exactly one player state from what the player reported. No I/O, and no guessing. */
export function playerState(input: {
  hasSource: boolean;
  loading: boolean;
  unavailable: boolean;
  failed: boolean;
  isPlaying: boolean;
  isBuffering: boolean;
  /** Milliseconds without progress. A long stall is an error, never a silent spinner. */
  stalledMs?: number | null;
}): PlayerState {
  if (input.unavailable) return 'unavailable';
  if (input.failed) return 'error';
  if (input.loading || !input.hasSource) return 'loading';
  if (input.isBuffering) return (input.stalledMs ?? 0) >= BUFFER_STALL_MS ? 'error' : 'buffering';
  return input.isPlaying ? 'playing' : 'paused';
}

/** True for the reasons retrying can never fix: the title has nothing playable for this viewer. */
export function isUnavailableReason(reason: string | null | undefined): boolean {
  return reason === 'no_full_stream' || reason === 'not_configured' || reason === 'signed_out';
}

/** The one line of copy per failure reason, so every Watch surface says the same thing. */
export function watchErrorMessage(reason: string | null | undefined, quality?: string | null): string {
  if (reason === 'no_full_stream') {
    return quality ? `No full-length stream is available at ${quality} right now.` : 'No full-length stream is available for this title right now.';
  }
  if (reason === 'signed_out') return 'Sign in to watch Hallyu TV.';
  if (reason === 'offline') return 'You are offline. Connect to stream, or play a downloaded copy.';
  if (reason === 'not_configured') return 'Hallyu TV is not set up yet.';
  if (reason === 'stalled') return 'Playback stalled and did not recover. Check your connection, then tap Try again.';
  return 'This stream could not be loaded. Check your connection and try again.';
}

/* ---------- TTL cache (shared by the Watch client) ---------- */

export interface TtlEntry<T> {
  value: T;
  until: number;
}

/**
 * Stores a bounded, expiring cache entry. A non-positive TTL stores nothing, which is how a caller
 * says "never remember this". Oldest entry is evicted once the map is full.
 */
export function ttlPut<T>(map: Map<string, TtlEntry<T>>, key: string, value: T, ttlMs: number, nowMs = Date.now(), maxEntries = 128): void {
  if (!(ttlMs > 0)) {
    map.delete(key);
    return;
  }
  if (maxEntries > 0 && map.size >= maxEntries && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, { value, until: nowMs + ttlMs });
}

/** The cached value while it is inside its window, else null (and the expired entry is dropped). */
export function ttlGet<T>(map: Map<string, TtlEntry<T>>, key: string, nowMs = Date.now()): T | null {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.until <= nowMs) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

/* ---------- Download targets (Play and Download beside each other) ---------- */

export interface DownloadTarget {
  key: string;
  quality: string | null;
  /** Bytes of a finished file for this exact title/season/episode/quality, or null. */
  savedBytes: number | null;
  /** The state of a transfer for this exact title/quality, or null. */
  transferStatus: TransferStatus | null;
  /** A new transfer may be started for this quality right now. */
  canStart: boolean;
}

/**
 * One entry per quality the title offers. Qualities are independent: a saved or running 360p copy never
 * blocks a 480p download, and the two files never share a key or a path.
 */
export function downloadTargets(input: {
  subjectId: string;
  season: number | null;
  episode: number | null;
  qualities: (string | null)[];
  saved: { key: string; quality: string | null; bytes: number }[];
  transfers: { key: string; quality: string | null; status: TransferStatus }[];
}): DownloadTarget[] {
  const seen = new Set<string>();
  const out: DownloadTarget[] = [];
  for (const quality of input.qualities) {
    const key = qualityDownloadKey(input.subjectId, input.season, input.episode, quality);
    if (seen.has(key)) continue;
    seen.add(key);
    const saved = input.saved.find((d) => d.key === key && d.quality === quality) ?? null;
    const active = input.transfers.find((t) => t.key === key && t.quality === quality) ?? null;
    out.push({
      key,
      quality,
      savedBytes: saved ? saved.bytes : null,
      transferStatus: active ? active.status : null,
      canStart: !saved && (active === null || active.status === 'failed'),
    });
  }
  return out;
}
