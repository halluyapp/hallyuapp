/**
 * Rork Auth — Google sign-in for React Native (OAuth 2.0 + PKCE, zero app passwords).
 *
 * There are no email/password credentials anywhere in Hallyu: the only way in is the Google
 * account the member already has, brokered by Rork Auth. Tokens live ONLY in expo-secure-store
 * (device Keychain / Keystore) — never AsyncStorage, never a database. The short-lived access
 * token is a JWT whose `sub` identifies the member; lib/api/client.ts presents it to Supabase as
 * the Bearer credential so Row Level Security resolves the same member on every query.
 *
 * Flow (Rork Auth contract):
 *   1. POST {AUTH_URL}/oauth/initiate { app_key, provider: 'google', code_challenge, target: 'rn', env }
 *   2. openAuthSessionAsync(auth_url, `rork-<project>://auth/callback`)
 *   3. POST {AUTH_URL}/oauth/token { app_key, code, code_verifier } → { access_token, refresh_token, user }
 *   4. POST {AUTH_URL}/oauth/refresh { app_key, refresh_token }      → { access_token }
 */
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

const AUTH_URL = (process.env.EXPO_PUBLIC_RORK_AUTH_URL || 'https://api.rork.com').replace(/\/$/, '');
const APP_KEY = process.env.EXPO_PUBLIC_RORK_APP_KEY || '';
/** Fallback matches this Rork project id so a missing env var still resolves the right scheme. */
const PROJECT_ID = process.env.EXPO_PUBLIC_PROJECT_ID || 'za3mp0mb7b2ipipxalav8';

const ACCESS_KEY = 'hallyu.rork.access_token';
const REFRESH_KEY = 'hallyu.rork.refresh_token';

/** This build's backend (web only): hosts the auth-broker edge function. */
const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
/**
 * Rork's auth server answers CORS only for allowlisted origins (rork.com, *.rork.app). From any
 * other web origin — GitHub Pages, localhost, a custom domain — every direct /oauth/* call is
 * blocked before it leaves the browser, throwing the same "Failed to fetch" a dead network does.
 * When the build knows its backend, auth traffic is therefore routed through the backend's
 * auth-broker edge function (server-to-server, no CORS). A 404 from a not-yet-deployed broker
 * falls back to the direct call, so native and allowlisted origins behave exactly as before.
 */
const AUTH_BROKER_URL = Platform.OS === 'web' && SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/auth-broker` : null;

/** The Google identity the app renders: Rork JWT `sub` + profile claims. */
export interface RorkIdentity {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
}

/** True when this build carries the Rork Auth app key. */
export function rorkAuthConfigured(): boolean {
  return Boolean(APP_KEY);
}

/** The deep link the OAuth browser returns to (declared in app.json `scheme`). */
export function authCallbackScheme(): string {
  return `rork-${PROJECT_ID}://auth/callback`;
}

// ── PKCE + JWT helpers (no polyfills, no btoa dependency) ────────────────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += chars[b0 >> 2];
    out += chars[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += chars[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += chars[b2 & 0x3f];
  }
  return out;
}

async function randomVerifier(): Promise<string> {
  // Never weaken PKCE to Math.random when WebCrypto is unavailable (as on some React Native runtimes).
  const bytes = await Crypto.getRandomBytesAsync(32);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(input: string): Promise<string> {
  const hex = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return base64UrlEncode(bytes);
}

/** Decodes a JWT payload without verifying (verification happens server-side at exchange time). */
export function identityFromAccessToken(token: string): RorkIdentity | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const binary = typeof atob === 'function' ? atob(b64 + pad) : '';
    if (!binary) return null;
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (!sub) return null;
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;
    return {
      sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      name: typeof payload.name === 'string' ? payload.name : undefined,
      picture: typeof payload.picture === 'string' ? payload.picture : undefined,
    };
  } catch {
    return null;
  }
}

// ── Token custody (SecureStore only) ─────────────────────────────────────────────────────────

let custodyGeneration = 0;
let custodyQueue: Promise<unknown> = Promise.resolve();

function serializeCustody<T>(operation: () => Promise<T>): Promise<T> {
  const run = custodyQueue.then(operation, operation);
  custodyQueue = run.then(() => undefined, () => undefined);
  return run;
}

