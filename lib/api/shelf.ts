/**
 * Book Shelf & Reading Log API (Migrations 52 and 54).
 * Book search goes to Open Library (free, no key) and is optional: members can always add a book
 * by hand. Everything a member owns (shelf, bookmark, reading log, manual books) is written through
 * owner-only RPCs and is private by default.
 */
import { ensureBackendSessionToken, supabase } from './client';
import type { ShelfId } from '../bookRules';
import { effectiveTotal } from '../bookRules';

export type ShelfName = ShelfId;

export interface ShelfBook {
  bookId: string;
  externalId: string;
  source: 'openlibrary' | 'manual';
  isManual: boolean;
  title: string;
  authors: string[];
  coverUrl: string | null;
  /** Length from the catalogue (Open Library or the member's manual entry). */
  pageCount: number | null;
  /** The member's own page count for an Open Library book, when they set one. */
  totalPagesOverride: number | null;
  /** The length the app should use: override first, then the catalogue. Null when unknown. */
  totalPages: number | null;
  firstPublishYear: number | null;
  shelf: ShelfName;
  currentPage: number;
  rating: number | null;
  note: string | null;
  startedOn: string | null;
  finishedOn: string | null;
  updatedAt: string;
}

export interface ShelfPage {
  year: number;
  books: ShelfBook[];
  pagesReadYear: number;
  finishedYear: number;
}

export interface BookSearchHit {
  externalId: string;
  title: string;
  authors: string[];
  firstPublishYear: number | null;
  pageCount: number | null;
  coverUrl: string | null;
  isbn13: string | null;
}

export type BookSearchResult =
  | { ok: true; hits: BookSearchHit[] }
  | { ok: false; error: 'timeout' | 'network' | 'service' };

