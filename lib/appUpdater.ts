import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { Linking, NativeModules, Platform } from 'react-native';
import { supabase } from './api/client';
import {
  ANDROID_RELEASE_SHA256,
  LATEST_ARM32_APK_CDN_URL,
  LATEST_ARM64_APK_CDN_URL,
  LATEST_UNIVERSAL_APK_CDN_URL,
  LATEST_X86_64_APK_CDN_URL,
  LATEST_X86_APK_CDN_URL,
  SUPABASE_PUBLIC_STORAGE_BASE,
} from './links';

export type SupportedApkAbi = 'arm64-v8a' | 'armeabi-v7a' | 'x86_64' | 'x86' | 'universal';

export interface AbiArtifactInfo {
  abi: SupportedApkAbi;
  url: string;
  fallbackGithubUrl?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
  versionCode?: number | null;
  supportedAbis?: string[];
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

export interface NativeInstalledPackageInfo {
  packageName: string;
  versionName: string;
  versionCode: number;
  minSdkVersion: number;
  targetSdkVersion: number;
  nativeLibraryDir: string;
  signingSha256: string;
  signingSha256List: string[];
}

export interface AndroidDeviceEnvironment {
  source: 'native-os' | 'fallback';
  supportedAbis: string[];
  supported64BitAbis: string[];
  supported32BitAbis: string[];
  kernelArch: string;
  cpu64BitCapableOs32BitOnly: boolean;
  sdkInt: number;
  androidRelease: string;
  brand: string;
  manufacturer: string;
  model: string;
  device: string;
  canRequestPackageInstalls: boolean;
  installed: NativeInstalledPackageInfo;
}

export interface ApkArchiveInspection {
  ok: boolean;
  reasonCode: string;
  message: string;
  sizeBytes?: number;
  actualSha256?: string;
  packageName?: string;
  versionName?: string;
  versionCode?: number;
  minSdkVersion?: number;
  targetSdkVersion?: number;
  apkAbis?: string[];
  deviceAbis?: string[];
  matchedAbi?: string | null;
  signingSha256?: string;
  packageMatches?: boolean;
  signatureMatches?: boolean;
  sdkCompatible?: boolean;
  abiCompatible?: boolean;
  versionNotDowngrade?: boolean;
}

export interface AppReleaseInfo {
  packageId?: string;
  minSdkVersion?: number;
  targetSdkVersion?: number;
  signingSha256?: string;
  versionCode: number;
  releaseTrain: number;
  versionName: string;
  apkUrl: string;
  arm64ApkUrl: string;
  arm32ApkUrl: string;
  x86_64ApkUrl: string;
  x86ApkUrl: string;
  universalApkUrl: string;
  perAbi?: Partial<Record<SupportedApkAbi, AbiArtifactInfo>>;
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
  status: 'awaiting_user_install' | 'not_installed_yet' | 'cancelled_by_user' | 'install_failed';
  lastErrorReasonCode?: string | null;
  lastErrorMessage?: string | null;
}

export interface UpdateCheckResult {
  installedCode: number;
  installedTrain: number;
  installedVersion: string;
  deviceAbis: string[];
  deviceEnv: AndroidDeviceEnvironment | null;
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
  stage?: 'downloading' | 'verifying' | 'launching_installer';
}

export type InstallLaunchOutcome =
  | {
      status: 'installed';
      usedCachedApk: boolean;
      selectedAbi: SupportedApkAbi;
      inspection: ApkArchiveInspection | null;
    }
  | {
      status: 'awaiting_user_install';
      usedCachedApk: boolean;
      selectedAbi: SupportedApkAbi;
      inspection: ApkArchiveInspection | null;
    }
  | {
      status: 'cancelled_by_user';
      usedCachedApk: boolean;
      selectedAbi: SupportedApkAbi;
      message: string;
    }
  | {
      status: 'not_installed_yet';
      usedCachedApk: boolean;
      selectedAbi: SupportedApkAbi;
      message?: string;
    }
  | {
      status: 'needs_unknown_sources_permission';
      selectedAbi: SupportedApkAbi;
      message?: string;
    }
  | {
      status: 'install_failed';
      reasonCode: string;
      message: string;
      selectedAbi: SupportedApkAbi;
      inspection?: ApkArchiveInspection | null;
    }
  | { status: 'browser_opened'; selectedAbi: SupportedApkAbi };

interface NativeApkInstallerBridge {
  getDeviceEnvironment(): Promise<Omit<AndroidDeviceEnvironment, 'source'>>;
  inspectApkArchive(
    filePathOrUri: string,
    expectedSha256: string | null,
  ): Promise<ApkArchiveInspection>;
  installApkSession(filePathOrUri: string): Promise<{
    status: string;
    androidStatus?: number;
    reasonCode?: string;
    message?: string;
  }>;
}

function getNativeInstallerBridge(): NativeApkInstallerBridge | null {
  if (Platform.OS !== 'android') return null;
  const mod = (NativeModules as Record<string, unknown>)?.HallyuApkInstaller as
    | NativeApkInstallerBridge
    | undefined;
  return mod && typeof mod.getDeviceEnvironment === 'function' ? mod : null;
}

const SEEN_VERSION_STORAGE_KEY = 'hallyu.updater.seenBuild.v2';
const PENDING_INSTALL_STORAGE_KEY = 'hallyu.updater.pendingInstall.v1';
const APK_STORAGE_SUBDIR = 'hallyu-updates/';
const APK_CACHE_PREFIX = 'hallyu-release-';
const APK_ZIP_MAGIC_BASE64_PREFIX = 'UEsDB'; // `PK\x03\x04` (0x50 0x4b 0x03 0x04)
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;

let cachedNativeEnv: AndroidDeviceEnvironment | null = null;

/**
 * Normalizes ABI-split version codes (`12191` x86, `12192` armeabi-v7a, `12193` x86_64,
 * `12194` arm64-v8a, `12195` universal) to their shared CI release train (`1219`) so EVERY
 * ABI variant of the exact same commit knows with 100% certainty whether it is up to date.
 */
export function getReleaseTrain(versionCode: number): number {
  if (!Number.isFinite(versionCode) || versionCode <= 0) return 0;
  return versionCode >= 10_000 ? Math.floor(versionCode / 10) : versionCode;
}

/**
 * Compares version strings numerically across arbitrary segments including zero-padded segments
 * like `1.7.01` vs `1.7.02` vs `1.0.219` (`-1` if `a < b`, `0` if equal, `1` if `a > b`).
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
 * Infers the specific per-ABI split from split versionCode suffix ONLY when installed build is an
 * explicit single-ABI split (`...1` in >=12190 = `x86` only when native confirmed, `...2` = `armeabi-v7a`,
 * `...3` = `x86_64`, `...4` = `arm64-v8a`). Returns `null` when unknown or Universal (`...5` / legacy `...1`)
 * so Hallyu NEVER guesses `arm64-v8a` on a 32-bit phone!
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
 * Queries real Android OS runtime environment via `HallyuApkInstaller.getDeviceEnvironment()`,
 * distinguishing hardware CPU capability (`kernelArch` e.g. `aarch64` Cortex-A53) from the ABIs
 * actually supported by the installed Android OS Zygote (`Build.SUPPORTED_ABIS` e.g. `armeabi-v7a`).
 */
export async function resolveAndroidDeviceEnvironment(): Promise<AndroidDeviceEnvironment | null> {
  if (Platform.OS !== 'android') return null;
  const bridge = getNativeInstallerBridge();
  if (bridge) {
    try {
      const raw = await bridge.getDeviceEnvironment();
      const env: AndroidDeviceEnvironment = {
        source: 'native-os',
        supportedAbis: Array.isArray(raw.supportedAbis)
          ? raw.supportedAbis.map((s) => String(s).trim()).filter(Boolean)
          : [],
        supported64BitAbis: Array.isArray(raw.supported64BitAbis) ? raw.supported64BitAbis : [],
        supported32BitAbis: Array.isArray(raw.supported32BitAbis) ? raw.supported32BitAbis : [],
        kernelArch: String(raw.kernelArch ?? ''),
        cpu64BitCapableOs32BitOnly: Boolean(raw.cpu64BitCapableOs32BitOnly),
        sdkInt: Number(raw.sdkInt || Platform.Version || 23),
        androidRelease: String(raw.androidRelease ?? ''),
        brand: String(raw.brand ?? ''),
        manufacturer: String(raw.manufacturer ?? ''),
        model: String(raw.model ?? ''),
        device: String(raw.device ?? ''),
        canRequestPackageInstalls: Boolean(raw.canRequestPackageInstalls),
        installed: {
          packageName: String(raw.installed?.packageName ?? Application.applicationId ?? 'com.hallyu.app'),
          versionName: String(raw.installed?.versionName ?? Application.nativeApplicationVersion ?? ''),
          versionCode: Number(raw.installed?.versionCode ?? getInstalledBuildCode()),
          minSdkVersion: Number(raw.installed?.minSdkVersion ?? 23),
          targetSdkVersion: Number(raw.installed?.targetSdkVersion ?? 34),
          nativeLibraryDir: String(raw.installed?.nativeLibraryDir ?? ''),
          signingSha256: String(raw.installed?.signingSha256 ?? ''),
          signingSha256List: Array.isArray(raw.installed?.signingSha256List)
            ? raw.installed.signingSha256List
            : [],
        },
      };
      cachedNativeEnv = env;
      return env;
    } catch {
      // Fall through to non-assumed metadata below
    }
  }

  const inferred = inferInstalledAbiFromBuildCode(getInstalledBuildCode());
  const consts = (Platform.constants ?? {}) as Record<string, unknown>;
  return {
    source: 'fallback',
    supportedAbis: inferred ? [inferred] : ['universal'],
    supported64BitAbis: inferred === 'arm64-v8a' || inferred === 'x86_64' ? [inferred] : [],
    supported32BitAbis: inferred === 'armeabi-v7a' || inferred === 'x86' ? [inferred] : [],
    kernelArch: '',
    cpu64BitCapableOs32BitOnly: false,
    sdkInt: typeof Platform.Version === 'number' ? Platform.Version : 23,
    androidRelease: String(consts.Release ?? ''),
    brand: String(consts.Brand ?? ''),
    manufacturer: String(consts.Manufacturer ?? ''),
    model: String(consts.Model ?? ''),
    device: '',
    canRequestPackageInstalls: true,
    installed: {
      packageName: Application.applicationId ?? 'com.hallyu.app',
      versionName: Application.nativeApplicationVersion ?? '',
      versionCode: getInstalledBuildCode(),
      minSdkVersion: 23,
      targetSdkVersion: 34,
      nativeLibraryDir: '',
      signingSha256: '',
      signingSha256List: [],
    },
  };
}

/**
 * Synchronously returns ordered device ABIs from cached native Android OS `Build.SUPPORTED_ABIS`
 * (or optional override constants for unit tests). NEVER guesses `arm64-v8a` when unknown —
 * returns `['universal']` when exact OS ABI has not been verified natively so a 32-bit phone
 * can NEVER accidentally be fed an `arm64-v8a`-only split!
 */
export function detectDeviceAbis(overridePlatformConstants?: Record<string, unknown>): string[] {
  if (!overridePlatformConstants && cachedNativeEnv?.supportedAbis?.length) {
    return [...cachedNativeEnv.supportedAbis];
  }

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
    if (
      singleArch === 'armv7l' ||
      singleArch === 'armeabi-v7a' ||
      singleArch === 'armeabi' ||
      singleArch === 'arm'
    ) {
      return ['armeabi-v7a'];
    }
    if (singleArch === 'x86_64' || singleArch === 'amd64') {
      return ['x86_64'];
    }
    if (singleArch === 'x86' || singleArch === 'i686' || singleArch === 'i386' || singleArch === 'ia32') {
      return ['x86'];
    }
    return [singleArch];
  }

