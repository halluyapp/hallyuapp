/**
 * Hallyu TV — local state: resume progress (Continue Watching), private downloads, and transfers.
 *
 * Downloads live in the app's private document directory and are never added to the device photo library.
 * The signed Android APK uses Android DownloadManager for background transfers; other builds use the
 * foreground Expo transfer and require the app to remain open. Expired links are refreshed before retry.
 * Opaque byte counts and Expo resume blobs are never persisted as Range data: partials are retained
 * for diagnosis, then retried from zero with a newly minted URL.
 * A transfer is complete only when the byte count matches the server's length and the file starts with an MP4 header.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { clearDownloadNotice, reportDownload } from './watchNotify';
import { fetchWatchDownloadUrl } from './api/moviebox';
import { nativeDownloader } from './watchNative';
import { decodeBase64 } from './textEncoding';
import {
  canStartDownload,
  canTransition,
  decideAfterTransfer,
  MIN_PLAYABLE_BYTES,
  validateMp4Layout,
  lostMessage,
  repairTransfer,
  qualityDownloadKey,
  stoppedMessage,
  totalFromContentRange,
  withoutPersistedResumeData,
  type TransferStatus,
} from './watchRules';

const PROGRESS_KEY = 'watch.progress.v1';
const DOWNLOADS_KEY = 'watch.downloads.v1';
const TRANSFERS_KEY = 'watch.transfers.v1';
const DOWNLOAD_DIR = `${FileSystem.documentDirectory ?? ''}watch-downloads/`;
/** Free space we keep in reserve before starting a download of known size. */
const STORAGE_RESERVE_BYTES = 200 * 1024 * 1024;
const PROGRESS_THROTTLE_MS = 1000;

export interface WatchEpisodeRef {
  subjectId: string;
  title: string;
  cover: string | null;
  detailPath: string | null;
  season: number | null;
  episode: number | null;
}

export interface ProgressEntry extends WatchEpisodeRef {
  key: string;
  positionMs: number;
  durationMs: number;
  updatedAt: number;
}

/** What a download needs: the proxy download link from `playback`, and the quality label. */
export interface DownloadSource {
  downloadUrl: string;
  quality: string | null;
}

export interface DownloadEntry extends WatchEpisodeRef {
  key: string;
  fileUri: string;
  bytes: number;
  quality: string | null;
  savedAt: number;
}

/** A download that is not finished yet: active, paused, or failed. Completed files are DownloadEntry. */
export interface TransferEntry extends WatchEpisodeRef {
  key: string;
  quality: string | null;
  fileUri: string;
  status: TransferStatus;
  bytesWritten: number;
  totalBytes: number | null;
  error: string | null;
  updatedAt: number;
  /** 'native': Android DownloadManager runs it (survives the app closing). 'expo': foreground transfer. */
  engine?: 'native' | 'expo';
  /** Android DownloadManager is waiting on network/power constraints; still owned by the system. */
  nativeWaiting?: boolean;
}

export type TransferFailure = 'insufficient_storage' | 'already_downloading' | 'already_downloaded' | 'link_expired' | 'network' | 'invalid_file' | 'http_error' | 'unknown';

export function episodeKey(subjectId: string, season: number | null, episode: number | null): string {
  return `${subjectId}:${season ?? 0}:${episode ?? 0}`;
}