export interface ReadingLog {
  id: string;
  readOn: string;
  pages: number;
  createdAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type ActionResult<T extends object = {}> = ({ ok: true } & T) | { ok: false; error: string };

const OPEN_LIBRARY = 'https://openlibrary.org';
const SEARCH_TIMEOUT_MS = 8000;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function normalizeShelfBook(raw: Record<string, unknown>): ShelfBook {
  const authors = Array.isArray(raw.authors) ? raw.authors.map(String) : [];
  const source = raw.source === 'manual' ? 'manual' : 'openlibrary';
  const pageCount = num(raw.page_count);
  const override = num(raw.total_pages_override);
  const totalPages = num(raw.total_pages) ?? effectiveTotal({ pageCount, totalPagesOverride: override });
  return {
    bookId: String(raw.book_id ?? ''),
    externalId: String(raw.external_id ?? ''),
    source,
    isManual: source === 'manual',
    title: String(raw.title ?? 'Untitled'),
    authors,
    coverUrl: str(raw.cover_url),
    pageCount,
    totalPagesOverride: override,
    totalPages,
    firstPublishYear: num(raw.first_publish_year),
    shelf: (raw.shelf as ShelfName) ?? 'want',
    currentPage: num(raw.current_page) ?? 0,
    rating: num(raw.rating),
    note: str(raw.note),
    startedOn: str(raw.started_on),
    finishedOn: str(raw.finished_on),
    updatedAt: String(raw.updated_at ?? ''),
  };
}

/** Shelf page for a calendar year. Pass the member's local year so the totals match their calendar. */
export async function fetchShelf(year: number): Promise<ShelfPage | null> {
  if (!supabase || !(await ensureBackendSessionToken())) return null;
  const { data, error } = await supabase.rpc('shelf_page', { p_year: year });
  if (error || !data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const books = Array.isArray(raw.books) ? (raw.books as Record<string, unknown>[]).map(normalizeShelfBook) : [];
  return {
    year: num(raw.year) ?? year,
    books,
    pagesReadYear: num(raw.pages_read_year) ?? 0,
    finishedYear: num(raw.finished_year) ?? 0,
  };
}

export async function addBookToShelf(hit: BookSearchHit, shelf: ShelfName = 'want'): Promise<ActionResult<{ bookId: string }>> {
  if (!supabase) return { ok: false, error: 'offline' };
  if (!(await ensureBackendSessionToken())) return { ok: false, error: 'signed_out' };
  const { data, error } = await supabase.rpc('shelf_add_book', {
    p_external_id: hit.externalId,
    p_title: hit.title,
    p_authors: hit.authors,
    p_first_publish_year: hit.firstPublishYear,
    p_page_count: hit.pageCount,
    p_cover_url: hit.coverUrl,
    p_isbn13: hit.isbn13,
    p_shelf: shelf,
    p_source: 'openlibrary',
  });
  if (error || typeof data !== 'string') return { ok: false, error: error?.message ?? 'Could not add that book.' };
  return { ok: true, bookId: data };
}

export interface ManualBookInput {
  title: string;
  authors: string[];
  firstPublishYear: number | null;
  pageCount: number | null;
  coverUrl: string | null;
  isbn13: string | null;
  note: string | null;
}

/** Adds a book that is not in Open Library. Safe to retry with the same clientKey. */
export async function addManualBook(
  input: ManualBookInput,
  shelf: ShelfName,
  clientKey: string,
): Promise<ActionResult<{ bookId: string }>> {
  if (!supabase) return { ok: false, error: 'offline' };
  if (!(await ensureBackendSessionToken())) return { ok: false, error: 'signed_out' };
  const { data, error } = await supabase.rpc('shelf_add_manual_book', {
    p_client_key: clientKey,
    p_title: input.title,
    p_authors: input.authors,
    p_first_publish_year: input.firstPublishYear,
    p_page_count: input.pageCount,
    p_cover_url: input.coverUrl,
    p_isbn13: input.isbn13,
    p_shelf: shelf,
    p_note: input.note,
  });
  if (error || typeof data !== 'string') return { ok: false, error: error?.message ?? 'Could not save that book.' };
  return { ok: true, bookId: data };
}

export async function moveBook(
  bookId: string,
  shelf: ShelfName,
  extras: { rating?: number | null; note?: string | null } = {},
): Promise<ActionResult> {
  if (!supabase) return { ok: false, error: 'offline' };
  if (!(await ensureBackendSessionToken())) return { ok: false, error: 'signed_out' };
  const { data, error } = await supabase.rpc('shelf_move', {
    p_book_id: bookId,
    p_shelf: shelf,
    p_rating: extras.rating ?? null,
    p_note: extras.note ?? null,
  });
  if (error) return { ok: false, error: error.message };
  return data === true ? { ok: true } : { ok: false, error: 'That book is no longer on your shelf.' };
}

/** Partial update of a book's details. Only the keys in `patch` change; null clears a field. */
export async function updateBookDetails(bookId: string, patch: Record<string, unknown>): Promise<ActionResult> {
  if (!supabase) return { ok: false, error: 'offline' };
  if (!(await ensureBackendSessionToken())) return { ok: false, error: 'signed_out' };
  if (Object.keys(patch).length === 0) return { ok: true };
  const { data, error } = await supabase.rpc('shelf_update_details', { p_book_id: bookId, p_patch: patch });
  if (error) return { ok: false, error: error.message };
  return data === true ? { ok: true } : { ok: false, error: 'Nothing was saved.' };
}

/** Correct the bookmark. Does not change pages-read totals (those come from logged reading). */
export async function setBookProgress(
  bookId: string,
  page: number,
): Promise<ActionResult<{ shelf: ShelfName; currentPage: number }>> {
  if (!supabase) return { ok: false, error: 'offline' };
  if (!(await ensureBackendSessionToken())) return { ok: false, error: 'signed_out' };
  const { data, error } = await supabase.rpc('shelf_set_progress', { p_book_id: bookId, p_page: page });
  if (error) return { ok: false, error: error.message };
  const raw = (data ?? {}) as Record<string, unknown>;
  return { ok: true, shelf: (raw.shelf as ShelfName) ?? 'reading', currentPage: num(raw.current_page) ?? page };
}

export type LogPagesResult =
  | { ok: true; finished: boolean; duplicate: boolean; pagesApplied: number; currentPage: number }
  | { ok: false; error: string };

/** One dated reading entry. Retrying with the same clientKey is a no-op. */
export async function logPages(
  bookId: string,
  pages: number,
  readOn: string,
  clientKey: string,
): Promise<LogPagesResult> {
  if (!supabase) return { ok: false, error: 'offline' };
  if (!(await ensureBackendSessionToken())) return { ok: false, error: 'signed_out' };
  const { data, error } = await supabase.rpc('log_reading', {
    p_book_id: bookId,
    p_read_on: readOn,
    p_pages: pages,
    p_client_key: clientKey,
  });
  if (error) return { ok: false, error: error.message };
  const raw = (data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    finished: Boolean(raw.finished),
    duplicate: Boolean(raw.duplicate),
    pagesApplied: num(raw.pages_applied) ?? 0,
    currentPage: num(raw.current_page) ?? 0,
  };
}

export async function fetchBookLogs(bookId: string): Promise<ReadingLog[] | null> {
  if (!supabase || !(await ensureBackendSessionToken())) return null;
  const { data, error } = await supabase.rpc('shelf_book_logs', { p_book_id: bookId });
  if (error || !Array.isArray(data)) return null;
  return (data as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    readOn: String(r.read_on),
    pages: num(r.pages) ?? 0,
    createdAt: String(r.created_at ?? ''),
  }));
}

