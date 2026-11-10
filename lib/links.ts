
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

import { Platform } from 'react-native';

export const SUPPORT_EMAIL = 'fixhallyu@gmail.com';
export const ADMIN_CONTACT_EMAIL = 'jgdevv10@gmail.com';

export const ANDROID_PACKAGE_ID = 'com.hallyu.app';

export const DEFAULT_WEB_BASE_URL = 'https://halluyapp.github.io/hallyuapp';
export const PRODUCTION_WEB_ORIGIN = 'https://halluyapp.github.io';
export const PRODUCTION_WEB_BASE_PATH = '/hallyuapp';
export const PRODUCTION_WEB_URL = DEFAULT_WEB_BASE_URL;

/**
 * The Rork Cloud backend this build talks to (managed by Rork — migrations live in
 * `backend/migrations/` of the Rork project, not applied by CI).
 */
const BACKEND_SUPABASE_URL = 'https://ltyymanoidagwsapgiql.supabase.co';

export const SUPABASE_PUBLIC_STORAGE_BASE =
  `${BACKEND_SUPABASE_URL}/storage/v1/object/public/app-releases`;

/** Public ECDSA P-256 VAPID applicationServerKey (RFC 8292 public key — required by browsers to subscribe). */
export const VAPID_PUBLIC_KEY =
  'BPPsdnRM3XroAtSPKNcz3zGWGLCmqZPDsTqu7_0wNEGcbIOLJ488DCKQQzQL2AHxxtTLW6yyj4-1jsp_nXaCCug';

/** Public permanent Android release certificate SHA-256 fingerprint (used for Digital Asset Links & verification). */
export const ANDROID_RELEASE_SHA256 =
  '64:20:BE:5B:CF:B5:EA:B5:D7:3A:74:BA:06:B7:94:36:FC:68:B2:69:7E:3E:63:36:16:4B:74:51:CB:15:31:DA';

/**
 * Direct 100% public Supabase Storage CDN URLs (`200 OK` globally, zero private-repo 404s).
 *
 * Universal-only release pipeline (backend migrations 58/59): CI builds ONE signed APK that
 * installs on EVERY Android device — 64-bit ARMv8/ARMv9, 32-bit ARM (`armeabi-v7a`), `x86_64`
 * and `x86` — and uploads it to ONE stable object (`hallyu-universal-latest.apk`). A database
 * trigger on the storage bucket deletes every other object on each new upload, so storage can
 * never fill and there is never a stale per-ABI split to pick wrong. The per-ABI constants are
 * kept (older releases of this app import them) but all resolve to the universal package.
 */
export const LATEST_UNIVERSAL_APK_CDN_URL = `${SUPABASE_PUBLIC_STORAGE_BASE}/hallyu-universal-latest.apk`;
export const LATEST_ARM64_APK_CDN_URL = LATEST_UNIVERSAL_APK_CDN_URL;
export const LATEST_ARM32_APK_CDN_URL = LATEST_UNIVERSAL_APK_CDN_URL;
export const LATEST_X86_64_APK_CDN_URL = LATEST_UNIVERSAL_APK_CDN_URL;
export const LATEST_X86_APK_CDN_URL = LATEST_UNIVERSAL_APK_CDN_URL;

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

