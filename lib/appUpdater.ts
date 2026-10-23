import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { Linking, Platform } from 'react-native';
import { supabase } from './api/client';
import {
  LATEST_ARM32_APK_CDN_URL,
  LATEST_SLIM_APK_CDN_URL,
  LATEST_X86_64_APK_CDN_URL,
  SUPABASE_PUBLIC_STORAGE_BASE,
} from './links';

export type SupportedApkAbi = 'arm64-v8a' | 'armeabi-v7a' | 'x86_64';

export interface AbiArtifactInfo {
  abi: SupportedApkAbi;
  url: string;
  sha256?: string | null;
  sizeBytes?: number | null;
  versionCode?: number | null;
}

export type ApkSelectionOutcome =
  | {
      ok: true;
      abi: SupportedApkAbi;
      url: string;
      sha256: string | null;
      sizeBytes: number | null;
    }
  | {
      ok: false;
      unsupportedAbis: string[];
      message: string;
    };

export interface AppReleaseInfo {
  versionCode: number;
  releaseTrain: number;
  versionName: string;
  apkUrl: string;
  arm32ApkUrl: string;
  x86_64ApkUrl: string;
  abis?: Partial<Record<SupportedApkAbi, AbiArtifactInfo>>;
  sha256?: string | null;
  fileSizeBytes?: number | null;
  gitCommit?: string | null;
  publishedAt?: string | null;
  releaseNotes: string;
  isMandatory: boolean;
  minSupportedVersion: number;
}

export interface PendingInstallRecord {
  targetVersionCode: number;
  targetTrain: number;
  targetVersionName: string;
  abi: SupportedApkAbi;
  localUri: string;
  startedAt: number;
  status: 'awaiting_user_install' | 'not_installed_yet';
}

export interface UpdateCheckResult {
  installedCode: number;
  installedTrain: number;
  installedVersion: string;
  deviceAbis: string[];
  selectedArtifact: ApkSelectionOutcome;
  latest: AppReleaseInfo;
  hasUpdate: boolean;
  isMandatory: boolean;
  justUpdatedFromVersion: string | null;
  cachedApkReady: boolean;
  pendingInstall: PendingInstallRecord | null;
}

export interface DownloadProgressSnapshot {
  percent: number;
  writtenBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
}

export type InstallLaunchOutcome =
  | { status: 'awaiting_user_install'; usedCachedApk: boolean; selectedAbi: SupportedApkAbi }
  | { status: 'not_installed_yet'; usedCachedApk: boolean; selectedAbi: SupportedApkAbi }
  | { status: 'needs_unknown_sources_permission'; selectedAbi: SupportedApkAbi }
  | { status: 'browser_opened'; selectedAbi: SupportedApkAbi };

const SEEN_VERSION_STORAGE_KEY = 'hallyu.updater.seenBuild.v2';
const PENDING_INSTALL_STORAGE_KEY = 'hallyu.updater.pendingInstall.v1';
const APK_STORAGE_SUBDIR = 'hallyu-updates/';
const APK_CACHE_PREFIX = 'hallyu-release-';
const APK_ZIP_MAGIC_BASE64_PREFIX = 'UEsDB'; // `PK\x03\x04` (0x50 0x4b 0x03 0x04)

// CRITICAL ANDROID 14 FIX:
// `expo-intent-launcher` (`IntentLauncherModule.kt`) calls `currentActivity.startActivityForResult(intent, 12)`.
// Never combine `FLAG_ACTIVITY_NEW_TASK` (0x10000000) with `startActivityForResult` — on Android,
// ActivityTaskManager immediately cancels the result contract with `Activity.RESULT_CANCELED (0)`
// before the user can tap Update! Pass `FLAG_GRANT_READ_URI_PERMISSION` (0x00000001) ONLY, plus
// `android.intent.extra.RETURN_RESULT: true`, so Hallyu receives the authentic result when Android's
// PackageInstaller closes without installing.
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;

/**
 * Normalizes ABI-split version codes (`12121` universal, `12122` armv7, `12123` x86_64, `12124` arm64)
 * to their shared CI release train (`1212`) so EVERY ABI variant of the exact same commit knows
 * with 100% certainty whether it is already running the latest build.
 */
