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
import { provisionWithRetry } from './provisioning';
import { Platform } from 'react-native';
import { getWebAppBaseUrl } from './links';
import { ensureBackendSessionToken, setBackendAccessToken, setBackendTokenRefresher, supabase, supabaseAuth } from './api/client';
import * as RorkAuth from './rorkAuth';

export type AuthStatus = 'loading' | 'signedOut' | 'guest' | 'signedIn' | 'recovery';

/** How this account was established. Both Google (Rork Auth) and Email (Supabase Auth) provision backend profiles. */
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
  /** Sign-in succeeded, but the application profile still needs a safe retry. */
  provisioningError: string | null;
  retryProfileProvisioning: () => Promise<void>;
  restoreSession: () => Promise<boolean>;
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

function authRedirectUrl(): string {
  if (Platform.OS === 'web') {
    const base =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : getWebAppBaseUrl();
    return `${base.replace(/\/$/, '')}/auth/callback`;
  }
  return 'hallyu://auth/callback';
}

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
 * Registers (or resumes) the backend profile for a signed-in identity (Google or Email). `register_profile`
 * (migration 58) is an idempotent upsert keyed on `auth_sub`, so it is safe to call on every
 * sign-in; the first profile ever created is promoted to the founder/CEO role by the database.
 */
async function registerBackendProfile(
  identity: RorkAuth.RorkIdentity,
  preferredName?: string,
  provider: AuthProviderName = 'google',
): Promise<AuthUser | null> {
  if (!supabase) return null;
  if (!identity.sub.trim()) throw new AuthError('credentials', 'Sign-in returned an invalid identity. Try Gmail login.');
  const displayName = (preferredName?.trim() || identity.name?.trim() || displayNameFor(identity.email || 'Member')).slice(0, 40);
  const handle = handleFrom(identity.email || identity.name, displayName);
  try {
    const { data, error } = await supabase.rpc('register_profile', { p_handle: handle, p_display_name: displayName });
    if (error) throw error;
    const returned = typeof data === 'string' ? data : (data as { id?: unknown } | null)?.id;
    const id = typeof returned === 'string' ? returned : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error('register_profile returned no valid application profile UUID');
    }

    // A UUID alone is not proof of a usable account. Read the provisioned row back through RLS and
    // use its persisted naming rather than inventing client-side profile state from identity.sub.
    const { data: profile, error: readError } = await supabase
      .from('profiles')
      .select('id, auth_sub, handle, display_name, account_status')
      .eq('id', id)
      .eq('auth_sub', identity.sub)
      .single();
    if (readError) throw readError;
    if (!profile || profile.id !== id || profile.auth_sub !== identity.sub || profile.account_status !== 'active') {
      throw new Error('the provisioned application profile is not active');
    }
    return {
      id: profile.id,
      email: identity.email || undefined,
      displayName: profile.display_name,
      handle: profile.handle,
      avatarUrl: identity.picture,
      emailVerified: true,
      provider,
    };
  } catch (e) {
    reportError('auth.register_profile', e);
    const message = e instanceof Error ? e.message : String(e);
    if (/network|fetch|timeout|timed out|offline|failed to fetch/i.test(message)) {
      const browserOnline = typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
      throw new AuthError(
        'network',
        browserOnline
          ? 'Sign-in succeeded, but Hallyu could not finish your account setup — the backend connection was refused from this browser. Retry setup or try Gmail login.'
          : 'Sign-in succeeded, but Hallyu could not finish your account setup while offline. Retry account setup when you are back online.',
      );
    }
    throw new AuthError('unknown', 'Sign-in succeeded, but Hallyu could not finish your account setup. Retry account setup.');
  }
}

