import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { BookShelfSvg } from '../components/shelf/BookShelfSvg';
import { Button } from '../components/ui/Button';
import { Chip, ChipRow } from '../components/ui/Chip';
import { Dialog } from '../components/ui/Dialog';
import { Screen } from '../components/ui/Screen';
import { EmptyState } from '../components/ui/States';
import { Text } from '../components/ui/Text';
import { TextField } from '../components/ui/TextField';
import { useToast } from '../components/ui/Toast';
import { TopBar } from '../components/ui/TopBar';
import { colors, radius, space } from '../constants/theme';
import { useAuth } from '../lib/auth';
import { localDateKey } from '../lib/api/tracker';
import {
  addBookToShelf,
  addManualBook,
  BookSearchHit,
  deleteReadingLog,
  fetchBookLogs,
  fetchShelf,
  logPages,
  moveBook,
  ReadingLog,
  removeFromShelf,
  searchBooks,
  setBookProgress,
  ShelfBook,
  ShelfName,
  ShelfPage,
  updateBookDetails,
} from '../lib/api/shelf';
import {
  cleanIsbn,
  detailsPatch,
  DetailsState,
  effectiveTotal,
  isValidDateKey,
  makeClientKey,
  ManualBookDraft,
  parseAuthors,
  parsePagesRead,
  parseProgress,
  parseRating,
  parseTotalPages,
  progressPercent,
  searchState,
  SHELF_LABELS,
  SHELF_ORDER,
  validateManualBook,
} from '../lib/bookRules';
import { haptic } from '../lib/hooks';

const SPINE_COLORS = ['#7C2D12', '#1E3A5F', '#14532D', '#4C1D95', '#831843', '#713F12', '#0F3D3E', '#3F3F46'];

function spineColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return SPINE_COLORS[h % SPINE_COLORS.length];
}

/** Spine width follows the known page count; unknown length gets a neutral width, never a guess. */
function spineWidth(pages: number | null): number {
  if (!pages) return 22;
  return Math.max(14, Math.min(44, Math.round(pages / 22)));
}

const EMPTY_MANUAL: ManualBookDraft = { title: '', authors: '', year: '', pages: '', coverUrl: '', isbn: '', notes: '' };

