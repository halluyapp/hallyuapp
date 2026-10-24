import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Button } from '../components/ui/Button';
import { Screen } from '../components/ui/Screen';
import { EmptyState } from '../components/ui/States';
import { Text } from '../components/ui/Text';
import { useToast } from '../components/ui/Toast';
import { TopBar } from '../components/ui/TopBar';
import { colors, radius, space } from '../constants/theme';
import { useAuth } from '../lib/auth';
import { localDateKey } from '../lib/api/tracker';
import {
  addBookToShelf,
  BookSearchHit,
  fetchShelf,
  logPages,
  moveBook,
  removeFromShelf,
  searchBooks,
  ShelfBook,
  ShelfName,
  ShelfPage,
} from '../lib/api/shelf';
import { haptic } from '../lib/hooks';

const SHELVES: { id: ShelfName; label: string }[] = [
  { id: 'want', label: 'Want to read' },
  { id: 'reading', label: 'Reading' },
  { id: 'finished', label: 'Finished' },
];

const SPINE_COLORS = ['#7C2D12', '#1E3A5F', '#14532D', '#4C1D95', '#831843', '#713F12', '#0F3D3E', '#3F3F46'];

function spineColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return SPINE_COLORS[h % SPINE_COLORS.length];
}

/** Spine width follows page count so thick books look thick on the shelf. */
function spineWidth(pages: number | null): number {
  if (!pages) return 22;
  return Math.max(14, Math.min(44, Math.round(pages / 22)));
}