  const fromInstalledBuild = inferInstalledAbiFromBuildCode(getInstalledBuildCode());
  if (fromInstalledBuild) return [fromInstalledBuild];

  return ['universal'];
}

export function normalizeAbiToken(raw: string): SupportedApkAbi | null {
  const clean = raw.trim().toLowerCase();
  if (clean === 'arm64-v8a' || clean === 'arm64' || clean === 'aarch64') return 'arm64-v8a';
  if (clean === 'armeabi-v7a' || clean === 'armeabi' || clean === 'armv7' || clean === 'armv7l') {
    return 'armeabi-v7a';
  }
  if (clean === 'x86_64' || clean === 'amd64') return 'x86_64';
  if (clean === 'x86' || clean === 'i686' || clean === 'i386' || clean === 'ia32') return 'x86';
  if (clean === 'universal') return 'universal';
  return null;
}

/**
 * Pure, deterministic APK selector matching Android's exact `Build.SUPPORTED_ABIS` priority order
 * across `arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`, and `universal`:
 *   1. Prefers exact `perAbi` artifact when available (fast ~16–20 MB download matching exact ABI).
 *   2. Uses `universal` (4-ABI `arm64-v8a` + `armeabi-v7a` + `x86_64` + `x86`) ONLY when device
 *      ABI was `'universal'` (unknown) or if a specific split URL was omitted while universal supports it.
 *   3. Cleanly rejects unsupported exotic architectures (`mips`, `riscv64`, empty list) with an
 *      honest, actionable error instead of ever silently serving an `arm64-v8a` APK.
 */
