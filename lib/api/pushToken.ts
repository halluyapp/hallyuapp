/**
 * Server-side remote push registration, token rotation listener, transparent diagnostic state,
 * and end-to-end server test dispatch (`send_test_notification` RPC).
 */
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { reportError } from '../analytics';
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
  tokenType: 'expo' | 'fcm' | null;
  tokenPreview: string | null;
  lastError: string | null;
  updatedAt: number | null;
}

let pushState: PushRegistrationState = {
  status: Platform.OS === 'web' ? 'unsupported' : 'idle',
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

export function subscribePushRegistrationState(listener: (state: PushRegistrationState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function maskToken(token: string): string {
  if (token.length <= 16) return token;
  return `${token.slice(0, 12)}…${token.slice(-6)}`;
}

async function resolveDevicePushToken(): Promise<{ token: string; tokenType: 'expo' | 'fcm' }> {
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  let firstError: unknown = null;

  try {
    const expoPush = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    if (expoPush?.data && expoPush.data.length > 20) {
      return { token: expoPush.data, tokenType: 'expo' };
    }
  } catch (err) {
    firstError = err;
  }

  // Fallback for bare / standalone Android APKs without an EAS projectId: obtain raw FCM token
  // directly from Firebase Messaging (`push-dispatch` delivers `fcm:<token>` payloads natively).
  const nativeToken = await Notifications.getDevicePushTokenAsync().catch((err) => {
    if (!firstError) firstError = err;
    return null;
  });

  if (nativeToken?.data && String(nativeToken.data).length > 20) {
    const raw = String(nativeToken.data).trim();
    const formatted = raw.startsWith('ExponentPushToken[') || raw.startsWith('fcm:') ? raw : `fcm:${raw}`;
    return { token: formatted, tokenType: formatted.startsWith('fcm:') ? 'fcm' : 'expo' };
  }

  throw firstError instanceof Error ? firstError : new Error('Unable to acquire push token from device');
}

export async function registerPushTokenValue(
  token: string,
  tokenType: 'expo' | 'fcm',
): Promise<boolean> {
  if (!supabase || Platform.OS === 'web' || !token || token.length <= 20) return false;
  const { error } = await supabase.rpc('register_push_token', {
    p_token: token,
    p_platform: Platform.OS === 'ios' ? 'ios' : 'android',
    p_device_name: Constants.deviceName ?? undefined,
    p_app_version: Application.nativeApplicationVersion ?? undefined,
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

export async function registerDevicePushToken(): Promise<boolean> {
  if (!supabase || Platform.OS === 'web') {
    setPushState({ status: 'unsupported' });
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
    return await registerPushTokenValue(resolved.token, resolved.tokenType);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const missingNativeCreds =
      /FirebaseApp|google-services|projectId|FCM/i.test(msg);
    setPushState({
      status: missingNativeCreds ? 'missing_native_push_credentials' : 'backend_error',
      lastError: msg,
    });
    reportError('pushToken.register', e);
    return false;
  }
}

/** Listen for OS-initiated FCM/APNs push token refreshes and immediately sync to Supabase. */
export function installPushTokenRotationListener(): () => void {
  if (!supabase || Platform.OS === 'web') return () => {};
  const sub = Notifications.addPushTokenListener((event) => {
    const raw = typeof event.data === 'string' ? event.data.trim() : '';
    if (!raw || raw.length <= 20) return;
    const formatted = raw.startsWith('ExponentPushToken[') || raw.startsWith('fcm:') ? raw : `fcm:${raw}`;
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
