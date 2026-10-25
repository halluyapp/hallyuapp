/**
 * Hallyu Watch — local state: resume progress (Continue Watching) and private offline downloads.
 *
 * Downloads are saved inside the app's private document directory and are never added to the
 * device photo library. They are foreground-only: the transfer stops if the app is closed or
 * backgrounded. Background transfers need a native Android service, which is not built yet.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import type { WatchStream } from './api/moviebox';

const PROGRESS_KEY = 'watch.progress.v1';
const DOWNLOADS_KEY = 'watch.downloads.v1';
const DOWNLOAD_DIR = `${FileSystem.documentDirectory ?? ''}watch-downloads/`;

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

export interface DownloadEntry extends WatchEpisodeRef {
  key: string;
  fileUri: string;
  bytes: number;
  quality: string | null;
  savedAt: number;
}

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

/* ---------- Downloads ---------- */

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

export interface DownloadHandle {
  promise: Promise<DownloadEntry | null>;
  cancel: () => Promise<void>;
}

/**
 * Saves one progressive MP4 to the private download folder. `onProgress` receives real byte counts
 * from the transfer. A failed or cancelled transfer removes its partial file and resolves to null.
 */
export function startDownload(
  ref: WatchEpisodeRef,
  stream: WatchStream,
  onProgress: (fraction: number | null) => void,
): DownloadHandle {
  const key = episodeKey(ref.subjectId, ref.season, ref.episode);
  const fileUri = `${DOWNLOAD_DIR}${key.replace(/[^A-Za-z0-9:_-]/g, '_')}.mp4`;
  let resumable: FileSystem.DownloadResumable | null = null;
  let cancelled = false;

  const promise = (async (): Promise<DownloadEntry | null> => {
    try {
      await FileSystem.makeDirectoryAsync(DOWNLOAD_DIR, { intermediates: true });
      resumable = FileSystem.createDownloadResumable(
        stream.url,
        fileUri,
        { headers: stream.requiredHeaders },
        (p) => {
          const total = p.totalBytesExpectedToWrite;
          onProgress(total > 0 ? Math.min(1, p.totalBytesWritten / total) : null);
        },
      );
      const result = await resumable.downloadAsync();
      if (cancelled || !result || result.status < 200 || result.status >= 300) {
        await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
        return null;
      }
      const info = await FileSystem.getInfoAsync(fileUri);
      const bytes = info.exists && 'size' in info && typeof info.size === 'number' ? info.size : 0;
      if (bytes < 1024) {
        await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
        return null;
      }
      const entry: DownloadEntry = { ...ref, key, fileUri, bytes, quality: stream.quality, savedAt: Date.now() };
      const all = await readJson<DownloadEntry[]>(DOWNLOADS_KEY, []);
      await writeJson(DOWNLOADS_KEY, [entry, ...all.filter((d) => d.key !== key)]);
      return entry;
    } catch {
      await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
      return null;
    }
  })();

  return {
    promise,
    cancel: async () => {
      cancelled = true;
      await resumable?.cancelAsync().catch(() => {});
    },
  };
}

export async function removeDownload(entry: DownloadEntry): Promise<void> {
  await FileSystem.deleteAsync(entry.fileUri, { idempotent: true }).catch(() => {});
  const all = await readJson<DownloadEntry[]>(DOWNLOADS_KEY, []);
  await writeJson(DOWNLOADS_KEY, all.filter((d) => d.key !== entry.key));
}