export async function getDeviceSupportedAbisAsync(): Promise<string[]> {
  const env = await resolveAndroidDeviceEnvironment();
  return env?.supportedAbis?.length ? env.supportedAbis : detectDeviceAbis();
}

export function selectApkArtifactForAbis(
  deviceAbis: readonly string[],
  release: Partial<
    Pick<
      AppReleaseInfo,
      | 'apkUrl'
      | 'arm64ApkUrl'
      | 'arm32ApkUrl'
      | 'x86_64ApkUrl'
      | 'x86ApkUrl'
      | 'universalApkUrl'
      | 'perAbi'
      | 'abis'
      | 'sha256'
      | 'fileSizeBytes'
    >
  >,
): ApkSelectionOutcome {
  const per = release.perAbi;
  const legacyAbis = release.abis;
  const explicitUniversalUrl = per?.universal?.url || legacyAbis?.universal?.url || release.universalApkUrl || '';

  if (!Array.isArray(deviceAbis) || deviceAbis.length === 0) {
    if (explicitUniversalUrl) {
      return {
        ok: true,
        abi: 'universal',
        url: explicitUniversalUrl,
        sha256: per?.universal?.sha256 ?? release.sha256 ?? null,
        sizeBytes: per?.universal?.sizeBytes ?? release.fileSizeBytes ?? null,
      };
    }
    return {
      ok: false,
      unsupportedAbis: [],
      message: 'Could not determine device CPU architecture for APK installation.',
    };
  }

  const artifacts: Record<
    SupportedApkAbi,
    { url: string; fallbackUrl: string | null; sha256: string | null; sizeBytes: number | null }
  > = {
    'arm64-v8a': {
      url:
        per?.['arm64-v8a']?.url ||
        release.arm64ApkUrl ||
        legacyAbis?.['arm64-v8a']?.url ||
        release.apkUrl ||
        LATEST_ARM64_APK_CDN_URL,
      fallbackUrl: per?.['arm64-v8a']?.fallbackGithubUrl ?? null,
      sha256: per?.['arm64-v8a']?.sha256 ?? legacyAbis?.['arm64-v8a']?.sha256 ?? release.sha256 ?? null,
      sizeBytes:
        per?.['arm64-v8a']?.sizeBytes ??
        legacyAbis?.['arm64-v8a']?.sizeBytes ??
        release.fileSizeBytes ??
        null,
    },
    'armeabi-v7a': {
      url:
        per?.['armeabi-v7a']?.url ||
        legacyAbis?.['armeabi-v7a']?.url ||
        release.arm32ApkUrl ||
        LATEST_ARM32_APK_CDN_URL,
      fallbackUrl: per?.['armeabi-v7a']?.fallbackGithubUrl ?? null,
      sha256: per?.['armeabi-v7a']?.sha256 ?? legacyAbis?.['armeabi-v7a']?.sha256 ?? null,
      sizeBytes: per?.['armeabi-v7a']?.sizeBytes ?? legacyAbis?.['armeabi-v7a']?.sizeBytes ?? null,
    },
    x86_64: {
      url:
        per?.x86_64?.url ||
        legacyAbis?.x86_64?.url ||
        release.x86_64ApkUrl ||
        LATEST_X86_64_APK_CDN_URL,
      fallbackUrl: per?.x86_64?.fallbackGithubUrl ?? null,
      sha256: per?.x86_64?.sha256 ?? legacyAbis?.x86_64?.sha256 ?? null,
      sizeBytes: per?.x86_64?.sizeBytes ?? legacyAbis?.x86_64?.sizeBytes ?? null,
    },
    x86: {
      url: per?.x86?.url || legacyAbis?.x86?.url || release.x86ApkUrl || LATEST_X86_APK_CDN_URL,
      fallbackUrl: per?.x86?.fallbackGithubUrl ?? null,
      sha256: per?.x86?.sha256 ?? legacyAbis?.x86?.sha256 ?? null,
      sizeBytes: per?.x86?.sizeBytes ?? legacyAbis?.x86?.sizeBytes ?? null,
    },
    universal: {
      url:
        per?.universal?.url ||
        release.universalApkUrl ||
        release.apkUrl ||
        LATEST_UNIVERSAL_APK_CDN_URL,
      fallbackUrl: per?.universal?.fallbackGithubUrl ?? null,
      sha256: per?.universal?.sha256 ?? release.sha256 ?? null,
      sizeBytes: per?.universal?.sizeBytes ?? release.fileSizeBytes ?? null,
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
 * Verifies that a local APK file has valid ZIP/APK magic bytes (`PK\x03\x04`) and exact byte length.
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
      return {
        ok: false,
        reason: 'Downloaded file does not have a valid Android APK signature header.',
      };
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
 * Reads the exact installed build code from native Android PackageManager metadata when available,
 * falling back to `Application.nativeBuildVersion` -> `EXPO_PUBLIC_BUILD_NUMBER`.
 */
export function getInstalledBuildCode(): number {
  if (cachedNativeEnv && cachedNativeEnv.installed.versionCode > 0) {
    return cachedNativeEnv.installed.versionCode;
  }

  const nativeCode = Number.parseInt(String(Application.nativeBuildVersion ?? ''), 10);
  if (Number.isFinite(nativeCode) && nativeCode > 0) return nativeCode;

  const envCode = Number.parseInt(process.env.EXPO_PUBLIC_BUILD_NUMBER ?? '', 10);
  if (Number.isFinite(envCode) && envCode > 0) return envCode;

  return 100;
}

/**
 * Returns the exact human-readable release version currently running on this device.
 */
export function getInstalledVersionLabel(): string {
  const code = getInstalledBuildCode();
  const train = getReleaseTrain(code);
  const nativePkgVer = cachedNativeEnv?.installed.versionName?.trim();
  const nativeVer = Application.nativeApplicationVersion?.trim();
  const configVer = Constants.expoConfig?.version?.trim();
  const envVer = process.env.EXPO_PUBLIC_APP_VERSION?.trim();

  const bestExplicit = [nativePkgVer, nativeVer, envVer, configVer].find(
    (v) => v && v !== '1.0.0',
  );
  if (bestExplicit) return bestExplicit;

  if (train > 1000) {
    return `1.0.${train - 1000}`;
  }
  return nativePkgVer || nativeVer || configVer || '1.0.0';
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

async function inspectLocalApkWithNativeBridge(
  uri: string,
  expectedSha256?: string | null,
): Promise<ApkArchiveInspection | null> {
  const bridge = getNativeInstallerBridge();
  if (!bridge) return null;
  return bridge.inspectApkArchive(uri, expectedSha256 ?? null);
}

async function hasValidCachedApk(
  versionCode: number,
  abi: SupportedApkAbi,
  expectedSizeBytes?: number | null,
  expectedSha256?: string | null,
): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  const target = getApkStoragePath(versionCode, abi);
  if (!target) return null;
  try {
    const info = await FileSystem.getInfoAsync(target);
    if (!info.exists || typeof info.size !== 'number') return null;
    const headerBase64 = await readLocalApkHeaderBase64(target);
    const check = verifyApkZipMagicAndSize(headerBase64, info.size, expectedSizeBytes);
    if (!check.ok) {
      await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
      return null;
    }
    const nativeInspection = await inspectLocalApkWithNativeBridge(target, expectedSha256);
    if (nativeInspection && !nativeInspection.ok) {
      await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
      return null;
    }
    return target;
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

    if (installedTrain >= parsed.targetTrain) {
      await AsyncStorage.removeItem(PENDING_INSTALL_STORAGE_KEY).catch(() => {});
      if (parsed.localUri) {
        await FileSystem.deleteAsync(parsed.localUri, { idempotent: true }).catch(() => {});
      }
      return null;
    }

    if (parsed.localUri) {
      const info = await FileSystem.getInfoAsync(parsed.localUri).catch(() => null);
      if (!info?.exists && parsed.status !== 'install_failed') {
        await AsyncStorage.removeItem(PENDING_INSTALL_STORAGE_KEY).catch(() => {});
        return null;
      }
    }

    if (parsed.status === 'awaiting_user_install') {
      const updated: PendingInstallRecord = {
        ...parsed,
        status: 'not_installed_yet',
      };
      await AsyncStorage.setItem(PENDING_INSTALL_STORAGE_KEY, JSON.stringify(updated)).catch(
        () => {},
      );
      return updated;
    }
    return parsed;
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

function parseManifestAbis(
  rawAbis: unknown,
): Partial<Record<SupportedApkAbi, AbiArtifactInfo>> | undefined {
  if (!rawAbis || typeof rawAbis !== 'object') return undefined;
  const out: Partial<Record<SupportedApkAbi, AbiArtifactInfo>> = {};
  for (const key of ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86', 'universal'] as const) {
    const entry = (rawAbis as Record<string, unknown>)[key];
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>).url === 'string'
    ) {
      const obj = entry as Record<string, unknown>;
      out[key] = {
        abi: key,
        url: String(obj.url),
        fallbackGithubUrl: obj.fallbackGithubUrl ? String(obj.fallbackGithubUrl) : null,
        sha256: obj.sha256 ? String(obj.sha256) : null,
        sizeBytes: typeof obj.sizeBytes === 'number' ? obj.sizeBytes : null,
        versionCode: typeof obj.versionCode === 'number' ? obj.versionCode : null,
        supportedAbis: Array.isArray(obj.supportedAbis) ? (obj.supportedAbis as string[]) : undefined,
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
 * Checks live Android runtime environment + `public.get_latest_app_release()` + live CDN
 * `latest/manifest.json` (cache-busted) and verifies actual running build honestly.
 */
export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  const deviceEnv = await resolveAndroidDeviceEnvironment();
  const installedCode = deviceEnv?.installed.versionCode || getInstalledBuildCode();
  const installedTrain = getReleaseTrain(installedCode);
  const installedVersion = getInstalledVersionLabel();
  const deviceAbis =
    deviceEnv?.supportedAbis && deviceEnv.supportedAbis.length > 0
      ? deviceEnv.supportedAbis
      : detectDeviceAbis();

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
      const universalUrl = String(raw.universal_apk_url || raw.apk_url || LATEST_UNIVERSAL_APK_CDN_URL);
      rpcLatest = {
        packageId: 'com.hallyu.app',
        minSdkVersion: 23,
        targetSdkVersion: 34,
        signingSha256: ANDROID_RELEASE_SHA256,
        versionCode: vCode,
        releaseTrain: getReleaseTrain(vCode),
        versionName: String(
          raw.version_name ?? `1.0.${Math.max(0, getReleaseTrain(vCode) - 1000)}`,
        ),
        apkUrl: String(raw.apk_url ?? LATEST_UNIVERSAL_APK_CDN_URL),
        arm64ApkUrl: LATEST_ARM64_APK_CDN_URL,
        arm32ApkUrl: LATEST_ARM32_APK_CDN_URL,
        x86_64ApkUrl: LATEST_X86_64_APK_CDN_URL,
        x86ApkUrl: LATEST_X86_APK_CDN_URL,
        universalApkUrl: universalUrl,
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
      const perAbi = parseManifestAbis(m.perAbi);
      const abis = parseManifestAbis(m.abis);
      cdnLatest = {
        packageId: String(m.packageId ?? 'com.hallyu.app'),
        minSdkVersion: Number(m.minSdkVersion ?? 23),
        targetSdkVersion: Number(m.targetSdkVersion ?? 34),
        signingSha256: String(m.signingSha256 ?? ANDROID_RELEASE_SHA256),
        versionCode: mCode,
        releaseTrain: getReleaseTrain(mCode),
        versionName: String(m.version ?? `1.0.${Math.max(0, getReleaseTrain(mCode) - 1000)}`),
        apkUrl: String(m.universalUrl ?? m.slimUrl ?? LATEST_UNIVERSAL_APK_CDN_URL),
        arm64ApkUrl: String(perAbi?.['arm64-v8a']?.url ?? m.arm64Url ?? LATEST_ARM64_APK_CDN_URL),
        arm32ApkUrl: String(perAbi?.['armeabi-v7a']?.url ?? m.arm32Url ?? LATEST_ARM32_APK_CDN_URL),
        x86_64ApkUrl: String(perAbi?.x86_64?.url ?? m.x86_64Url ?? LATEST_X86_64_APK_CDN_URL),
        x86ApkUrl: String(perAbi?.x86?.url ?? m.x86Url ?? LATEST_X86_APK_CDN_URL),
        universalApkUrl: String(
          perAbi?.universal?.url ?? m.universalUrl ?? LATEST_UNIVERSAL_APK_CDN_URL,
        ),
        perAbi,
        abis,
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
          apkUrl: LATEST_UNIVERSAL_APK_CDN_URL,
          arm64ApkUrl: LATEST_ARM64_APK_CDN_URL,
          arm32ApkUrl: LATEST_ARM32_APK_CDN_URL,
          x86_64ApkUrl: LATEST_X86_64_APK_CDN_URL,
          x86ApkUrl: LATEST_X86_APK_CDN_URL,
          universalApkUrl: LATEST_UNIVERSAL_APK_CDN_URL,
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
      ? await hasValidCachedApk(
          latest.versionCode,
          selectedArtifact.abi,
          selectedArtifact.sizeBytes,
          selectedArtifact.sha256,
        )
      : null;

  return {
    installedCode,
    installedTrain,
    installedVersion,
    deviceAbis,
    deviceEnv,
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
 * Launches Android installation using `HallyuApkInstaller.installApkSession` (Android
 * `PackageInstaller.Session` with authentic `BroadcastReceiver` status codes) when present, falling
 * back cleanly to `IntentLauncher` without `FLAG_ACTIVITY_NEW_TASK`.
 */
async function launchAndroidPackageInstaller(
  localFileUri: string,
  selectedAbi: SupportedApkAbi,
  targetVersionCode: number,
  targetVersionName: string,
  usedCachedApk: boolean,
  inspection: ApkArchiveInspection | null,
): Promise<InstallLaunchOutcome> {
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

  const bridge = getNativeInstallerBridge();
  if (bridge && typeof bridge.installApkSession === 'function') {
    const nativeRes = await bridge.installApkSession(localFileUri);
    const refreshedEnv = await resolveAndroidDeviceEnvironment();
    const installedTrainAfter = getReleaseTrain(
      refreshedEnv?.installed.versionCode ?? getInstalledBuildCode(),
    );

    if (nativeRes.status === 'needs_unknown_sources_permission') {
      await openUnknownSourcesSettings();
      return {
        status: 'needs_unknown_sources_permission',
        selectedAbi,
        message: nativeRes.message,
      };
    }

    if (nativeRes.status === 'cancelled_by_user') {
      const rec: PendingInstallRecord = {
        ...initialPending,
        status: 'cancelled_by_user',
        lastErrorReasonCode: nativeRes.reasonCode ?? 'INSTALL_CANCELLED',
        lastErrorMessage:
          nativeRes.message ?? 'Installation cancelled — still running your previous version.',
      };
      await AsyncStorage.setItem(PENDING_INSTALL_STORAGE_KEY, JSON.stringify(rec)).catch(() => {});
      return {
        status: 'cancelled_by_user',
        usedCachedApk,
        selectedAbi,
        message: rec.lastErrorMessage!,
      };
    }

    if (nativeRes.status === 'install_failed') {
      const rec: PendingInstallRecord = {
        ...initialPending,
        status: 'install_failed',
        lastErrorReasonCode: nativeRes.reasonCode ?? 'INSTALL_FAILED',
        lastErrorMessage: nativeRes.message ?? 'Android rejected package installation.',
      };
      await AsyncStorage.setItem(PENDING_INSTALL_STORAGE_KEY, JSON.stringify(rec)).catch(() => {});
      return {
        status: 'install_failed',
        reasonCode: rec.lastErrorReasonCode!,
        message: rec.lastErrorMessage!,
        selectedAbi,
        inspection,
      };
    }

    // NEVER claim `installed` unless actual native installed build train matches `targetTrain`!
    if (nativeRes.status === 'installed' && installedTrainAfter >= targetTrain) {
      await AsyncStorage.removeItem(PENDING_INSTALL_STORAGE_KEY).catch(() => {});
      await FileSystem.deleteAsync(localFileUri, { idempotent: true }).catch(() => {});
      return {
        status: 'installed',
        usedCachedApk,
        selectedAbi,
        inspection,
      };
    }

    return {
      status: 'awaiting_user_install',
      usedCachedApk,
      selectedAbi,
      inspection,
    };
  }

  // Fallback for environments where `IntentLauncher` is used directly
  try {
    const contentUri = await FileSystem.getContentUriAsync(localFileUri);
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

    return { status: 'awaiting_user_install', usedCachedApk, selectedAbi, inspection };
  } catch {
    await openUnknownSourcesSettings();
    return { status: 'needs_unknown_sources_permission', selectedAbi };
  }
}

async function downloadAndVerifySingleCandidate(
  abi: SupportedApkAbi,
  url: string,
  fallbackUrl: string | null,
  versionCode: number,
  expectedSizeBytes: number | null,
  expectedSha256: string | null,
  onProgress?: (snapshot: DownloadProgressSnapshot) => void,
): Promise<
  | { ok: true; localUri: string; usedCached: boolean; inspection: ApkArchiveInspection | null }
  | { ok: false; reasonCode: string; message: string; inspection: ApkArchiveInspection | null }
> {
  const existingValid = await hasValidCachedApk(
    versionCode,
    abi,
    expectedSizeBytes,
    expectedSha256,
  );
  if (existingValid) {
    const inspection = await inspectLocalApkWithNativeBridge(existingValid, expectedSha256);
    if (!inspection || inspection.ok) {
      const total = expectedSizeBytes ?? inspection?.sizeBytes ?? 20_000_000;
      onProgress?.({
        percent: 100,
        writtenBytes: total,
        totalBytes: total,
        speedBytesPerSec: 0,
        stage: 'launching_installer',
      });
      return { ok: true, localUri: existingValid, usedCached: true, inspection };
    }
    await FileSystem.deleteAsync(existingValid, { idempotent: true }).catch(() => {});
  }

  const targetPath = getApkStoragePath(versionCode, abi)!;
  await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});

  const candidateUrls = [url, fallbackUrl].filter((u): u is string => Boolean(u));
  let lastFailure = 'Download failed before completion.';

  for (const sourceUrl of candidateUrls) {
    const startedAt = Date.now();
    let lastEmitAt = 0;
    let lastPercent = -1;

    try {
      const resumable = FileSystem.createDownloadResumable(sourceUrl, targetPath, {}, (prog) => {
        const now = Date.now();
        const total =
          prog.totalBytesExpectedToWrite > 0
            ? prog.totalBytesExpectedToWrite
            : expectedSizeBytes ?? 20_000_000;
        const pct =
          total > 0 ? Math.min(100, Math.round((prog.totalBytesWritten / total) * 100)) : 0;

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
          stage: 'downloading',
        });
      });

      const downloaded = await resumable.downloadAsync();
      if (!downloaded?.uri) {
        await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
        lastFailure = 'Download interrupted before completion.';
        continue;
      }

      const headerCheck = validateApkHttpHeaders(downloaded.status, downloaded.headers);
      if (!headerCheck.ok) {
        await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
        lastFailure = headerCheck.reason;
        continue;
      }

      onProgress?.({
        percent: 100,
        writtenBytes: expectedSizeBytes ?? 20_000_000,
        totalBytes: expectedSizeBytes ?? 20_000_000,
        speedBytesPerSec: 0,
        stage: 'verifying',
      });

      const stat = await FileSystem.getInfoAsync(downloaded.uri);
      const actualSize = stat.exists && typeof stat.size === 'number' ? stat.size : 0;
      const headerBase64 = await readLocalApkHeaderBase64(downloaded.uri);
      const integrityCheck = verifyApkZipMagicAndSize(
        headerBase64,
        actualSize,
        sourceUrl === url ? expectedSizeBytes : null,
      );
      if (!integrityCheck.ok) {
        await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
        lastFailure = integrityCheck.reason;
        continue;
      }

      const inspection = await inspectLocalApkWithNativeBridge(
        downloaded.uri,
        sourceUrl === url ? expectedSha256 : null,
      );
      if (inspection && !inspection.ok) {
        await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
        return {
          ok: false,
          reasonCode: inspection.reasonCode,
          message: inspection.message,
          inspection,
        };
      }

      onProgress?.({
        percent: 100,
        writtenBytes: actualSize,
        totalBytes: actualSize,
        speedBytesPerSec: Math.round(actualSize / Math.max(0.25, (Date.now() - startedAt) / 1000)),
        stage: 'launching_installer',
      });

      return { ok: true, localUri: downloaded.uri, usedCached: false, inspection };
    } catch (dlErr) {
      await FileSystem.deleteAsync(targetPath, { idempotent: true }).catch(() => {});
      lastFailure = dlErr instanceof Error ? dlErr.message : 'Network error during download.';
    }
  }

  return {
    ok: false,
    reasonCode: 'DOWNLOAD_VERIFICATION_FAILED',
    message: `${lastFailure} Partial file was removed safely so you can retry.`,
    inspection: null,
  };
}

/**
 * Selects the exact compatible signed APK for this device's real Android OS environment, verifies
 * HTTP headers, ZIP integrity, cryptographic SHA-256, package ID, signing certificate, SDK level,
 * and native `lib/<abi>/*.so` match (falling back automatically to the 4-ABI Universal APK if a
 * split ever mismatches), then runs Android's `PackageInstaller.Session` honestly.
 */
export async function downloadAndInstallApk(
  release: Partial<AppReleaseInfo> & Pick<AppReleaseInfo, 'versionCode' | 'versionName'>,
  onProgress?: (snapshot: DownloadProgressSnapshot) => void,
  overrideDeviceAbis?: readonly string[],
): Promise<InstallLaunchOutcome> {
  const nativeEnv = overrideDeviceAbis ? null : await resolveAndroidDeviceEnvironment();
  const deviceAbis =
    overrideDeviceAbis ??
    (nativeEnv?.supportedAbis?.length ? nativeEnv.supportedAbis : detectDeviceAbis());

  const selection = selectApkArtifactForAbis(deviceAbis, release);
  if (!selection.ok) {
    throw new Error(selection.message);
  }

  const targetDir = getApkStorageDir();
  if (Platform.OS !== 'android' || !targetDir) {
    await Linking.openURL(selection.url);
    return { status: 'browser_opened', selectedAbi: selection.abi };
  }

  await ensureApkStorageDir();
  await pruneOldCachedApks(release.versionCode, selection.abi);

  const vName =
    release.versionName || `1.0.${Math.max(0, getReleaseTrain(release.versionCode) - 1000)}`;

  let verified = await downloadAndVerifySingleCandidate(
    selection.abi,
    selection.url,
    release.perAbi?.[selection.abi]?.fallbackGithubUrl ?? null,
    release.versionCode,
    selection.sizeBytes,
    selection.sha256,
    onProgress,
  );

  let finalAbi: SupportedApkAbi = selection.abi;

  // Automatic self-healing Universal fallback if a per-ABI split ever mismatches the device ABI
  if (!verified.ok && selection.abi !== 'universal' && verified.reasonCode === 'ABI_INCOMPATIBLE') {
    const univSel = selectApkArtifactForAbis(['universal'], release);
    if (univSel.ok) {
      verified = await downloadAndVerifySingleCandidate(
        'universal',
        univSel.url,
        release.perAbi?.universal?.fallbackGithubUrl ?? null,
        release.versionCode,
        univSel.sizeBytes,
        univSel.sha256,
        onProgress,
      );
      finalAbi = 'universal';
    }
  }

  if (!verified.ok) {
    return {
      status: 'install_failed',
      reasonCode: verified.reasonCode,
      message: verified.message,
      selectedAbi: finalAbi,
      inspection: verified.inspection,
    };
  }

  return launchAndroidPackageInstaller(
    verified.localUri,
    finalAbi,
    release.versionCode,
    vName,
    verified.usedCached,
    verified.inspection,
  );
}