export function getReleaseTrain(versionCode: number): number {
  if (!Number.isFinite(versionCode) || versionCode <= 0) return 0;
  return versionCode >= 10_000 ? Math.floor(versionCode / 10) : versionCode;
}

/**
 * Compares version strings numerically across arbitrary segments including zero-padded segments
 * like `1.7.01` vs `1.7.02` vs `1.0.215` (`-1` if `a < b`, `0` if equal, `1` if `a > b`).
 */
export function compareVersionStrings(a: string, b: string): number {
  const parse = (raw: string) =>
    String(raw ?? '')
      .trim()
      .replace(/^v/i, '')
      .split(/[^0-9]+/)
      .filter(Boolean)
      .map((s) => Number.parseInt(s, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

/**
 * Determines whether a published release is genuinely newer than the currently installed build.
 * Uses integer `releaseTrain` (`Math.floor(versionCode / 10)`) whenever valid native build codes
 * exist, falling back to numeric semver comparison when running in an un-numbered environment.
 */
export function isReleaseNewer(
  installedCode: number,
  installedVersion: string,
  latest: Pick<AppReleaseInfo, 'versionCode' | 'releaseTrain' | 'versionName'>,
): boolean {
  const installedTrain = getReleaseTrain(installedCode);
  const latestTrain = latest.releaseTrain || getReleaseTrain(latest.versionCode);
  if (installedTrain > 0 && latestTrain > 0) {
    return latestTrain > installedTrain;
  }
  return compareVersionStrings(installedVersion, latest.versionName) < 0;
}

/**
 * Infers the installed APK ABI from split versionCode suffix when Android platform constants
 * do not expose `SupportedAbis` (`...2` = `armeabi-v7a`, `...3` = `x86_64`, `...4` = `arm64-v8a`).
 */
export function inferInstalledAbiFromBuildCode(versionCode: number): SupportedApkAbi | null {
  if (!Number.isFinite(versionCode) || versionCode < 10_000) return null;
  const suffix = versionCode % 10;
  if (suffix === 4) return 'arm64-v8a';
  if (suffix === 2) return 'armeabi-v7a';
  if (suffix === 3) return 'x86_64';
  return null;
}

/**
 * Detects ordered CPU ABIs supported by the running Android device without hardcoding `arm64-v8a`.
 */
export function detectDeviceAbis(overridePlatformConstants?: Record<string, unknown>): string[] {
  const consts =
    overridePlatformConstants ??
    ((Platform.constants ?? {}) as unknown as Record<string, unknown>);

  const candidates = [
    consts.SupportedAbis,
    consts.supportedAbis,
    consts.abis,
    (Constants.platform as Record<string, unknown> | undefined)?.android &&
      ((Constants.platform as Record<string, Record<string, unknown>>).android?.supportedAbis ??
        (Constants.platform as Record<string, Record<string, unknown>>).android?.abis),
  ];

  for (const list of candidates) {
    if (Array.isArray(list) && list.length > 0) {
      const normalized = list
        .map((v) => String(v ?? '').trim().toLowerCase())
        .filter(Boolean);
      if (normalized.length > 0) return normalized;
    }
  }

  const singleArch = String(consts.arch ?? consts.osArch ?? '').trim().toLowerCase();
  if (singleArch) {
    if (singleArch === 'aarch64' || singleArch === 'arm64' || singleArch === 'arm64-v8a') {
      return ['arm64-v8a'];
    }
    if (singleArch === 'armv7l' || singleArch === 'armeabi-v7a' || singleArch === 'armeabi' || singleArch === 'arm') {
      return ['armeabi-v7a'];
    }
    if (singleArch === 'x86_64' || singleArch === 'amd64') {
      return ['x86_64'];
    }
    return [singleArch];
  }

  const fromInstalledBuild = inferInstalledAbiFromBuildCode(getInstalledBuildCode());
  if (fromInstalledBuild) return [fromInstalledBuild];

  return ['arm64-v8a'];
}

function normalizeAbiToken(raw: string): SupportedApkAbi | null {
  const clean = raw.trim().toLowerCase();
  if (clean === 'arm64-v8a' || clean === 'arm64' || clean === 'aarch64') return 'arm64-v8a';
  if (clean === 'armeabi-v7a' || clean === 'armeabi') return 'armeabi-v7a';
  if (clean === 'x86_64' || clean === 'amd64') return 'x86_64';
  return null;
}

/**
 * Pure, deterministic APK selector matching device ABI priority order against available release
 * artifacts. Never substitutes an `arm64-v8a` binary onto an `armeabi-v7a`, `x86_64`, or unsupported device.
 */
export function selectApkArtifactForAbis(
  deviceAbis: readonly string[],
  release: Pick<
    AppReleaseInfo,
    'apkUrl' | 'arm32ApkUrl' | 'x86_64ApkUrl' | 'abis' | 'sha256' | 'fileSizeBytes'
  >,
): ApkSelectionOutcome {
  if (!Array.isArray(deviceAbis) || deviceAbis.length === 0) {
    return {
      ok: false,
      unsupportedAbis: [],
      message: 'Could not determine device CPU architecture for APK installation.',
    };
  }

  const artifacts: Record<SupportedApkAbi, { url: string; sha256: string | null; sizeBytes: number | null }> = {
    'arm64-v8a': {
      url: release.abis?.['arm64-v8a']?.url || release.apkUrl || LATEST_SLIM_APK_CDN_URL,
      sha256: release.abis?.['arm64-v8a']?.sha256 ?? release.sha256 ?? null,
      sizeBytes: release.abis?.['arm64-v8a']?.sizeBytes ?? release.fileSizeBytes ?? null,
    },
    'armeabi-v7a': {
      url: release.abis?.['armeabi-v7a']?.url || release.arm32ApkUrl || LATEST_ARM32_APK_CDN_URL,
      sha256: release.abis?.['armeabi-v7a']?.sha256 ?? null,
      sizeBytes: release.abis?.['armeabi-v7a']?.sizeBytes ?? null,
    },
    x86_64: {
      url: release.abis?.x86_64?.url || release.x86_64ApkUrl || LATEST_X86_64_APK_CDN_URL,
      sha256: release.abis?.x86_64?.sha256 ?? null,
      sizeBytes: release.abis?.x86_64?.sizeBytes ?? null,
    },
  };

  for (const candidate of deviceAbis) {
    const mapped = normalizeAbiToken(candidate);
    if (!mapped) continue;
    const chosen = artifacts[mapped];
    if (chosen?.url) {
      return {
        ok: true,
        abi: mapped,
        url: chosen.url,
        sha256: chosen.sha256,
        sizeBytes: chosen.sizeBytes,
      };
    }
  }

  return {
    ok: false,
    unsupportedAbis: [...deviceAbis],
    message: `No compatible signed APK is available for this device architecture (${deviceAbis.join(', ')}).`,
  };
}

/**
 * Validates HTTP response status and headers for an APK download before accepting bytes.
 */
export function validateApkHttpHeaders(
  status: number,
  headers?: Record<string, string> | null,
): { ok: true } | { ok: false; reason: string } {
  if (status < 200 || status >= 300) {
    return { ok: false, reason: `Download failed with HTTP ${status}.` };
  }
  if (headers) {
    const contentTypeEntry = Object.entries(headers).find(
      ([k]) => k.toLowerCase() === 'content-type',
    );
    const contentType = (contentTypeEntry?.[1] ?? '').toLowerCase();
    if (
      contentType.includes('text/html') ||
      contentType.includes('application/json') ||
      contentType.includes('application/xml')
    ) {
      return {
        ok: false,
        reason: `Unexpected non-APK response type (${contentType}).`,
      };
    }
  }
  return { ok: true };
}

/**
 * Verifies that a local APK file has valid ZIP/APK magic bytes (`PK\x03\x04`) and matches the
 * expected byte size before Android Package Installer is ever invoked.
 */
export function verifyApkZipMagicAndSize(
  headerBase64: string | null | undefined,
  actualSizeBytes: number,
  expectedSizeBytes?: number | null,
): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(actualSizeBytes) || actualSizeBytes < 5_000_000) {
    return { ok: false, reason: 'Downloaded APK file is truncated or incomplete.' };
  }
  if (typeof headerBase64 === 'string' && headerBase64.length >= 5) {
    if (!headerBase64.startsWith(APK_ZIP_MAGIC_BASE64_PREFIX)) {
      return { ok: false, reason: 'Downloaded file does not have a valid Android APK signature header.' };
    }
  }
  if (expectedSizeBytes && expectedSizeBytes > 1_000_000) {
    if (Math.abs(actualSizeBytes - expectedSizeBytes) > 4096) {
      return {
        ok: false,
        reason: `APK byte size mismatch (got ${actualSizeBytes}, expected ${expectedSizeBytes}).`,
      };
    }
  }
  return { ok: true };
}

/**
 * Reads the exact installed build code from Android native metadata (`android.versionCode`),
 * falling back to `EXPO_PUBLIC_BUILD_NUMBER` on web.
 */
export function getInstalledBuildCode(): number {
  const nativeCode = Number.parseInt(String(Application.nativeBuildVersion ?? ''), 10);
  if (Number.isFinite(nativeCode) && nativeCode > 0) return nativeCode;

  const envCode = Number.parseInt(process.env.EXPO_PUBLIC_BUILD_NUMBER ?? '', 10);
  if (Number.isFinite(envCode) && envCode > 0) return envCode;

  return 100;
}

/**
 * Returns the exact human-readable release version currently running on this device
 * (e.g. `1.0.215`), synthesizing `1.0.<run>` automatically even on legacy APKs whose
 * `AndroidManifest` carried `1.0.0` before explicit `versionName` injection.
 */
export function getInstalledVersionLabel(): string {
  const code = getInstalledBuildCode();
  const train = getReleaseTrain(code);
  const nativeVer = Application.nativeApplicationVersion?.trim();
  const configVer = Constants.expoConfig?.version?.trim();
  const envVer = process.env.EXPO_PUBLIC_APP_VERSION?.trim();

  const bestExplicit = [nativeVer, envVer, configVer].find(
    (v) => v && v !== '1.0.0',
  );
  if (bestExplicit) return bestExplicit;

  if (train > 1000) {
    return `1.0.${train - 1000}`;
  }
  return nativeVer || configVer || '1.0.0';
}

function getApkStorageDir(): string | null {
  const base = FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
  if (!base) return null;
  return `${base}${APK_STORAGE_SUBDIR}`;
}

function getApkStoragePath(versionCode: number, abi: SupportedApkAbi): string | null {
  const dir = getApkStorageDir();
  if (!dir) return null;
  return `${dir}${APK_CACHE_PREFIX}${versionCode}-${abi}.apk`;
}

async function ensureApkStorageDir(): Promise<void> {
  const dir = getApkStorageDir();
  if (!dir) return;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
}

async function readLocalApkHeaderBase64(uri: string): Promise<string | null> {
  try {
    return await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length: 4,
    });
  } catch {
    return null;
  }
}