export async function readStoredTokens(): Promise<StoredTokens | null> {
  return serializeCustody(async () => {
    try {
      const accessToken = await SecureStore.getItemAsync(ACCESS_KEY);
      const refreshToken = await SecureStore.getItemAsync(REFRESH_KEY);
      return accessToken && refreshToken ? { accessToken, refreshToken } : null;
    } catch {
      return null;
    }
  });
}

async function storeTokens(tokens: StoredTokens, expectedGeneration?: number): Promise<boolean> {
  // A fresh OAuth exchange is a new session and invalidates every older refresh in flight.
  if (expectedGeneration === undefined) custodyGeneration += 1;
  return serializeCustody(async () => {
    if (expectedGeneration !== undefined && expectedGeneration !== custodyGeneration) return false;
    await Promise.all([
      SecureStore.setItemAsync(ACCESS_KEY, tokens.accessToken),
      SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken),
    ]);
    return true;
  });
}

export async function clearStoredTokens(): Promise<void> {
  // Invalidate immediately, then order deletion after any secure-store write already in progress.
  custodyGeneration += 1;
  await serializeCustody(async () => {
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_KEY).catch(() => {}),
      SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {}),
    ]);
  });
}

/** Decode the previous subject even when its access token expired; the server still verifies every JWT. */
function identityFromStoredToken(token: string): RorkIdentity | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const binary = typeof atob === 'function' ? atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)) : '';
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))) as Record<string, unknown>;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      name: typeof payload.name === 'string' ? payload.name : undefined,
      picture: typeof payload.picture === 'string' ? payload.picture : undefined,
    };
  } catch {
    return null;
  }
}

/** A rejection Rork actually answered (its HTTP status is kept) versus a call that never left the device. */
class AuthTransportError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const AUTH_ACTIONS = ['initiate', 'token', 'refresh'] as const;
type AuthAction = (typeof AUTH_ACTIONS)[number];

/**
 * One Rork Auth call. On web it is attempted through the backend's auth-broker edge function
 * first (server-to-server — a browser cannot call api.rork.com from an origin Rork has not
 * allowlisted) and falls back to the direct call when the broker is not deployed or unreachable.
 * Rork's own rejection statuses travel on AuthTransportError so callers keep their
 * clear-on-400/401/403 semantics.
 */