/** Download identity includes quality; episode progress intentionally does not. */
export function downloadKey(subjectId: string, season: number | null, episode: number | null, quality: string | null): string {
  return qualityDownloadKey(subjectId, season, episode, quality);
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

/* ---------- Continue Watching ---------- */

export async function listProgress(): Promise<ProgressEntry[]> {
  const all = await readJson<ProgressEntry[]>(PROGRESS_KEY, []);
  // Finished episodes (over 95%) drop off the rail.
  return all.filter((p) => p.durationMs > 0 && p.positionMs / p.durationMs < 0.95 && p.positionMs > 5000).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProgress(key: string): Promise<ProgressEntry | null> {
  const all = await readJson<ProgressEntry[]>(PROGRESS_KEY, []);
  return all.find((p) => p.key === key) ?? null;
}

export async function saveProgress(ref: WatchEpisodeRef, positionMs: number, durationMs: number): Promise<void> {
  if (!Number.isFinite(positionMs) || !Number.isFinite(durationMs) || durationMs <= 0) return;
  const key = episodeKey(ref.subjectId, ref.season, ref.episode);
  const all = await readJson<ProgressEntry[]>(PROGRESS_KEY, []);
  const next: ProgressEntry = { ...ref, key, positionMs: Math.max(0, positionMs), durationMs, updatedAt: Date.now() };
  await writeJson(PROGRESS_KEY, [next, ...all.filter((p) => p.key !== key)].slice(0, 30));
}

/* ---------- Completed downloads ---------- */

export function downloadsSupported(): boolean {
  return Platform.OS !== 'web' && !!FileSystem.documentDirectory;
}

let completedCache: DownloadEntry[] | null = null;
const completedListeners = new Set<Listener>();

export async function listDownloads(forceRefresh = false): Promise<DownloadEntry[]> {
  if (!forceRefresh && completedCache !== null) return completedCache;
  const all = await readJson<DownloadEntry[]>(DOWNLOADS_KEY, []);
  const checked = await Promise.all(
    all.map(async (d) => ((await FileSystem.getInfoAsync(d.fileUri).catch(() => ({ exists: false }))).exists ? d : null)),
  );
  const alive = checked.filter((d): d is DownloadEntry => d !== null);
  if (alive.length !== all.length) await writeJson(DOWNLOADS_KEY, alive);
  const sorted = alive.sort((a, b) => b.savedAt - a.savedAt);
  completedCache = sorted;
  return sorted;
}

export async function findDownload(subjectId: string, season: number | null, episode: number | null, quality?: string | null): Promise<DownloadEntry | null> {
  const all = await listDownloads();
  return all.find((d) => d.subjectId === subjectId && d.season === season && d.episode === episode && (quality === undefined || d.quality === quality)) ?? null;
}

export async function removeDownload(entry: DownloadEntry): Promise<void> {
  await FileSystem.deleteAsync(entry.fileUri, { idempotent: true }).catch(() => {});
  const all = await readJson<DownloadEntry[]>(DOWNLOADS_KEY, []);
  const next = all.filter((d) => d.key !== entry.key);
  await writeJson(DOWNLOADS_KEY, next);
  completedCache = next.sort((a, b) => b.savedAt - a.savedAt);
  notifyDownloads();
}

/** Subscribe to completed downloads changes (added or removed). */
export function subscribeCompletedDownloads(fn: Listener): () => void {
  completedListeners.add(fn);
  return () => completedListeners.delete(fn);
}

function notifyDownloads(): void {
  completedListeners.forEach((fn) => fn());
  notifyTransfers();
}

/* ---------- Transfers ---------- */

type Listener = () => void;
const transferListeners = new Set<Listener>();
export const transfersMemory = new Map<string, TransferEntry>();

function notifyTransfers(): void {
  transferListeners.forEach((fn) => fn());
}

/** Subscribe to transfer changes. Returns an unsubscribe function. */
export function subscribeTransfers(fn: Listener): () => void {
  transferListeners.add(fn);
  return () => transferListeners.delete(fn);
}

function stripLegacyResumeData(t: TransferEntry): TransferEntry {
  return withoutPersistedResumeData(t as TransferEntry & { resumeData?: unknown }) as TransferEntry;
}

export async function listTransfers(): Promise<TransferEntry[]> {
  const raw = await readJson<TransferEntry[]>(TRANSFERS_KEY, []);
  const all = raw.map(stripLegacyResumeData);
  // Overlay memory state for live byte counts without waiting for disk
  const overlaid = all.map((t) => transfersMemory.get(t.key) ?? t);
  for (const t of overlaid) {
    if (!transfersMemory.has(t.key)) transfersMemory.set(t.key, t);
  }
  // Native downloads may have finished while the app was closed. Checking them when the app opens picks that up.
  if (overlaid.some((t) => t.engine === 'native' && t.status === 'downloading')) ensureNativePoll();
  // A download that was "downloading" when the app closed is interrupted now, not still running.
  const repaired = overlaid.map((t) =>
    repairTransfer(t, { running: active.has(t.key) || t.engine === 'native', queued: queuedKeys.has(t.key) }),
  );
  if (JSON.stringify(repaired) !== JSON.stringify(raw)) await writeJson(TRANSFERS_KEY, repaired);
  return repaired.sort((a, b) => b.updatedAt - a.updatedAt);
}

function noticeTitle(t: TransferEntry): string {
  const episode = t.season && t.episode ? ` · S${t.season} E${t.episode}` : '';
  const quality = t.quality ? ` · ${t.quality}` : '';
  return `${t.title}${episode}${quality}`.slice(0, 110);
}

async function putTransfer(t: TransferEntry): Promise<void> {
  const safe = stripLegacyResumeData(t);
  transfersMemory.set(safe.key, safe);
  const raw = await readJson<TransferEntry[]>(TRANSFERS_KEY, []);
  const all = raw.map(stripLegacyResumeData);
  await writeJson(TRANSFERS_KEY, [safe, ...all.filter((x) => x.key !== safe.key)]);
  notifyTransfers();
  if (safe.status === 'downloading') void reportDownload(safe.key, noticeTitle(safe), 'progress', safe.bytesWritten, safe.totalBytes);
  else if (safe.status === 'paused') void reportDownload(safe.key, noticeTitle(safe), 'paused', safe.bytesWritten, safe.totalBytes);
  else if (safe.status === 'failed') void reportDownload(safe.key, noticeTitle(safe), 'failed', safe.bytesWritten, safe.totalBytes, safe.error);
}

async function dropTransfer(key: string): Promise<void> {
  transfersMemory.delete(key);
  const all = (await readJson<TransferEntry[]>(TRANSFERS_KEY, [])).map(stripLegacyResumeData);
  await writeJson(TRANSFERS_KEY, all.filter((x) => x.key !== key));
  notifyTransfers();
}

async function getTransfer(key: string): Promise<TransferEntry | null> {
  if (transfersMemory.has(key)) return transfersMemory.get(key)!;
  const t = (await readJson<TransferEntry[]>(TRANSFERS_KEY, [])).map(stripLegacyResumeData).find((x) => x.key === key) ?? null;
  if (t) transfersMemory.set(key, t);
  return t;
}

interface ActiveTransfer {
  resumable: FileSystem.DownloadResumable;
  /** Ephemeral signed link used only for the current foreground transfer. */
  url: string;
  paused: boolean;
  cancelled: boolean;
}
const active = new Map<string, ActiveTransfer>();
/** Links for queued transfers, in queue order. Held in memory only: a link is never written to storage. */
const queuedKeys = new Set<string>();

function fileUriFor(key: string): string {
  return `${DOWNLOAD_DIR}${key.replace(/[^A-Za-z0-9_-]/g, '_')}.mp4`;
}

async function failTransfer(key: string, reason: TransferFailure, message: string): Promise<void> {
  const t = await getTransfer(key);
  if (!t) return;
  await putTransfer({ ...t, status: 'failed', error: message, updatedAt: Date.now() });
  if (reason === 'invalid_file' || reason === 'insufficient_storage') {
    await FileSystem.deleteAsync(t.fileUri, { idempotent: true }).catch(() => {});
  }
}

/** Reads a header from an expo-file-system result, whichever casing the native side used. */
function headerOf(headers: Record<string, string> | undefined, name: string): string | null {
  if (!headers) return null;
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.replace(/(^|-)([a-z])/g, (m) => m.toUpperCase())] ?? null;
}

/** Validates a file whose bytes are all on disk, then records it as a completed download. */
/** Reads a byte range of a saved file. Empty when the range is past the end. */
async function readFileRange(fileUri: string, position: number, length: number): Promise<Uint8Array> {
  const b64 = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64, position, length }).catch(() => '');
  return b64 ? decodeBase64(b64) : new Uint8Array();
}

