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
import { setBackendAccessToken, supabaseAuth } from './client';
import { completePendingRorkRedirect, hasPendingRorkRedirect, readStoredTokens } from '../rorkAuth';
import { parseAuthCallback, type CallbackKind, type ParsedCallback } from '../authCallbackParse';

export { parseAuthCallback, type CallbackKind, type ParsedCallback };

export type CallbackResult =
  | { ok: true; recovery: boolean; provider: 'email' | 'google'; closePopup?: boolean }
  | { ok: false; message: string };

/**
 * Consume the callback URL and establish the session (for either Google OAuth or Email sign-up/reset).
 */
export async function consumeAuthCallback(url: string): Promise<CallbackResult> {
  if (!supabaseAuth) return { ok: false, message: 'This build has no backend, so there is no session to restore.' };
  const parsed = parseAuthCallback(url);
  if (!parsed) return { ok: false, message: 'That link is not a Hallyu sign-in link.' };
  if (parsed.kind === 'unsupported') {
    if (parsed.error === 'no_tokens') {
      return { ok: false, message: `${parsed.errorDescription ?? 'That link is missing its session information.'} Try Gmail login.` };
    }
    if (parsed.recovery && parsed.error === 'recovery_link_expired') {
      return { ok: false, message: 'That password-reset link has expired. Ask for a new one.' };
    }
    return {
      ok: false,
      message: `${parsed.errorDescription ?? `The link could not be used (${parsed.error}).`} Try Gmail login.`,
    };
  }

  // Handle Google OAuth redirect (custom rork- scheme OR pending Rork PKCE code on web).
  if (parsed.code && !parsed.recovery && (parsed.isRorkScheme || hasPendingRorkRedirect())) {
    try {
      await completePendingRorkRedirect(parsed.code);
      const tokens = await readStoredTokens();
      if (tokens?.accessToken) {
        setBackendAccessToken(tokens.accessToken);
      }
      const isPopup = typeof window !== 'undefined' && Boolean(window.opener && window.opener !== window);
      return { ok: true, recovery: false, provider: 'google', closePopup: isPopup };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : 'Google sign-in redirect failed. Try Gmail login.',
      };
    }
  }

  // Handle Supabase GoTrue Email verification or Password recovery callback.
  try {
    const { error } = parsed.code
      ? await supabaseAuth.auth.exchangeCodeForSession(parsed.code)
      : await supabaseAuth.auth.setSession({ access_token: parsed.accessToken!, refresh_token: parsed.refreshToken! });
    if (error) return { ok: false, message: `${error.message}. Try Gmail login.` };
    const { data } = await supabaseAuth.auth.getSession();
    if (!data.session) return { ok: false, message: 'The link was accepted but no session was created. Sign in to continue or try Gmail login.' };
    setBackendAccessToken(data.session.access_token);
    return { ok: true, recovery: Boolean(parsed.recovery), provider: 'email' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'The sign-in link could not be completed. Try Gmail login.' };
  }
}