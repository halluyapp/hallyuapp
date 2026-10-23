/**
 * Cross-platform remote push registration across:
 *   1. Native Android Firebase Cloud Messaging (`fcm:<token>` via `google-services.json` -> `hallyu-f502c`)
 *   2. Apple iPhone / iPad Full-Screen Home-Screen Web App & Desktop/Android Browser W3C Web Push
 *      (`webpush:<subscription>` via Service Worker + ECDSA P-256 `VAPID_PUBLIC_KEY`)
 *   3. Expo Push Service (`ExponentPushToken[...]`)
 */
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { reportError } from '../analytics';
import { VAPID_PUBLIC_KEY } from '../links';
import { ensureAndroidNotificationChannels } from '../reminders';
import { supabase } from './client';

export type PushRegistrationStatus =
  | 'idle'
  | 'registering'
  | 'registered'
  | 'permission_denied'
  | 'missing_native_push_credentials'
  | 'backend_error'
  | 'unsupported';

export interface PushRegistrationState {
  status: PushRegistrationStatus;
  tokenType: 'expo' | 'fcm' | 'webpush' | null;
  tokenPreview: string | null;
  lastError: string | null;
  updatedAt: number | null;
}

let pushState: PushRegistrationState = {
  status: 'idle',
  tokenType: null,
  tokenPreview: null,
  lastError: null,
  updatedAt: null,
};

const listeners = new Set<(state: PushRegistrationState) => void>();

function setPushState(patch: Partial<PushRegistrationState>) {
  pushState = { ...pushState, ...patch, updatedAt: Date.now() };
  listeners.forEach((listener) => listener(pushState));
}

export function getPushRegistrationState(): PushRegistrationState {
  return pushState;
}

export function subscribePushRegistrationState(
  listener: (state: PushRegistrationState) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function maskToken(token: string): string {
  if (token.startsWith('webpush:')) {
    try {
      const parsed = JSON.parse(token.slice(8)) as { endpoint?: string };
      if (parsed.endpoint) {
        const host = new URL(parsed.endpoint).host;
        return `webpush (${host})`;
      }
    } catch {
      // Fall through
    }
  }
  if (token.length <= 16) return token;
  return `${token.slice(0, 12)}…${token.slice(-6)}`;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function isIosWeb(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function isStandaloneWebApp(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)').matches || nav.standalone === true,
  );
}

async function resolveWebPushToken(requestPermissionIfNeeded = false): Promise<{
  token: string;
  tokenType: 'webpush';
  platform: 'ios' | 'web';
}> {
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    throw new Error(
      isIosWeb() && !isStandaloneWebApp()
        ? 'Add Hallyu to your iPhone Home Screen first to enable lock-screen notifications.'
        : 'Push notifications are not supported in this browser.',
    );
  }

  let perm = Notification.permission;
  if (perm === 'default' && requestPermissionIfNeeded) {
    perm = await Notification.requestPermission();
  }
  if (perm !== 'granted') {
    const err = new Error('Notification permission not granted');
    (err as Error & { code?: string }).code = 'PERMISSION_DENIED';
    throw err;
  }

  const configuredBase = (process.env.EXPO_PUBLIC_BASE_PATH ?? '').trim().replace(/\/$/, '');
  const ghSubpathMatch = window.location.origin.includes('github.io')
    ? /^\/(hallyuapp|Grok-hallyu)(?:\/|$)/.exec(window.location.pathname)
    : null;
  const detectedPrefix = configuredBase || (ghSubpathMatch ? `/${ghSubpathMatch[1]}` : '');
  const basePath = `${detectedPrefix}/sw.js`;

  const registration = await navigator.serviceWorker.register(basePath).catch(() =>
    navigator.serviceWorker.ready,
  );
  await navigator.serviceWorker.ready;

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    });
  }

  const serialized = `webpush:${JSON.stringify(subscription.toJSON())}`;
  return {
    token: serialized,
    tokenType: 'webpush',
    platform: isIosWeb() ? 'ios' : 'web',
  };
}

async function resolveDevicePushToken(): Promise<{ token: string; tokenType: 'expo' | 'fcm' }> {
  let firstError: unknown = null;

  // Prefer native Firebase Cloud Messaging device token on Android when `google-services.json`
  // is compiled in (`push-dispatch` delivers `fcm:<token>` directly over Google OAuth2 HTTP v1).
  if (Platform.OS === 'android') {
    const nativeToken = await Notifications.getDevicePushTokenAsync().catch((err) => {
      firstError = err;
      return null;
    });
    if (nativeToken?.data && String(nativeToken.data).length > 20) {
      const raw = String(nativeToken.data).trim();
      const formatted =
        raw.startsWith('ExponentPushToken[') || raw.startsWith('fcm:') ? raw : `fcm:${raw}`;
      return { token: formatted, tokenType: formatted.startsWith('fcm:') ? 'fcm' : 'expo' };
    }
  }

  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
    ?.eas?.projectId;
  try {
    const expoPush = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    if (expoPush?.data && expoPush.data.length > 20) {
      return { token: expoPush.data, tokenType: 'expo' };
    }
  } catch (err) {
    if (!firstError) firstError = err;
  }

  throw firstError instanceof Error ? firstError : new Error('Unable to acquire push token from device');
}