const INVALID_FILE_MESSAGES = {
  too_small: 'The file is too small to be a video. It was removed. Tap retry.',
  not_mp4: 'The file is not a playable video (it may be an error page). It was removed. Tap retry.',
  no_movie_box: 'The video file is incomplete (no movie index). It was removed. Tap retry.',
  size_mismatch: 'The file size does not match the server. It was removed. Tap retry.',
} as const;

async function finalize(key: string, t: TransferEntry, bytes: number): Promise<void> {
  // Structure, not size, decides whether the file is a video: boxes must parse to the exact end of the file,
  // begin with "ftyp", and contain "moov". Any HTML, JSON, truncated or expired-link body fails here.
  const verdict = await validateMp4Layout((p, n) => readFileRange(t.fileUri, p, n), bytes, bytes);
  if (!verdict.ok) {
    await FileSystem.deleteAsync(t.fileUri, { idempotent: true }).catch(() => {});
    return failTransfer(key, 'invalid_file', INVALID_FILE_MESSAGES[verdict.reason]);
  }
  const entry: DownloadEntry = {
    subjectId: t.subjectId,
    title: t.title,
    cover: t.cover,
    detailPath: t.detailPath,
    season: t.season,
    episode: t.episode,
    key,
    fileUri: t.fileUri,
    bytes,
    quality: t.quality,
    savedAt: Date.now(),
  };
  const done = await readJson<DownloadEntry[]>(DOWNLOADS_KEY, []);
  const updatedDone = [entry, ...done.filter((d) => !(d.key === key && d.quality === t.quality))];
  await writeJson(DOWNLOADS_KEY, updatedDone);
  completedCache = updatedDone.sort((a, b) => b.savedAt - a.savedAt);
  await dropTransfer(key);
  notifyDownloads();
  if (t.engine !== 'native') void reportDownload(key, noticeTitle(t), 'done', bytes, bytes);
}

