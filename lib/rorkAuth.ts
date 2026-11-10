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

function randomVerifier(): string {
  const bytes = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
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

export async function readStoredTokens(): Promise<StoredTokens | null> {
  try {
    const accessToken = await SecureStore.getItemAsync(ACCESS_KEY);
    const refreshToken = await SecureStore.getItemAsync(REFRESH_KEY);
    return accessToken && refreshToken ? { accessToken, refreshToken } : null;
  } catch {
    return null;
  }
}

async function storeTokens(tokens: StoredTokens): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_KEY, tokens.accessToken),
    SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken),
  ]);
}

export async function clearStoredTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_KEY).catch(() => {}),
    SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {}),
  ]);
}

/**
 * Trades the stored refresh token for a fresh access token. Returns null when there is nothing
 * stored or Rork Auth rejects the refresh (stale install, revoked session) — the caller then
 * treats the member as signed out. A rejected refresh token is cleared so it cannot loop.
 */
export async function refreshAccessToken(): Promise<StoredTokens | null> {
  const stored = await readStoredTokens();
  if (!stored || !APP_KEY) return null;
  let res: Response;
  try {
    res = await fetch(`${AUTH_URL}/oauth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_key: APP_KEY, refresh_token: stored.refreshToken }),
    });
  } catch {
    return null; // offline — keep the stored tokens and retry on the next launch
  }
  if (!res.ok) {
    await clearStoredTokens();
    return null;
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) return null;
  const next: StoredTokens = { accessToken: data.access_token, refreshToken: stored.refreshToken };
  await storeTokens(next);
  return next;
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
  const verifier = randomVerifier();
  const challenge = await sha256Base64Url(verifier);

  let authUrl: string;
  const init = await fetch(`${AUTH_URL}/oauth/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_key: APP_KEY,
      provider: 'google',
      code_challenge: challenge,
      target: 'rn',
      env: Platform.OS === 'web' ? 'preview' : 'native',
    }),
  });
  if (!init.ok) {
    const body = (await init.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Google sign-in could not start (HTTP ${init.status}).`);
  }
  const initiated = (await init.json()) as { auth_url?: string };
  authUrl = initiated.auth_url ?? '';
  if (!authUrl) throw new Error('Google sign-in did not return a consent URL.');

  if (Platform.OS === 'web') {
    // Browser preview: a popup + postMessage hand-off instead of a system browser sheet.
    await exchangeViaPopup(authUrl, verifier);
    const tokens = await readStoredTokens();
    return identityFromAccessToken(tokens?.accessToken ?? '') ?? (await requireIdentityAfterExchange());
  }

  const result = await WebBrowser.openAuthSessionAsync(authUrl, authCallbackScheme());
  if (result.type !== 'success') throw new Error('cancelled');
  const code = new URL(result.url).searchParams.get('code');
  if (!code) throw new Error('Google sign-in did not return an authorization code.');
  await exchangeCode(code, verifier);
  const tokens = await readStoredTokens();
  const identity = identityFromAccessToken(tokens?.accessToken ?? '');
  if (!identity) throw new Error('Google sign-in returned an unreadable session — try again.');
  return identity;
}

async function requireIdentityAfterExchange(): Promise<RorkIdentity> {
  const tokens = await readStoredTokens();
  const identity = identityFromAccessToken(tokens?.accessToken ?? '');
  if (!identity) throw new Error('Google sign-in did not complete — try again.');
  return identity;
}

async function exchangeCode(code: string, verifier: string): Promise<void> {
  const res = await fetch(`${AUTH_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_key: APP_KEY, code, code_verifier: verifier }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Google sign-in failed (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!data.access_token || !data.refresh_token) {
    throw new Error('Google sign-in returned no session tokens.');
  }
  await storeTokens({ accessToken: data.access_token, refreshToken: data.refresh_token });
}

async function exchangeViaPopup(authUrl: string, verifier: string): Promise<void> {
  const popup = window.open(authUrl, '_blank', 'width=500,height=650');
  await new Promise<void>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'rork_auth_callback') return;
      window.removeEventListener('message', onMessage);
      clearInterval(poll);
      const code = typeof event.data.code === 'string' ? event.data.code : '';
      if (!code) {
        reject(new Error('cancelled'));
        return;
      }
      exchangeCode(code, verifier).then(resolve, reject);
    };
    window.addEventListener('message', onMessage);
    const poll = setInterval(() => {
      if (popup?.closed) {
        clearInterval(poll);
        window.removeEventListener('message', onMessage);
        resolve();
      }
    }, 500);
  });
}
