/**
 * Book Shelf & Reading Log API (Migration 52).
 * Book search goes to Open Library (free, no key). Everything a member owns — the shelf, the
 * bookmark, the reading log — is written through owner-only RPCs and is private by default.
 */
import { ensureBackendSessionToken, supabase } from './client';

export type ShelfName = 'want' | 'reading' | 'finished' | 'dropped';

export interface ShelfBook {
  bookId: string;
  externalId: string;
  title: string;
  authors: string[];
  coverUrl: string | null;
  pageCount: number | null;
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

const OPEN_LIBRARY = 'https://openlibrary.org';

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function normalizeShelfBook(raw: Record<string, unknown>): ShelfBook {
  const authors = Array.isArray(raw.authors) ? raw.authors.map(String) : [];
  return {
    bookId: String(raw.book_id ?? ''),
    externalId: String(raw.external_id ?? ''),
    title: String(raw.title ?? 'Untitled'),
    authors,
    coverUrl: str(raw.cover_url),
    pageCount: num(raw.page_count),
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

export async function fetchShelf(year?: number): Promise<ShelfPage | null> {
  if (!supabase || !(await ensureBackendSessionToken())) return null;
  const { data, error } = await supabase.rpc('shelf_page', { p_year: year ?? null });
  if (error || !data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const books = Array.isArray(raw.books) ? (raw.books as Record<string, unknown>[]).map(normalizeShelfBook) : [];
  return {
    year: num(raw.year) ?? new Date().getFullYear(),
    books,
    pagesReadYear: num(raw.pages_read_year) ?? 0,
    finishedYear: num(raw.finished_year) ?? 0,
  };
}

export async function addBookToShelf(hit: BookSearchHit, shelf: ShelfName = 'want'): Promise<string | null> {
  if (!supabase || !(await ensureBackendSessionToken())) return null;
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
  if (error || typeof data !== 'string') return null;
  return data;
}

export async function moveBook(
  bookId: string,
  shelf: ShelfName,
  extras: { rating?: number | null; note?: string | null } = {},
): Promise<boolean> {
  if (!supabase || !(await ensureBackendSessionToken())) return false;
  const { data, error } = await supabase.rpc('shelf_move', {
    p_book_id: bookId,
    p_shelf: shelf,
    p_rating: extras.rating ?? null,
    p_note: extras.note ?? null,
  });
  return !error && data === true;
}

export async function logPages(
  bookId: string,
  pages: number,
  readOn: string,
  clientKey: string,
): Promise<{ ok: true; finished: boolean } | { ok: false; error: string }> {
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
  return { ok: true, finished: Boolean(raw.finished) };
}

export async function removeFromShelf(bookId: string): Promise<boolean> {
  if (!supabase || !(await ensureBackendSessionToken())) return false;
  const { data, error } = await supabase.rpc('shelf_remove', { p_book_id: bookId });
  return !error && data === true;
}

/** Open Library title search. Returns at most `limit` editions-as-works. */
export async function searchBooks(query: string, limit = 12): Promise<BookSearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const url =
    `${OPEN_LIBRARY}/search.json?q=${encodeURIComponent(q)}&limit=${limit}` +
    '&fields=key,title,author_name,first_publish_year,number_of_pages_median,isbn,cover_i';
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = (await res.json()) as { docs?: Record<string, unknown>[] };
    return (json.docs ?? [])
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
  } catch {
    return [];
  }
}