/**
 * Runs one transfer to completion or interruption, then validates the file before marking it complete.
 * A short response is preserved as partial state; user retries restart from zero with a fresh signed URL.
 */
async function drive(
  key: string,
  run: () => Promise<FileSystem.FileSystemDownloadResult | undefined>,
  startBytes = 0,
  continues = 0,
): Promise<void> {
  try {
    const result = await run();
    const current = active.get(key);
    if (!current) return; // dropped by cancel
    if (current.paused) return; // paused by the user; the saved state is already stored
    if (current.cancelled) {
      active.delete(key);
      return;
    }

    const t = await getTransfer(key);
    if (!t) {
      active.delete(key);
      return;
    }
    if (!result) {
      active.delete(key);
      return failTransfer(key, 'unknown', 'The download stopped unexpectedly. Tap retry.');
    }

    const bytes = await bytesOnDisk(t.fileUri);
    const decision = decideAfterTransfer({
      status: result.status,
      startBytes: 0,
      bytesOnDisk: bytes,
      expectedBytes: t.totalBytes,
      continues,
      contentRangeStart: result.status === 206 ? contentRangeStartOf(headerOf(result.headers, 'content-range')) : null,
    });

    if (decision.action === 'continue') {
      // A byte count is not safe Expo resume data and must never become an HTTP Range offset.
      // Keep the partial for inspection; Retry fetches a new signed link and starts cleanly.
      active.delete(key);
      await putTransfer({ ...t, status: 'failed', bytesWritten: bytes, error: stoppedMessage(bytes, t.totalBytes, result.status), updatedAt: Date.now() });
      return;
    }
    if (decision.action === 'restart') {
      await FileSystem.deleteAsync(t.fileUri, { idempotent: true }).catch(() => {});
      const resumable = makeResumable(key, current.url, (w, total) => void updateBytes(key, w, total));
      active.set(key, { ...current, resumable });
      return drive(key, () => resumable.downloadAsync(), continues + 1);
    }

    active.delete(key);
    if (decision.action === 'fail') {
      const messages = {
        link_expired: 'The download link has expired. Tap retry to get a new one.',
        http_error: `The server returned an error (${result.status}). Tap retry.`,
        network: 'The download was interrupted before it finished. Tap retry to restart safely.',
        unknown: 'The server did not confirm the file size, so the download was not saved as complete. Tap retry.',
      } as const;
      const message = decision.reason === 'network' ? stoppedMessage(bytes, t.totalBytes, result.status) : messages[decision.reason];
      return failTransfer(key, decision.reason, message);
    }
    return finalize(key, t, bytes);
  } catch {
    const current = active.get(key);
    if (current && !current.paused && !current.cancelled) {
      active.delete(key);
      const t = await getTransfer(key);
      if (!t) return;
      // If the socket failed after the final byte, validate the complete file instead of retrying it.
      const bytes = await bytesOnDisk(t.fileUri);
      if (t.totalBytes && bytes === t.totalBytes) return finalize(key, t, bytes);
      await putTransfer({ ...t, status: 'failed', bytesWritten: bytes, error: lostMessage(bytes, t.totalBytes), updatedAt: Date.now() });
    }
  }
}

function contentRangeStartOf(value: string | null): number | null {
  const m = /^bytes\s+(\d+)-/.exec(value ?? '');
  return m ? Number(m[1]) : null;
}

/** Learns the full file length from the headers of a one-byte ranged request. Null when the server states none. */
export function probeLength(url: string): Promise<number | null> {
  // fetch() in React Native resolves only after the whole body is received, so a server that ignored Range
  // would download the entire video into memory. XHR exposes the headers first, and the request is aborted there.
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      try {
        xhr.abort();
      } catch {
        // Nothing to abort.
      }
      resolve(value);
    };
    xhr.open('GET', url);
    xhr.setRequestHeader('Range', 'bytes=0-0');
    xhr.timeout = 20000;
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 2) return; // HEADERS_RECEIVED
      const status = xhr.status;
      const declared = Number(xhr.getResponseHeader('content-length'));
      const total =
        totalFromContentRange(xhr.getResponseHeader('content-range')) ??
        (status === 200 && Number.isSafeInteger(declared) && declared > 0 ? declared : null);
      finish(total);
    };
    xhr.onerror = () => finish(null);
    xhr.ontimeout = () => finish(null);
    xhr.send();
  });
}

