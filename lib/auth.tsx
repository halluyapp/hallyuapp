/**
 * Authentication — Google via Rork Auth, with an honest device-local fallback.
 *
 * When the build carries a backend connection (constants/keys.ts `backendConfigured`), sign-in is
 * Google-only through Rork Auth (lib/rorkAuth.ts): the Rork access token doubles as the Supabase
 * Bearer credential (lib/api/client.ts `accessToken` option) so Row Level Security resolves the
 * member on every query, and the idempotent `register_profile` RPC provisions the profile row on
 * first sign-in (migration 58) — the very first profile to register becomes the founder/CEO role.
 * Email-and-password simply does not exist here: those methods report it honestly instead of
 * pretending.
 *
 * When the build has no backend, the provider falls back to the original device-local behaviour so
 * a local build still boots: an "account" is a profile in AsyncStorage, and the email-dependent
 * flows report the honest `NO_MAIL` error instead of pretending an email was sent.
 *
 * Screens depend only on the AuthValue contract below, which both implementations keep intact.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { performVerifiedAccountDeletion } from './accountDeletion';
import { reportError, track } from './analytics';
import { markBoot } from './boot';
import { ensureBackendSessionToken, setBackendAccessToken, setBackendTokenRefresher, supabase } from './api/client';
import * as RorkAuth from './rorkAuth';

export type AuthStatus = 'loading' | 'signedOut' | 'guest' | 'signedIn';

/** How this account was established. Google is the only backend path; email is device-local. */
export type AuthProviderName = 'email' | 'google';

export interface AuthUser {
  id: string;
  email?: string;
  displayName: string;
  handle: string;
  avatarUrl?: string;
  emailVerified: boolean;
  provider: AuthProviderName;
}

