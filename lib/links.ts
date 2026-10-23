import { Platform } from 'react-native';

/**
 * Canonical public URLs, support contacts, and public verification constants for Hallyu.
 *
 * Works seamlessly across:
 *   - Native Android APK (`com.hallyu.app`) across ALL architectures:
 *       `arm64-v8a` (64-bit ARMv8/ARMv9), `armeabi-v7a` (32-bit ARMv7 & 32-bit OS on 64-bit SoCs),
 *       `x86_64` (Chromebooks & 64-bit emulators), `x86` (32-bit Intel tablets & emulators),
 *       and `universal` (multi-ABI single package for 100% phone compatibility).
 *   - Apple iPhone / iPad Full-Screen Home-Screen Web App (`https://halluyapp.github.io/hallyuapp`)
 *   - Desktop & Mobile Web (`https://halluyapp.github.io/hallyuapp` or `https://hallyuapp.github.io`)
 *
 * Every public APK URL points directly to public Supabase Storage CDN (`200 OK` worldwide with
 * zero private-repo authentication dependencies).
 */

export const SUPPORT_EMAIL = 'fixhallyu@gmail.com';
export const ADMIN_CONTACT_EMAIL = 'jgdevv10@gmail.com';

export const ANDROID_PACKAGE_ID = 'com.hallyu.app';

export const DEFAULT_WEB_BASE_URL = 'https://halluyapp.github.io/hallyuapp';
export const PRODUCTION_WEB_ORIGIN = 'https://halluyapp.github.io';
export const PRODUCTION_WEB_BASE_PATH = '/hallyuapp';
export const PRODUCTION_WEB_URL = DEFAULT_WEB_BASE_URL;

export const SUPABASE_PUBLIC_STORAGE_BASE =
  'https://kzxlbscfkixnswurpkzb.supabase.co/storage/v1/object/public/app-releases';

/** Public ECDSA P-256 VAPID applicationServerKey (RFC 8292 public key — required by browsers to subscribe). */
export const VAPID_PUBLIC_KEY =
  'BPPsdnRM3XroAtSPKNcz3zGWGLCmqZPDsTqu7_0wNEGcbIOLJ488DCKQQzQL2AHxxtTLW6yyj4-1jsp_nXaCCug';

/** Public permanent Android release certificate SHA-256 fingerprint (used for Digital Asset Links & verification). */
export const ANDROID_RELEASE_SHA256 =
  '64:20:BE:5B:CF:B5:EA:B5:D7:3A:74:BA:06:B7:94:36:FC:68:B2:69:7E:3E:63:36:16:4B:74:51:CB:15:31:DA';

/**
 * Direct 100% public Supabase Storage CDN URLs (`200 OK` globally, zero private-repo 404s):
 *   - `LATEST_UNIVERSAL_APK_CDN_URL`: Multi-ABI signed package supporting BOTH 64-bit ARMv8/ARMv9
 *     (`arm64-v8a`) AND 32-bit ARM (`armeabi-v7a`) (+ `x86_64` / `x86` when <= 49 MB).
 *     Previously aliased to `LATEST_ARM32_APK_CDN_URL` (`armeabi-v7a`-only!), which caused
 *     `"App not installed as app isn't compatible with your phone."` on every 64-bit-only ARMv9 phone!
 *   - `LATEST_ARM64_APK_CDN_URL`: Slim 64-bit ARM split (`hallyu-arm64-v8a.apk`, ~18 MB)
 *   - `LATEST_ARM32_APK_CDN_URL`: Slim 32-bit ARM split (`hallyu-armeabi-v7a.apk`, ~15 MB)
 *   - `LATEST_X86_64_APK_CDN_URL`: Slim 64-bit Chromebook/emulator split (`hallyu-x86_64.apk`, ~19 MB)
 *   - `LATEST_X86_APK_CDN_URL`: Slim 32-bit Intel split (`hallyu-x86.apk`, ~18 MB)
 */
export const LATEST_UNIVERSAL_APK_CDN_URL = `${SUPABASE_PUBLIC_STORAGE_BASE}/latest/hallyu-universal.apk`;
export const LATEST_ARM64_APK_CDN_URL = `${SUPABASE_PUBLIC_STORAGE_BASE}/latest/hallyu-arm64-v8a.apk`;
export const LATEST_ARM32_APK_CDN_URL = `${SUPABASE_PUBLIC_STORAGE_BASE}/latest/hallyu-armeabi-v7a.apk`;
export const LATEST_X86_64_APK_CDN_URL = `${SUPABASE_PUBLIC_STORAGE_BASE}/latest/hallyu-x86_64.apk`;
export const LATEST_X86_APK_CDN_URL = `${SUPABASE_PUBLIC_STORAGE_BASE}/latest/hallyu-x86.apk`;

/**
 * Default primary APK link across Web & Share surfaces — points to `LATEST_UNIVERSAL_APK_CDN_URL`
 * so clicking "Download Android APK" from ANY phone browser (64-bit ARMv9 flagship OR 32-bit OS
 * Android Go phone OR 64-bit CPU running 32-bit OS) ALWAYS installs cleanly in 1 tap!
 */
export const LATEST_SLIM_APK_CDN_URL = LATEST_UNIVERSAL_APK_CDN_URL;

/**
 * Resolves the live base URL dynamically from `window.location.origin` + optional configured
 * `EXPO_PUBLIC_BASE_PATH` on web, while native builds always share canonical `https://halluyapp.github.io/hallyuapp`.
 */
export function getWebAppBaseUrl(): string {
  const configuredBasePath = (process.env.EXPO_PUBLIC_BASE_PATH ?? '').trim().replace(/\/$/, '');
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.origin) {
    const cleanOrigin = window.location.origin.replace(/\/$/, '');
    return configuredBasePath ? `${cleanOrigin}${configuredBasePath}` : cleanOrigin;
  }
  return DEFAULT_WEB_BASE_URL;
}

export function buildWebUrl(routePath: string): string {
  const clean = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return `${getWebAppBaseUrl()}${clean}`;
}

export const buildHallyuUrl = buildWebUrl;

export const sharePostUrl = (postId: string) => buildWebUrl(`/post/${encodeURIComponent(postId)}`);
export const shareUserUrl = (handle: string) =>
  buildWebUrl(`/u/${encodeURIComponent(handle.replace(/^@/, ''))}`);
export const shareDramaUrl = (dramaId: string) =>
  buildWebUrl(`/drama/${encodeURIComponent(dramaId)}`);
export const shareCommunityUrl = (communityId: string) =>
  buildWebUrl(`/community/${encodeURIComponent(communityId)}`);
export const shareEventsUrl = () => buildWebUrl('/events');