function beginTransfer(key: string, url: string): void {
  const resumable = makeResumable(key, url, (w, total) => void updateBytes(key, w, total));
  active.set(key, { resumable, url, paused: false, cancelled: false });
  runTransfer(key, () => resumable.downloadAsync());
}

/* ---------- Android background engine (DownloadManager) ---------- */

const NATIVE_POLL_MS = 2000;
let nativePoll: ReturnType<typeof setInterval> | null = null;
let nativePolling = false;

function ensureNativePoll(): void {
  if (nativePoll) return;
  nativePoll = setInterval(() => void pollNative(), NATIVE_POLL_MS);
}

function stopNativePollIfIdle(all: TransferEntry[]): void {
  if (nativePoll && !all.some((t) => t.engine === 'native' && t.status === 'downloading')) {
    clearInterval(nativePoll);
    nativePoll = null;
  }
}

/** Starts a fresh download in DownloadManager. If the module is missing or refuses, the foreground path is used. */
async function beginFresh(key: string, url: string): Promise<void> {
  const t = await getTransfer(key);
  if (t?.engine === 'native') {
    const mod = nativeDownloader();
    if (mod) {
      try {
        await mod.start(key, url, t.title);
        ensureNativePoll();
        return;
      } catch {
        // Fall through to the foreground path.
      }
    }
    await putTransfer({ ...t, engine: 'expo' });
  }
  beginTransfer(key, url);
}

/** Checks each active native download. Success moves the file into place and validates it; failure is reported. */
async function pollNative(): Promise<void> {
  if (nativePolling) return;
  nativePolling = true;
  try {
    const all = await readJson<TransferEntry[]>(TRANSFERS_KEY, []);
    const live = all.filter((t) => t.engine === 'native' && t.status === 'downloading');
    stopNativePollIfIdle(all);
    if (live.length === 0) return;
    const mod = nativeDownloader();
    for (const t of live) {
      if (!mod) {
        await failTransfer(t.key, 'unknown', 'Background downloads are not available in this version of the app. Tap retry.');
        void pumpQueue();
        continue;
      }
      const q = await mod.query(t.key).catch(() => null);
      const current = await getTransfer(t.key);
      if (!q || !current || current.status !== 'downloading' || current.engine !== 'native') continue;
      if (q.status === 'running' || q.status === 'paused') {
        await updateBytes(t.key, q.bytes, q.total > 0 ? q.total : null);
        if (current.nativeWaiting !== (q.status === 'paused')) {
          const latest = await getTransfer(t.key);
          if (latest) await putTransfer({ ...latest, nativeWaiting: q.status === 'paused' });
        }
      } else if (q.status === 'successful') {
        await settleNativeSuccess(t.key, q.localPath);
        void pumpQueue();
      } else {
        await mod.remove(t.key).catch(() => {});
        await failTransfer(t.key, 'unknown', q.status === 'missing' ? 'The download was removed. Tap retry.' : 'The download stopped. Tap retry.');
        void pumpQueue();
      }
    }
  } finally {
    nativePolling = false;
  }
}

/** Moves a finished DownloadManager file into the private app sandbox folder, then validates it. */
async function settleNativeSuccess(key: string, localPath: string | null): Promise<void> {
  const t = await getTransfer(key);
  if (!t) return;
  if (!localPath) return failTransfer(key, 'unknown', 'The download finished but could not be found. Tap retry.');
  const from = localPath.startsWith('file://') ? localPath : `file://${localPath}`;
  const bytes = await bytesOnDisk(from);
  if (bytes === 0 || bytes < MIN_PLAYABLE_BYTES) {
    await FileSystem.deleteAsync(from, { idempotent: true }).catch(() => {});
    return failTransfer(key, 'unknown', 'The download finished but its file was empty or missing. Tap retry.');
  }

  // Ensure file is safely placed inside the app's private document directory (sandboxed, never in gallery)
  await FileSystem.makeDirectoryAsync(DOWNLOAD_DIR, { intermediates: true }).catch(() => {});
  const dest = t.fileUri;
  let finalUri = from;

  if (from !== dest) {
    try {
      await FileSystem.copyAsync({ from, to: dest });
      const destBytes = await bytesOnDisk(dest);
      if (destBytes >= MIN_PLAYABLE_BYTES) {
        await FileSystem.deleteAsync(from, { idempotent: true }).catch(() => {});
        finalUri = dest;
      }
    } catch {
      // If cross-device partition copy is constrained, keep 'from' (it is already in the app-scoped directory)
      finalUri = from;
    }
  }

  const savedBytes = await bytesOnDisk(finalUri);
  if (savedBytes === 0 || savedBytes < MIN_PLAYABLE_BYTES) {
    return failTransfer(key, 'unknown', 'Could not save the download to app storage. Tap retry.');
  }
  const registered: TransferEntry = { ...t, fileUri: finalUri, bytesWritten: savedBytes, totalBytes: savedBytes };
  await putTransfer(registered);
  await finalize(key, registered, savedBytes);
}

