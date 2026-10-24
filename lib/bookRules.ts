/**
 * Pure rules for the Book Tracker: shelves, progress, manual book drafts, search state and
 * details patches. No React Native or network imports, so the same rules are unit-tested under
 * plain Node (scripts/test-book-diary.mjs) and enforced in the UI before a request is sent.
 * The database enforces the same limits again (migrations 52 and 54).
 */

export const MAX_PAGES = 20000;
export const MAX_PAGES_PER_LOG = 2000;
export const MAX_NOTE = 280;
export const MAX_TITLE = 300;
export const MAX_AUTHORS = 10;

export type ShelfId = 'want' | 'reading' | 'finished' | 'dropped';

export const SHELF_ORDER: ShelfId[] = ['want', 'reading', 'finished', 'dropped'];

export const SHELF_LABELS: Record<ShelfId, string> = {
  want: 'Want to read',
  reading: 'Reading',
  finished: 'Finished',
  dropped: 'Dropped',
};

/** The page count the member should see: their own override first, then the catalogue value. */
export function effectiveTotal(book: { pageCount: number | null; totalPagesOverride?: number | null }): number | null {
  if (typeof book.totalPagesOverride === 'number' && book.totalPagesOverride > 0) return book.totalPagesOverride;
  if (typeof book.pageCount === 'number' && book.pageCount > 0) return book.pageCount;
  return null;
}

/** Progress as a whole percentage, or null when the book length is unknown (never invented). */
export function progressPercent(current: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  const pct = Math.round((Math.min(Math.max(current, 0), total) / total) * 100);
  return Math.max(0, Math.min(100, pct));
}

export type ParseResult = { ok: true; value: number } | { ok: false; message: string };

/** A bookmark page: whole number, never negative, never past the known length. */
export function parseProgress(text: string, total: number | null): ParseResult {
  const t = text.trim();
  if (t === '') return { ok: false, message: 'Enter the page you are on.' };
  if (!/^\d+$/.test(t)) return { ok: false, message: 'Use whole numbers only.' };
  const n = Number(t);
  if (n > MAX_PAGES) return { ok: false, message: `Pages must be ${MAX_PAGES.toLocaleString()} or fewer.` };
  if (total !== null && n > total) return { ok: false, message: `This book has ${total} pages.` };
  return { ok: true, value: n };
}

/** Pages read in one log: 1 to 2000, whole number. */
export function parsePagesRead(text: string): ParseResult {
  const t = text.trim();
  if (t === '') return { ok: false, message: 'Enter how many pages you read.' };
  if (!/^\d+$/.test(t)) return { ok: false, message: 'Use whole numbers only.' };
  const n = Number(t);
  if (n < 1) return { ok: false, message: 'Enter at least 1 page.' };
  if (n > MAX_PAGES_PER_LOG) return { ok: false, message: `One log can hold at most ${MAX_PAGES_PER_LOG} pages.` };
  return { ok: true, value: n };
}

/** Accepts a total page count for a book (1 to 20000). Blank means "unknown". */
export function parseTotalPages(text: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  if (!/^\d+$/.test(t)) return { ok: false, message: 'Use whole numbers only.' };
  const n = Number(t);
  if (n < 1 || n > MAX_PAGES) return { ok: false, message: `Pages must be between 1 and ${MAX_PAGES.toLocaleString()}.` };
  return { ok: true, value: n };
}