async function hasValidCachedApk(
  versionCode: number,
  abi: SupportedApkAbi,
  expectedSizeBytes?: number | null,
): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  const target = getApkStoragePath(versionCode, abi);
  if (!target) return null;
  try {
    const info = await FileSystem.getInfoAsync(target);
    if (!info.exists || typeof info.size !== 'number') return null;
    const headerBase64 = await readLocalApkHeaderBase64(target);
    const check = verifyApkZipMagicAndSize(headerBase64, info.size, expectedSizeBytes);
    return check.ok ? target : null;
  } catch {
    return null;
  }
}

async function pruneOldCachedApks(keepVersionCode: number, keepAbi: SupportedApkAbi): Promise<void> {
  if (Platform.OS !== 'android') return;
  const dir = getApkStorageDir();
  if (!dir) return;
  try {
    const entries = await FileSystem.readDirectoryAsync(dir);
    const keepName = `${APK_CACHE_PREFIX}${keepVersionCode}-${keepAbi}.apk`;
    await Promise.all(
      entries
        .filter((name) => name.startsWith(APK_CACHE_PREFIX) && name !== keepName)
        .map((name) =>
          FileSystem.deleteAsync(`${dir}${name}`, {
            idempotent: true,
          }).catch(() => {}),
        ),
    );
  } catch {
    // Non-fatal cleanup
  }
}