/** Runs one transfer chain. When it ends (complete, failed, paused, or cancelled), the next queued download starts. */
function runTransfer(key: string, run: () => Promise<FileSystem.FileSystemDownloadResult | undefined>): void {
  void drive(key, run).finally(() => void pumpQueue());
}

/** Starts the oldest queued download, one at a time, minting a fresh URL only when its slot opens. */
async function pumpQueue(): Promise<void> {
  if (queuePumping || activeStartReservation !== null) return;
  queuePumping = true;
  try {
    if ((await listTransfers()).some((t) => t.status === 'downloading')) return;
    const next = queuedKeys.values().next().value as string | undefined;
    if (next === undefined) return;
    queuedKeys.delete(next);
    const t = await getTransfer(next);
    if (!t || t.status !== 'queued') return;
    const url = await fetchWatchDownloadUrl(t.subjectId, t.season ?? undefined, t.episode ?? undefined, t.quality);
    if (!url) {
      await failTransfer(next, 'link_expired', 'Could not get a fresh download link. Check your connection and tap retry.');
      return;
    }
    const total = await probeLength(url);
    if (!total) {
      await failTransfer(next, 'unknown', 'Could not confirm the file size from the server. Tap retry later.');
      return;
    }
    if (total < MIN_PLAYABLE_BYTES) {
      await failTransfer(next, 'invalid_file', 'The server returned an empty or error response instead of a video.');
      return;
    }
    const free = await FileSystem.getFreeDiskStorageAsync().catch(() => Number.POSITIVE_INFINITY);
    if (free < total + STORAGE_RESERVE_BYTES) {
      await failTransfer(next, 'insufficient_storage', 'Not enough free storage for this download. Free up space and try again.');
      return;
    }
    await putTransfer({ ...t, status: 'downloading', error: null, totalBytes: total, updatedAt: Date.now() });
    await FileSystem.deleteAsync(t.fileUri, { idempotent: true }).catch(() => {});
    await beginFresh(next, url);
  } finally {
    queuePumping = false;
    if (queuedKeys.size > 0 && activeStartReservation === null) void pumpQueue();
  }
}

async function bytesOnDisk(fileUri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(fileUri).catch(() => null);
  return info && info.exists && 'size' in info && typeof info.size === 'number' ? info.size : 0;
}

function makeResumable(key: string, url: string, onBytes: (written: number, total: number | null) => void): FileSystem.DownloadResumable {
  let lastWrite = 0;
  return FileSystem.createDownloadResumable(
    url,
    fileUriFor(key),
    {},
    (p) => {
      const total = p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : null;
      const now = Date.now();
      if (now - lastWrite < PROGRESS_THROTTLE_MS) return;
      lastWrite = now;
      onBytes(p.totalBytesWritten, total);
    },
  );
}

let lastBytesPersist = 0;

/** Persists byte progress only. In-memory state updates smoothly; disk writes are throttled to save CPU and battery. */
async function updateBytes(key: string, written: number, total: number | null): Promise<void> {
  const t = await getTransfer(key);
  if (!t || t.status !== 'downloading') return;
  const updated: TransferEntry = {
    ...t,
    bytesWritten: written,
    totalBytes: total ?? t.totalBytes,
    updatedAt: Date.now(),
  };
  transfersMemory.set(key, updated);
  notifyTransfers();
  const now = Date.now();
  if (now - lastBytesPersist > 4000) {
    lastBytesPersist = now;
    const raw = await readJson<TransferEntry[]>(TRANSFERS_KEY, []);
    const all = raw.map(stripLegacyResumeData);
    await writeJson(TRANSFERS_KEY, [updated, ...all.filter((x) => x.key !== key)]);
  }
}

export interface StartResult {
  ok: boolean;
  reason?: TransferFailure;
  message?: string;
}

/**
 * Starts a new download of one full-length MP4 at one quality. Refuses duplicates and checks actual
 * server length against free storage. Resolves once queued or refused.
 * Completion is reported through the transfer state and `subscribeTransfers`.
 */
const startingDownloads = new Set<string>();
let activeStartReservation: string | null = null;
let queuePumping = false;

