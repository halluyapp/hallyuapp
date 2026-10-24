import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Button } from '../components/ui/Button';
import { Chip, ChipRow } from '../components/ui/Chip';
import { Dialog } from '../components/ui/Dialog';
import { Screen, useListPadding } from '../components/ui/Screen';
import { EmptyState } from '../components/ui/States';
import { Text } from '../components/ui/Text';
import { TextField } from '../components/ui/TextField';
import { useToast } from '../components/ui/Toast';
import { TopBar } from '../components/ui/TopBar';
import { colors, radius, space } from '../constants/theme';
import { useAuth } from '../lib/auth';
import {
  DiaryCursor,
  DiaryEntry,
  deleteWatchEntry,
  fetchDiaryPage,
  localDateKey,
  updateWatchEntry,
} from '../lib/api/tracker';
import { dayLabel, groupByDay, isValidDayKey, mergePages } from '../lib/diaryRules';
import { haptic } from '../lib/hooks';

const PAGE_SIZE = 30;

/**
 * Diary — every dated watch, newest day first, grouped by the day you watched it (the day you
 * recorded, in your own time zone). Tap an entry to edit its rating, note or day. Deleting asks first.
 */
export default function Diary() {
  const router = useRouter();
  const toast = useToast();
  const auth = useAuth();
  const listPad = useListPadding();
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [cursor, setCursor] = useState<DiaryCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DiaryEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadFirst = useCallback(async () => {
    const page = await fetchDiaryPage(null, PAGE_SIZE);
    if (!page.ok) {
      setError(page.error);
      return;
    }
    setError(null);
    setEntries(page.entries);
    setHasMore(page.hasMore);
    setCursor(page.next);
  }, []);

  useEffect(() => {
    if (auth.status !== 'signedIn') {
      setLoading(false);
      return;
    }
    setLoading(true);
    loadFirst().finally(() => setLoading(false));
  }, [auth.status, loadFirst]);

  const loadOlder = async () => {
    if (!hasMore || loadingMore || !cursor) return;
    setLoadingMore(true);
    const page = await fetchDiaryPage(cursor, PAGE_SIZE);
    setLoadingMore(false);
    if (!page.ok) {
      toast.show({ message: 'Could not load older entries. Try again.', tone: 'danger' });
      return;
    }
    // The cursor carries (day, watched_at, id), so pages join without skips or repeats.
    setEntries((prev) => mergePages(prev, page.entries));
    setHasMore(page.hasMore);
    setCursor(page.next);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    const ok = await deleteWatchEntry(pendingDelete.id);
    setDeleting(false);
    if (ok) {
      haptic.light();
      setEntries((prev) => prev.filter((e) => e.id !== pendingDelete.id));
      toast.show({ message: 'Entry removed' });
    } else {
      toast.show({ message: 'Could not remove that entry. Try again.', tone: 'danger' });
    }
    setPendingDelete(null);
  };

  const onSaved = async (entry: DiaryEntry, change: { rating: number | null; note: string | null; watchedOn: string }) => {
    setEditingId(null);
    if (change.watchedOn === entry.watchedOn) {
      setEntries((prev) =>
        prev.map((e) => (e.id === entry.id ? { ...e, rating: change.rating, note: change.note } : e)),
      );
    } else {
      // A new day moves the entry to another group; re-read the first page so order stays exact.
      await loadFirst();
    }
    toast.show({ message: 'Entry saved', tone: 'success' });
  };

  const groups = useMemo(() => groupByDay(entries), [entries]);
  const today = localDateKey();
  const header = <TopBar mode="stack" title="Diary" onBack={() => router.back()} />;

  if (auth.status !== 'signedIn') {
    return (
      <Screen header={header}>
        <EmptyState
          icon="book-outline"
          title="Sign in to keep a diary"
          body="Your diary is private to you. Sign in to start logging what you watch."
        />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <FlatList
        data={groups}
        keyExtractor={(g) => g.key}
        contentContainerStyle={[listPad, styles.list]}
        ListEmptyComponent={
          loading ? null : error ? (
            <View style={{ gap: space.x3 }}>
              <EmptyState icon="cloud-offline-outline" title="Diary unavailable" body="We could not load your diary. Check your connection and try again." />
              <Button label="Try again" variant="secondary" onPress={() => { setLoading(true); loadFirst().finally(() => setLoading(false)); }} />
            </View>
          ) : (
            <EmptyState
              icon="calendar-outline"
              title="Nothing logged yet"
              body="Open an episode or movie and tap Mark watched. It lands here on the day you watched it."
            />
          )
        }
        ListFooterComponent={
          hasMore ? (
            <View style={styles.footer}>
              <Button label={loadingMore ? 'Loading…' : 'Load older'} variant="secondary" onPress={loadOlder} disabled={loadingMore} />
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.day}>
            <Text variant="caption" tone="tertiary" style={styles.dayLabel}>
              {dayLabel(item.key, today)} · {item.items.length} {item.items.length === 1 ? 'entry' : 'entries'}
            </Text>
            {item.items.map((entry) => (
              <DiaryRow
                key={entry.id}
                entry={entry}
                today={today}
                editing={editingId === entry.id}
                onToggleEdit={() => setEditingId(editingId === entry.id ? null : entry.id)}
                onDelete={() => setPendingDelete(entry)}
                onSaved={(change) => onSaved(entry, change)}
              />
            ))}
          </View>
        )}
      />
      <Dialog
        visible={pendingDelete !== null}
        title="Remove this entry?"
        body={pendingDelete ? `${pendingDelete.title} will be removed from your diary. This cannot be undone.` : undefined}
        confirmLabel="Remove"
        confirmVariant="danger"
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </Screen>
  );
}

