/**
 * Pure parser for Hallyu authentication and verification callback URLs.
 * Supports Supabase GoTrue PKCE (?code=), implicit (#access_token=), password recovery,
 * error redirects, and Rork custom schemes (rork-*://auth/callback?code=...).
 */

export type CallbackKind = 'session' | 'recovery' | 'unsupported';

export interface ParsedCallback {
  kind: CallbackKind;
  /** PKCE authorisation code, when the link carries one. */
  code?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Present on a password-recovery link; tells the app to show "choose a new password". */
  recovery?: boolean;
  isRorkScheme?: boolean;
  error?: string;
  errorDescription?: string;
}

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

/** Parse a callback URL without touching the network — used to classify before acting. */
export function parseAuthCallback(url: string): ParsedCallback | null {
  if (!url || !/^(hallyu|rork-[a-z0-9-]+|exp|https?):\/\//i.test(url.trim())) return null;

  const raw = url.trim();
  const isRorkScheme = /^rork-[a-z0-9-]+:\/\//i.test(raw);
  const [beforeHash, fragment] = raw.split('#', 2);
  const qIndex = beforeHash.indexOf('?');
  const query = qIndex === -1 ? '' : beforeHash.slice(qIndex + 1);
  const params = parseQueryString(query);
  parseQueryString(fragment ?? '', params);

  const error = params.get('error') ?? undefined;
  const errorDescription = params.get('error_description') ?? undefined;
  const recovery = params.get('type') === 'recovery' || error === 'recovery_link_expired';

  const code = params.get('code') ?? undefined;
  const accessToken = params.get('access_token') ?? undefined;
  const refreshToken = params.get('refresh_token') ?? undefined;

  if (error) return { kind: 'unsupported', error, errorDescription, recovery, isRorkScheme };
  if (code) return { kind: 'session', code, recovery, isRorkScheme };
  if (accessToken && refreshToken) return { kind: 'session', accessToken, refreshToken, recovery, isRorkScheme };
  return { kind: 'unsupported', error: 'no_tokens', errorDescription: 'The link carried no session information.', isRorkScheme };
}
