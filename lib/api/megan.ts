/**
 * Megan metadata, reached only through the `megan-metadata` edge function. The app never holds the key
 * and never calls Megan directly. Metadata only: no streams, no downloads.
 */
import { ensureBackendSessionToken, supabase } from './client';

export interface MeganSearchHit {
  id: number;
  slug: string | null;
  title: string;
  year: number | null;
  rating: number | null;
  poster: string | null;
}

export interface MeganEpisode {
  episode: number;
  runtime: number | null;
  air_date: string | null;
}

export interface RuntimeCheck {
  compared: number;
  agrees: boolean;
  mismatches: { episode: number; tmdb: number; megan: number }[];
  tolerance_minutes: number;
}

type Result<T> = { ok: true; value: T } | { ok: false; reason: 'offline' | 'signed_out' | 'not_configured' | 'failed' };

async function call<T>(body: Record<string, unknown>): Promise<Result<T>> {
  if (!supabase) return { ok: false, reason: 'offline' };
  if (!(await ensureBackendSessionToken())) return { ok: false, reason: 'signed_out' };
  const { data, error } = await supabase.functions.invoke<T & { error?: string }>('megan-metadata', { body });
  if (error || !data) return { ok: false, reason: 'failed' };
  if ((data as { error?: string }).error === 'not_configured') return { ok: false, reason: 'not_configured' };
  if ((data as { error?: string }).error) return { ok: false, reason: 'failed' };
  return { ok: true, value: data as T };
}

export async function searchMegan(q: string): Promise<Result<MeganSearchHit[]>> {
  const r = await call<{ results: MeganSearchHit[] }>({ action: 'search', q });
  if (!r.ok) return r;
  return { ok: true, value: Array.isArray(r.value.results) ? r.value.results : [] };
}

export async function fetchMeganSeason(id: number, season: number): Promise<Result<MeganEpisode[]>> {
  const r = await call<{ episodes: MeganEpisode[] }>({ action: 'season', id, season });
  if (!r.ok) return r;
  return { ok: true, value: Array.isArray(r.value.episodes) ? r.value.episodes : [] };
}

/** Compares TMDB episode runtimes with Megan's for one season. Differences over 2 minutes are reported. */
export async function crossCheckRuntimes(
  id: number,
  season: number,
  tmdb: { episode: number; runtime: number }[],
): Promise<Result<RuntimeCheck>> {
  return call<RuntimeCheck>({ action: 'runtime_check', id, season, tmdb });
}
