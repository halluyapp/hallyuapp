/**
 * Pure rules for the Viewing Diary: day grouping, page merging, labels, runtime coverage and
 * import rejection summaries. No React Native or network imports (tested under plain Node).
 */

export interface DiaryCursor {
  watchedOn: string;
  watchedAt: string;
  id: string;
}

export interface DayGroup<T> {
  /** Member-local calendar day, YYYY-MM-DD. Unique per group. */
  key: string;
  items: T[];
}

/**
 * Groups entries by their calendar day, newest day first. Entries arrive sorted by the server; the
 * grouping still merges any later run of a day already seen, so every key is unique and no entry
 * is shown twice.
 */
export function groupByDay<T extends { id: string; watchedOn: string }>(entries: T[]): DayGroup<T>[] {
  const order: string[] = [];
  const buckets = new Map<string, T[]>();
  const seenIds = new Set<string>();
  for (const e of entries) {
    if (seenIds.has(e.id)) continue;
    seenIds.add(e.id);
    let bucket = buckets.get(e.watchedOn);
    if (!bucket) {
      bucket = [];
      buckets.set(e.watchedOn, bucket);
      order.push(e.watchedOn);
    }
    bucket.push(e);
  }
  return order.map((key) => ({ key, items: buckets.get(key) ?? [] }));
}

/** Appends a newer-to-older page to what is already shown, dropping any id already present. */
export function mergePages<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const seen = new Set(existing.map((e) => e.id));
  const out = [...existing];
  for (const e of incoming) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

export function isValidDayKey(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Shifts a YYYY-MM-DD key by whole days using calendar arithmetic (no time zone involved). */
export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** "Today", "Yesterday", or a short date. `todayKey` is the member's local day. */
export function dayLabel(key: string, todayKey: string): string {
  if (key === todayKey) return 'Today';
  if (key === addDays(todayKey, -1)) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Honest runtime line. Minutes only count entries whose runtime is known, so the line says how
 * many entries were counted and never presents a partial total as complete.
 */
export function runtimeCoverageLine(known: number, unknown: number): string | null {
  const total = known + unknown;
  if (total === 0) return null;
  if (unknown === 0) return 'Runtime known for every entry.';
  return `Runtime known for ${known} of ${total} entries. Minutes count only those.`;
}

export interface RejectedRow {
  index: number;
  reason: string;
}

export interface RejectionSummary {
  reason: string;
  count: number;
  /** 1-based row numbers, at most 5 shown. */
  rows: number[];
}

/** Groups import rejections by reason so the member sees what went wrong and where. */
export function summarizeRejections(rejected: RejectedRow[]): RejectionSummary[] {
  const map = new Map<string, RejectionSummary>();
  for (const r of rejected) {
    const reason = r.reason.trim() || 'Row could not be imported';
    const existing = map.get(reason) ?? { reason, count: 0, rows: [] };
    existing.count += 1;
    if (existing.rows.length < 5) existing.rows.push(r.index + 1);
    map.set(reason, existing);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** Readable form of a server reason. Keeps database messages short for a member. */
export function friendlyImportReason(reason: string): string {
  if (/does not exist/i.test(reason)) return 'That title is not in the catalogue.';
  if (/daily diary limit/i.test(reason)) return 'More than 60 entries for one day. Extra rows were skipped.';
  if (/already in your diary/i.test(reason)) return 'That title is already in your diary for that day.';
  if (/cannot be in the future/i.test(reason)) return 'The date is in the future.';
  if (/too far in the past/i.test(reason)) return 'The date is more than 10 years ago.';
  if (/rating must be/i.test(reason)) return 'The rating must be between 1 and 5.';
  return reason;
}
