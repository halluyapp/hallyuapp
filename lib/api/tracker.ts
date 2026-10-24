/**
 * Watch Tracker & Diary API (Migration 51).
 *
 * Every write goes through the `log_watch` RPC, which is idempotent (client_key), enforces the
 * daily cap, rejects future dates and advances the existing watchlist pointer in one transaction.
 * Reads are owner-only. Entries stay private; nothing here publishes anything.
 */
import { ensureBackendSessionToken, supabase } from './client';
import { type ImportRow, parseDiaryCsv } from '../diaryCsv';

export type { ImportRow } from '../diaryCsv';
export { parseDiaryCsv };

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
  /** Entries whose runtime is known. Minutes only count these. */
  runtimeKnownEntries: number;
  runtimeUnknownEntries: number;
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
    runtimeKnownEntries: num(raw.runtime_known_entries) ?? 0,
    runtimeUnknownEntries: num(raw.runtime_unknown_entries) ?? 0,
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

export type DiaryPageResult =
  | { ok: true; entries: DiaryEntry[]; hasMore: boolean; next: DiaryCursor | null }
  | { ok: false; error: string };

/**
 * One newest-first page of the diary. Pass the `next` cursor from the previous page; the cursor is
 * (watched_on, watched_at, id), so rows that share a timestamp are never skipped or repeated.
 */
export async function fetchDiaryPage(cursor?: DiaryCursor | null, limit = 30): Promise<DiaryPageResult> {
  if (!supabase) return { ok: false, error: 'offline' };
  if (!(await ensureBackendSessionToken())) return { ok: false, error: 'signed_out' };
  const { data, error } = await supabase.rpc('watch_diary_page_keyset', {
    p_limit: limit,
    p_before_on: cursor?.watchedOn ?? null,
    p_before_at: cursor?.watchedAt ?? null,
    p_before_id: cursor?.id ?? null,
  });
  if (error || !data || typeof data !== 'object') return { ok: false, error: error?.message ?? 'Could not load your diary.' };
  const r = data as Record<string, unknown>;
  const rows = Array.isArray(r.entries) ? (r.entries as Record<string, unknown>[]) : [];
  const nx = r.next && typeof r.next === 'object' ? (r.next as Record<string, unknown>) : null;
  return {
    ok: true,
    entries: rows.map(normalizeDiaryEntry),
    hasMore: r.has_more === true,
    next: nx ? { watchedOn: String(nx.watched_on), watchedAt: String(nx.watched_at), id: String(nx.id) } : null,
  };
}

export interface DiaryCursor {
  watchedOn: string;
  watchedAt: string;
  id: string;
}

export interface DiaryEdit {
  rating?: number | null;
  note?: string | null;
  watchedOn?: string;
}