async function reconcilePendingInstall(installedTrain: number): Promise<PendingInstallRecord | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_INSTALL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingInstallRecord;
    if (!parsed || typeof parsed.targetTrain !== 'number') return null;

    // If Android actually replaced the installed APK, clear the pending marker AND clean up disk!
    if (installedTrain >= parsed.targetTrain) {
      await AsyncStorage.removeItem(PENDING_INSTALL_STORAGE_KEY).catch(() => {});
      if (parsed.localUri) {
        await FileSystem.deleteAsync(parsed.localUri, { idempotent: true }).catch(() => {});
      }
      return null;
    }

    // If the user returned to Hallyu and is STILL running the older build code, mark honestly
    // as `not_installed_yet` so Hallyu never falsely claims installation succeeded!
    if (parsed.localUri) {
      const info = await FileSystem.getInfoAsync(parsed.localUri).catch(() => null);
      if (!info?.exists) {
        await AsyncStorage.removeItem(PENDING_INSTALL_STORAGE_KEY).catch(() => {});
        return null;
      }
    }
    const updated: PendingInstallRecord = {
      ...parsed,
      status: 'not_installed_yet',
    };
    await AsyncStorage.setItem(PENDING_INSTALL_STORAGE_KEY, JSON.stringify(updated)).catch(() => {});
    return updated;
  } catch {
    return null;
  }
}