/** Star rating: blank clears it, otherwise a whole number 1 to 5. */
export function parseRating(value: number | null): number | null {
  if (value === null) return null;
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

/** Authors typed as one line: split on commas, semicolons or new lines. Max 10, each up to 200 chars. */
export function parseAuthors(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((a) => a.trim().slice(0, 200))
    .filter((a) => a.length > 0)
    .slice(0, MAX_AUTHORS);
}

/** ISBN-10 or ISBN-13 digits (hyphens and spaces stripped). Blank is allowed. */
export function cleanIsbn(text: string): { ok: true; value: string | null } | { ok: false; message: string } {
  const digits = text.replace(/[^0-9Xx]/g, '');
  if (digits === '') return { ok: true, value: null };
  if (digits.length !== 10 && digits.length !== 13) return { ok: false, message: 'An ISBN has 10 or 13 digits.' };
  return { ok: true, value: digits.toUpperCase() };
}

/** Calendar date check for YYYY-MM-DD, rejecting impossible dates such as 2026-02-30. */
export function isValidDateKey(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export interface ManualBookDraft {
  title: string;
  authors: string;
  year: string;
  pages: string;
  coverUrl: string;
  isbn: string;
  notes: string;
}

export interface ManualBookValue {
  title: string;
  authors: string[];
  firstPublishYear: number | null;
  pageCount: number | null;
  coverUrl: string | null;
  isbn13: string | null;
  note: string | null;
}

/**
 * Validates a manual book before anything is sent. Only the title is required; every other field
 * is optional and blank means "not known". Returns per-field messages for the form.
 */
export function validateManualBook(
  draft: ManualBookDraft,
  currentYear: number,
): { ok: true; value: ManualBookValue } | { ok: false; errors: Partial<Record<keyof ManualBookDraft, string>> } {
  const errors: Partial<Record<keyof ManualBookDraft, string>> = {};
  const title = draft.title.trim();
  if (title.length === 0) errors.title = 'A title is required.';
  else if (title.length > MAX_TITLE) errors.title = `Titles can be ${MAX_TITLE} characters or fewer.`;

  let year: number | null = null;
  const yt = draft.year.trim();
  if (yt !== '') {
    if (!/^\d{1,4}$/.test(yt) || Number(yt) > currentYear + 1) errors.year = `Enter a year up to ${currentYear + 1}.`;
    else year = Number(yt);
  }

  let pages: number | null = null;
  const pt = parseTotalPages(draft.pages);
  if (!pt.ok) errors.pages = pt.message;
  else pages = pt.value;

  let cover: string | null = null;
  const ct = draft.coverUrl.trim();
  if (ct !== '') {
    if (!/^https:\/\/\S+$/.test(ct)) errors.coverUrl = 'Use a secure link that starts with https://';
    else cover = ct;
  }

  let isbn: string | null = null;
  const it = cleanIsbn(draft.isbn);
  if (!it.ok) errors.isbn = it.message;
  else isbn = it.value;

  const note = draft.notes.trim();
  if (note.length > MAX_NOTE) errors.notes = `Notes can be ${MAX_NOTE} characters or fewer.`;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      title,
      authors: parseAuthors(draft.authors),
      firstPublishYear: year,
      pageCount: pages,
      coverUrl: cover,
      isbn13: isbn,
      note: note.length > 0 ? note : null,
    },
  };
}

export type SearchState = 'idle' | 'short' | 'loading' | 'error' | 'empty' | 'results';

/** Which message the search area shows. Errors are never shown as "no results". */
export function searchState(args: { query: string; loading: boolean; error: string | null; hitCount: number }): SearchState {
  if (args.query.trim().length === 0) return 'idle';
  if (args.query.trim().length < 2) return 'short';
  if (args.loading) return 'loading';
  if (args.error) return 'error';
  return args.hitCount === 0 ? 'empty' : 'results';
}

/**
 * A key for one submission attempt. The UI keeps the same key while a request is retrying and
 * makes a new one only after the server confirms, so a double tap cannot add a second log.
 */
export function makeClientKey(prefix: string, now: number = Date.now(), rand: () => number = Math.random): string {
  const stamp = now.toString(36);
  const salt = Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0');
  return `${prefix}-${stamp}-${salt}`.slice(0, 120);
}

export interface DetailsState {
  rating: number | null;
  note: string | null;
  startedOn: string | null;
  finishedOn: string | null;
  totalPages: number | null;
}

/**
 * Builds a patch containing only the fields that changed, so the server never overwrites a field
 * the member did not touch. Null means "clear".
 */
export function detailsPatch(before: DetailsState, after: DetailsState): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (after.rating !== before.rating) patch.rating = after.rating;
  if ((after.note ?? null) !== (before.note ?? null)) patch.note = after.note ?? '';
  if (after.startedOn !== before.startedOn) patch.started_on = after.startedOn;
  if (after.finishedOn !== before.finishedOn) patch.finished_on = after.finishedOn;
  if (after.totalPages !== before.totalPages) patch.total_pages = after.totalPages;
  return patch;
}
