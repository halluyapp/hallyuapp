/**
 * Watch Tracker & Diary API (Migration 51).
 *
 * Every write goes through the `log_watch` RPC, which is idempotent (client_key), enforces the
 * daily cap, rejects future dates and advances the existing watchlist pointer in one transaction.
 * Reads are owner-only. Entries stay private; nothing here publishes anything.
 */
import { ensureBackendSessionToken, supabase } from './client';

export type WatchUnit = 'episode' | 'movie';
export type WatchSource = 'manual' | 'mark_watched' | 'import';

export interface DiaryEntry {
  id: string;
  titleId: string;
  watchedOn: string;
  watchedAt: string;
  season: number | null;
  episode: number | null;
  unit: WatchUnit;
  rating: number | null;
  note: string | null;
  source: WatchSource;
  title: string;
  posterUrl: string | null;
  mediaType: string;
  runtimeMinutes: number | null;
}

export interface HeatmapDay {
  day: string;
  count: number;
}

export interface TrackerSummary {
  today: string;
  todayCount: number;
  totalEntries: number;
  totalMinutes: number;
  daysActive: number;
  currentStreak: number;
  longestStreak: number;
  heatmap: HeatmapDay[];
}

export interface LogWatchInput {
  titleId: string;
  watchedOn: string;
  season?: number | null;
  episode?: number | null;
  rating?: number | null;
  note?: string | null;
  clientKey?: string | null;
  source?: WatchSource;
}

export type LogWatchResult =
  | { ok: true; entryId: string; duplicate: boolean }
  | { ok: false; error: string };

/** Member-local calendar date (YYYY-MM-DD) from the device clock. */
export function localDateKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeDiaryEntry(raw: Record<string, unknown>): DiaryEntry {
  const runtime = num(raw.episode_runtime) ?? num(raw.title_runtime);
  return {
    id: String(raw.id ?? ''),
    titleId: String(raw.title_id ?? ''),
    watchedOn: String(raw.watched_on ?? ''),
    watchedAt: String(raw.watched_at ?? ''),
    season: num(raw.season),
    episode: num(raw.episode),
    unit: raw.unit === 'movie' ? 'movie' : 'episode',
    rating: num(raw.rating),
    note: raw.note ? String(raw.note) : null,
    source: (raw.source as WatchSource) ?? 'manual',
    title: String(raw.title ?? 'Untitled'),
    posterUrl: raw.poster_url ? String(raw.poster_url) : null,
    mediaType: String(raw.media_type ?? 'tv'),
    runtimeMinutes: runtime,
  };
}

export function normalizeTrackerSummary(raw: Record<string, unknown>): TrackerSummary {
  const heatmap = Array.isArray(raw.heatmap)
    ? raw.heatmap.map((row) => {
        const r = row as Record<string, unknown>;
        return { day: String(r.day), count: num(r.count) ?? 0 };
      })
    : [];
  return {
    today: String(raw.today ?? localDateKey()),
    todayCount: num(raw.today_count) ?? 0,
    totalEntries: num(raw.total_entries) ?? 0,
    totalMinutes: num(raw.total_minutes) ?? 0,
    daysActive: num(raw.days_active) ?? 0,
    currentStreak: num(raw.current_streak) ?? 0,
    longestStreak: num(raw.longest_streak) ?? 0,
    heatmap,
  };
}

/** Writes one watch event. Safe to retry: the same client_key returns the original entry. */
export async function logWatch(input: LogWatchInput): Promise<LogWatchResult> {
  if (!supabase) return { ok: false, error: 'offline' };
  if (!(await ensureBackendSessionToken())) return { ok: false, error: 'signed_out' };
  const { data, error } = await supabase.rpc('log_watch', {
    p_title_id: input.titleId,
    p_watched_on: input.watchedOn,
    p_season: input.season ?? null,
    p_episode: input.episode ?? null,
    p_rating: input.rating ?? null,
    p_note: input.note ?? null,
    p_client_key: input.clientKey ?? null,
    p_source: input.source ?? 'manual',
  });
  if (error) return { ok: false, error: error.message };
  const raw = (data ?? {}) as Record<string, unknown>;
  return { ok: true, entryId: String(raw.entry_id ?? ''), duplicate: Boolean(raw.duplicate) };
}

export async function deleteWatchEntry(entryId: string): Promise<boolean> {
  if (!supabase || !(await ensureBackendSessionToken())) return false;
  const { data, error } = await supabase.rpc('delete_watch_entry', { p_entry_id: entryId });
  return !error && data === true;
}

export async function fetchDiaryPage(
  before?: string | null,
  limit = 30,
): Promise<{ entries: DiaryEntry[]; hasMore: boolean } | null> {
  if (!supabase || !(await ensureBackendSessionToken())) return null;
  const { data, error } = await supabase.rpc('watch_diary_page', {
    p_before: before ?? null,
    p_limit: limit,
  });
  if (error || !data || typeof data !== 'object') return null;
  const rows = Array.isArray((data as Record<string, unknown>).entries)
    ? ((data as Record<string, unknown>).entries as Record<string, unknown>[])
    : [];
  return { entries: rows.map(normalizeDiaryEntry), hasMore: rows.length === limit };
}

export async function fetchTrackerSummary(today = localDateKey()): Promise<TrackerSummary | null> {
  if (!supabase || !(await ensureBackendSessionToken())) return null;
  const { data, error } = await supabase.rpc('tracker_summary', { p_today: today });
  if (error || !data || typeof data !== 'object') return null;
  return normalizeTrackerSummary(data as Record<string, unknown>);
}
