/**
 * Android background transport for Hallyu TV downloads, via react-native-background-downloader (Fetch2).
 * The library is loaded only on Android at runtime. Web, iOS, and builds without the native module get
 * `null` and keep using the foreground path in watchStore.
 *
 * What the native layer does: it keeps a download running while the app is in the background, and reattaches
 * to it on the next launch (checkForExistingDownloads). Whether it keeps going with the app fully closed by
 * the OS depends on the device, and is verified on a device, not assumed.
 */
import { Platform } from 'react-native';

export interface NativeTask {
  id: string;
  state: 'PENDING' | 'DOWNLOADING' | 'PAUSED' | 'DONE' | 'FAILED' | 'STOPPED';
  pause(): void;
  resume(): void;
  stop(): void;
  progress(fn: (percent: number, written: number, total: number) => void): NativeTask;
  done(fn: () => void): NativeTask;
  error(fn: (message: string, code?: number) => void): NativeTask;
}

/** A task the native layer still knows about. state is DOWNLOADING, PAUSED, or DONE. */
export interface ExistingTask extends NativeTask {
  bytesWritten: number;
  totalBytes: number;
}

interface NativeLib {
  download(options: { id: string; url: string; destination: string }): NativeTask;
  checkForExistingDownloads(): Promise<ExistingTask[]>;
}

let loaded: NativeLib | null | undefined;

function library(): NativeLib | null {
  if (Platform.OS !== 'android') return null;
  if (loaded !== undefined) return loaded;
  try {
    // Required lazily on purpose: importing a native module at the top of a file would break web and Expo Go.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native-background-downloader');
    const lib = (mod?.default ?? mod) as NativeLib;
    loaded = typeof lib?.download === 'function' ? lib : null;
  } catch {
    loaded = null;
  }
  return loaded;
}

export function nativeAvailable(): boolean {
  return library() !== null;
}

/** A plain absolute path, as the native downloader expects. */
export function nativePath(fileUri: string): string {
  return fileUri.replace(/^file:\/\//, '');
}

export function startNativeTask(id: string, url: string, fileUri: string): NativeTask | null {
  const lib = library();
  if (!lib) return null;
  return lib.download({ id, url, destination: nativePath(fileUri) });
}

/** Tasks the native layer still knows about, for example after the app was restarted. */
export async function existingNativeTasks(): Promise<ExistingTask[]> {
  const lib = library();
  if (!lib) return [];
  try {
    return await lib.checkForExistingDownloads();
  } catch {
    return [];
  }
}
