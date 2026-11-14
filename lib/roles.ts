/**
 * Application roles, mirrored from public.profile_role.
 *
 * Keep permission decisions here: CEO is a distinct database role, not an alias that may be
 * normalized away during deserialization. These helpers control presentation only; PostgreSQL
 * RLS and privileged RPCs remain the authorization boundary.
 */
export type AppRole = 'member' | 'moderator' | 'admin' | 'ceo';

export function normalizeRole(value: unknown): AppRole {
  return value === 'ceo' || value === 'admin' || value === 'moderator' ? value : 'member';
}

/** Community moderation and the staff console. */
export function hasModeratorAccess(role: unknown): boolean {
  const normalized = normalizeRole(role);
  return normalized === 'ceo' || normalized === 'admin' || normalized === 'moderator';
}

/** Global administration, verification, recognition and account management. */
export function hasAdminAccess(role: unknown): boolean {
  const normalized = normalizeRole(role);
  return normalized === 'ceo' || normalized === 'admin';
}

export function isCeo(role: unknown): boolean {
  return normalizeRole(role) === 'ceo';
}
