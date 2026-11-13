/**
 * Client credentials shipped in the app.
 *
 * TMDB — the drama and actor catalog, read directly by the client (lib/catalog.ts). The catalog
 * token is a public, read-only credential by design. Rotate it at themoviedb.org → Settings → API.
 *
 * Backend — the Rork Cloud (Supabase) connection. Only the client-safe values live here: the
 * project URL, the anon key, the Rork Auth app key and the media bucket name. The service-role
 * key, TMDB server credentials and push tokens are server-side only and never reach this file or
 * the app bundle (docs/BACKEND-CREDENTIALS.md). Every backend value is read from `EXPO_PUBLIC_*`
 * at build time — never hardcoded — so a build without the secrets simply has no backend, and the
 * connection gate reports that honestly instead of pretending.
 *
 * An `EXPO_PUBLIC_*` variable overrides a value ONLY when it is non-empty — CI and copied
 * `.env.example` files often define the variable as an empty string, which must not blank the key.
 */

const env = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/** TMDB v4 read access token (preferred — sent as `Authorization: Bearer`). */
export const TMDB_ACCESS_TOKEN =
  env(process.env.EXPO_PUBLIC_TMDB_ACCESS_TOKEN) ??
  'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJmZjAxZjI4ZmM1YzQ3NzkxZTI4MDM4MzQ5NDQ1YmY1OCIsIm5iZiI6MTc4OTAyMDA1Ny43NzksInN1YiI6IjZhYTI0Nzk5OGQ1YWFjZTczMzY2ODJkMyIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.ETon7kqWQjj7jtJJOXyRgAWme9Sh9B7OUrdAI61uuH8';

/** TMDB v3 API key (used as `?api_key=` when no v4 token is available). */
export const TMDB_API_KEY = env(process.env.EXPO_PUBLIC_TMDB_API_KEY) ?? 'ff01f28fc5c47791e28038349445bf58';

// ── Backend (Rork Cloud / Supabase) — client-safe, build-time injected ────────────────────────

/** Supabase project URL (Rork Cloud). Undefined = the build has no backend connection. */
export const SUPABASE_URL = env(process.env.EXPO_PUBLIC_SUPABASE_URL);

/** Supabase anon key. Client-safe by design: every table is guarded by row level security. */
export const SUPABASE_ANON_KEY = env(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);

/** Rork Auth app key — identifies this app in the Google/Apple OAuth token exchange. */
export const RORK_APP_KEY = env(process.env.EXPO_PUBLIC_RORK_APP_KEY);

/** Rork Auth base (the OAuth refresh endpoint lives at `${RORK_AUTH_URL}/oauth/refresh`). */
export const RORK_AUTH_URL = env(process.env.EXPO_PUBLIC_RORK_AUTH_URL) ?? 'https://api.rork.com';

/** The private `media` bucket created by migration 17 (reads go through signed URLs). */
export const MEDIA_BUCKET = env(process.env.EXPO_PUBLIC_MEDIA_BUCKET) ?? 'media';

/** Gemini API keys — the primary AI provider. Multiple keys support rotation on quota exhaustion.
 *  The first non-empty key is used; additional keys are tried in order when a call fails.
 */
export const GEMINI_API_KEYS = (() => {
  const raw = env(process.env.EXPO_PUBLIC_GEMINI_API_KEYS) ?? '';
  return raw.split(',').map((k) => k.trim()).filter(Boolean);
})();

/** Default Gemini model. Override with EXPO_PUBLIC_GEMINI_MODEL at build time. */
export const GEMINI_MODEL = env(process.env.EXPO_PUBLIC_GEMINI_MODEL) ?? 'gemini-1.5-pro';

/** Gemini API base URL. */
export const GEMINI_API_URL = env(process.env.EXPO_PUBLIC_GEMINI_API_URL) ?? 'https://generativelanguage.googleapis.com/v1beta';

/** True when at least one Gemini key is configured. */
export const geminiConfigured = GEMINI_API_KEYS.length > 0;

/** True when the build carries a backend connection (URL + anon key both present). */
export const backendConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