function DiaryRow({
  entry,
  today,
  editing,
  onToggleEdit,
  onDelete,
  onSaved,
}: {
  entry: DiaryEntry;
  today: string;
  editing: boolean;
  onToggleEdit: () => void;
  onDelete: () => void;
  onSaved: (change: { rating: number | null; note: string | null; watchedOn: string }) => void;
}) {
  const toast = useToast();
  const [rating, setRating] = useState<number | null>(entry.rating);
  const [note, setNote] = useState(entry.note ?? '');
  const [day, setDay] = useState(entry.watchedOn);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) return;
    setRating(entry.rating);
    setNote(entry.note ?? '');
    setDay(entry.watchedOn);
  }, [editing, entry.rating, entry.note, entry.watchedOn]);

  const save = async () => {
    const trimmed = note.trim();
    if (trimmed.length > 280) {
      toast.show({ message: 'Notes can be 280 characters or fewer.', tone: 'danger' });
      return;
    }
    if (!isValidDayKey(day)) {
      toast.show({ message: 'Use a real date in the form YYYY-MM-DD.', tone: 'danger' });
      return;
    }
    if (day > today) {
      toast.show({ message: 'The date cannot be in the future.', tone: 'danger' });
      return;
    }
    setSaving(true);
    const change = { rating, note: trimmed.length ? trimmed : null, watchedOn: day };
    const result = await updateWatchEntry(entry.id, {
      rating: change.rating,
      note: change.note,
      watchedOn: change.watchedOn === entry.watchedOn ? undefined : change.watchedOn,
    });
    setSaving(false);
    if (!result.ok) {
      toast.show({ message: result.error, tone: 'danger' });
      return;
    }
    onSaved(change);
  };

  return (
    <View style={styles.row}>
      <Pressable style={styles.rowTop} onPress={onToggleEdit} accessibilityRole="button" accessibilityLabel={`Edit ${entry.title}`}>
        <View style={styles.rowBody}>
          <Text variant="body" numberOfLines={1}>{entry.title}</Text>
          <Text variant="caption" tone="secondary" numberOfLines={1}>
            {entry.unit === 'episode' && entry.season != null && entry.episode != null
              ? `Season ${entry.season} · Episode ${entry.episode}`
              : 'Movie'}
            {entry.runtimeMinutes ? ` · ${entry.runtimeMinutes} min` : ' · runtime unknown'}
            {entry.rating ? ` · ${entry.rating}★` : ''}
          </Text>
          {entry.note && !editing ? (
            <Text variant="caption" tone="tertiary" numberOfLines={2}>{entry.note}</Text>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${entry.title} from diary`}
          hitSlop={10}
          onPress={onDelete}
        >
          <Ionicons name="trash-outline" size={18} color={colors.textTertiary} />
        </Pressable>
      </Pressable>

      {editing ? (
        <View style={styles.editor}>
          <Text variant="label" tone="secondary">Rating</Text>
          <ChipRow>
            {[1, 2, 3, 4, 5].map((n) => (
              <Chip key={n} label={`${n}★`} selected={rating === n} onPress={() => setRating(rating === n ? null : n)} size="sm" accessibilityLabel={`${n} stars`} />
            ))}
            <Chip label="Clear" selected={false} onPress={() => setRating(null)} size="sm" accessibilityLabel="Clear rating" />
          </ChipRow>
          <TextField
            label="Note"
            value={note}
            onChangeText={setNote}
            counter={280}
            maxLength={300}
            placeholder="Optional"
            accessibilityLabel="Entry note"
          />
          <TextField
            label="Watched on (YYYY-MM-DD)"
            value={day}
            onChangeText={setDay}
            autoCapitalize="none"
            autoCorrect={false}
            hint="Moving the day keeps the entry, and it is re-sorted into that day."
            error={day.length > 0 && !isValidDayKey(day) ? 'Use a real date, like 2026-10-01.' : null}
            accessibilityLabel="Watched on date"
          />
          <View style={styles.editorActions}>
            <Button label="Cancel" variant="ghost" size="sm" onPress={onToggleEdit} disabled={saving} />
            <Button label={saving ? 'Saving…' : 'Save'} size="sm" onPress={save} disabled={saving} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.x4 },
  day: { gap: space.x2 },
  dayLabel: { textTransform: 'uppercase', letterSpacing: 0.6 },
  row: {
    gap: space.x3,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: space.x3 },
  rowBody: { flex: 1, gap: 2 },
  editor: { gap: space.x3, paddingTop: space.x2 },
  editorActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.x2 },
  footer: { paddingVertical: space.x3 },
});
