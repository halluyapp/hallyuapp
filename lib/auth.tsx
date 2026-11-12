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
import { ensureBackendSessionToken, setBackendAccessToken, setBackendTokenRefresher, supabase } from './api/client';
import * as RorkAuth from './rorkAuth';

export type AuthStatus = 'loading' | 'signedOut' | 'guest' | 'signedIn' | 'recovery';

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
  /** Google succeeded, but the application profile still needs a safe retry. */
  provisioningError: string | null;
  retryProfileProvisioning: () => Promise<void>;
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
  if (!identity.sub.trim()) throw new AuthError('credentials', 'Google returned an invalid identity. Please sign in again.');
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
      provider: 'google',
    };
  } catch (e) {
    reportError('auth.register_profile', e);
    const message = e instanceof Error ? e.message : String(e);
    if (/network|fetch|timeout|timed out|offline|failed to fetch/i.test(message)) {
      // "Failed to fetch" is thrown both offline and by a refused/origin-blocked request; when the
      // browser itself says it is online, the honest message is the second one.
      const browserOnline = typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
      throw new AuthError(
        'network',
        browserOnline
          ? 'Google sign-in succeeded, but Hallyu could not finish your account setup — the backend connection was refused from this browser. Retry account setup; you will not need to create another Google account.'
          : 'Google sign-in succeeded, but Hallyu could not finish your account setup while offline. Retry account setup when you are back online.',
      );
    }
    throw new AuthError('unknown', 'Google sign-in succeeded, but Hallyu could not finish your account setup. Retry account setup; you will not need to create another Google account.');
  }
}

function authFailure(e: unknown): AuthError {
  if (e instanceof AuthError) return e;
  if (e instanceof Error && e.message === 'cancelled') return new AuthError('cancelled', 'cancelled');
  if (e instanceof Error && /network|fetch|timeout|timed out|offline/i.test(e.message)) {
    // "Failed to fetch" is thrown by a dead network AND by a request the sign-in server refused
    // (CORS/origin). When the browser itself says it is online, reporting "offline" pointed the
    // member at their own device when the device was fine — so name the real failure instead.
    const browserOnline = typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
    return new AuthError(
      'network',
      browserOnline
        ? 'You’re online, but Hallyu’s sign-in service refused the connection from this browser. Try the Hallyu mobile app, or retry from the app’s published web address.'
        : 'You appear to be offline — try again.',
    );
  }
  return new AuthError('unknown', e instanceof Error ? e.message : String(e));
}


export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [provisioningError, setProvisioningError] = useState<string | null>(null);
  const provisioning = useRef<{ key: string; run: Promise<AuthUser | null> } | null>(null);
  const sessionGeneration = useRef(0);
  const booted = useRef(false);

  const completeBackendProvisioning = useCallback(async (identity: RorkAuth.RorkIdentity, preferredName?: string) => {
    const generation = sessionGeneration.current;
    const key = `${generation}:${identity.sub}`;
    try {
      let run = provisioning.current?.key === key ? provisioning.current.run : null;
      if (!run) {
        // register_profile is idempotent, so transient edge/network failures are safe to retry in
        // the original action. The member must not need to enter guest mode or tap repeatedly just
        // to finish creating the account they already authorized with Google.
        run = provisionWithRetry(
          () => registerBackendProfile(identity, preferredName),
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
      const failure = authFailure(e);
      setUser(null);
      setProvisioningError(failure.message);
      setStatus('recovery');
      throw failure;
    }
  }, []);

  // Boot. With a backend: restore the Rork session from SecureStore (refreshing an expired access
  // token) and register the profile. Without one: the original device-local account resolves
  // straight from storage.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;

    // Keep lib/api/client.ts's ensureBackendSessionToken able to recover a lapsed token.
    setBackendTokenRefresher(async () => {
      const next = await RorkAuth.refreshAccessToken();
      if (next) return next.accessToken;
      const stored = await RorkAuth.readStoredTokens();
      if (!stored) {
        // Rork cleared a rejected/revoked refresh token. Network failures deliberately keep the
        // stored session and therefore do not sign the member out.
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
        if (!tokens) {
          if (stored) {
            // Expired access token + offline/5xx refresh: retain credentials for an explicit retry.
            setProvisioningError('Your saved session could not be refreshed. Retry when you are back online.');
            setStatus('recovery');
            markBoot('auth:session-refresh-pending');
          } else {
            setStatus((await AsyncStorage.getItem(GUEST_KEY)) === '1' ? 'guest' : 'signedOut');
            markBoot('auth:no-session');
          }
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
        await completeBackendProvisioning(identity);
        markBoot('auth:session-restored');
      } catch (e) {
        reportError('auth.boot.session', e);
        markBoot('auth:boot-failed');
        const failure = authFailure(e);
        if (failure.code === 'network') {
          setProvisioningError('Your saved session could not be restored while offline. Retry when you are back online.');
          setStatus('recovery');
        } else if (failure.code === 'unknown') {
          // completeBackendProvisioning already retained the Rork session for an explicit retry.
          setProvisioningError(failure.message);
          setStatus('recovery');
        } else {
          setStatus('signedOut');
        }
      }
    })();
  }, [completeBackendProvisioning]);

  /** The one backend door: Google, brokered by Rork Auth. */
  const signInWithGoogle = useCallback(async (preferredName?: string) => {
    try {
      const identity = await RorkAuth.startGoogleSignIn();
      sessionGeneration.current += 1;
      setBackendAccessToken((await RorkAuth.readStoredTokens())?.accessToken ?? null);
      await AsyncStorage.removeItem(GUEST_KEY).catch(() => {});
      await completeBackendProvisioning(identity, preferredName);
      track('auth.signin', { provider: 'google' });
    } catch (e) {
      throw authFailure(e);
    }
  }, [completeBackendProvisioning]);

  const retryProfileProvisioning = useCallback(async () => {
    try {
      const stored = await RorkAuth.readStoredTokens();
      let tokens = stored;
      if (tokens && !RorkAuth.identityFromAccessToken(tokens.accessToken)) {
        tokens = await RorkAuth.refreshAccessToken();
      }
      if (!tokens) {
        if (stored) {
          setStatus('recovery');
          throw new AuthError('network', 'Your session could not be refreshed. Check your connection and retry account setup.');
        }
        sessionGeneration.current += 1;
        setBackendAccessToken(null);
        setUser(null);
        setStatus('signedOut');
        throw new AuthError('credentials', 'Your Google session has expired. Continue with Google to sign in again.');
      }
      const identity = RorkAuth.identityFromAccessToken(tokens.accessToken);
      if (!identity) {
        await RorkAuth.clearStoredTokens();
        setBackendAccessToken(null);
        setUser(null);
        setStatus('signedOut');
        throw new AuthError('credentials', 'Your saved Google session is invalid. Continue with Google to sign in again.');
      }
      setBackendAccessToken(tokens.accessToken);
      await completeBackendProvisioning(identity);
      markBoot('auth:provision-retried');
    } catch (e) {
      throw authFailure(e);
    }
  }, [completeBackendProvisioning]);

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
    sessionGeneration.current += 1;
    if (supabase) {
      setBackendAccessToken(null);
      void RorkAuth.clearStoredTokens();
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
      provisioningError,
      retryProfileProvisioning,
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
    [status, user, recoveryPending, provisioningError, retryProfileProvisioning, signInWithGoogle, signIn, signUp, sendReset, updatePassword, resendVerification, continueAsGuest, signOut, deleteAccount],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}