export class AuthError extends Error {
  code: 'network' | 'credentials' | 'exists' | 'unverified' | 'weak_password' | 'rate_limit' | 'cancelled' | 'unknown';
  constructor(code: AuthError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

interface AuthValue {
  status: AuthStatus;
  user: AuthUser | null;
  recoveryPending: boolean;
  signInWithGoogle: (preferredName?: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<'signedIn' | 'verify'>;
  sendReset: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
  continueAsGuest: () => void;
  signOut: () => Promise<void>;
  deleteAccount: () => Promise<void>;
  clearRecovery: () => void;
}

const Ctx = createContext<AuthValue | null>(null);
const GUEST_KEY = 'hallyu.auth.guest';
const ACCOUNT_KEY = 'hallyu.auth.account.v1';

const MIN_PASSWORD = 6;

/** Honest message for the flows that need an email service when no backend is configured. */
const NO_MAIL = 'Email isn’t available in this build — no backend is configured.';

/** Honest message for email-and-password in backend builds: the only door is Google. */
const GOOGLE_ONLY = 'Email sign-in isn’t available — use Continue with Google.';

function handleFrom(email?: string, name?: string): string {
  const base =
    (name ?? email?.split('@')[0] ?? 'member')
      .toLowerCase()
      .replace(/[^a-z0-9_.]/g, '')
      .slice(0, 20) || 'member';
  return base;
}

/** Deterministic id for the device-local account: the same email always maps to the same account. */
function idFor(email: string): string {
  return `local-${handleFrom(email)}`;
}

function displayNameFor(email: string): string {
  const local = email.split('@')[0] ?? 'Member';
  return local.charAt(0).toUpperCase() + local.slice(1);
}

async function readLocalAccount(): Promise<AuthUser | null> {
  try {
    const raw = await AsyncStorage.getItem(ACCOUNT_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

async function writeLocalAccount(user: AuthUser): Promise<void> {
  await AsyncStorage.setItem(ACCOUNT_KEY, JSON.stringify(user)).catch(() => {});
}

/**
 * Registers (or resumes) the backend profile for a fresh Rork identity. `register_profile`
 * (migration 58) is an idempotent upsert keyed on the Rork `sub`, so it is safe to call on every
 * sign-in; the first profile ever created is promoted to the founder/CEO role by the database.
 * Resolves null when this build has no database to register against.
 */
async function registerBackendProfile(identity: RorkAuth.RorkIdentity, preferredName?: string): Promise<AuthUser | null> {
  if (!supabase) return null;
  const displayName = (preferredName?.trim() || identity.name?.trim() || displayNameFor(identity.email || 'Member')).slice(0, 40);
  const handle = handleFrom(identity.email || identity.name, displayName);
  try {
    const { data, error } = await supabase.rpc('register_profile', { p_handle: handle, p_display_name: displayName });
    if (error) {
      reportError('auth.register_profile', error);
    }
    const id = typeof data === 'string' && data ? data : (data as { id?: string } | null)?.id ?? identity.sub;
    return {
      id,
      email: identity.email || undefined,
      displayName,
      handle,
      avatarUrl: identity.picture,
      emailVerified: true,
      provider: 'google',
    };
  } catch (e) {
    reportError('auth.register_profile', e);
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const booted = useRef(false);

  // Boot. With a backend: restore the Rork session from SecureStore (refreshing an expired access
  // token) and register the profile. Without one: the original device-local account resolves
  // straight from storage.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;

    // Keep lib/api/client.ts's ensureBackendSessionToken able to recover a lapsed token.
    setBackendTokenRefresher(async () => (await RorkAuth.refreshAccessToken())?.accessToken ?? null);

    if (!supabase) {
      (async () => {
        try {
          const local = await readLocalAccount();
          if (local) {
            setUser(local);
            setStatus('signedIn');
            markBoot('auth:local-account');
            return;
          }
          setStatus((await AsyncStorage.getItem(GUEST_KEY)) === '1' ? 'guest' : 'signedOut');
          markBoot('auth:no-session');
        } catch (e) {
          reportError('auth.boot', e);
          markBoot('auth:boot-failed');
          setStatus('signedOut');
        }
      })();
      return;
    }

    void (async () => {
      try {
        const stored = await RorkAuth.readStoredTokens();
        let tokens = stored;
        if (tokens && !RorkAuth.identityFromAccessToken(tokens.accessToken)) {
          tokens = await RorkAuth.refreshAccessToken();
        }
        if (!tokens) {
          setStatus((await AsyncStorage.getItem(GUEST_KEY)) === '1' ? 'guest' : 'signedOut');
          markBoot('auth:no-session');
          return;
        }
        const identity = RorkAuth.identityFromAccessToken(tokens.accessToken);
        if (!identity) {
          await RorkAuth.clearStoredTokens();
          setStatus('signedOut');
          markBoot('auth:no-session');
          return;
        }
        setBackendAccessToken(tokens.accessToken);
        const next = (await registerBackendProfile(identity)) ?? {
          id: identity.sub,
          email: identity.email || undefined,
          displayName: identity.name || displayNameFor(identity.email || 'Member'),
          handle: handleFrom(identity.email, identity.name),
          avatarUrl: identity.picture,
          emailVerified: true,
          provider: 'google' as const,
        };
        setUser(next);
        setStatus('signedIn');
        markBoot('auth:session-restored');
      } catch (e) {
        reportError('auth.boot.session', e);
        markBoot('auth:boot-failed');
        setStatus('signedOut');
      }
    })();
  }, []);

  /** The one backend door: Google, brokered by Rork Auth. */
  const signInWithGoogle = useCallback(async (preferredName?: string) => {
    try {
      const identity = await RorkAuth.startGoogleSignIn();
      setBackendAccessToken((await RorkAuth.readStoredTokens())?.accessToken ?? null);
      await AsyncStorage.removeItem(GUEST_KEY).catch(() => {});
      const next =
        (await registerBackendProfile(identity, preferredName)) ?? {
          id: identity.sub,
          email: identity.email || undefined,
          displayName: preferredName?.trim() || identity.name || displayNameFor(identity.email || 'Member'),
          handle: handleFrom(identity.email, identity.name),
          avatarUrl: identity.picture,
          emailVerified: true,
          provider: 'google' as const,
        };
      setUser(next);
      setStatus('signedIn');
      track('auth.signin', { provider: 'google' });
    } catch (e) {
      if (e instanceof Error && e.message === 'cancelled') throw new AuthError('cancelled', 'cancelled');
      if (e instanceof Error && /network|fetch|timeout/i.test(e.message)) {
        throw new AuthError('network', 'You appear to be offline — try again.');
      }
      throw e instanceof AuthError ? e : new AuthError('unknown', e instanceof Error ? e.message : String(e));
    }
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const address = email.trim().toLowerCase();
    if (!address.includes('@')) throw new AuthError('credentials', 'Enter the email address you signed up with.');
    if (password.length < MIN_PASSWORD) throw new AuthError('credentials', 'Your password is at least 6 characters.');

    if (!supabase) {
      // Device-local fallback (no backend in this build).
      const stored = await readLocalAccount();
      const next: AuthUser =
        stored && stored.email === address && stored.provider === 'email'
          ? stored
          : { id: idFor(address), email: address, displayName: displayNameFor(address), handle: handleFrom(address), emailVerified: true, provider: 'email' };
      await writeLocalAccount(next);
      await AsyncStorage.removeItem(GUEST_KEY).catch(() => {});
      setUser(next);
      setStatus('signedIn');
      track('auth.signin', { provider: next.provider });
      return;
    }

    throw new AuthError('unknown', GOOGLE_ONLY);
  }, []);

  const signUp = useCallback(async (email: string, password: string, displayName: string) => {
    const address = email.trim().toLowerCase();
    if (!address.includes('@')) throw new AuthError('unknown', 'That email address does not look right.');
    if (password.length < MIN_PASSWORD) throw new AuthError('weak_password', 'Use at least 6 characters.');
    const name = displayName.trim() || displayNameFor(address);

    if (!supabase) {
      const handle = handleFrom(address, name);
      const next: AuthUser = { id: idFor(address), email: address, displayName: name, handle, emailVerified: true, provider: 'email' };
      await writeLocalAccount(next);
      await AsyncStorage.removeItem(GUEST_KEY).catch(() => {});
      setUser(next);
      setStatus('signedIn');
      track('auth.signup', { provider: 'email' });
      return 'signedIn' as const;
    }

    throw new AuthError('unknown', GOOGLE_ONLY);
  }, []);

  const sendReset = useCallback(async (email: string) => {
    const address = email.trim().toLowerCase();
    if (!address.includes('@')) throw new AuthError('unknown', 'That email address does not look right.');
    if (!supabase) throw new AuthError('unknown', NO_MAIL);
    // Google accounts authenticate with Google — there is no app password to reset.
    throw new AuthError('unknown', GOOGLE_ONLY);
  }, []);

  const updatePassword = useCallback(async (password: string) => {
    if (password.length < MIN_PASSWORD) throw new AuthError('weak_password', 'Use at least 6 characters.');
    if (!supabase) throw new AuthError('unknown', 'Password changes aren’t available yet — this account is stored on this device only.');
    throw new AuthError('unknown', GOOGLE_ONLY);
  }, []);

  const resendVerification = useCallback(async (email: string) => {
    const address = email.trim().toLowerCase();
    if (!address.includes('@')) throw new AuthError('unknown', 'That email address does not look right.');
    if (!supabase) throw new AuthError('unknown', NO_MAIL);
    throw new AuthError('unknown', GOOGLE_ONLY);
  }, []);

  const continueAsGuest = useCallback(() => {
    AsyncStorage.setItem(GUEST_KEY, '1').catch(() => {});
    setUser(null);
    setStatus('guest');
    track('auth.guest');
  }, []);

  const signOut = useCallback(async () => {
    if (supabase) {
      await RorkAuth.clearStoredTokens().catch((e) => reportError('auth.signOut', e));
      setBackendAccessToken(null);
    }
    await AsyncStorage.removeItem(GUEST_KEY).catch(() => {});
    await AsyncStorage.removeItem(ACCOUNT_KEY).catch(() => {});
    setUser(null);
    setRecoveryPending(false);
    setStatus('signedOut');
  }, []);

  const deleteAccount = useCallback(async () => {
    // Server-side deletion MUST confirm `{ deleted: true }` before signing out or wiping device storage.
    // If the RPC errors, times out, or lacks a session, `performVerifiedAccountDeletion` throws
    // without touching local session/cache so the UI never falsely claims deletion succeeded.
    await performVerifiedAccountDeletion({
      hasRemoteBackend: Boolean(supabase),
      ensureSessionToken: () => ensureBackendSessionToken(),
      rpcDeleteAccount: async () => {
        const res = await supabase!.rpc('delete_account');
        return {
          data: (res.data as { deleted?: boolean } | null) ?? null,
          error: res.error ? { message: res.error.message, code: res.error.code } : null,
        };
      },
      signOutRemote: async () => {
        setBackendAccessToken(null);
        await RorkAuth.clearStoredTokens();
      },
      clearLocalAccountStorage: async () => {
        await AsyncStorage.removeItem(ACCOUNT_KEY).catch(() => {});
        await AsyncStorage.removeItem(GUEST_KEY).catch(() => {});
      },
      clearLocalSessionState: () => {
        setBackendAccessToken(null);
        setUser(null);
        setStatus('signedOut');
      },
      recordDiagnosticError: (scope, summary) => {
        reportError(scope, new Error(summary));
      },
    });
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      recoveryPending,
      signInWithGoogle,
      signIn,
      signUp,
      sendReset,
      updatePassword,
      resendVerification,
      continueAsGuest,
      signOut,
      deleteAccount,
      clearRecovery: () => setRecoveryPending(false),
    }),
    [status, user, recoveryPending, signInWithGoogle, signIn, signUp, sendReset, updatePassword, resendVerification, continueAsGuest, signOut, deleteAccount],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
