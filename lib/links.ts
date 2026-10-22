import { Platform } from 'react-native';

/**
 * Canonical public URLs, support contacts, and public verification constants for Hallyu.
 *
 * Works seamlessly across:
 *   - Native Android APK (`com.hallyu.app`)
 *   - Apple iPhone / iPad Full-Screen Home-Screen Web App (`https://hallyuapp.github.io`)
 *   - Desktop & Mobile Web (`https://hallyuapp.github.io` or any custom domain)
 *
 * Note: Only public, non-secret constants live here. All server signing and push keys stay
 * strictly inside server vaults and CI secrets — never in client source.
 */

export const SUPPORT_EMAIL = 'fixhallyu@gmail.com';
export const ADMIN_CONTACT_EMAIL = 'jgdevv10@gmail.com';

export const DEFAULT_WEB_BASE_URL = 'https://macaulay-spec.github.io/Grok-hallyu';
export const SUPABASE_PUBLIC_STORAGE_BASE =
  'https://kzxlbscfkixnswurpkzb.supabase.co/storage/v1/object/public/app-releases';

/** Public ECDSA P-256 VAPID applicationServerKey (RFC 8292 public key — required by browsers to subscribe). */
export const VAPID_PUBLIC_KEY =
  'BPPsdnRM3XroAtSPKNcz3zGWGLCmqZPDsTqu7_0wNEGcbIOLJ488DCKQQzQL2AHxxtTLW6yyj4-1jsp_nXaCCug';

/** Public permanent Android release certificate SHA-256 fingerprint (used for Digital Asset Links & verification). */
export const ANDROID_RELEASE_SHA256 =
  '64:20:BE:5B:CF:B5:EA:B5:D7:3A:74:BA:06:B7:94:36:FC:68:B2:69:7E:3E:63:36:16:4B:74:51:CB:15:31:DA';

/** Direct public CDN URL to the latest slim arm64-v8a Android APK (works even when source repo is private). */
export const LATEST_SLIM_APK_CDN_URL = `${SUPABASE_PUBLIC_STORAGE_BASE}/latest/hallyu-arm64.apk`;
export const LATEST_UNIVERSAL_APK_CDN_URL = `${SUPABASE_PUBLIC_STORAGE_BASE}/latest/hallyu-universal.apk`;

/**
 * Resolves the live base URL dynamically from `window.location.origin` + optional configured
 * `EXPO_PUBLIC_BASE_PATH` on web, while native builds always share canonical `https://hallyuapp.github.io`.
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

export const sharePostUrl = (postId: string) => buildWebUrl(`/post/${encodeURIComponent(postId)}`);
export const shareUserUrl = (handle: string) =>
  buildWebUrl(`/u/${encodeURIComponent(handle.replace(/^@/, ''))}`);
export const shareDramaUrl = (dramaId: string) =>
  buildWebUrl(`/drama/${encodeURIComponent(dramaId)}`);
export const shareCommunityUrl = (communityId: string) =>
  buildWebUrl(`/community/${encodeURIComponent(communityId)}`);
export const shareEventsUrl = () => buildWebUrl('/events');