/** Shelf — your books on four shelves. Search Open Library, or add a book by hand. */
export default function Shelf() {
  const router = useRouter();
  const toast = useToast();
  const auth = useAuth();
  const year = new Date().getFullYear();
  const [page, setPage] = useState<ShelfPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<BookSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<'timeout' | 'network' | 'service' | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualDraft, setManualDraft] = useState<ManualBookDraft>(EMPTY_MANUAL);
  const [manualShelf, setManualShelf] = useState<ShelfName>('want');
  const [manualErrors, setManualErrors] = useState<Partial<Record<keyof ManualBookDraft, string>>>({});
  const [manualSaving, setManualSaving] = useState(false);
  const manualKey = useRef<string>(makeClientKey('manual'));
  const searchSeq = useRef(0);

  const load = useCallback(async () => {
    const next = await fetchShelf(year);
    setFailed(!next);
    if (next) setPage(next);
  }, [year]);

  useEffect(() => {
    if (auth.status !== 'signedIn') {
      setLoading(false);
      return;
    }
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [auth.status, load]);

  // Debounced Open Library search. Errors are shown as errors, never as "no books found".
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setSearching(false);
      setSearchError(null);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      searchBooks(q).then((result) => {
        if (seq !== searchSeq.current) return;
        setSearching(false);
        if (result.ok) {
          setHits(result.hits);
          setSearchError(null);
        } else {
          setHits([]);
          setSearchError(result.error);
        }
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [query, retryTick]);

  const books = useMemo(() => page?.books ?? [], [page]);
  const selected = useMemo(() => books.find((b) => b.bookId === selectedId) ?? null, [books, selectedId]);
  const onShelf = useMemo(() => new Set(books.map((b) => b.externalId)), [books]);
  const state = searchState({ query, loading: searching, error: searchError, hitCount: hits.length });

  const addHit = async (hit: BookSearchHit) => {
    if (onShelf.has(hit.externalId)) {
      const existing = books.find((b) => b.externalId === hit.externalId);
      if (existing) setSelectedId(existing.bookId);
      toast.show({ message: 'That book is already on your shelf', tone: 'default' });
      return;
    }
    haptic.light();
    const result = await addBookToShelf(hit, 'want');
    if (!result.ok) {
      toast.show({ message: result.error || 'Could not add that book. Try again.', tone: 'danger' });
      return;
    }
    toast.show({ message: `${hit.title} added to Want to read`, tone: 'success' });
    setQuery('');
    setHits([]);
    await load();
    setSelectedId(result.bookId);
  };

  const submitManual = async () => {
    if (manualSaving) return;
    const checked = validateManualBook(manualDraft, year);
    if (!checked.ok) {
      setManualErrors(checked.errors);
      return;
    }
    setManualErrors({});
    setManualSaving(true);
    haptic.light();
    const result = await addManualBook(checked.value, manualShelf, manualKey.current);
    setManualSaving(false);
    if (!result.ok) {
      toast.show({ message: result.error, tone: 'danger' });
      return;
    }
    // Only a confirmed save gets a fresh key; a failed save keeps the key so a retry cannot duplicate.
    manualKey.current = makeClientKey('manual');
    toast.show({ message: `${checked.value.title} added`, tone: 'success' });
    setManualDraft(EMPTY_MANUAL);
    setManualOpen(false);
    await load();
    setSelectedId(result.bookId);
  };

  const header = <TopBar mode="stack" title="Book shelf" onBack={() => router.back()} />;

  if (auth.status !== 'signedIn') {
    return (
      <Screen header={header}>
        <EmptyState icon="library-outline" title="Sign in to build your shelf" body="Your shelf and reading log are private to you." />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <TextField
          leading="search-outline"
          value={query}
          onChangeText={setQuery}
          placeholder="Search Open Library"
          accessibilityLabel="Search books"
          returnKeyType="search"
          containerStyle={styles.searchBox}
        />

        {state === 'short' ? <Text variant="caption" tone="tertiary">Type at least 2 letters to search.</Text> : null}
        {state === 'loading' ? <Text variant="caption" tone="tertiary">Searching Open Library…</Text> : null}
        {state === 'error' ? (
          <View style={styles.notice}>
            <Text variant="body" tone="danger">
              {searchError === 'timeout'
                ? 'Open Library took too long to answer.'
                : 'Open Library could not be reached.'}
            </Text>
            <Text variant="caption" tone="secondary">This is not a "no results" answer. You can retry or add the book by hand.</Text>
            <View style={styles.moveRow}>
              <Button label="Retry search" size="sm" variant="secondary" onPress={() => setRetryTick((t) => t + 1)} />
              <Button label="Add by hand" size="sm" variant="ghost" onPress={() => setManualOpen(true)} />
            </View>
          </View>
        ) : null}
        {state === 'empty' ? (
          <View style={styles.notice}>
            <Text variant="body" tone="secondary">No books matched "{query.trim()}".</Text>
            <Button label="Add it by hand" size="sm" variant="secondary" onPress={() => setManualOpen(true)} />
          </View>
        ) : null}

        {state === 'results' ? (
          <View style={styles.hits}>
            {hits.map((hit) => {
              const have = onShelf.has(hit.externalId);
              return (
                <Pressable
                  key={hit.externalId}
                  onPress={() => addHit(hit)}
                  accessibilityRole="button"
                  accessibilityLabel={`${have ? 'Open' : 'Add'} ${hit.title}`}
                  style={styles.hit}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="body" numberOfLines={1}>{hit.title}</Text>
                    <Text variant="caption" tone="secondary" numberOfLines={1}>
                      {hit.authors.slice(0, 2).join(', ') || 'Unknown author'}
                      {hit.firstPublishYear ? ` · ${hit.firstPublishYear}` : ''}
                      {hit.pageCount ? ` · ${hit.pageCount} pages` : ' · length unknown'}
                    </Text>
                  </View>
                  <Text variant="caption" tone="tertiary">{have ? 'On shelf' : ''}</Text>
                  <Ionicons name={have ? 'checkmark-circle-outline' : 'add-circle-outline'} size={22} color={colors.textPrimary} />
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {query.trim().length < 2 ? (
          <Pressable onPress={() => setManualOpen((v) => !v)} accessibilityRole="button" style={styles.manualToggle}>
            <Ionicons name="create-outline" size={18} color={colors.textSecondary} />
            <Text variant="body" tone="secondary">{manualOpen ? 'Close manual entry' : 'Add a book by hand'}</Text>
          </Pressable>
        ) : null}

        {manualOpen ? (
          <View style={styles.panel}>
            <Text variant="headline">New book</Text>
            <Text variant="caption" tone="tertiary">Only the title is required. Everything else is optional and stays private to you.</Text>
            <ManualForm
              draft={manualDraft}
              errors={manualErrors}
              onChange={(next) => setManualDraft(next)}
            />
            <Text variant="label" tone="secondary">Put it on</Text>
            <ChipRow>
              {SHELF_ORDER.map((s) => (
                <Chip key={s} label={SHELF_LABELS[s]} selected={manualShelf === s} onPress={() => setManualShelf(s)} size="sm" accessibilityLabel={`Put on ${SHELF_LABELS[s]}`} />
              ))}
            </ChipRow>
            <View style={styles.moveRow}>
              <Button label="Cancel" variant="ghost" size="sm" onPress={() => setManualOpen(false)} disabled={manualSaving} />
              <Button label={manualSaving ? 'Saving…' : 'Save book'} size="sm" onPress={submitManual} disabled={manualSaving} />
            </View>
          </View>
        ) : null}

        {!loading && failed ? (
          <EmptyState icon="cloud-offline-outline" title="Shelf unavailable" body="We could not load your shelf. Check your connection and try again." />
        ) : null}

        {!loading && !failed && books.length === 0 ? (
          <EmptyState icon="library-outline" title="Your shelf is empty" body="Search above or add a book by hand to start." />
        ) : null}

        {SHELF_ORDER.map((shelf) => {
          const items = books.filter((b) => b.shelf === shelf);
          return (
            <View key={shelf} style={styles.shelfBlock}>
              <View style={styles.shelfHead}>
                <Text variant="caption" tone="tertiary" style={styles.shelfLabel}>{SHELF_LABELS[shelf]}</Text>
                <Text variant="caption" tone="tertiary">{items.length}</Text>
              </View>
              {items.length ? (
                <BookShelfSvg
                  spines={items.map((b) => ({
                    id: b.bookId,
                    title: b.title,
                    width: spineWidth(b.totalPages),
                    color: spineColor(b.title),
                    selected: selectedId === b.bookId,
                  }))}
                  onPress={(id) => setSelectedId(id)}
                />
              ) : null}
            </View>
          );
        })}

        {selected ? (
          <BookPanel
            key={selected.bookId}
            book={selected}
            year={year}
            onChanged={load}
            onClose={() => setSelectedId(null)}
            onRemoved={async () => {
              setSelectedId(null);
              await load();
            }}
          />
        ) : null}

        {page ? (
          <View style={styles.stats}>
            <Text variant="caption" tone="tertiary">{page.year} so far</Text>
            <Text variant="body">
              {page.pagesReadYear.toLocaleString()} pages read · {page.finishedYear} finished · {books.filter((b) => b.shelf === 'reading').length} in progress
            </Text>
            <Text variant="caption" tone="tertiary">Pages count only when you log them. Moving a bookmark does not add pages.</Text>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function ManualForm({
  draft,
  errors,
  onChange,
}: {
  draft: ManualBookDraft;
  errors: Partial<Record<keyof ManualBookDraft, string>>;
  onChange: (next: ManualBookDraft) => void;
}) {
  const set = (key: keyof ManualBookDraft) => (value: string) => onChange({ ...draft, [key]: value });
  return (
    <View style={{ gap: space.x3 }}>
      <TextField label="Title" value={draft.title} onChangeText={set('title')} error={errors.title} maxLength={300} accessibilityLabel="Book title" />
      <TextField label="Authors" value={draft.authors} onChangeText={set('authors')} hint="Separate names with commas" accessibilityLabel="Authors" />
      <View style={styles.twoUp}>
        <TextField label="Year" value={draft.year} onChangeText={set('year')} keyboardType="number-pad" error={errors.year} containerStyle={{ flex: 1 }} accessibilityLabel="Publication year" />
        <TextField label="Pages" value={draft.pages} onChangeText={set('pages')} keyboardType="number-pad" error={errors.pages} containerStyle={{ flex: 1 }} accessibilityLabel="Page count" />
      </View>
      <TextField label="ISBN" value={draft.isbn} onChangeText={set('isbn')} error={errors.isbn} autoCapitalize="characters" accessibilityLabel="ISBN" />
      <TextField label="Cover image link" value={draft.coverUrl} onChangeText={set('coverUrl')} error={errors.coverUrl} autoCapitalize="none" hint="Optional, must start with https://" accessibilityLabel="Cover image link" />
      <TextField label="Notes" value={draft.notes} onChangeText={set('notes')} counter={280} error={errors.notes} accessibilityLabel="Notes" />
    </View>
  );
}

/** Details, progress, reading log and moves for the selected book. */
function BookPanel({
  book,
  year,
  onChanged,
  onClose,
  onRemoved,
}: {
  book: ShelfBook;
  year: number;
  onChanged: () => Promise<void>;
  onClose: () => void;
  onRemoved: () => Promise<void>;
}) {
  const toast = useToast();
  const total = effectiveTotal({ pageCount: book.pageCount, totalPagesOverride: book.totalPagesOverride });
  const percent = progressPercent(book.currentPage, total);
  const locked = book.shelf === 'finished' || book.shelf === 'dropped';

  const [pagesText, setPagesText] = useState('');
  const [progressText, setProgressText] = useState(String(book.currentPage));
  const [logs, setLogs] = useState<ReadingLog[] | null>(null);
  const [logging, setLogging] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [pendingLog, setPendingLog] = useState<ReadingLog | null>(null);
  const logBusy = useRef(false);
  const logKey = useRef<{ pages: number; day: string; key: string } | null>(null);

  const [editing, setEditing] = useState(false);
  const [rating, setRating] = useState<number | null>(book.rating);
  const [note, setNote] = useState(book.note ?? '');
  const [started, setStarted] = useState(book.startedOn ?? '');
  const [finished, setFinished] = useState(book.finishedOn ?? '');
  const [totalText, setTotalText] = useState(book.isManual ? (book.pageCount ? String(book.pageCount) : '') : book.totalPagesOverride ? String(book.totalPagesOverride) : '');
  const [manual, setManual] = useState<ManualBookDraft>({
    title: book.title,
    authors: book.authors.join(', '),
    year: book.firstPublishYear ? String(book.firstPublishYear) : '',
    pages: '',
    coverUrl: book.coverUrl ?? '',
    isbn: '',
    notes: '',
  });
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setProgressText(String(book.currentPage));
  }, [book.currentPage]);

  const reloadLogs = useCallback(async () => {
    const next = await fetchBookLogs(book.bookId);
    setLogs(next ?? []);
  }, [book.bookId]);

  useEffect(() => {
    reloadLogs();
  }, [reloadLogs]);

  const saveProgress = async () => {
    const parsed = parseProgress(progressText, total);
    if (!parsed.ok) {
      toast.show({ message: parsed.message, tone: 'danger' });
      return;
    }
    const result = await setBookProgress(book.bookId, parsed.value);
    if (!result.ok) {
      toast.show({ message: result.error, tone: 'danger' });
      return;
    }
    toast.show({ message: 'Bookmark updated. Totals only count logged pages.', tone: 'success' });
    await onChanged();
  };

  const logReading = async () => {
    if (logBusy.current || locked) return;
    const parsed = parsePagesRead(pagesText);
    if (!parsed.ok) {
      toast.show({ message: parsed.message, tone: 'danger' });
      return;
    }
    const day = localDateKey();
    // The same key is reused for a retry of the same entry (same book, pages and day), so a double
    // tap cannot count twice; a different entry always gets a new key.
    if (!logKey.current || logKey.current.pages !== parsed.value || logKey.current.day !== day) {
      logKey.current = { pages: parsed.value, day, key: makeClientKey('read') };
    }
    logBusy.current = true;
    setLogging(true);
    haptic.success();
    const result = await logPages(book.bookId, parsed.value, day, logKey.current.key);
    setLogging(false);
    logBusy.current = false;
    if (!result.ok) {
      toast.show({ message: result.error, tone: 'danger' });
      return;
    }
    logKey.current = null;
    setPagesText('');
    if (result.duplicate) {
      toast.show({ message: 'That entry was already logged.' });
    } else if (result.finished) {
      toast.show({ message: `${book.title} finished`, tone: 'success' });
    } else {
      const cut = result.pagesApplied < parsed.value ? ` (${result.pagesApplied} counted: the book ends there)` : '';
      toast.show({ message: `${result.pagesApplied} pages logged${cut}`, tone: 'success' });
    }
    await Promise.all([onChanged(), reloadLogs()]);
  };

  const deleteLog = async () => {
    if (!pendingLog) return;
    const result = await deleteReadingLog(pendingLog.id);
    setPendingLog(null);
    if (!result.ok) {
      toast.show({ message: result.error, tone: 'danger' });
      return;
    }
    toast.show({ message: 'Entry removed. Bookmark adjusted.' });
    await Promise.all([onChanged(), reloadLogs()]);
  };

  const saveDetails = async () => {
    const errors: Record<string, string> = {};
    if (started && !isValidDateKey(started)) errors.started = 'Use a real date, like 2026-10-01.';
    if (finished && !isValidDateKey(finished)) errors.finished = 'Use a real date, like 2026-10-01.';
    if (started && finished && finished < started) errors.finished = 'Finish date cannot be before the start date.';
    const totalParsed = parseTotalPages(totalText);
    if (!totalParsed.ok) errors.total = totalParsed.message;
    if (note.trim().length > 280) errors.note = 'Notes can be 280 characters or fewer.';
    if (book.shelf === 'finished' && !finished) errors.finished = 'A finished book needs a finish date.';
    if (book.shelf !== 'finished' && finished) errors.finished = 'Set the finish date by moving the book to Finished.';
    if (book.isManual) {
      if (!manual.title.trim()) errors.manualTitle = 'A title is required.';
      const check = validateManualBook({ ...manual, pages: '', isbn: manual.isbn, notes: '' }, year);
      if (!check.ok) {
        if (check.errors.year) errors.year = check.errors.year;
        if (check.errors.coverUrl) errors.coverUrl = check.errors.coverUrl;
        if (check.errors.isbn) errors.isbn = check.errors.isbn;
      }
    }
    setDetailErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const before: DetailsState = {
      rating: book.rating,
      note: book.note,
      startedOn: book.startedOn,
      finishedOn: book.finishedOn,
      totalPages: book.isManual ? book.pageCount : book.totalPagesOverride,
    };
    const after: DetailsState = {
      rating: parseRating(rating),
      note: note.trim() ? note.trim() : null,
      startedOn: started || null,
      finishedOn: finished || null,
      totalPages: totalParsed.ok ? totalParsed.value : null,
    };
    const patch: Record<string, unknown> = detailsPatch(before, after);
    if (book.isManual) {
      if (manual.title.trim() !== book.title) patch.title = manual.title.trim();
      const authors = parseAuthors(manual.authors);
      if (authors.join('|') !== book.authors.join('|')) patch.authors = authors;
      const year2 = manual.year.trim() ? Number(manual.year.trim()) : null;
      if (year2 !== book.firstPublishYear) patch.first_publish_year = year2;
      const cover = manual.coverUrl.trim() || null;
      if (cover !== book.coverUrl) patch.cover_url = cover;
      const isbn = cleanIsbn(manual.isbn);
      if (isbn.ok && isbn.value !== null) patch.isbn13 = isbn.value;
    }
    if (Object.keys(patch).length === 0) {
      toast.show({ message: 'Nothing has changed.' });
      setEditing(false);
      return;
    }
    setSaving(true);
    const result = await updateBookDetails(book.bookId, patch);
    setSaving(false);
    if (!result.ok) {
      toast.show({ message: result.error, tone: 'danger' });
      return;
    }
    toast.show({ message: 'Details saved', tone: 'success' });
    setEditing(false);
    await onChanged();
  };

  const move = async (shelf: ShelfName) => {
    haptic.light();
    const result = await moveBook(book.bookId, shelf);
    if (!result.ok) {
      toast.show({ message: result.error, tone: 'danger' });
      return;
    }
    await onChanged();
  };

  const remove = async () => {
    setRemoving(true);
    const result = await removeFromShelf(book.bookId);
    setRemoving(false);
    setConfirmRemove(false);
    if (!result.ok) {
      toast.show({ message: result.error, tone: 'danger' });
      return;
    }
    toast.show({ message: 'Removed from your shelf' });
    await onRemoved();
  };

  return (
    <View style={styles.panel}>
      <Text variant="headline" numberOfLines={2}>{book.title}</Text>
      <Text variant="caption" tone="secondary">
        {book.authors.join(', ') || 'Unknown author'}
        {book.firstPublishYear ? ` · ${book.firstPublishYear}` : ''}
      </Text>
      <Text variant="caption" tone="tertiary">
        {book.isManual ? 'Added by you' : 'From Open Library'} · {SHELF_LABELS[book.shelf]}
      </Text>

      {total !== null && percent !== null ? (
        <View style={{ gap: space.x1 }}>
          <Text variant="body">Page {Math.min(book.currentPage, total)} of {total} · {percent}%</Text>
          <View style={styles.bar} accessibilityRole="progressbar" accessibilityValue={{ now: percent, min: 0, max: 100 }}>
            <View style={[styles.barFill, { width: `${percent}%` }]} />
          </View>
        </View>
      ) : (
        <Text variant="body" tone="secondary">Page {book.currentPage} · length unknown. Add the page count below to see progress.</Text>
      )}

      <View style={styles.section}>
        <Text variant="label" tone="secondary">Bookmark</Text>
        <View style={styles.logRow}>
          <TextField
            value={progressText}
            onChangeText={(t) => setProgressText(t.replace(/[^0-9]/g, '').slice(0, 5))}
            keyboardType="number-pad"
            placeholder="Current page"
            accessibilityLabel="Current page"
            containerStyle={{ flex: 1 }}
          />
          <Button label="Set page" size="sm" variant="secondary" onPress={saveProgress} />
        </View>
        <Text variant="caption" tone="tertiary">Correct the bookmark any time. It does not change your pages-read totals.</Text>
      </View>

      <View style={styles.section}>
        <Text variant="label" tone="secondary">Log pages read</Text>
        {locked ? (
          <Text variant="caption" tone="tertiary">
            {book.shelf === 'finished'
              ? 'This book is finished. Move it back to Reading to log more pages.'
              : 'Dropped books cannot be logged. Move it to another shelf first.'}
          </Text>
        ) : (
          <View style={styles.logRow}>
            <TextField
              value={pagesText}
              onChangeText={(t) => setPagesText(t.replace(/[^0-9]/g, '').slice(0, 4))}
              keyboardType="number-pad"
              placeholder="Pages read today"
              accessibilityLabel="Pages read"
              containerStyle={{ flex: 1 }}
            />
            <Button label={logging ? 'Logging…' : 'Log pages'} size="sm" onPress={logReading} disabled={logging} />
          </View>
        )}
        {logs && logs.length > 0 ? (
          <View style={{ gap: space.x2 }}>
            {logs.slice(0, 8).map((l) => (
              <View key={l.id} style={styles.logItem}>
                <Text variant="caption" tone="secondary" style={{ flex: 1 }}>{l.readOn} · {l.pages} pages</Text>
                <Pressable onPress={() => setPendingLog(l)} accessibilityRole="button" accessibilityLabel={`Remove ${l.pages} pages from ${l.readOn}`} hitSlop={10}>
                  <Ionicons name="close-circle-outline" size={18} color={colors.textTertiary} />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      <View style={styles.section}>
        <View style={styles.moveRow}>
          <Button label={editing ? 'Close details' : 'Edit details'} size="sm" variant="secondary" onPress={() => setEditing((v) => !v)} />
        </View>
        {editing ? (
          <View style={{ gap: space.x3 }}>
            {book.isManual ? (
              <>
                <TextField label="Title" value={manual.title} onChangeText={(t) => setManual({ ...manual, title: t })} error={detailErrors.manualTitle} maxLength={300} accessibilityLabel="Edit title" />
                <TextField label="Authors" value={manual.authors} onChangeText={(t) => setManual({ ...manual, authors: t })} accessibilityLabel="Edit authors" />
                <TextField label="Year" value={manual.year} onChangeText={(t) => setManual({ ...manual, year: t })} keyboardType="number-pad" error={detailErrors.year} accessibilityLabel="Edit year" />
                <TextField label="ISBN" value={manual.isbn} onChangeText={(t) => setManual({ ...manual, isbn: t })} error={detailErrors.isbn} autoCapitalize="characters" accessibilityLabel="Edit ISBN" hint="Leave blank to keep the current value" />
                <TextField label="Cover image link" value={manual.coverUrl} onChangeText={(t) => setManual({ ...manual, coverUrl: t })} error={detailErrors.coverUrl} autoCapitalize="none" accessibilityLabel="Edit cover link" />
              </>
            ) : null}
            <TextField
              label={book.isManual ? 'Total pages' : 'Your page count (optional)'}
              value={totalText}
              onChangeText={(t) => setTotalText(t.replace(/[^0-9]/g, '').slice(0, 5))}
              keyboardType="number-pad"
              hint={book.isManual ? 'Blank means unknown' : 'Only affects your shelf. The catalogue is not changed.'}
              error={detailErrors.total}
              accessibilityLabel="Total pages"
            />
            <Text variant="label" tone="secondary">Rating</Text>
            <ChipRow>
              {[1, 2, 3, 4, 5].map((n) => (
                <Chip key={n} label={`${n}★`} selected={rating === n} onPress={() => setRating(rating === n ? null : n)} size="sm" accessibilityLabel={`${n} stars`} />
              ))}
              <Chip label="Clear" selected={false} onPress={() => setRating(null)} size="sm" accessibilityLabel="Clear rating" />
            </ChipRow>
            <TextField label="Started (YYYY-MM-DD)" value={started} onChangeText={setStarted} autoCapitalize="none" error={detailErrors.started} placeholder="Optional" accessibilityLabel="Start date" />
            <TextField label="Finished (YYYY-MM-DD)" value={finished} onChangeText={setFinished} autoCapitalize="none" error={detailErrors.finished} placeholder={book.shelf === 'finished' ? 'Needed for Finished books' : 'Set by moving to Finished'} accessibilityLabel="Finish date" />
            <TextField label="Notes" value={note} onChangeText={setNote} counter={280} error={detailErrors.note} accessibilityLabel="Book notes" />
            <View style={styles.moveRow}>
              <Button label={saving ? 'Saving…' : 'Save details'} size="sm" onPress={saveDetails} disabled={saving} />
            </View>
          </View>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text variant="label" tone="secondary">Move to</Text>
        <View style={styles.moveRow}>
          {SHELF_ORDER.filter((s) => s !== book.shelf).map((s) => (
            <Button key={s} label={SHELF_LABELS[s]} variant="secondary" size="sm" onPress={() => move(s)} />
          ))}
        </View>
      </View>

      <View style={styles.moveRow}>
        <Button label="Close" variant="ghost" size="sm" onPress={onClose} />
        <Button label="Remove from shelf" variant="ghost" size="sm" onPress={() => setConfirmRemove(true)} />
      </View>

      <Dialog
        visible={confirmRemove}
        title="Remove this book?"
        body={`${book.title} will leave your shelf. Its reading log entries are deleted too, so those pages stop counting toward your totals.${book.isManual ? ' This book was added by you, so it is deleted for good.' : ''}`}
        confirmLabel="Remove"
        confirmVariant="danger"
        loading={removing}
        onConfirm={remove}
        onCancel={() => setConfirmRemove(false)}
      />
      <Dialog
        visible={pendingLog !== null}
        title="Remove this reading entry?"
        body={pendingLog ? `${pendingLog.pages} pages on ${pendingLog.readOn} will stop counting. Your bookmark moves back by the same amount.` : undefined}
        confirmLabel="Remove entry"
        confirmVariant="danger"
        onConfirm={deleteLog}
        onCancel={() => setPendingLog(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.x4, gap: space.x4 },
  searchBox: { backgroundColor: colors.surface1, borderRadius: radius.md },
  notice: { gap: space.x2, padding: space.x3, borderRadius: radius.md, backgroundColor: colors.surface1 },
  manualToggle: { flexDirection: 'row', alignItems: 'center', gap: space.x2, paddingVertical: space.x2 },
  twoUp: { flexDirection: 'row', gap: space.x3 },
  hits: { gap: space.x2 },
  hit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
  },
  shelfBlock: { gap: space.x2 },
  shelfHead: { flexDirection: 'row', justifyContent: 'space-between' },
  shelfLabel: { textTransform: 'uppercase', letterSpacing: 0.6 },
  panel: { gap: space.x3, padding: space.x4, borderRadius: radius.lg, backgroundColor: colors.surface1 },
  bar: { height: 6, borderRadius: 3, backgroundColor: colors.surface2, overflow: 'hidden' },
  barFill: { height: 6, backgroundColor: colors.accent },
  section: { gap: space.x2 },
  logRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.x2 },
  logItem: { flexDirection: 'row', alignItems: 'center', gap: space.x2 },
  moveRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x2 },
  stats: { gap: space.x1, padding: space.x3, borderRadius: radius.md, backgroundColor: colors.surface1 },
});
