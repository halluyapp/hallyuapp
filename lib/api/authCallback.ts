/**
 * The signup-verification deep link.
 *
 * Supabase emails a link to `hallyu://auth/callback`. The app is opened by that link — cold start
 * (the app is not running) or warm start (it is) — and the tokens in the URL are the ONLY thing
 * that turns "account created, check your email" into a real session.
 *
 * The client is built with `detectSessionInUrl: false` (lib/api/client.ts), which is correct for a
 * native app: supabase-js's own URL parsing is web-shaped and cannot be relied on here. That also
 * means nothing consumes the URL unless this module does, and a callback route that just redirects
 * home silently drops the session — which is exactly the "dead page after verification" failure.
 * So the URL is parsed here, explicitly, for both shapes Supabase can send:
 *
 *   PKCE      hallyu://auth/callback?code=…            → exchangeCodeForSession
 *   implicit  hallyu://auth/callback#access_token=…    → setSession
 *
 * Both cold start (the route mounts with the URL already in it) and warm start (expo-router pushes
 * the route when the link arrives) go through this same path.
 */
import { supabase } from './client';

/** Decode an `a=1&b=2` string into a map. Later keys win, matching normal query semantics. */
function parseQueryString(input: string, into: Map<string, string> = new Map()): Map<string, string> {
  for (const pair of input.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      into.set(decodeURIComponent(key.replace(/\+/g, ' ')), decodeURIComponent(value.replace(/\+/g, ' ')));
    } catch {
      into.set(key, value);
    }
  }
  return into;
}

export type CallbackKind = 'session' | 'recovery' | 'unsupported';

export interface ParsedCallback {
  kind: CallbackKind;
  /** PKCE authorisation code, when the link carries one. */
  code?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Present on a password-recovery link; tells the app to show "choose a new password". */
  recovery?: boolean;
  error?: string;
  errorDescription?: string;
}

/** Parse a callback URL without touching the network — used to classify before acting. */
export function parseAuthCallback(url: string): ParsedCallback | null {
  if (!url || !/^(hallyu|exp|https?):\/\//i.test(url.trim())) return null;

  const raw = url.trim();
  // The implicit flow puts the tokens in the fragment; the PKCE flow uses the query. Parsed by
  // hand rather than with URLSearchParams: Hermes ships an incomplete one, and this runs on the
  // cold-start path where a surprise exception means the member is stranded on a blank screen.
  const [beforeHash, fragment] = raw.split('#', 2);
  const qIndex = beforeHash.indexOf('?');
  const query = qIndex === -1 ? '' : beforeHash.slice(qIndex + 1);
  const params = parseQueryString(query);
  parseQueryString(fragment ?? '', params);

  const error = params.get('error') ?? undefined;
  const errorDescription = params.get('error_description') ?? undefined;
  // Recovery links carry type=recovery; signup verification does not.
  const recovery = params.get('type') === 'recovery' || error === 'recovery_link_expired';

  const code = params.get('code') ?? undefined;
  const accessToken = params.get('access_token') ?? undefined;
  const refreshToken = params.get('refresh_token') ?? undefined;

  if (error) return { kind: 'unsupported', error, errorDescription, recovery };
  if (code) return { kind: 'session', code, recovery };
  if (accessToken && refreshToken) return { kind: 'session', accessToken, refreshToken, recovery };
  // A link that carries nothing usable is not a session link; treating it as one would send the
  // member to a "you're signed in" screen with no account behind it.
  return { kind: 'unsupported', error: 'no_tokens', errorDescription: 'The link carried no session information.' };
}

export type CallbackResult = { ok: true; recovery: boolean } | { ok: false; message: string };

/**
 * Consume the callback URL and establish the session.
 *
 * Returns the outcome rather than throwing, so the route can show the actual reason a link failed
 * instead of bouncing to a home screen that looks like nothing happened.
 */
export async function consumeAuthCallback(url: string): Promise<CallbackResult> {
  if (!supabase) return { ok: false, message: 'This build has no backend, so there is no session to restore.' };
  const parsed = parseAuthCallback(url);
  if (!parsed) return { ok: false, message: 'That link is not a Hallyu sign-in link.' };
  if (parsed.kind === 'unsupported') {
    if (parsed.error === 'no_tokens') return { ok: false, message: parsed.errorDescription ?? 'That link is missing its session information.' };
    if (parsed.recovery && parsed.error === 'recovery_link_expired') {
      return { ok: false, message: 'That password-reset link has expired. Ask for a new one.' };
    }
    return { ok: false, message: parsed.errorDescription ?? `The link could not be used (${parsed.error}).` };
  }

  try {
    const { error } = parsed.code
      ? await supabase.auth.exchangeCodeForSession(parsed.code)
      : await supabase.auth.setSession({ access_token: parsed.accessToken!, refresh_token: parsed.refreshToken! });
    if (error) return { ok: false, message: error.message };
    // A verified-email link that did not actually sign anyone in must not look like success.
    const { data } = await supabase.auth.getSession();
    if (!data.session) return { ok: false, message: 'The link was accepted but no session was created. Sign in to continue.' };
    return { ok: true, recovery: Boolean(parsed.recovery) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'The sign-in link could not be completed.' };
  }
}