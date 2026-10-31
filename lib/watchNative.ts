/**
 * Android background downloads for Hallyu TV, through the native `HallyuDownloader` module (Android
 * DownloadManager, see scripts/ci/android-downloader-module.mjs). Returns null on web, iOS, Expo Go, and any
 * build without the module, so those keep using the foreground path in watchStore.
 */
import { NativeModules, Platform } from 'react-native';

export interface NativeDownloadStatus {
  status: 'running' | 'paused' | 'successful' | 'failed' | 'missing';
  bytes: number;
  total: number;
  /** DownloadManager COLUMN_REASON for a failure: no space, an HTTP error, too many redirects, a blocked network. */
  reason: number | null;
  localPath: string | null;
}

export interface HallyuDownloaderNative {
  start(key: string, url: string, title: string): Promise<string>;
  query(key: string): Promise<NativeDownloadStatus>;
  remove(key: string): Promise<null>;
}

export function nativeDownloader(): HallyuDownloaderNative | null {
  if (Platform.OS !== 'android') return null;
  const mod = (NativeModules as Record<string, unknown>).HallyuDownloader as HallyuDownloaderNative | undefined;
  return mod && typeof mod.start === 'function' && typeof mod.query === 'function' && typeof mod.remove === 'function' ? mod : null;
}