/** Shelf — your books on wooden shelves, search to add, log pages to move your bookmark. */
export default function Shelf() {
  const router = useRouter();
  const toast = useToast();
  const auth = useAuth();
  const [page, setPage] = useState<ShelfPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<BookSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pagesText, setPagesText] = useState('');
  const searchSeq = useRef(0);
  const logLock = useRef(false);

  const load = useCallback(async () => {
    const next = await fetchShelf();
    setFailed(!next);
    if (next) setPage(next);
  }, []);

  useEffect(() => {
    if (auth.status !== 'signedIn') {
      setLoading(false);
      return;
    }
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [auth.status, load]);

  // Debounced Open Library search. A sequence number drops stale responses.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      searchBooks(q).then((results) => {
        if (seq !== searchSeq.current) return;
        setHits(results);
        setSearching(false);
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);

  const books = useMemo(() => page?.books ?? [], [page]);
  const selected = useMemo(() => books.find((b) => b.bookId === selectedId) ?? null, [books, selectedId]);

  const addHit = async (hit: BookSearchHit) => {
    haptic.light();
    const id = await addBookToShelf(hit, 'want');
    if (!id) {
      toast.show({ message: 'Could not add that book. Try again.', tone: 'danger' });
      return;
    }
    toast.show({ message: `${hit.title} added to Want to read`, tone: 'success' });
    setQuery('');
    setHits([]);
    await load();
    setSelectedId(id);
  };

  const move = async (book: ShelfBook, shelf: ShelfName) => {
    haptic.light();
    const ok = await moveBook(book.bookId, shelf);
    if (!ok) {
      toast.show({ message: 'Could not move that book.', tone: 'danger' });
      return;
    }
    await load();
  };

  const logReading = async (book: ShelfBook) => {
    if (logLock.current) return; // double-tap guard: one request in flight at a time
    const pages = Number.parseInt(pagesText, 10);
    if (!Number.isFinite(pages) || pages < 1 || pages > 2000) {
      toast.show({ message: 'Enter pages between 1 and 2000', tone: 'danger' });
      return;
    }
    logLock.current = true;
    try {
      haptic.success();
      const today = localDateKey();
      // One key per tap attempt; a retry of the same attempt is deduped server-side.
      const key = `read-${book.bookId}-${today}-${pages}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await logPages(book.bookId, pages, today, key);
      if (!result.ok) {
        toast.show({ message: 'Could not log those pages.', tone: 'danger' });
        return;
      }
      setPagesText('');
      toast.show({ message: result.finished ? `${book.title} finished` : `${pages} pages logged`, tone: 'success' });
      await load();
    } finally {
      logLock.current = false;
    }
  };

  const remove = async (book: ShelfBook) => {
    const ok = await removeFromShelf(book.bookId);
    if (!ok) {
      toast.show({ message: 'Could not remove that book.', tone: 'danger' });
      return;
    }
    setSelectedId(null);
    await load();
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
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={18} color={colors.textTertiary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search books to add"
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            accessibilityLabel="Search books"
            returnKeyType="search"
          />
        </View>

        {query.trim().length >= 2 ? (
          <View style={styles.hits}>
            {searching ? <Text variant="caption" tone="tertiary">Searching…</Text> : null}
            {!searching && hits.length === 0 ? <Text variant="caption" tone="tertiary">No books found.</Text> : null}
            {hits.map((hit) => (
              <Pressable key={hit.externalId} onPress={() => addHit(hit)} accessibilityRole="button" accessibilityLabel={`Add ${hit.title}`} style={styles.hit}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="body" numberOfLines={1}>{hit.title}</Text>
                  <Text variant="caption" tone="secondary" numberOfLines={1}>
                    {hit.authors.slice(0, 2).join(', ') || 'Unknown author'}
                    {hit.firstPublishYear ? ` · ${hit.firstPublishYear}` : ''}
                    {hit.pageCount ? ` · ${hit.pageCount} pages` : ''}
                  </Text>
                </View>
                <Ionicons name="add-circle-outline" size={22} color={colors.textPrimary} />
              </Pressable>
            ))}
          </View>
        ) : null}

        {!loading && failed ? (
          <EmptyState icon="cloud-offline-outline" title="Shelf unavailable" body="We could not load your shelf. Check your connection and try again." />
        ) : null}

        {!loading && !failed && books.length === 0 ? (
          <EmptyState icon="library-outline" title="Your shelf is empty" body="Search above to add your first book." />
        ) : null}

        {SHELVES.map((shelf) => {
          const items = books.filter((b) => b.shelf === shelf.id);
          return (
            <View key={shelf.id} style={styles.shelfBlock}>
              <View style={styles.shelfHead}>
                <Text variant="caption" tone="tertiary" style={styles.shelfLabel}>{shelf.label}</Text>
                <Text variant="caption" tone="tertiary">{items.length}</Text>
              </View>
              <View style={styles.spines}>
                {items.map((b) => (
                  <Pressable
                    key={b.bookId}
                    onPress={() => {
                      haptic.light();
                      setSelectedId(b.bookId);
                      setPagesText('');
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`${b.title}, ${b.shelf}`}
                    style={[
                      styles.spine,
                      {
                        width: spineWidth(b.pageCount),
                        backgroundColor: spineColor(b.title),
                        borderWidth: selectedId === b.bookId ? 2 : 0,
                        borderColor: colors.textPrimary,
                      },
                    ]}
                  >
                    <Text variant="caption" style={styles.spineText} numberOfLines={1}>{b.title}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.board} />
            </View>
          );
        })}

        {selected ? (
          <View style={styles.panel}>
            <Text variant="headline" numberOfLines={2}>{selected.title}</Text>
            <Text variant="caption" tone="secondary">
              {selected.authors.join(', ') || 'Unknown author'}
              {selected.pageCount ? ` · ${selected.pageCount} pages` : ''}
            </Text>
            {selected.pageCount ? (
              <Text variant="caption" tone="tertiary">
                Page {selected.currentPage} of {selected.pageCount}
              </Text>
            ) : (
              <Text variant="caption" tone="tertiary">Page {selected.currentPage} · length unknown</Text>
            )}

            {selected.shelf !== 'dropped' ? (
              <View style={styles.logRow}>
                <TextInput
                  value={pagesText}
                  onChangeText={(t) => setPagesText(t.replace(/[^0-9]/g, '').slice(0, 4))}
                  keyboardType="number-pad"
                  placeholder="Pages read today"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.input, styles.pagesInput]}
                  accessibilityLabel="Pages read"
                />
                <Button label="Log pages" size="sm" onPress={() => logReading(selected)} />
              </View>
            ) : null}

            <View style={styles.moveRow}>
              {(['want', 'reading', 'finished', 'dropped'] as ShelfName[])
                .filter((s) => s !== selected.shelf)
                .map((s) => (
                  <Button key={s} label={`Move to ${labelFor(s)}`} variant="secondary" size="sm" onPress={() => move(selected, s)} />
                ))}
            </View>

            <View style={styles.moveRow}>
              <Button label="Close" variant="ghost" size="sm" onPress={() => setSelectedId(null)} />
              <Button label="Remove from shelf" variant="ghost" size="sm" onPress={() => remove(selected)} />
            </View>
          </View>
        ) : null}

        {page ? (
          <View style={styles.stats}>
            <Text variant="caption" tone="tertiary">{page.year} so far</Text>
            <Text variant="body">
              {page.pagesReadYear.toLocaleString()} pages read · {page.finishedYear} finished
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function labelFor(shelf: ShelfName): string {
  return shelf === 'want' ? 'Want to read' : shelf === 'reading' ? 'Reading' : shelf === 'finished' ? 'Finished' : 'Dropped';
}

const styles = StyleSheet.create({
  content: { padding: space.x4, gap: space.x4 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    paddingHorizontal: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
  },
  input: { flex: 1, color: colors.textPrimary, paddingVertical: space.x3 },
  pagesInput: { backgroundColor: colors.surface2, borderRadius: radius.md, paddingHorizontal: space.x3 },
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
  spines: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    minHeight: 150,
    paddingHorizontal: space.x2,
    gap: 2,
    flexWrap: 'wrap',
  },
  spine: {
    height: 140,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: space.x2,
    overflow: 'hidden',
  },
  spineText: { color: '#FFFFFF', transform: [{ rotate: '-90deg' }], width: 120, textAlign: 'center' },
  board: { height: 10, borderRadius: 2, backgroundColor: '#8B5E3C' },
  panel: { gap: space.x2, padding: space.x4, borderRadius: radius.lg, backgroundColor: colors.surface1 },
  logRow: { flexDirection: 'row', alignItems: 'center', gap: space.x2 },
  moveRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x2 },
  stats: { gap: space.x1, padding: space.x3, borderRadius: radius.md, backgroundColor: colors.surface1 },
});
