/**
 * Hallyu TV — local state: resume progress (Continue Watching), private downloads, and transfers.
 *
 * Downloads live in the app's private document directory and are never added to the device photo
 * library. Transfers run in the foreground: they continue while the Hallyu TV screens are open and stop
 * when the app is backgrounded or closed. Their state survives a restart, and a paused or interrupted
 * transfer resumes from the bytes already on disk. Background transfers need a native download service,
 * which is not built yet, so they are not claimed here.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import {
  canStartDownload,
  canTransition,
  decideAfterTransfer,
  isMp4Header,
  lostMessage,
  stoppedMessage,
  totalFromContentRange,
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
  /** Opaque resume data from expo-file-system. Holds no download URL, because those tokens expire. */
  resumeData: string | null;
  error: string | null;
  updatedAt: number;
}

export type TransferFailure = 'insufficient_storage' | 'already_downloading' | 'already_downloaded' | 'link_expired' | 'network' | 'invalid_file' | 'http_error' | 'unknown';

export function episodeKey(subjectId: string, season: number | null, episode: number | null): string {
  return `${subjectId}:${season ?? 0}:${episode ?? 0}`;
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

export async function listDownloads(): Promise<DownloadEntry[]> {
  const all = await readJson<DownloadEntry[]>(DOWNLOADS_KEY, []);
  const checked = await Promise.all(
    all.map(async (d) => ((await FileSystem.getInfoAsync(d.fileUri).catch(() => ({ exists: false }))).exists ? d : null)),
  );
  const alive = checked.filter((d): d is DownloadEntry => d !== null);
  if (alive.length !== all.length) await writeJson(DOWNLOADS_KEY, alive);
  return alive.sort((a, b) => b.savedAt - a.savedAt);
}

export async function findDownload(subjectId: string, season: number | null, episode: number | null): Promise<DownloadEntry | null> {
  const key = episodeKey(subjectId, season, episode);
  return (await listDownloads()).find((d) => d.key === key) ?? null;
}

export async function removeDownload(entry: DownloadEntry): Promise<void> {
  await FileSystem.deleteAsync(entry.fileUri, { idempotent: true }).catch(() => {});
  const all = await readJson<DownloadEntry[]>(DOWNLOADS_KEY, []);
  await writeJson(DOWNLOADS_KEY, all.filter((d) => d.key !== entry.key));
  notify();
}

/* ---------- Transfers ---------- */

type Listener = () => void;
const listeners = new Set<Listener>();
function notify(): void {
  listeners.forEach((fn) => fn());
}

/** Subscribe to transfer changes. Returns an unsubscribe function. */
export function subscribeTransfers(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function listTransfers(): Promise<TransferEntry[]> {
  const all = await readJson<TransferEntry[]>(TRANSFERS_KEY, []);
  // A download that was "downloading" when the app closed is interrupted now, not still running.
  const repaired = all.map((t) => {
    if (t.status === 'downloading' && !active.has(t.key)) return { ...t, status: 'paused' as const, error: null };
    if (t.status === 'queued' && !queuedUrls.has(t.key)) {
      return { ...t, status: 'failed' as const, error: 'This download was waiting in the queue when the app closed. Tap retry to start it.' };
    }
    return t;
  });
  if (JSON.stringify(repaired) !== JSON.stringify(all)) await writeJson(TRANSFERS_KEY, repaired);
  return repaired.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function putTransfer(t: TransferEntry): Promise<void> {
  const all = await readJson<TransferEntry[]>(TRANSFERS_KEY, []);
  await writeJson(TRANSFERS_KEY, [t, ...all.filter((x) => x.key !== t.key)]);
  notify();
}

async function dropTransfer(key: string): Promise<void> {
  const all = await readJson<TransferEntry[]>(TRANSFERS_KEY, []);
  await writeJson(TRANSFERS_KEY, all.filter((x) => x.key !== key));
  notify();
}

async function getTransfer(key: string): Promise<TransferEntry | null> {
  return (await readJson<TransferEntry[]>(TRANSFERS_KEY, [])).find((t) => t.key === key) ?? null;
}

interface ActiveTransfer {
  resumable: FileSystem.DownloadResumable;
  /** The link this transfer downloads from, kept so a continuation can reuse it. */
  url: string;
  paused: boolean;
  cancelled: boolean;
}
const active = new Map<string, ActiveTransfer>();
/** Links for queued transfers, in queue order. Held in memory only: a link is never written to storage. */
const queuedUrls = new Map<string, string>();

function fileUriFor(key: string): string {
  return `${DOWNLOAD_DIR}${key.replace(/[^A-Za-z0-9:_-]/g, '_')}.mp4`;
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
async function finalize(key: string, t: TransferEntry, bytes: number): Promise<void> {
  const head = await FileSystem.readAsStringAsync(t.fileUri, { encoding: FileSystem.EncodingType.Base64, position: 0, length: 12 }).catch(() => '');
  const headBytes = head ? Uint8Array.from(atob(head), (c) => c.charCodeAt(0)) : new Uint8Array();
  if (!isMp4Header(headBytes)) {
    await FileSystem.deleteAsync(t.fileUri, { idempotent: true }).catch(() => {});
    return failTransfer(key, 'invalid_file', 'The file is not a playable video. It was removed. Try a different quality.');
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
  await writeJson(DOWNLOADS_KEY, [entry, ...done.filter((d) => !(d.key === key && d.quality === t.quality))]);
  await dropTransfer(key);
}

/**
 * Runs one transfer to completion or interruption, then validates the file before marking it complete.
 * A transfer that stops early is continued from the bytes on disk (Range request); see decideAfterTransfer.
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
      startBytes,
      bytesOnDisk: bytes,
      expectedBytes: t.totalBytes,
      continues,
      contentRangeStart: result.status === 206 ? contentRangeStartOf(headerOf(result.headers, 'content-range')) : null,
    });

    if (decision.action === 'continue' || decision.action === 'restart') {
      // Continue the same file from the bytes on disk, or start it over if the server ignored Range.
      const fromBytes = decision.action === 'continue' ? decision.fromBytes : 0;
      if (fromBytes === 0) await FileSystem.deleteAsync(t.fileUri, { idempotent: true }).catch(() => {});
      const resumable = makeResumable(key, current.url, fromBytes > 0 ? String(fromBytes) : null, (w, total) => void updateBytes(key, w, total));
      active.set(key, { ...current, resumable });
      return drive(key, () => resumable.downloadAsync(), fromBytes, continues + 1);
    }

    active.delete(key);
    if (decision.action === 'fail') {
      const messages = {
        link_expired: 'The download link has expired. Tap retry to get a new one.',
        http_error: `The server returned an error (${result.status}). Tap retry.`,
        network: 'The download was interrupted before it finished. Tap resume to continue.',
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
      // expo-file-system saves resume data only on pause, so the byte count on disk is the real resume point.
      // The connection can fail after the last byte: a whole file is validated, not retried.
      const bytes = await bytesOnDisk(t.fileUri);
      if (t.totalBytes && bytes === t.totalBytes) return finalize(key, t, bytes);
      // Android continues with a Range request from this byte. iOS cannot resume from a byte count, so it starts over.
      const resumeData = Platform.OS === 'android' && bytes > 0 ? String(bytes) : null;
      await putTransfer({ ...t, status: 'failed', bytesWritten: bytes, resumeData, error: lostMessage(bytes, t.totalBytes), updatedAt: Date.now() });
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

function beginTransfer(key: string, url: string, resumeData: string | null, startBytes: number): void {
  const resumable = makeResumable(key, url, resumeData, (w, total) => void updateBytes(key, w, total));
  active.set(key, { resumable, url, paused: false, cancelled: false });
  runTransfer(key, () => resumable.downloadAsync(), startBytes);
}

/** Runs one transfer chain. When it ends (complete, failed, paused, or cancelled), the next queued download starts. */
function runTransfer(key: string, run: () => Promise<FileSystem.FileSystemDownloadResult | undefined>, startBytes = 0): void {
  void drive(key, run, startBytes).finally(() => void pumpQueue());
}

/** Starts the oldest queued download, one at a time. A queued item keeps its place until a slot is free. */
async function pumpQueue(): Promise<void> {
  if ((await listTransfers()).some((t) => t.status === 'downloading')) return;
  const next = queuedUrls.keys().next().value as string | undefined;
  if (next === undefined) return;
  const url = queuedUrls.get(next) as string;
  queuedUrls.delete(next);
  const t = await getTransfer(next);
  if (!t || t.status !== 'queued') return pumpQueue();
  await putTransfer({ ...t, status: 'downloading', error: null, updatedAt: Date.now() });
  const startBytes = t.resumeData ? await bytesOnDisk(t.fileUri) : 0;
  beginTransfer(next, url, t.resumeData, startBytes);
}

async function bytesOnDisk(fileUri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(fileUri).catch(() => null);
  return info && info.exists && 'size' in info && typeof info.size === 'number' ? info.size : 0;
}

function safeSavable(r: FileSystem.DownloadResumable): string | null {
  try {
    return r.savable().resumeData ?? null;
  } catch {
    return null;
  }
}

function makeResumable(key: string, url: string, resumeData: string | null, onBytes: (written: number, total: number | null) => void): FileSystem.DownloadResumable {
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
    resumeData ?? undefined,
  );
}

/** Persists progress and the current resume data, so a restart can continue from these bytes. */
async function updateBytes(key: string, written: number, total: number | null): Promise<void> {
  const t = await getTransfer(key);
  if (!t || t.status !== 'downloading') return;
  const a = active.get(key);
  const resumeData = a ? safeSavable(a.resumable) : t.resumeData;
  await putTransfer({ ...t, bytesWritten: written, totalBytes: total ?? t.totalBytes, resumeData, updatedAt: Date.now() });
}

export interface StartResult {
  ok: boolean;
  reason?: TransferFailure;
  message?: string;
}

/**
 * Starts a new download of one full-length MP4 at one quality. Refuses duplicates, and refuses when the
 * device clearly lacks space for a file of known size. Resolves once the transfer has been queued or refused.
 * Completion is reported through the transfer state and `subscribeTransfers`.
 */
export async function startDownload(ref: WatchEpisodeRef, source: DownloadSource, expectedBytes: number | null): Promise<StartResult> {
  if (!downloadsSupported()) return { ok: false, reason: 'unknown', message: 'Downloads are available in the Android and iOS apps.' };
  const key = episodeKey(ref.subjectId, ref.season, ref.episode);
  const transfers = await listTransfers();
  const completed = await listDownloads();
  const check = canStartDownload(transfers, completed, key, source.quality);
  if (!check.ok) {
    return check.reason === 'already_downloaded'
      ? { ok: false, reason: check.reason, message: 'This episode is already downloaded at this quality.' }
      : { ok: false, reason: check.reason, message: 'This download is already in progress.' };
  }

  await FileSystem.makeDirectoryAsync(DOWNLOAD_DIR, { intermediates: true });
  if (expectedBytes && expectedBytes > 0) {
    const free = await FileSystem.getFreeDiskStorageAsync().catch(() => Number.POSITIVE_INFINITY);
    if (free < expectedBytes + STORAGE_RESERVE_BYTES) {
      return { ok: false, reason: 'insufficient_storage', message: 'Not enough free storage for this download. Free up space and try again.' };
    }
  }

  const queueNow = transfers.some((t) => t.status === 'downloading');
  const total = await probeLength(source.downloadUrl);
  if (!total) {
    return { ok: false, reason: 'unknown', message: 'Could not confirm the full file size from the server, so the download was not started. Try again later.' };
  }

  const fileUri = fileUriFor(key);
  await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
  const record: TransferEntry = {
    ...ref,
    key,
    quality: source.quality,
    fileUri,
    status: queueNow ? 'queued' : 'downloading',
    bytesWritten: 0,
    // The server's full length, from the probe. The provider's size estimate is never used to judge completion.
    totalBytes: total,
    resumeData: null,
    error: null,
    updatedAt: Date.now(),
  };
  await putTransfer(record);

  if (queueNow) {
    queuedUrls.set(key, source.downloadUrl);
    return { ok: true, message: 'Queued. It starts when the current download finishes.' };
  }
  beginTransfer(key, source.downloadUrl, null, 0);
  return { ok: true };
}

/** Pauses an active transfer and saves its resume data, so it can continue from the same byte later. */
export async function pauseDownload(key: string): Promise<boolean> {
  const a = active.get(key);
  const t = await getTransfer(key);
  if (!a || !t || !canTransition(t.status, 'paused')) return false;
  a.paused = true;
  try {
    const state = await a.resumable.pauseAsync();
    await putTransfer({ ...t, status: 'paused', resumeData: state.resumeData ?? null, error: null, updatedAt: Date.now() });
    return true;
  } catch {
    a.paused = false;
    return false;
  }
}

/**
 * Resumes a paused or failed transfer. `getFreshUrl` supplies a new download link, because the link from
 * before a pause or restart may have expired. The file is continued from the bytes already on disk.
 */
export async function resumeDownload(key: string, getFreshUrl: () => Promise<string | null>): Promise<StartResult> {
  const t = await getTransfer(key);
  if (!t || !canTransition(t.status, 'downloading')) return { ok: false, reason: 'unknown', message: 'This download cannot be resumed.' };
  const busy = (await listTransfers()).some((x) => x.key !== key && x.status === 'downloading');
  const a = active.get(key);
  if (a && a.paused) {
    if (busy) {
      active.delete(key);
      queuedUrls.set(key, a.url);
      await putTransfer({ ...t, status: 'queued', error: null, updatedAt: Date.now() });
      return { ok: true, message: 'Queued. It resumes when the current download finishes.' };
    }
    a.paused = false;
    await putTransfer({ ...t, status: 'downloading', error: null, updatedAt: Date.now() });
    const onDisk = await bytesOnDisk(t.fileUri);
    runTransfer(key, () => a.resumable.resumeAsync(), onDisk);
    return { ok: true };
  }
  const url = await getFreshUrl();
  if (!url) return { ok: false, reason: 'link_expired', message: 'Could not get a fresh link. Check your connection and try again.' };
  if (!t.totalBytes) {
    const total = await probeLength(url);
    if (!total) return { ok: false, reason: 'unknown', message: 'Could not confirm the full file size from the server. Try again later.' };
    await putTransfer({ ...t, totalBytes: total, updatedAt: Date.now() });
  }
  if (busy) {
    queuedUrls.set(key, url);
    await putTransfer({ ...t, status: 'queued', error: null, updatedAt: Date.now() });
    return { ok: true, message: 'Queued. It starts when the current download finishes.' };
  }
  await putTransfer({ ...t, status: 'downloading', error: null, updatedAt: Date.now() });
  // Only a request that carries resume data appends to the file; otherwise the file is written from zero.
  const startBytes = t.resumeData ? await bytesOnDisk(t.fileUri) : 0;
  beginTransfer(key, url, t.resumeData, startBytes);
  return { ok: true };
}

/** Cancels a transfer and deletes its partial file. Only this transfer's file is removed. */
export async function cancelDownload(key: string): Promise<void> {
  queuedUrls.delete(key);
  const a = active.get(key);
  if (a) {
    a.cancelled = true;
    active.delete(key);
    await a.resumable.cancelAsync().catch(() => {});
  }
  const t = await getTransfer(key);
  if (t) await FileSystem.deleteAsync(t.fileUri, { idempotent: true }).catch(() => {});
  await dropTransfer(key);
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
