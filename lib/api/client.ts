/**
 * Backend connection layer — one typed Supabase client for the whole app (§6.1 of
 * docs/RORK-CLOUD-CONNECTION-PROMPT.md).
 *
 * The client is built once from the client-safe connection values (constants/keys.ts). When the
 * build carries no backend (no `EXPO_PUBLIC_*` secrets at build time) the client is null and the
 * rest of the app degrades to the device-local behaviour it shipped with — honestly: the
 * connection gate reports `misconfigured` ("local mode"), never a fake "connected".
 *
 * Health follows the exact pattern of lib/catalog.ts's CatalogHealth store: a module-level
 * snapshot, a subscribe function, and a `useSyncExternalStore` hook (lib/hooks.ts
 * `useBackendHealth`). The five gate states:
 *
 *   connecting     first handshake in flight (bounded timeout, then a real state)
 *   connected      the remote path answered: session + an authenticated RPC round trip
 *   unavailable    reachable config, backend error (5xx, RPC error, missing function)
 *   offline        the device has no network
 *   misconfigured  missing URL/key, auth rejects, schema not served, RLS blocking reads
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  MEDIA_BUCKET,
  RORK_APP_KEY,
  RORK_AUTH_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  backendConfigured,
} from '../../constants/keys';

export type ConnectionStatus = 'connecting' | 'connected' | 'unavailable' | 'offline' | 'misconfigured';

/** The private media bucket (migration 17). Signed URLs are how post media renders. */
export const mediaBucket = MEDIA_BUCKET;

const client: SupabaseClient | null =
  backendConfigured && SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          storage: AsyncStorage,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      })
    : null;

/** The shared Supabase client, or null when this build has no backend connection. */
export const supabase = client;

/** True when the build carries a backend connection. */
export function isBackendConfigured(): boolean {
  return backendConfigured;
}

// ── Access-token plumbing ─────────────────────────────────────────────────────────────────────
// lib/auth.tsx keeps the session (persisted by supabase-js into AsyncStorage) and mirrors the
// access token here so server paths that do not go through supabase-js (the Rork OAuth exchange,
// future signed fetches) present the same credential.

let currentToken: string | null = null;

/** Called by lib/auth.tsx on every session change. */
export function setBackendAccessToken(token: string | null): void {
  currentToken = token;
}

/** The current member access token, or null when signed out. */
export function getBackendAccessToken(): string | null {
  return currentToken;
}

/**
 * Ensures the in-memory member access token is populated from the active Supabase session
 * whenever React auth state transitions slightly ahead of `onAuthStateChange`.
 */
export async function ensureBackendSessionToken(): Promise<string | null> {
  if (currentToken) return currentToken;
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token ?? null;
    if (token) currentToken = token;
    return token;
  } catch {
    return currentToken;
  }
}

/**
 * Repairs any relative Supabase Storage path (such as `/object/sign/media/...` returned by
 * `row.signedURL` in older `@supabase/storage-js` shapes) into a full `https://` URL so native
 * Android/iOS decoders (`expo-image` / `expo-av`) never treat signed URLs as local disk paths.
 */
export function normalizeMediaUrl(url?: string | null): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed) || /^(file:|content:|blob:|ph:|data:|assets-library:)/i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('/storage/v1/') && SUPABASE_URL) {
    return `${SUPABASE_URL.replace(/\/$/, '')}${trimmed}`;
  }
  if (trimmed.startsWith('/object/') && SUPABASE_URL) {
    return `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1${trimmed}`;
  }
  return trimmed;
}

// ── Health store (CatalogHealth pattern) ──────────────────────────────────────────────────────

export interface BackendHealth {
  status: ConnectionStatus;
  message?: string;
  at: number;
}

let health: BackendHealth = {
  status: backendConfigured ? 'connecting' : 'misconfigured',
  message: backendConfigured ? undefined : 'No backend configured — running in local mode.',
  at: 0,
};

const listeners = new Set<() => void>();

export function getBackendHealth(): BackendHealth {
  return health;
}

export function subscribeBackendHealth(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Internal: publish a new health snapshot (no-op when nothing changed). */
function publish(next: BackendHealth): void {
  if (health.status === next.status && health.message === next.message) return;
  health = next;
  for (const fn of Array.from(listeners)) fn();
}

// ── Classification ────────────────────────────────────────────────────────────────────────────

/** Classify any failure into exactly one of the five gate states. */
export function classifyBackendError(error: unknown, online = true): ConnectionStatus {
  if (!backendConfigured) return 'misconfigured';
  if (!online) return 'offline';
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/timeout|timed out|abort/i.test(message)) return 'unavailable';
  if (/network|fetch|connect|socket|offline/i.test(message)) return 'offline';
  if (/schema cache|could not find the (function|table)|relation .* does not exist|invalid api key|invalid jwt|row-level|permission denied|jwt/i.test(message)) {
    return 'misconfigured';
  }
  return 'unavailable';
}

/** Bounded wait: rejects with a timeout Error so classifyBackendError can map it. Accepts any
 *  thenable (PostgREST builders are thenable, not Promises). */
async function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`backend probe timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The real connection probe (§7): an RPC round trip against the Rork-hosted database —
 * `get_bootstrap()` for a signed-in member, the anonymous `handle_is_available()` otherwise — not
 * a TCP ping. Bounded by `timeoutMs`; always resolves to a real state and publishes it.
 */
export async function probeBackend(timeoutMs = 6000, online = true): Promise<ConnectionStatus> {
  if (!supabase) {
    publish({ status: 'misconfigured', message: 'No backend configured — running in local mode.', at: Date.now() });
    return 'misconfigured';
  }

  publish({ status: 'connecting', at: Date.now() });
  try {
    // A saved session may need a token refresh before getSession() returns. If that refresh is slow
    // (common on web after a long idle), it must not decide the gate: the backend is still reachable.
    // So the session lookup gets a short bound, and any failure there falls back to the anonymous probe.
    let signedIn = false;
    try {
      const session = await withTimeout(supabase.auth.getSession(), Math.min(2000, timeoutMs));
      signedIn = !!session.data.session;
    } catch {
      signedIn = false;
    }
    const probe = signedIn
      ? supabase.rpc('get_bootstrap')
      : supabase.rpc('handle_is_available', { p_handle: 'hallyu-probe' });
    const { error } = await withTimeout(probe, timeoutMs);
    if (error) throw error;
    publish({ status: 'connected', at: Date.now() });
    return 'connected';
  } catch (e) {
    const status = classifyBackendError(e, online);
    publish({ status, message: e instanceof Error ? e.message : String(e), at: Date.now() });
    return status;
  }
}

/**
 * Rork Auth token exchange (§1.6 of the connection contract): a Rork refresh token is traded for
 * an access token whose `sub` is the database user id. The caller presents that token to
 * PostgREST as `Authorization: Bearer …` (see `authorizedFetch`).
 */
export async function exchangeRorkToken(refreshToken: string): Promise<string> {
  if (!RORK_APP_KEY) throw new Error('Rork Auth is not configured in this build (missing EXPO_PUBLIC_RORK_APP_KEY).');
  const res = await fetch(`${RORK_AUTH_URL}/oauth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_key: RORK_APP_KEY, refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`Rork Auth rejected the token exchange (HTTP ${res.status}).`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('Rork Auth returned no access token.');
  return data.access_token;
}
