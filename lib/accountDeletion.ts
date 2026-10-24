/**
 * Verified server-first account deletion coordinator (`performVerifiedAccountDeletion`).
 *
 * Guarantees:
 *   1. Server confirmation is required BEFORE local sign-out or local storage wipe occurs.
 *   2. Any RPC error, transport exception, expired session, or missing `{ deleted: true }` payload
 *      aborts immediately and propagates a sanitized error to UI without logging PII or wiping local state.
 *   3. Once server deletion succeeds (`{ deleted: true }`), local session/cache cleanup runs best-effort
 *      so partial sign-out glitches cannot leave the app showing an active session for a deleted account.
 */

export interface AccountDeletionDeps {
  hasRemoteBackend: boolean;
  ensureSessionToken: () => Promise<string | null>;
  rpcDeleteAccount: () => Promise<{
    data: { deleted?: boolean } | null;
    error: { message?: string; code?: string } | null;
  }>;
  signOutRemote: () => Promise<void>;
  clearLocalAccountStorage: () => Promise<void>;
  clearLocalSessionState: () => void;
  recordDiagnosticError?: (scope: string, summary: string) => void;
}

export interface AccountDeletionOutcome {
  deleted: true;
  localSignOutWarning: string | null;
}

function sanitizeDeletionDiagnostic(raw: unknown): string {
  const msg =
    raw instanceof Error
      ? raw.message
      : typeof raw === 'object' && raw !== null && 'message' in raw
        ? String((raw as { message?: unknown }).message ?? 'unknown')
        : String(raw ?? 'unknown');
  // Redact any accidental email, bearer token, or UUID fragments before recording diagnostic telemetry
  return msg
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
    .slice(0, 180);
}

export async function performVerifiedAccountDeletion(
  deps: AccountDeletionDeps,
): Promise<AccountDeletionOutcome> {
  if (deps.hasRemoteBackend) {
    const token = await deps.ensureSessionToken();
    if (!token) {
      deps.recordDiagnosticError?.('auth.deleteAccount.session', 'Session missing or expired');
      throw new Error('Your session has expired. Sign in again to confirm permanent account deletion.');
    }

    let rpcResult: {
      data: { deleted?: boolean } | null;
      error: { message?: string; code?: string } | null;
    };
    try {
      rpcResult = await deps.rpcDeleteAccount();
    } catch (err) {
      const safe = sanitizeDeletionDiagnostic(err);
      deps.recordDiagnosticError?.('auth.deleteAccount.network', safe);
      throw new Error('Could not reach the server to delete your account. Your account is still active — please try again.');
    }

    if (rpcResult.error || !rpcResult.data || rpcResult.data.deleted !== true) {
      const safe = sanitizeDeletionDiagnostic(
        rpcResult.error ?? 'Server did not confirm deletion',
      );
      deps.recordDiagnosticError?.('auth.deleteAccount.rejected', safe);
      throw new Error(
        rpcResult.error?.message
          ? `Account deletion failed on server: ${sanitizeDeletionDiagnostic(rpcResult.error.message)}`
          : 'Server did not confirm account deletion. Your account was not deleted.',
      );
    }
  }

  let localSignOutWarning: string | null = null;
  if (deps.hasRemoteBackend) {
    try {
      await deps.signOutRemote();
    } catch {
      localSignOutWarning = 'Account deleted on server; local token cleanup completed offline.';
    }
  }

  await deps.clearLocalAccountStorage().catch(() => {});
  deps.clearLocalSessionState();

  return {
    deleted: true,
    localSignOutWarning,
  };
}