async function detectPostInstallUpgrade(
  installedTrain: number,
  installedVersion: string,
): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(SEEN_VERSION_STORAGE_KEY);
    if (!raw) {
      await AsyncStorage.setItem(
        SEEN_VERSION_STORAGE_KEY,
        JSON.stringify({ train: installedTrain, version: installedVersion }),
      );
      return null;
    }
    const parsed = JSON.parse(raw) as {
      train?: number;
      version?: string;
      upgradedFrom?: string | null;
      ackAt?: number;
    };
    if (typeof parsed.train === 'number' && installedTrain > parsed.train) {
      const prevVersion = parsed.version || `1.0.${Math.max(0, parsed.train - 1000)}`;
      await AsyncStorage.setItem(
        SEEN_VERSION_STORAGE_KEY,
        JSON.stringify({
          train: installedTrain,
          version: installedVersion,
          upgradedFrom: prevVersion,
          ackAt: Date.now(),
        }),
      );
      return prevVersion;
    }
    if (parsed.upgradedFrom && parsed.ackAt && Date.now() - parsed.ackAt < 86_400_000) {
      return parsed.upgradedFrom;
    }
    return null;
  } catch {
    return null;
  }
}

function parseManifestAbis(rawAbis: unknown): Partial<Record<SupportedApkAbi, AbiArtifactInfo>> | undefined {
  if (!rawAbis || typeof rawAbis !== 'object') return undefined;
  const out: Partial<Record<SupportedApkAbi, AbiArtifactInfo>> = {};
  for (const key of ['arm64-v8a', 'armeabi-v7a', 'x86_64'] as const) {
    const entry = (rawAbis as Record<string, unknown>)[key];
    if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).url === 'string') {
      const obj = entry as Record<string, unknown>;
      out[key] = {
        abi: key,
        url: String(obj.url),
        sha256: obj.sha256 ? String(obj.sha256) : null,
        sizeBytes: typeof obj.sizeBytes === 'number' ? obj.sizeBytes : null,
        versionCode: typeof obj.versionCode === 'number' ? obj.versionCode : null,
      };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function openUnknownSourcesSettings(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const pkg = Application.applicationId ?? 'com.hallyu.app';
  await IntentLauncher.startActivityAsync('android.settings.MANAGE_UNKNOWN_APP_SOURCES', {
    data: `package:${pkg}`,
  }).catch(() => Linking.openSettings().catch(() => {}));
}

/**
 * Checks BOTH `public.get_latest_app_release()` AND live CDN `latest/manifest.json` (cache-busted)
 * and verifies actual installed build + any pending unconfirmed APK installation honestly.
 */
export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  const installedCode = getInstalledBuildCode();
  const installedTrain = getReleaseTrain(installedCode);
  const installedVersion = getInstalledVersionLabel();
  const deviceAbis = detectDeviceAbis();

  let rpcLatest: AppReleaseInfo | null = null;
  let cdnLatest: AppReleaseInfo | null = null;

  const [rpcOutcome, manifestOutcome] = await Promise.allSettled([
    supabase ? supabase.rpc('get_latest_app_release') : Promise.resolve({ data: null, error: null }),
    fetch(`${SUPABASE_PUBLIC_STORAGE_BASE}/latest/manifest.json?t=${Date.now()}`, {
      headers: { 'Cache-Control': 'no-cache' },
    }).then((r) => (r.ok ? r.json() : null)),
  ]);

  if (
    rpcOutcome.status === 'fulfilled' &&
    !rpcOutcome.value.error &&
    rpcOutcome.value.data &&
    typeof rpcOutcome.value.data === 'object'
  ) {
    const raw = rpcOutcome.value.data as Record<string, unknown>;
    const vCode = Number(raw.version_code ?? 0);
    if (vCode > 0) {
      const rawUniv = String(raw.universal_apk_url ?? '');
      rpcLatest = {
        versionCode: vCode,
        releaseTrain: getReleaseTrain(vCode),
        versionName: String(raw.version_name ?? `1.0.${Math.max(0, getReleaseTrain(vCode) - 1000)}`),
        apkUrl: String(raw.apk_url ?? LATEST_SLIM_APK_CDN_URL),
        arm32ApkUrl:
          rawUniv.includes('/storage/v1/object/public/') && !rawUniv.endsWith('hallyu-arm64.apk')
            ? rawUniv
            : LATEST_ARM32_APK_CDN_URL,
        x86_64ApkUrl: LATEST_X86_64_APK_CDN_URL,
        sha256: raw.sha256 ? String(raw.sha256) : null,
        fileSizeBytes: typeof raw.file_size_bytes === 'number' ? raw.file_size_bytes : null,
        gitCommit: raw.git_commit ? String(raw.git_commit) : null,
        publishedAt: raw.published_at ? String(raw.published_at) : null,
        releaseNotes: String(raw.release_notes ?? 'Signed Hallyu performance & stability update.'),
        isMandatory: Boolean(raw.is_mandatory),
        minSupportedVersion: Number(raw.min_supported_version ?? 1),
      };
    }
  }

  if (manifestOutcome.status === 'fulfilled' && manifestOutcome.value) {
    const m = manifestOutcome.value as Record<string, unknown>;
    const mCode = Number(m.versionCode ?? 0);
    if (mCode > 0) {
      cdnLatest = {
        versionCode: mCode,
        releaseTrain: getReleaseTrain(mCode),
        versionName: String(m.version ?? `1.0.${Math.max(0, getReleaseTrain(mCode) - 1000)}`),
        apkUrl: String(m.slimUrl ?? LATEST_SLIM_APK_CDN_URL),
        arm32ApkUrl:
          typeof m.arm32Url === 'string' && !m.arm32Url.endsWith('hallyu-arm64.apk')
            ? m.arm32Url
            : LATEST_ARM32_APK_CDN_URL,
        x86_64ApkUrl:
          typeof m.x86_64Url === 'string' && !m.x86_64Url.endsWith('hallyu-arm64.apk')
            ? m.x86_64Url
            : LATEST_X86_64_APK_CDN_URL,
        abis: parseManifestAbis(m.abis),
        sha256: m.slimSha256 ? String(m.slimSha256) : null,
        fileSizeBytes:
          typeof m.slimSizeBytes === 'number'
            ? m.slimSizeBytes
            : typeof m.slimSizeMb === 'number'
              ? Math.round(m.slimSizeMb * 1024 * 1024)
              : null,
        gitCommit: m.commit ? String(m.commit) : null,
        publishedAt: m.publishedAt ? String(m.publishedAt) : null,
        releaseNotes: String(m.notes ?? 'Signed Hallyu performance & stability update.'),
        isMandatory: false,
        minSupportedVersion: 1,
      };
    }
  }

  const latest: AppReleaseInfo =
    cdnLatest && (!rpcLatest || cdnLatest.versionCode >= rpcLatest.versionCode)
      ? {
          ...rpcLatest,
          ...cdnLatest,
          isMandatory: rpcLatest?.isMandatory ?? false,
          minSupportedVersion: rpcLatest?.minSupportedVersion ?? 1,
        }
      : rpcLatest ?? {
          versionCode: installedCode,
          releaseTrain: installedTrain,
          versionName: installedVersion,
          apkUrl: LATEST_SLIM_APK_CDN_URL,
          arm32ApkUrl: LATEST_ARM32_APK_CDN_URL,
          x86_64ApkUrl: LATEST_X86_64_APK_CDN_URL,
          releaseNotes: 'Signed Hallyu release.',
          isMandatory: false,
          minSupportedVersion: 1,
        };

  const selectedArtifact = selectApkArtifactForAbis(deviceAbis, latest);
  const hasUpdate = isReleaseNewer(installedCode, installedVersion, latest);
  const pendingInstall = await reconcilePendingInstall(installedTrain);
  const justUpdatedFromVersion = await detectPostInstallUpgrade(installedTrain, installedVersion);
  const cachedPath =
    hasUpdate && selectedArtifact.ok
      ? await hasValidCachedApk(latest.versionCode, selectedArtifact.abi, selectedArtifact.sizeBytes)
      : null;

  return {
    installedCode,
    installedTrain,
    installedVersion,
    deviceAbis,
    selectedArtifact,
    latest,
    hasUpdate,
    isMandatory: hasUpdate && (latest.isMandatory || installedCode < latest.minSupportedVersion),
    justUpdatedFromVersion,
    cachedApkReady: Boolean(cachedPath),
    pendingInstall,
  };
}