function mapSupabaseEmailError(err: { message?: string; status?: number }): AuthError {
  const msg = err.message ?? 'Authentication failed.';
  if (/invalid login credentials/i.test(msg)) {
    return new AuthError('credentials', 'Incorrect email or password.');
  }
  if (/email not confirmed/i.test(msg)) {
    return new AuthError('unverified', 'Check your inbox to verify your email address first, or try Gmail login.');
  }
  if (/already registered|user already exists/i.test(msg)) {
    return new AuthError('exists', 'An account with that email already exists. Sign in instead.');
  }
  if (/rate limit|too many requests/i.test(msg)) {
    return new AuthError('rate_limit', 'Too many attempts. Wait a moment before trying again.');
  }
  if (/password.*least|weak/i.test(msg)) {
    return new AuthError('weak_password', msg);
  }
  if (/network|fetch|timeout|timed out|offline/i.test(msg)) {
    return new AuthError('network', 'Could not reach the authentication server. Check your connection.');
  }
  return new AuthError('unknown', msg);
}

function authFailure(e: unknown, isGoogle = false): AuthError {
  if (e instanceof AuthError) return e;
  if (e instanceof Error && e.message === 'cancelled') return new AuthError('cancelled', 'cancelled');
  const rawMessage = e instanceof Error ? e.message : String(e);
  const hint = isGoogle && !/try gmail login/i.test(rawMessage) ? ' Try Gmail login.' : '';
  if (e instanceof Error && /network|fetch|timeout|timed out|offline/i.test(e.message)) {
    const browserOnline = typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
    return new AuthError(
      'network',
      browserOnline
        ? `You’re online, but Hallyu’s sign-in service refused the connection from this browser.${hint || ' Try the email sign-in below.'}`
        : `You appear to be offline — try again.${hint}`,
    );
  }
  return new AuthError('unknown', `${rawMessage}${hint}`);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [provisioningError, setProvisioningError] = useState<string | null>(null);
  const provisioning = useRef<{ key: string; run: Promise<AuthUser | null> } | null>(null);
  const sessionGeneration = useRef(0);
  const booted = useRef(false);

  const completeBackendProvisioning = useCallback(
    async (identity: RorkAuth.RorkIdentity, preferredName?: string, provider: AuthProviderName = 'google') => {
      const generation = sessionGeneration.current;
      const key = `${generation}:${identity.sub}`;
      try {
        let run = provisioning.current?.key === key ? provisioning.current.run : null;
        if (!run) {
          // register_profile is idempotent, so transient edge/network failures are safe to retry in
          // the original action.
          const provisionFn =
            provider === 'google'
              ? () => registerBackendProfile(identity, preferredName)
              : () => registerBackendProfile(identity, preferredName, provider);
          run = provisionWithRetry(
            provisionFn,
            () => generation === sessionGeneration.current,
          );
          provisioning.current = { key, run };
          const clear = () => {
            if (provisioning.current?.run === run) provisioning.current = null;
          };
          void run.then(clear, clear);
        }
        const next = await run;
        if (generation !== sessionGeneration.current) throw new AuthError('cancelled', 'cancelled');
        if (!next) throw new AuthError('unknown', 'Account setup is unavailable in this build.');
        setProvisioningError(null);
        setUser(next);
        setStatus('signedIn');
        markBoot(`auth:profile-ready:${next.id}`);
        return next;
      } catch (e) {
        if (generation !== sessionGeneration.current) throw new AuthError('cancelled', 'cancelled');
        const failure = authFailure(e, provider === 'google');
        setUser(null);
        setProvisioningError(failure.message);
        setStatus('recovery');
        throw failure;
      }
    },
    [],
  );

  const restoreSession = useCallback(async (): Promise<boolean> => {
    if (!supabase) return false;
    try {
      // 1. Check Rork Auth tokens (Google)
      const stored = await RorkAuth.readStoredTokens();
      let tokens = stored;
      if (tokens && !RorkAuth.identityFromAccessToken(tokens.accessToken)) {
        tokens = await RorkAuth.refreshAccessToken();
      }
      if (tokens) {
        const identity = RorkAuth.identityFromAccessToken(tokens.accessToken);
        if (identity) {
          setBackendAccessToken(tokens.accessToken);
          await completeBackendProvisioning(identity, undefined, 'google');
          return true;
        }
      }

      // 2. Check Supabase GoTrue session (Email/Password)
      if (supabaseAuth) {
        const { data } = await supabaseAuth.auth.getSession();
        const session = data.session;
        if (session?.access_token && session.user?.id) {
          setBackendAccessToken(session.access_token);
          const meta = (session.user.user_metadata ?? {}) as Record<string, unknown>;
          const metaName =
            (typeof meta.display_name === 'string' && meta.display_name) ||
            (typeof meta.full_name === 'string' && meta.full_name) ||
            undefined;
          await completeBackendProvisioning(
            { sub: session.user.id, email: session.user.email ?? '', name: metaName },
            metaName,
            'email',
          );
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }, [completeBackendProvisioning]);

  // Boot: restore Rork Google session OR Supabase Email session; fallback to device-local if no backend.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;

    // Keep lib/api/client.ts's ensureBackendSessionToken able to recover a lapsed Rork OR GoTrue token.
    setBackendTokenRefresher(async () => {
      const next = await RorkAuth.refreshAccessToken();
      if (next) return next.accessToken;

      if (supabaseAuth) {
        const { data } = await supabaseAuth.auth.refreshSession().catch(() => ({ data: { session: null } }));
        if (data.session?.access_token) return data.session.access_token;
      }

      const stored = await RorkAuth.readStoredTokens();
      if (!stored) {
        sessionGeneration.current += 1;
        setBackendAccessToken(null);
        setUser(null);
        setStatus((current) => (current === 'guest' ? current : 'signedOut'));
      }
      return null;
    });

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
        if (tokens) {
          const identity = RorkAuth.identityFromAccessToken(tokens.accessToken);
          if (!identity) {
            await RorkAuth.clearStoredTokens();
          } else {
            setBackendAccessToken(tokens.accessToken);
            await completeBackendProvisioning(identity, undefined, 'google');
            markBoot('auth:session-restored');
            return;
          }
        } else if (stored) {
          // Expired access token + offline/5xx refresh: retain credentials for an explicit retry.
          setProvisioningError('Your saved session could not be refreshed. Retry when you are back online.');
          setStatus('recovery');
          markBoot('auth:session-refresh-pending');
          return;
        }

        // No Rork session — check Supabase GoTrue email session.
        if (supabaseAuth) {
          const { data } = await supabaseAuth.auth.getSession();
          const session = data.session;
          if (session?.access_token && session.user?.id) {
            setBackendAccessToken(session.access_token);
            const meta = (session.user.user_metadata ?? {}) as Record<string, unknown>;
            const metaName =
              (typeof meta.display_name === 'string' && meta.display_name) ||
              (typeof meta.full_name === 'string' && meta.full_name) ||
              undefined;
            await completeBackendProvisioning(
              { sub: session.user.id, email: session.user.email ?? '', name: metaName },
              metaName,
              'email',
            );
            markBoot('auth:email-session-restored');
            return;
          }
        }

        setStatus((await AsyncStorage.getItem(GUEST_KEY)) === '1' ? 'guest' : 'signedOut');
        markBoot('auth:no-session');
      } catch (e) {
        reportError('auth.boot.session', e);
        markBoot('auth:boot-failed');
        const failure = authFailure(e, true);
        if (failure.code === 'network') {
          setProvisioningError('Your saved session could not be restored while offline. Retry when you are back online.');
          setStatus('recovery');
        } else if (failure.code === 'unknown') {
          setProvisioningError(failure.message);
          setStatus('recovery');
        } else {
          setStatus('signedOut');
        }
      }
    })();

    // Keep GoTrue email sessions synced on token refresh or password recovery events.
    const sub = supabaseAuth?.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        setRecoveryPending(true);
      }
      if (session?.access_token && (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED')) {
        setBackendAccessToken(session.access_token);
      }
    });
    return () => {
      sub?.data.subscription.unsubscribe();
    };
  }, [completeBackendProvisioning]);

  const signInWithGoogle = useCallback(async (preferredName?: string) => {
    try {
      const identity = await RorkAuth.startGoogleSignIn();
      sessionGeneration.current += 1;
      setBackendAccessToken((await RorkAuth.readStoredTokens())?.accessToken ?? null);
      await AsyncStorage.removeItem(GUEST_KEY).catch(() => {});
      await completeBackendProvisioning(identity, preferredName, 'google');
      track('auth.signin', { provider: 'google' });
    } catch (e) {
      throw authFailure(e, true);
    }
  }, [completeBackendProvisioning]);

  const retryProfileProvisioning = useCallback(async () => {
    try {
      const stored = await RorkAuth.readStoredTokens();
      let tokens = stored;
      if (tokens && !RorkAuth.identityFromAccessToken(tokens.accessToken)) {
        tokens = await RorkAuth.refreshAccessToken();
      }
      if (tokens) {
        const identity = RorkAuth.identityFromAccessToken(tokens.accessToken);
        if (!identity) {
          await RorkAuth.clearStoredTokens();
          setBackendAccessToken(null);
          setUser(null);
          setStatus('signedOut');
          throw new AuthError('credentials', 'Your saved Google session is invalid. Try Gmail login or email sign-in.');
        }
        setBackendAccessToken(tokens.accessToken);
        await completeBackendProvisioning(identity, undefined, 'google');
        markBoot('auth:provision-retried');
        return;
      }

      if (supabaseAuth) {
        const { data } = await supabaseAuth.auth.getSession();
        if (data.session?.access_token && data.session.user?.id) {
          setBackendAccessToken(data.session.access_token);
          await completeBackendProvisioning(
            { sub: data.session.user.id, email: data.session.user.email ?? '' },
            undefined,
            'email',
          );
          markBoot('auth:provision-retried');
          return;
        }
      }

      if (stored) {
        setStatus('recovery');
        throw new AuthError('network', 'Your session could not be refreshed. Check your connection and retry account setup.');
      }
      sessionGeneration.current += 1;
      setBackendAccessToken(null);
      setUser(null);
      setStatus('signedOut');
      throw new AuthError('credentials', 'Your session has expired. Try Gmail login or sign in with email.');
    } catch (e) {
      throw authFailure(e, true);
    }
  }, [completeBackendProvisioning]);

  const signIn = useCallback(async (email: string, password: string) => {
    const address = email.trim().toLowerCase();
    if (!address.includes('@')) throw new AuthError('credentials', 'Enter the email address you signed up with.');
    if (password.length < MIN_PASSWORD) throw new AuthError('credentials', 'Your password is at least 6 characters.');

    if (!supabase || !supabaseAuth) {
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

    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email: address, password });
    if (error) throw mapSupabaseEmailError(error);
    const session = data.session;
    const authUser = data.user ?? session?.user;
    if (!session?.access_token || !authUser?.id) {
      throw new AuthError('credentials', 'No active session returned. Try Gmail login.');
    }

    await RorkAuth.clearStoredTokens().catch(() => {});
    sessionGeneration.current += 1;
    setBackendAccessToken(session.access_token);
    await AsyncStorage.removeItem(GUEST_KEY).catch(() => {});
    const meta = (authUser.user_metadata ?? {}) as Record<string, unknown>;
    const metaName =
      (typeof meta.display_name === 'string' && meta.display_name) ||
      (typeof meta.full_name === 'string' && meta.full_name) ||
      undefined;
    await completeBackendProvisioning(
      { sub: authUser.id, email: authUser.email ?? address, name: metaName },
      metaName,
      'email',
    );
    track('auth.signin', { provider: 'email' });
  }, [completeBackendProvisioning]);

  const signUp = useCallback(async (email: string, password: string, displayName: string) => {
    const address = email.trim().toLowerCase();
    if (!address.includes('@')) throw new AuthError('unknown', 'That email address does not look right.');
    if (password.length < MIN_PASSWORD) throw new AuthError('weak_password', 'Use at least 6 characters.');
    const name = displayName.trim() || displayNameFor(address);

    if (!supabase || !supabaseAuth) {
      const handle = handleFrom(address, name);
      const next: AuthUser = { id: idFor(address), email: address, displayName: name, handle, emailVerified: true, provider: 'email' };
      await writeLocalAccount(next);
      await AsyncStorage.removeItem(GUEST_KEY).catch(() => {});
      setUser(next);
      setStatus('signedIn');
      track('auth.signup', { provider: 'email' });
      return 'signedIn' as const;
    }

    const { data, error } = await supabaseAuth.auth.signUp({
      email: address,
      password,
      options: {
        data: { display_name: name, full_name: name },
        emailRedirectTo: authRedirectUrl(),
      },
    });
    if (error) throw mapSupabaseEmailError(error);

    if (data.session?.access_token && data.user?.id) {
      await RorkAuth.clearStoredTokens().catch(() => {});
      sessionGeneration.current += 1;
      setBackendAccessToken(data.session.access_token);
      await AsyncStorage.removeItem(GUEST_KEY).catch(() => {});
      await completeBackendProvisioning(
        { sub: data.user.id, email: data.user.email ?? address, name },
        name,
        'email',
      );
      track('auth.signup', { provider: 'email' });
      return 'signedIn' as const;
    }

    track('auth.signup', { provider: 'email', verify: true });
    return 'verify' as const;
  }, [completeBackendProvisioning]);

  const sendReset = useCallback(async (email: string) => {
    const address = email.trim().toLowerCase();
    if (!address.includes('@')) throw new AuthError('unknown', 'That email address does not look right.');
    if (!supabase || !supabaseAuth) throw new AuthError('unknown', NO_MAIL);
    const { error } = await supabaseAuth.auth.resetPasswordForEmail(address, {
      redirectTo: authRedirectUrl(),
    });
    if (error) throw mapSupabaseEmailError(error);
  }, []);

  const updatePassword = useCallback(async (password: string) => {
    if (password.length < MIN_PASSWORD) throw new AuthError('weak_password', 'Use at least 6 characters.');
    if (!supabase || !supabaseAuth) throw new AuthError('unknown', 'Password changes aren’t available yet — this account is stored on this device only.');
    const { error } = await supabaseAuth.auth.updateUser({ password });
    if (error) throw mapSupabaseEmailError(error);
    setRecoveryPending(false);
  }, []);

  const resendVerification = useCallback(async (email: string) => {
    const address = email.trim().toLowerCase();
    if (!address.includes('@')) throw new AuthError('unknown', 'That email address does not look right.');
    if (!supabase || !supabaseAuth) throw new AuthError('unknown', NO_MAIL);
    const { error } = await supabaseAuth.auth.resend({
      type: 'signup',
      email: address,
      options: { emailRedirectTo: authRedirectUrl() },
    });
    if (error) throw mapSupabaseEmailError(error);
  }, []);

  const continueAsGuest = useCallback(() => {
    sessionGeneration.current += 1;
    if (supabase) {
      setBackendAccessToken(null);
      void RorkAuth.clearStoredTokens();
      void supabaseAuth?.auth.signOut({ scope: 'local' }).catch(() => {});
    }
    setProvisioningError(null);
    AsyncStorage.setItem(GUEST_KEY, '1').catch(() => {});
    setUser(null);
    setStatus('guest');
    track('auth.guest');
  }, []);

  const signOut = useCallback(async () => {
    sessionGeneration.current += 1;
    if (supabase) {
      await RorkAuth.clearStoredTokens().catch((e) => reportError('auth.signOut', e));
      await supabaseAuth?.auth.signOut({ scope: 'local' }).catch((e) => reportError('auth.signOut', e));
      setBackendAccessToken(null);
    }
    await AsyncStorage.removeItem(GUEST_KEY).catch(() => {});
    await AsyncStorage.removeItem(ACCOUNT_KEY).catch(() => {});
    setUser(null);
    setRecoveryPending(false);
    setProvisioningError(null);
    setStatus('signedOut');
  }, []);

  const deleteAccount = useCallback(async () => {
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
        await supabaseAuth?.auth.signOut({ scope: 'local' }).catch(() => {});
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
      provisioningError,
      retryProfileProvisioning,
      restoreSession,
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
    [status, user, recoveryPending, provisioningError, retryProfileProvisioning, restoreSession, signInWithGoogle, signIn, signUp, sendReset, updatePassword, resendVerification, continueAsGuest, signOut, deleteAccount],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}


