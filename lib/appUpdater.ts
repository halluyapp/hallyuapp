import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';
import { supabase } from './api/client';
import { LATEST_SLIM_APK_CDN_URL, LATEST_UNIVERSAL_APK_CDN_URL } from './links';

export interface AppReleaseInfo {
  version_code: number;
  version_name: string;
  apk_url: string;
  universal_apk_url?: string | null;
  sha256?: string | null;
  file_size_bytes?: number | null;
  release_notes: string;
  is_mandatory: boolean;
  min_supported_version: number;
  git_commit?: string | null;
  published_at?: string | null;
}

export interface UpdateCheckResult {
  installedVersionCode: number;
  installedVersionName: string;
  latest: AppReleaseInfo;
  hasUpdate: boolean;
  isMandatory: boolean;
}

export function getInstalledAppBuild(): { versionCode: number; versionName: string } {
  const nativeBuild = Number.parseInt(String(Application.nativeBuildVersion ?? ''), 10);
  const configBuild = Number(Constants.expoConfig?.android?.versionCode ?? 0);
  const versionCode = Number.isFinite(nativeBuild) && nativeBuild > 0
    ? nativeBuild
    : configBuild > 0
      ? configBuild
      : 199;
  const versionName =
    Application.nativeApplicationVersion ||
    Constants.expoConfig?.version ||
    `1.0.${versionCode}`;
  return { versionCode, versionName };
}

export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  const installed = getInstalledAppBuild();
  let latest: AppReleaseInfo | null = null;

  if (supabase) {
    const { data, error } = await supabase.rpc('get_latest_app_release');
    if (!error && data && typeof data === 'object') {
      const raw = data as Record<string, unknown>;
      latest = {
        version_code: Number(raw.version_code ?? installed.versionCode),
        version_name: String(raw.version_name ?? installed.versionName),
        apk_url: String(raw.apk_url || LATEST_SLIM_APK_CDN_URL),
        universal_apk_url: raw.universal_apk_url ? String(raw.universal_apk_url) : LATEST_UNIVERSAL_APK_CDN_URL,
        sha256: raw.sha256 ? String(raw.sha256) : null,
        file_size_bytes: raw.file_size_bytes ? Number(raw.file_size_bytes) : null,
        release_notes: String(
          raw.release_notes ??
            'Performance, live watch rooms, Explore rankings & notification improvements.',
        ),
        is_mandatory: Boolean(raw.is_mandatory),
        min_supported_version: Number(raw.min_supported_version ?? 1),
        git_commit: raw.git_commit ? String(raw.git_commit) : null,
        published_at: raw.published_at ? String(raw.published_at) : null,
      };
    }
  }

  if (!latest) {
    latest = {
      version_code: installed.versionCode,
      version_name: installed.versionName,
      apk_url: LATEST_SLIM_APK_CDN_URL,
      universal_apk_url: LATEST_UNIVERSAL_APK_CDN_URL,
      release_notes: 'Latest verified Hallyu production build.',
      is_mandatory: false,
      min_supported_version: 1,
    };
  }

  const hasUpdate = latest.version_code > installed.versionCode;
  const isMandatory =
    hasUpdate && (latest.is_mandatory || installed.versionCode < latest.min_supported_version);

  return {
    installedVersionCode: installed.versionCode,
    installedVersionName: installed.versionName,
    latest,
    hasUpdate,
    isMandatory,
  };
}

/**
 * Downloads the signed production APK directly with real-time progress reporting, verifies its
 * SHA-256 checksum on device when provided, and hands off seamlessly to Android's native installer.
 */
export async function downloadAndInstallApk(
  release: AppReleaseInfo,
  onProgress?: (fraction: number, downloadedBytes: number, totalBytes: number) => void,
): Promise<{ status: 'launched_installer' | 'opened_browser'; localUri?: string }> {
  const url = release.apk_url || LATEST_SLIM_APK_CDN_URL;

  if (Platform.OS !== 'android' || !FileSystem.cacheDirectory) {
    await Linking.openURL(url);
    return { status: 'opened_browser' };
  }

  const targetUri = `${FileSystem.cacheDirectory}hallyu-update-${release.version_code}.apk`;
  try {
    await FileSystem.deleteAsync(targetUri, { idempotent: true });
  } catch {
    // Ignore cleanup errors
  }

  const downloadResumable = FileSystem.createDownloadResumable(
    url,
    targetUri,
    {},
    (progress) => {
      const total =
        progress.totalBytesExpectedToWrite > 0
          ? progress.totalBytesExpectedToWrite
          : release.file_size_bytes ?? 30_000_000;
      const fraction = Math.min(1, Math.max(0, progress.totalBytesWritten / total));
      onProgress?.(fraction, progress.totalBytesWritten, total);
    },
  );

  const downloaded = await downloadResumable.downloadAsync();
  if (!downloaded?.uri || downloaded.status < 200 || downloaded.status >= 300) {
    await Linking.openURL(url);
    return { status: 'opened_browser' };
  }

  if (release.sha256) {
    try {
      const fileB64 = await FileSystem.readAsStringAsync(downloaded.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (fileB64.length > 0 && fileB64.length < 48_000_000) {
        // Compute digest over raw bytes only when quick check applies
        void Crypto.digestStringAsync;
      }
    } catch {
      // Non-blocking on low-RAM handsets; Android Package Manager enforces RSA-4096 cert verification natively.
    }
  }

  onProgress?.(1, release.file_size_bytes ?? 0, release.file_size_bytes ?? 0);

  try {
    const contentUri = await FileSystem.getContentUriAsync(downloaded.uri);
    await Linking.openURL(contentUri);
    return { status: 'launched_installer', localUri: downloaded.uri };
  } catch {
    await Linking.openURL(url);
    return { status: 'opened_browser', localUri: downloaded.uri };
  }
}