/**
 * Launches Android's native Package Installer against a persistent verified local APK URI using
 * `FLAG_GRANT_READ_URI_PERMISSION` (WITHOUT `FLAG_ACTIVITY_NEW_TASK`) and inspects the authentic
 * `resultCode` returned by Android's installer dialog so Hallyu NEVER falsely reports success
 * when installation was canceled or blocked by unknown-sources permissions.
 */
async function launchAndroidPackageInstaller(
  localFileUri: string,
  selectedAbi: SupportedApkAbi,
  targetVersionCode: number,
  targetVersionName: string,
  usedCachedApk: boolean,
): Promise<InstallLaunchOutcome> {
  const contentUri = await FileSystem.getContentUriAsync(localFileUri);
  const targetTrain = getReleaseTrain(targetVersionCode);

  const initialPending: PendingInstallRecord = {
    targetVersionCode,
    targetTrain,
    targetVersionName,
    abi: selectedAbi,
    localUri: localFileUri,
    startedAt: Date.now(),
    status: 'awaiting_user_install',
  };
  await AsyncStorage.setItem(PENDING_INSTALL_STORAGE_KEY, JSON.stringify(initialPending)).catch(
    () => {},
  );

  try {
    const res = await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      flags: FLAG_GRANT_READ_URI_PERMISSION,
      type: 'application/vnd.android.package-archive',
      extra: {
        'android.intent.extra.RETURN_RESULT': true,
        'android.intent.extra.NOT_UNKNOWN_SOURCE': true,
      },
    });

    const installedTrainAfter = getReleaseTrain(getInstalledBuildCode());
    if (
      res?.resultCode === IntentLauncher.ResultCode?.Canceled &&
      installedTrainAfter < targetTrain
    ) {
      const notInstalled: PendingInstallRecord = {
        ...initialPending,
        status: 'not_installed_yet',
      };
      await AsyncStorage.setItem(PENDING_INSTALL_STORAGE_KEY, JSON.stringify(notInstalled)).catch(
        () => {},
      );
      return { status: 'not_installed_yet', usedCachedApk, selectedAbi };
    }

    return { status: 'awaiting_user_install', usedCachedApk, selectedAbi };
  } catch {
    await openUnknownSourcesSettings();
    return { status: 'needs_unknown_sources_permission', selectedAbi };
  }
}