/** Deletes one reading entry and lowers the bookmark by the same pages. */
export async function deleteReadingLog(logId: string): Promise<ActionResult<{ currentPage: number | null }>> {
  if (!supabase) return { ok: false, error: 'offline' };
  if (!(await ensureBackendSessionToken())) return { ok: false, error: 'signed_out' };
  const { data, error } = await supabase.rpc('shelf_delete_reading_log', { p_log_id: logId });
  if (error) return { ok: false, error: error.message };
  const raw = (data ?? {}) as Record<string, unknown>;
  if (raw.removed !== true) return { ok: false, error: 'That entry was already removed.' };
  return { ok: true, currentPage: num(raw.current_page) };
}

export async function removeFromShelf(bookId: string): Promise<ActionResult> {
  if (!supabase) return { ok: false, error: 'offline' };
  if (!(await ensureBackendSessionToken())) return { ok: false, error: 'signed_out' };
  const { data, error } = await supabase.rpc('shelf_remove', { p_book_id: bookId });
  if (error) return { ok: false, error: error.message };
  return data === true ? { ok: true } : { ok: false, error: 'That book is no longer on your shelf.' };
}

/** Open Library title search with a timeout. Failures are reported, never shown as "no results". */
export async function searchBooks(query: string, limit = 12): Promise<BookSearchResult> {
  const q = query.trim();
  if (q.length < 2) return { ok: true, hits: [] };
  const url =
    `${OPEN_LIBRARY}/search.json?q=${encodeURIComponent(q)}&limit=${limit}` +
    '&fields=key,title,author_name,first_publish_year,number_of_pages_median,isbn,cover_i';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: 'service' };
    const json = (await res.json()) as { docs?: Record<string, unknown>[] };
    const hits = (json.docs ?? [])
      .filter((d) => typeof d.key === 'string' && typeof d.title === 'string')
      .map((d) => {
        const isbns = Array.isArray(d.isbn) ? (d.isbn as unknown[]).map(String) : [];
        const isbn13 = isbns.find((i) => i.length === 13) ?? null;
        const coverId = num(d.cover_i);
        return {
          externalId: String(d.key).replace(/^\/works\//, ''),
          title: String(d.title),
          authors: Array.isArray(d.author_name) ? (d.author_name as unknown[]).map(String) : [],
          firstPublishYear: num(d.first_publish_year),
          pageCount: num(d.number_of_pages_median),
          coverUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : null,
          isbn13,
        };
      });
    return { ok: true, hits };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return { ok: false, error: aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