export async function startDownload(ref: WatchEpisodeRef, source: DownloadSource, _expectedBytes: number | null): Promise<StartResult> {
  if (!downloadsSupported()) return { ok: false, reason: 'unknown', message: 'Downloads are available in the Android and iOS apps.' };
  const key = downloadKey(ref.subjectId, ref.season, ref.episode, source.quality);
  if (startingDownloads.has(key)) return { ok: false, reason: 'already_downloading', message: 'This download is already starting.' };
  const hadOtherStart = startingDownloads.size > 0;
  startingDownloads.add(key);
  if (!hadOtherStart && activeStartReservation === null) activeStartReservation = key;
  try {
  const transfers = await listTransfers();
  const completed = await listDownloads();
  const check = canStartDownload(transfers, completed, key, source.quality);
  if (!check.ok) {
    return check.reason === 'already_downloaded'
      ? { ok: false, reason: check.reason, message: 'This episode is already downloaded at this quality.' }
      : { ok: false, reason: check.reason, message: 'This download is already in progress.' };
  }

  await FileSystem.makeDirectoryAsync(DOWNLOAD_DIR, { intermediates: true });
  const queueNow = transfers.some((t) => t.status === 'downloading') || activeStartReservation !== key || queuedKeys.size > 0;
  const total = await probeLength(source.downloadUrl);
  if (!total) {
    return { ok: false, reason: 'unknown', message: 'Could not confirm the full file size from the server, so the download was not started. Try again later.' };
  }
  if (total < MIN_PLAYABLE_BYTES) return { ok: false, reason: 'invalid_file', message: 'The server returned an empty or error response instead of a video.' };
  const free = await FileSystem.getFreeDiskStorageAsync().catch(() => Number.POSITIVE_INFINITY);
  if (free < total + STORAGE_RESERVE_BYTES) {
    return { ok: false, reason: 'insufficient_storage', message: 'Not enough free storage for this download. Free up space and try again.' };
  }

  const fileUri = fileUriFor(key);
  await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
  if (queueNow) queuedKeys.add(key); // reserve its place before subscribers reconcile persisted state.
  const record: TransferEntry = {
    ...ref,
    key,
    quality: source.quality,
    fileUri,
    status: queueNow ? 'queued' : 'downloading',
    engine: nativeDownloader() ? 'native' : 'expo',
    nativeWaiting: false,
    bytesWritten: 0,
    // The server's full length, from the probe. The provider's size estimate is never used to judge completion.
    totalBytes: total,
    error: null,
    updatedAt: Date.now(),
  };
  await putTransfer(record);

  if (queueNow) {
    void pumpQueue();
    return { ok: true, message: 'Queued. It starts when the current download finishes.' };
  }
  await beginFresh(key, source.downloadUrl);
  return { ok: true };
  } finally {
    if (activeStartReservation === key) activeStartReservation = null;
    startingDownloads.delete(key);
    if (queuedKeys.size > 0) void pumpQueue();
  }
}

/** Pauses an active foreground transfer. Restart fetches a fresh link and safely starts from zero. */
export async function pauseDownload(key: string): Promise<boolean> {
  // DownloadManager cannot pause. Background downloads run until they finish, fail, or are cancelled.
  if ((await getTransfer(key))?.engine === 'native') return false;
  const a = active.get(key);
  const t = await getTransfer(key);
  if (!a || !t || !canTransition(t.status, 'paused')) return false;
  a.paused = true;
  try {
    await a.resumable.pauseAsync();
    await putTransfer({ ...t, status: 'paused', error: null, updatedAt: Date.now() });
    return true;
  } catch {
    a.paused = false;
    return false;
  }
}

/**
 * Retries a paused or failed transfer with a newly minted link. The partial is replaced from byte zero;
 * no stale link, Range offset, or opaque resume blob is trusted across the retry.
 */