export async function registerPushTokenValue(
  token: string,
  tokenType: 'expo' | 'fcm' | 'webpush',
  overridePlatform?: 'ios' | 'android' | 'web',
): Promise<boolean> {
  if (!supabase || !token || token.length <= 20) return false;
  const resolvedPlatform: 'ios' | 'android' | 'web' =
    overridePlatform ??
    (Platform.OS === 'web' ? 'web' : Platform.OS === 'ios' ? 'ios' : 'android');

  const deviceName =
    Platform.OS === 'web'
      ? isIosWeb()
        ? 'iPhone Home Screen Web App'
        : 'Web Browser'
      : Constants.deviceName ?? undefined;

  const { error } = await supabase.rpc('register_push_token', {
    p_token: token,
    p_platform: resolvedPlatform,
    p_device_name: deviceName,
    p_app_version: Application.nativeApplicationVersion ?? '1.0.200',
    p_locale: Intl.DateTimeFormat().resolvedOptions().locale || undefined,
  });
  if (error) {
    setPushState({
      status: 'backend_error',
      lastError: error.message,
    });
    reportError('pushToken.register', error);
    return false;
  }
  setPushState({
    status: 'registered',
    tokenType,
    tokenPreview: maskToken(token),
    lastError: null,
  });
  return true;
}

let nativePushMissingThisSession = false;

export async function registerDevicePushToken(interactive = false): Promise<boolean> {
  if (!supabase) {
    setPushState({ status: 'unsupported' });
    return false;
  }

  if (Platform.OS === 'web') {
    try {
      setPushState({ status: 'registering' });
      const webResolved = await resolveWebPushToken(interactive);
      return await registerPushTokenValue(
        webResolved.token,
        webResolved.tokenType,
        webResolved.platform,
      );
    } catch (e) {
      const code = (e as Error & { code?: string })?.code;
      const msg = e instanceof Error ? e.message : String(e);
      setPushState({
        status: code === 'PERMISSION_DENIED' ? 'permission_denied' : 'unsupported',
        lastError: msg,
      });
      return false;
    }
  }

  if (nativePushMissingThisSession && !interactive) {
    return false;
  }
  try {
    await ensureAndroidNotificationChannels();
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) {
      setPushState({ status: 'permission_denied', lastError: null });
      return false;
    }

    setPushState({ status: 'registering' });
    const resolved = await resolveDevicePushToken();
    nativePushMissingThisSession = false;
    return await registerPushTokenValue(resolved.token, resolved.tokenType);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const missingNativeCreds = /FirebaseApp|google-services|projectId|FCM/i.test(msg);
    if (missingNativeCreds) {
      nativePushMissingThisSession = true;
    }
    setPushState({
      status: missingNativeCreds ? 'missing_native_push_credentials' : 'backend_error',
      lastError: msg,
    });
    if (!missingNativeCreds) {
      reportError('pushToken.register', e);
    }
    return false;
  }
}

/** Listen for OS-initiated FCM/APNs push token refreshes and immediately sync to Supabase. */
export function installPushTokenRotationListener(): () => void {
  if (!supabase || Platform.OS === 'web') return () => {};
  const sub = Notifications.addPushTokenListener((event) => {
    const raw = typeof event.data === 'string' ? event.data.trim() : '';
    if (!raw || raw.length <= 20) return;
    const formatted =
      raw.startsWith('ExponentPushToken[') || raw.startsWith('fcm:') ? raw : `fcm:${raw}`;
    void registerPushTokenValue(formatted, formatted.startsWith('fcm:') ? 'fcm' : 'expo');
  });
  return () => sub.remove();
}

export interface ServerTestNotificationResult {
  notification_id: string;
  active_push_tokens: number;
  queued_deliveries: number;
  created_at: string;
}

/** Triggers a real server-side notification row + device delivery fan-out via `send_test_notification()`. */
export async function sendServerTestNotification(): Promise<ServerTestNotificationResult> {
  if (!supabase) throw new Error('Backend is not configured');
  const { data, error } = await supabase.rpc('send_test_notification');
  if (error) throw new Error(error.message);
  return data as unknown as ServerTestNotificationResult;
}