async function authPost(action: AuthAction, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(body);
  const parseError = async (res: Response, fallback: string): Promise<never> => {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new AuthTransportError(err.error || fallback, res.status);
  };
  if (AUTH_BROKER_URL) {
    try {
      const res = await fetch(`${AUTH_BROKER_URL}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
      if (res.status !== 404 && res.status !== 405) {
        await parseError(res, `Rork Auth rejected the request (HTTP ${res.status}).`);
      }
      // 404/405: this backend has not deployed the broker yet — use the direct call.
    } catch (error) {
      if (error instanceof AuthTransportError) throw error;
      // The broker itself was unreachable (offline, not deployed): fall through to the direct call.
    }
  }
  const res = await fetch(`${AUTH_URL}/oauth/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  if (!res.ok) await parseError(res, `Rork Auth rejected the request (HTTP ${res.status}).`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Trades the stored refresh token for a fresh access token. Authentication rejections clear the
 * credential; network/5xx failures preserve it. Logout/account-switch generations cannot be overwritten.
 */
async function requestAccessTokenRefresh(): Promise<StoredTokens | null> {
  const generation = custodyGeneration;
  const stored = await readStoredTokens();
  if (!stored || !APP_KEY || generation !== custodyGeneration) return null;
  const previousIdentity = identityFromStoredToken(stored.accessToken);
  if (!previousIdentity) return null;
  let data: { access_token?: string; refresh_token?: string };
  try {
    data = (await authPost('refresh', { app_key: APP_KEY, refresh_token: stored.refreshToken })) as {
      access_token?: string;
      refresh_token?: string;
    };
  } catch (error) {
    // A Rork rejection (400/401/403) invalidates the stored credential; a call that never left
    // the device (offline, CORS-refused) keeps it and retries on the next launch.
    if (
      error instanceof AuthTransportError &&
      [400, 401, 403].includes(error.status) &&
      generation === custodyGeneration
    ) {
      await clearStoredTokens();
    }
    return null;
  }
  const refreshedIdentity = data.access_token ? identityFromAccessToken(data.access_token) : null;
  if (!data.access_token || !refreshedIdentity || refreshedIdentity.sub !== previousIdentity.sub) return null;
  const next: StoredTokens = {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : stored.refreshToken,
  };
  return (await storeTokens(next, generation)) ? next : null;
}

let refreshInFlight: Promise<StoredTokens | null> | null = null;

/** One refresh across OAuth restoration and every PostgREST caller. */
export async function refreshAccessToken(): Promise<StoredTokens | null> {
  if (refreshInFlight) return refreshInFlight;
  const run = requestAccessTokenRefresh();
  refreshInFlight = run;
  try {
    return await run;
  } finally {
    if (refreshInFlight === run) refreshInFlight = null;
  }
}

// ── The Google flow ──────────────────────────────────────────────────────────────────────────

/**
 * Runs the full Google sign-in: opens the Rork-hosted Google consent screen, catches the
 * redirect, exchanges the code under PKCE and persists the tokens. Resolves with the member's
 * identity; throws an Error the screens can show verbatim.
 */
export async function startGoogleSignIn(): Promise<RorkIdentity> {
  if (!APP_KEY) {
    throw new Error('Google sign-in is not configured in this build (missing EXPO_PUBLIC_RORK_APP_KEY).');
  }
  const verifier = await randomVerifier();
  const challenge = await sha256Base64Url(verifier);

  const initiated = (await authPost('initiate', {
    app_key: APP_KEY,
    provider: 'google',
    code_challenge: challenge,
    target: 'rn',
    env: Platform.OS === 'web' ? 'preview' : 'native',
  })) as { auth_url?: string };
  const authUrl = initiated.auth_url ?? '';
  if (!authUrl) throw new Error('Google sign-in did not return a consent URL.');

  if (Platform.OS === 'web') {
    // Browser preview: only the tokens returned by THIS popup exchange may establish identity.
    // Falling back to SecureStore here could silently sign in the previous account after a cancel.
    const tokens = await exchangeViaPopup(authUrl, verifier);
    const identity = identityFromAccessToken(tokens.accessToken);
    if (!identity) throw new Error('Google sign-in returned an unreadable session — try again.');
    return identity;
  }

  const result = await WebBrowser.openAuthSessionAsync(authUrl, authCallbackScheme());
  if (result.type !== 'success') throw new Error('cancelled');
  const code = new URL(result.url).searchParams.get('code');
  if (!code) throw new Error('Google sign-in did not return an authorization code.');
  const tokens = await exchangeCode(code, verifier);
  const identity = identityFromAccessToken(tokens.accessToken);
  if (!identity) throw new Error('Google sign-in returned an unreadable session — try again.');
  return identity;
}

async function exchangeCode(code: string, verifier: string): Promise<StoredTokens> {
  const data = (await authPost('token', { app_key: APP_KEY, code, code_verifier: verifier })) as {
    access_token?: string;
    refresh_token?: string;
  };
  if (!data.access_token || !data.refresh_token) {
    throw new Error('Google sign-in returned no session tokens.');
  }
  const tokens = { accessToken: data.access_token, refreshToken: data.refresh_token };
  await storeTokens(tokens);
  return tokens;
}

const POPUP_TIMEOUT_MS = 120_000;

async function exchangeViaPopup(authUrl: string, verifier: string): Promise<StoredTokens> {
  const popup = window.open(authUrl, '_blank', 'width=500,height=650');
  if (!popup) {
    throw new Error('Google sign-in popup was blocked. Allow popups for Hallyu, then try again.');
  }
  const allowedOrigins = new Set([new URL(authUrl).origin, new URL(AUTH_URL).origin]);
  return new Promise<StoredTokens>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      clearInterval(poll);
      clearTimeout(timeout);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (tokens: StoredTokens) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(tokens);
    };
    const onMessage = (event: MessageEvent) => {
      if (!allowedOrigins.has(event.origin) || event.source !== popup) return;
      if (event.data?.type !== 'rork_auth_callback') return;
      const code = typeof event.data.code === 'string' ? event.data.code : '';
      if (!code) {
        fail(new Error('cancelled'));
        return;
      }
      exchangeCode(code, verifier).then(succeed, (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
    };
    const poll = setInterval(() => {
      if (popup.closed) fail(new Error('cancelled'));
    }, 250);
    const timeout = setTimeout(() => {
      popup.close();
      fail(new Error('Google sign-in timed out. Please try again.'));
    }, POPUP_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
  });
}

