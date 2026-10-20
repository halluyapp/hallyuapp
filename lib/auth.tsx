/**
 * Authentication — Rork Cloud sessions with an honest device-local fallback.
 *
 * When the build carries a backend connection (constants/keys.ts `backendConfigured`), accounts are
 * real Supabase Auth sessions: sign-up creates the `auth.users` row, and the database trigger
 * (migration 03) creates the profile + preferences — the client never inserts a profile. Password
 * reset and verification emails are real. The session persists across launches via AsyncStorage.
 *
 * When the build has no backend, the provider falls back to the original device-local behaviour so
 * a local build still boots: an "account" is a profile in AsyncStorage, and the email-dependent
 * flows report the honest `NO_MAIL` error instead of pretending an email was sent.
 *
 * Screens depend only on the AuthValue contract below, which both implementations keep intact.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Session, User as SupabaseUser } from '@supabase/supabase-js';
import { reportError, track } from './analytics';
import { markBoot } from './boot';
import { setBackendAccessToken, supabase } from './api/client';

export type AuthStatus = 'loading' | 'signedOut' | 'guest' | 'signedIn';

/** How this account was established. */
export type AuthProviderName = 'email';

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
/** Deep link the backend emails return to (declared in supabase/config.toml + app.json scheme). */
function authRedirectUrl(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/auth/callback`;
  }
  return 'hallyu://auth/callback';
}

const MIN_PASSWORD = 6;

/** Honest message for the flows that need an email service when no backend is configured. */
const NO_MAIL = 'Email isn’t available in this build — no backend is configured.';

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

/** Maps the Supabase auth user onto the AuthUser shape the screens render. */
function mapSupabaseUser(u: SupabaseUser): AuthUser {
  const meta = (u.user_metadata ?? {}) as Record<string, string | undefined>;
  const email = u.email ?? undefined;
  return {
    id: u.id,
    email,
    displayName: meta.display_name ?? meta.full_name ?? displayNameFor(email ?? 'Member'),
    handle: meta.handle ?? handleFrom(email, meta.user_name),
    emailVerified: Boolean(u.email_confirmed_at ?? u.confirmed_at),
    provider: 'email',
  };
}

/** Maps a supabase-js AuthApiError onto the AuthError codes the screens switch on. */
function mapAuthError(e: unknown): AuthError {
  if (e instanceof AuthError) return e;
  const raw = e as { code?: string; message?: string; status?: number } | null;
  const code = raw?.code ?? '';
  const message = raw?.message ?? String(e ?? 'Authentication failed.');
  if (/fetch|network|timeout/i.test(message)) return new AuthError('network', 'You appear to be offline — try again.');
  if (/invalid login credentials/i.test(message)) return new AuthError('credentials', 'That email and password don’t match an account.');
  if (/email not confirmed/i.test(message)) return new AuthError('unverified', 'Verify your email first — check your inbox.');
  if (code === 'user_already_exists' || /already registered|already exists/i.test(message)) return new AuthError('exists', 'An account with that email already exists — sign in instead.');
  if (code === 'weak_password' || /password.*weak|at least/i.test(message)) return new AuthError('weak_password', 'Use at least 6 characters.');
  if (/rate|too many/i.test(message)) return new AuthError('rate_limit', 'Too many attempts — wait a minute and try again.');
  return new AuthError('unknown', message);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const booted = useRef(false);

  // Boot. With a backend: restore the persisted session and follow auth state changes. Without
  // one: the original device-local account resolves straight from storage.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;

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
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        const session: Session | null = data.session;
        setBackendAccessToken(session?.access_token ?? null);
        if (session?.user) {
          setUser(mapSupabaseUser(session.user));
          setStatus('signedIn');
          markBoot('auth:session-restored');
          return;
        }
        setStatus((await AsyncStorage.getItem(GUEST_KEY)) === '1' ? 'guest' : 'signedOut');
        markBoot('auth:no-session');
      } catch (e) {
        reportError('auth.boot.session', e);
        markBoot('auth:boot-failed');
        setStatus('signedOut');
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      setBackendAccessToken(session?.access_token ?? null);
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        if (session?.user) {
          setUser(mapSupabaseUser(session.user));
          setStatus('signedIn');
        }
      } else if (event === 'SIGNED_OUT') {
        // The account switch itself is handled by the store's AccountSync; here we only resolve
        // back to the signed-out (or guest) state the gate expects.
        setStatus((prev) => (prev === 'guest' ? 'guest' : 'signedOut'));
      }
    });
    return () => sub.subscription.unsubscribe();
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

    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: address, password });
      if (error) throw error;
      await AsyncStorage.removeItem(GUEST_KEY).catch(() => {});
      const next = mapSupabaseUser(data.user);
      setUser(next);
      setStatus('signedIn');
      track('auth.signin', { provider: next.provider });
    } catch (e) {
      throw mapAuthError(e);
    }
  }, []);

  const signUp = useCallback(async (email: string, password: string, displayName: string) => {
    const address = email.trim().toLowerCase();
    if (!address.includes('@')) throw new AuthError('unknown', 'That email address does not look right.');
    if (password.length < MIN_PASSWORD) throw new AuthError('weak_password', 'Use at least 6 characters.');
    const name = displayName.trim() || displayNameFor(address);
    const handle = handleFrom(address, name);

    if (!supabase) {
      const next: AuthUser = { id: idFor(address), email: address, displayName: name, handle, emailVerified: true, provider: 'email' };
      await writeLocalAccount(next);
      await AsyncStorage.removeItem(GUEST_KEY).catch(() => {});
      setUser(next);
      setStatus('signedIn');
      track('auth.signup', { provider: 'email' });
      return 'signedIn' as const;
    }

    try {
      // `data` feeds the on_auth_user_created trigger (migration 03): handle + display name are
      // chosen at sign-up, not invented later.
      const { data, error } = await supabase.auth.signUp({
        email: address,
        password,
        options: { data: { display_name: name, full_name: name, handle }, emailRedirectTo: authRedirectUrl() },
      });
      if (error) throw error;
      await AsyncStorage.removeItem(GUEST_KEY).catch(() => {});
      if (data.session?.user) {
        setUser(mapSupabaseUser(data.session.user));
        setStatus('signedIn');
        track('auth.signup', { provider: 'email' });
        return 'signedIn' as const;
      }
      // Email confirmation is on: the account exists but there is no session yet.
      setStatus('signedOut');
      track('auth.signup', { provider: 'email', verify: true });
      return 'verify' as const;
    } catch (e) {
      throw mapAuthError(e);
    }
  }, []);

  const sendReset = useCallback(async (email: string) => {
    const address = email.trim().toLowerCase();
    if (!address.includes('@')) throw new AuthError('unknown', 'That email address does not look right.');

    if (!supabase) throw new AuthError('unknown', NO_MAIL);

    try {
      const { error } = await supabase.auth.resetPasswordForEmail(address, { redirectTo: authRedirectUrl() });
      if (error) throw error;
      setRecoveryPending(true);
    } catch (e) {
      throw mapAuthError(e);
    }
  }, []);

  const updatePassword = useCallback(async (password: string) => {
    if (password.length < MIN_PASSWORD) throw new AuthError('weak_password', 'Use at least 6 characters.');

    if (!supabase) throw new AuthError('unknown', 'Password changes aren’t available yet — this account is stored on this device only.');

    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setRecoveryPending(false);
    } catch (e) {
      throw mapAuthError(e);
    }
  }, []);

  const resendVerification = useCallback(async (email: string) => {
    const address = email.trim().toLowerCase();
    if (!address.includes('@')) throw new AuthError('unknown', 'That email address does not look right.');

    if (!supabase) throw new AuthError('unknown', NO_MAIL);

    try {
      const { error } = await supabase.auth.resend({ type: 'signup', email: address, options: { emailRedirectTo: authRedirectUrl() } });
      if (error) throw error;
    } catch (e) {
      throw mapAuthError(e);
    }
  }, []);

  const continueAsGuest = useCallback(() => {
    AsyncStorage.setItem(GUEST_KEY, '1').catch(() => {});
    setUser(null);
    setStatus('guest');
    track('auth.guest');
  }, []);

  const signOut = useCallback(async () => {
    if (supabase) {
      await supabase.auth.signOut().catch((e) => reportError('auth.signOut', e));
      setBackendAccessToken(null);
    }
    await AsyncStorage.removeItem(GUEST_KEY).catch(() => {});
    await AsyncStorage.removeItem(ACCOUNT_KEY).catch(() => {});
    setUser(null);
    setRecoveryPending(false);
    setStatus('signedOut');
  }, []);

  const deleteAccount = useCallback(async () => {
    // Server-side deletion first (migration 20/36: scrubs private data, tombstones the identity),
    // then the device wipe. When the backend is unavailable, deleting still means wiping the
    // device's copy — reported honestly by the settings screen's connection state.
    if (supabase) {
      try {
        const { error } = await supabase.rpc('delete_account');
        if (error) reportError('auth.deleteAccount.rpc', error);
      } catch (e) {
        reportError('auth.deleteAccount', e);
      }
      await supabase.auth.signOut().catch(() => {});
      setBackendAccessToken(null);
    }
    await AsyncStorage.removeItem(ACCOUNT_KEY).catch(() => {});
    await AsyncStorage.removeItem(GUEST_KEY).catch(() => {});
    setUser(null);
    setStatus('signedOut');
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      recoveryPending,
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
    [status, user, recoveryPending, signIn, signUp, sendReset, updatePassword, resendVerification, continueAsGuest, signOut, deleteAccount],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
