/**
 * Device locale and time zone, kept apart on purpose.
 *
 * A locale ("en-NG") is a language tag. A time zone ("Africa/Lagos") is an IANA identifier. The
 * scheduled reminder code once passed the locale to PostgreSQL as a zone and failed for every
 * member with that locale. Nothing in this module lets a locale pass as a zone.
 *
 * No imports: this file is also unit-tested under plain node (scripts/test-timezone.mjs).
 */

// Same shape the database accepts for push_tokens.locale.
const LOCALE_PATTERN = /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/;

// IANA zone names: "UTC", or Area/Location with optional sub-locations (America/Argentina/Buenos_Aires),
// and Etc/GMT+1 style offsets. A bare word such as "en-NG" has no slash and is rejected here.
const ZONE_PATTERN = /^(UTC|[A-Za-z][A-Za-z_]*(\/[A-Za-z0-9_+\-]+)+)$/;

export function normalizeLocale(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return LOCALE_PATTERN.test(value) ? value : null;
}

export function normalizeTimeZone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 64) return null;
  return ZONE_PATTERN.test(value) ? value : null;
}

/** The device's zone as reported by the platform, or null when the platform cannot say. */
export function deviceTimeZone(): string | null {
  try {
    return normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/** The device's locale as reported by the platform, or null when it is not a plain language tag. */
export function deviceLocale(): string | null {
  try {
    return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return null;
  }
}