export async function resumeDownload(key: string, getFreshUrl: () => Promise<string | null>): Promise<StartResult> {
  if (startingDownloads.has(key)) return { ok: false, reason: 'already_downloading', message: 'This download is already starting.' };
  const hadOtherStart = startingDownloads.size > 0;
  startingDownloads.add(key);
  if (!hadOtherStart && activeStartReservation === null) activeStartReservation = key;
  try {
  const t = await getTransfer(key);
  if (!t || !canTransition(t.status, 'downloading')) return { ok: false, reason: 'unknown', message: 'This download cannot be resumed.' };
  const busy = (await listTransfers()).some((x) => x.key !== key && x.status === 'downloading') || activeStartReservation !== key || queuedKeys.size > 0;
  if (busy) {
    queuedKeys.add(key);
    await putTransfer({ ...t, status: 'queued', error: null, updatedAt: Date.now() });
    return { ok: true, message: 'Queued. It resumes with a fresh link when the current download finishes.' };
  }
  const url = await getFreshUrl();
  if (!url) return { ok: false, reason: 'link_expired', message: 'Could not get a fresh link. Check your connection and try again.' };
  const total = await probeLength(url);
  if (!total) return { ok: false, reason: 'unknown', message: 'Could not confirm the full file size from the server. Try again later.' };
  if (total < MIN_PLAYABLE_BYTES) return { ok: false, reason: 'invalid_file', message: 'The server returned an empty or error response instead of a video.' };
  const free = await FileSystem.getFreeDiskStorageAsync().catch(() => Number.POSITIVE_INFINITY);
  if (free < total + STORAGE_RESERVE_BYTES) {
    return { ok: false, reason: 'insufficient_storage', message: 'Not enough free storage for this download. Free up space and try again.' };
  }
  // A fresh expiring link is used on every retry. Byte counts and stale resume blobs are never
  // presented as HTTP Range offsets; restart the partial rather than risk appending corrupt bytes.
  const oldActive = active.get(key);
  if (oldActive) {
    oldActive.cancelled = true;
    active.delete(key);
    await oldActive.resumable.cancelAsync().catch(() => {});
  }
  await FileSystem.deleteAsync(t.fileUri, { idempotent: true }).catch(() => {});
  await putTransfer({ ...t, status: 'downloading', bytesWritten: 0, totalBytes: total, error: null, updatedAt: Date.now() });
  await beginFresh(key, url);
  return { ok: true };
  } finally {
    if (activeStartReservation === key) activeStartReservation = null;
    startingDownloads.delete(key);
    if (queuedKeys.size > 0) void pumpQueue();
  }
}

/** Cancels a transfer and deletes its partial file. Only this transfer's file is removed. */
export async function cancelDownload(key: string): Promise<void> {
  queuedKeys.delete(key);
  void clearDownloadNotice(key);
  const before = await getTransfer(key);
  const wasNative = before?.engine === 'native' && before.status === 'downloading';
  if (wasNative) await nativeDownloader()?.remove(key).catch(() => {});
  const a = active.get(key);
  if (a) {
    a.cancelled = true;
    active.delete(key);
    await a.resumable.cancelAsync().catch(() => {});
  }
  const t = await getTransfer(key);
  if (t) await FileSystem.deleteAsync(t.fileUri, { idempotent: true }).catch(() => {});
  await dropTransfer(key);
  if (wasNative) void pumpQueue();
}


/* ---------- Preferences ---------- */

const QUALITY_PREF_KEY = 'watch.quality.preference.v1';

/** The viewer's chosen quality, or null when they have not picked one (the default rule then applies). */
export async function getPreferredQuality(): Promise<string | null> {
  try {
    const v = await AsyncStorage.getItem(QUALITY_PREF_KEY);
    return v && /^\d{3,4}p$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export async function setPreferredQuality(quality: string | null): Promise<void> {
  if (quality === null) await AsyncStorage.removeItem(QUALITY_PREF_KEY);
  else await AsyncStorage.setItem(QUALITY_PREF_KEY, quality);
}

const TITLE_QUALITY_KEY = 'watch.quality.titles.v1';
/** Titles remembered, newest first. Bounded so the map cannot grow without limit. */
const TITLE_QUALITY_MAX = 60;

/**
 * The quality the viewer chose for this one title and episode, or null when they have not chosen there.
 * Per-title, so a one-off 1080p pick no longer changes the default quality of every other title.
 */
export async function getTitleQuality(subjectId: string, season: number | null, episode: number | null): Promise<string | null> {
  const all = await readJson<Record<string, string>>(TITLE_QUALITY_KEY, {});
  const value = all[episodeKey(subjectId, season, episode)];
  return value && /^\d{3,4}p$/.test(value) ? value : null;
}

/** Remembers the viewer's quality for this title only; null clears it and returns to the 360p default. */
export async function setTitleQuality(subjectId: string, season: number | null, episode: number | null, quality: string | null): Promise<void> {
  const all = await readJson<Record<string, string>>(TITLE_QUALITY_KEY, {});
  const key = episodeKey(subjectId, season, episode);
  const next: Record<string, string> = { ...all };
  if (quality) next[key] = quality;
  else delete next[key];
  const keys = Object.keys(next);
  const kept = keys.length > TITLE_QUALITY_MAX ? keys.slice(-TITLE_QUALITY_MAX) : keys;
  const trimmed: Record<string, string> = {};
  for (const k of kept) trimmed[k] = next[k];
  await writeJson(TITLE_QUALITY_KEY, trimmed);
}