/** Edits an entry's rating, note or day. The server applies the same duplicate and cap rules as logging. */
export async function updateWatchEntry(entryId: string, edit: DiaryEdit): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'offline' };
  if (!(await ensureBackendSessionToken())) return { ok: false, error: 'signed_out' };
  const patch: Record<string, unknown> = {};
  if ('rating' in edit) patch.rating = edit.rating ?? null;
  if ('note' in edit) patch.note = edit.note ?? '';
  if (edit.watchedOn !== undefined) patch.watched_on = edit.watchedOn;
  const { error } = await supabase.rpc('update_watch_entry', { p_entry_id: entryId, p_patch: patch });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function fetchTrackerSummary(today = localDateKey()): Promise<TrackerSummary | null> {
  if (!supabase || !(await ensureBackendSessionToken())) return null;
  const { data, error } = await supabase.rpc('tracker_summary', { p_today: today });
  if (error || !data || typeof data !== 'object') return null;
  return normalizeTrackerSummary(data as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Year in Review, badges, export and CSV import (Migration 53).
// ---------------------------------------------------------------------------

export interface YearReview {
  year: number;
  entries: number;
  daysWatched: number;
  minutes: number;
  runtimeUnknownEntries: number;
  bestDay: string | null;
  bestDayEntries: number;
  topTitles: { title: string; entries: number; posterUrl: string | null }[];
  pagesRead: number;
  booksFinished: number;
}

export interface TrackerBadge {
  id: string;
  name: string;
  detail: string;
  earned: boolean;
  progress: number;
  target: number;
}

export async function fetchYearReview(year?: number): Promise<YearReview | null> {
  if (!supabase || !(await ensureBackendSessionToken())) return null;
  const { data, error } = await supabase.rpc('year_review', { p_year: year ?? null });
  if (error || !data || typeof data !== 'object') return null;
  const r = data as Record<string, unknown>;
  const top = Array.isArray(r.top_titles) ? (r.top_titles as Record<string, unknown>[]) : [];
  return {
    year: num(r.year) ?? new Date().getFullYear(),
    entries: num(r.entries) ?? 0,
    daysWatched: num(r.days_watched) ?? 0,
    minutes: num(r.minutes) ?? 0,
    runtimeUnknownEntries: num(r.runtime_unknown_entries) ?? 0,
    bestDay: r.best_day ? String(r.best_day) : null,
    bestDayEntries: num(r.best_day_entries) ?? 0,
    topTitles: top.map((t) => ({
      title: String(t.title ?? 'Untitled'),
      entries: num(t.entries) ?? 0,
      posterUrl: t.poster_url ? String(t.poster_url) : null,
    })),
    pagesRead: num(r.pages_read) ?? 0,
    booksFinished: num(r.books_finished) ?? 0,
  };
}

export async function fetchTrackerBadges(): Promise<TrackerBadge[] | null> {
  if (!supabase || !(await ensureBackendSessionToken())) return null;
  const { data, error } = await supabase.rpc('tracker_badges');
  if (error || !Array.isArray(data)) return null;
  return (data as Record<string, unknown>[]).map((b) => ({
    id: String(b.id),
    name: String(b.name),
    detail: String(b.detail),
    earned: Boolean(b.earned),
    progress: num(b.progress) ?? 0,
    target: num(b.target) ?? 1,
  }));
}

/** Full owner-only export as a JSON-serialisable object. Nothing is published. */
export async function exportTrackerData(): Promise<Record<string, unknown> | null> {
  if (!supabase || !(await ensureBackendSessionToken())) return null;
  const { data, error } = await supabase.rpc('tracker_export');
  if (error || !data || typeof data !== 'object') return null;
  return data as Record<string, unknown>;
}


export interface ImportMatch extends ImportRow {
  titleId: string | null;
}

/** Matches rows to tracked titles by exact title and year. Never writes. */
export async function matchImportRows(rows: ImportRow[]): Promise<ImportMatch[] | null> {
  if (!supabase || !(await ensureBackendSessionToken())) return null;
  const out: ImportMatch[] = [];
  for (let start = 0; start < rows.length; start += 500) {
    const chunk = rows.slice(start, start + 500);
    const { data, error } = await supabase.rpc('tracker_import_match', {
      p_items: chunk.map((r) => ({ title: r.title, year: r.year })),
    });
    if (error || !data || typeof data !== 'object') return null;
    const results = Array.isArray((data as Record<string, unknown>).results)
      ? ((data as Record<string, unknown>).results as Record<string, unknown>[])
      : [];
    chunk.forEach((row, i) => {
      const found = results.find((x) => num(x.index) === i);
      out.push({ ...row, titleId: found && found.matched ? String(found.title_id) : null });
    });
  }
  return out;
}

export interface ImportResult {
  inserted: number;
  duplicates: number;
  rejected: number;
  /** Each rejected row, identified by its title and date, with the server's reason. */
  rejections: { index: number; title: string; watchedOn: string; reason: string }[];
}

/**
 * Writes matched rows in batches of 500. Duplicates are skipped by the server; every rejected row
 * comes back with its reason so the member can see what did not import.
 */
export async function importMatchedRows(matches: ImportMatch[]): Promise<ImportResult | { error: string }> {
  if (!supabase || !(await ensureBackendSessionToken())) return { error: 'Sign in to import.' };
  const sendable = matches.filter((m) => m.titleId);
  const payload = sendable.map((m) => ({ title_id: m.titleId, watched_on: m.watchedOn, rating: m.rating }));
  const result: ImportResult = { inserted: 0, duplicates: 0, rejected: 0, rejections: [] };
  for (let start = 0; start < payload.length; start += 500) {
    const { data, error } = await supabase.rpc('log_watch_batch', { p_rows: payload.slice(start, start + 500) });
    if (error || !data || typeof data !== 'object') return { error: error?.message ?? 'The import did not complete. Nothing after this point was saved.' };
    const r = data as Record<string, unknown>;
    result.inserted += num(r.inserted) ?? 0;
    result.duplicates += num(r.duplicates) ?? 0;
    const rejected = Array.isArray(r.rejected) ? (r.rejected as Record<string, unknown>[]) : [];
    result.rejected += rejected.length;
    for (const row of rejected) {
      const globalIndex = start + (num(row.index) ?? 0);
      const source = sendable[globalIndex];
      result.rejections.push({
        index: globalIndex,
        title: source?.title ?? 'Unknown title',
        watchedOn: source?.watchedOn ?? '',
        reason: String(row.reason ?? ''),
      });
    }
  }
  return result;
}

export interface AdminTrackerOverview {
  perDayLast14: { day: string; entries: number }[];
  membersLogging30: number;
  entriesTotal: number;
  shelfBooksTotal: number;
  streakDistribution: Record<string, number>;
}

/** Staff-only aggregate view. Returns null for non-staff; no member diary is exposed. */
export async function fetchAdminTrackerOverview(): Promise<AdminTrackerOverview | null> {
  if (!supabase || !(await ensureBackendSessionToken())) return null;
  const { data, error } = await supabase.rpc('admin_tracker_overview');
  if (error || !data || typeof data !== 'object') return null;
  const r = data as Record<string, unknown>;
  const perDay = Array.isArray(r.per_day_last_14) ? (r.per_day_last_14 as Record<string, unknown>[]) : [];
  const buckets = (r.streak_distribution && typeof r.streak_distribution === 'object'
    ? r.streak_distribution
    : {}) as Record<string, unknown>;
  return {
    perDayLast14: perDay.map((d) => ({ day: String(d.day), entries: num(d.entries) ?? 0 })),
    membersLogging30: num(r.members_logging_last_30) ?? 0,
    entriesTotal: num(r.entries_total) ?? 0,
    shelfBooksTotal: num(r.shelf_books_total) ?? 0,
    streakDistribution: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, num(v) ?? 0])),
  };
}