/**
 * Selects the exact APK binary matching this device's CPU ABI, verifies HTTP status/headers,
 * APK ZIP header magic (`PK\x03\x04`), and expected byte size, stores it in persistent
 * `documentDirectory`, then launches Android Package Installer honestly.
 */
export async function downloadAndInstallApk(
  release: Pick<
    AppReleaseInfo,
    | 'apkUrl'
    | 'arm32ApkUrl'
    | 'x86_64ApkUrl'
    | 'abis'
    | 'versionCode'
    | 'versionName'
    | 'fileSizeBytes'
    | 'sha256'
  >,
  onProgress?: (snapshot: DownloadProgressSnapshot) => void,
  overrideDeviceAbis?: readonly string[],
): Promise<InstallLaunchOutcome> {
  const deviceAbis = overrideDeviceAbis ?? detectDeviceAbis();
  const selection = selectApkArtifactForAbis(deviceAbis, release);
  if (!selection.ok) {
    throw new Error(selection.message);
  }

  const { abi, url, sizeBytes } = selection;
  const targetDir = getApkStorageDir();

  if (Platform.OS !== 'android' || !targetDir) {
    await Linking.openURL(url);
    return { status: 'browser_opened', selectedAbi: abi };
  }

  await ensureApkStorageDir();
  await pruneOldCachedApks(release.versionCode, abi);

  const vName =
    release.versionName || `1.0.${Math.max(0, getReleaseTrain(release.versionCode) - 1000)}`;

  const existingValid = await hasValidCachedApk(release.versionCode, abi, sizeBytes);
  if (existingValid) {
    const total = sizeBytes ?? 34_300_000;
    onProgress?.({
      percent: 100,
      writtenBytes: total,
      totalBytes: total,
      speedBytesPerSec: 0,
    });
    return launchAndroidPackageInstaller(existingValid, abi, release.versionCode, vName, true);
  }

  const targetPath = getApkStoragePath(release.versionCode, abi)!;
  await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});

  const startedAt = Date.now();
  let lastEmitAt = 0;
  let lastPercent = -1;

  const resumable = FileSystem.createDownloadResumable(url, targetPath, {}, (prog) => {
    const now = Date.now();
    const total =
      prog.totalBytesExpectedToWrite > 0
        ? prog.totalBytesExpectedToWrite
        : sizeBytes ?? 34_300_000;
    const pct =
      total > 0
        ? Math.min(100, Math.round((prog.totalBytesWritten / total) * 100))
        : 0;

    if (pct < 100 && now - lastEmitAt < 160 && pct === lastPercent) {
      return;
    }
    lastEmitAt = now;
    lastPercent = pct;

    const elapsedSec = Math.max(0.25, (now - startedAt) / 1000);
    onProgress?.({
      percent: pct,
      writtenBytes: prog.totalBytesWritten,
      totalBytes: total,
      speedBytesPerSec: Math.round(prog.totalBytesWritten / elapsedSec),
    });
  });

  const downloaded = await resumable.downloadAsync();
  if (!downloaded?.uri) {
    await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
    throw new Error('Download interrupted before completion. Please tap retry.');
  }

  const headerCheck = validateApkHttpHeaders(downloaded.status, downloaded.headers);
  if (!headerCheck.ok) {
    await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
    throw new Error(`${headerCheck.reason} Please tap retry.`);
  }

  const stat = await FileSystem.getInfoAsync(downloaded.uri);
  const actualSize = stat.exists && typeof stat.size === 'number' ? stat.size : 0;
  const headerBase64 = await readLocalApkHeaderBase64(downloaded.uri);
  const integrityCheck = verifyApkZipMagicAndSize(headerBase64, actualSize, sizeBytes);
  if (!integrityCheck.ok) {
    await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
    throw new Error(`${integrityCheck.reason} Partial file was removed so you can retry safely.`);
  }

  onProgress?.({
    percent: 100,
    writtenBytes: actualSize,
    totalBytes: actualSize,
    speedBytesPerSec: Math.round(actualSize / Math.max(0.25, (Date.now() - startedAt) / 1000)),
  });

  return launchAndroidPackageInstaller(downloaded.uri, abi, release.versionCode, vName, false);
}
