import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Button } from '../components/ui/Button';
import { Screen, useListPadding } from '../components/ui/Screen';
import { EmptyState } from '../components/ui/States';
import { Text } from '../components/ui/Text';
import { useToast } from '../components/ui/Toast';
import { TopBar } from '../components/ui/TopBar';
import { colors, radius, space } from '../constants/theme';
import { useAuth } from '../lib/auth';
import { DiaryEntry, deleteWatchEntry, fetchDiaryPage } from '../lib/api/tracker';
import { haptic } from '../lib/hooks';

/** Diary — every dated watch, newest first, grouped by the day you watched it. */
export default function Diary() {
  const router = useRouter();
  const toast = useToast();
  const auth = useAuth();
  const listPad = useListPadding();
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (before?: string | null) => {
    const page = await fetchDiaryPage(before ?? null, 30);
    if (!page) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setEntries((prev) => (before ? [...prev, ...page.entries] : page.entries));
    setHasMore(page.hasMore);
  }, []);

  useEffect(() => {
    if (auth.status !== 'signedIn') {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    load(null).finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [auth.status, load]);

  const onEndReached = () => {
    if (!hasMore || loadingMore || entries.length === 0) return;
    setLoadingMore(true);
    load(entries[entries.length - 1].watchedAt).finally(() => setLoadingMore(false));
  };

  const remove = async (entry: DiaryEntry) => {
    haptic.light();
    const ok = await deleteWatchEntry(entry.id);
    if (ok) {
      setEntries((prev) => prev.filter((e) => e.id !== entry.id));
      toast.show({ message: 'Entry removed' });
    } else {
      toast.show({ message: 'Could not remove that entry. Try again.', tone: 'danger' });
    }
  };

  const sections = useMemo(() => {
    const groups: { day: string; items: DiaryEntry[] }[] = [];
    for (const e of entries) {
      const last = groups[groups.length - 1];
      if (last && last.day === e.watchedOn) last.items.push(e);
      else groups.push({ day: e.watchedOn, items: [e] });
    }
    return groups;
  }, [entries]);

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
        data={sections}
        keyExtractor={(s) => s.day}
        contentContainerStyle={[listPad, styles.list]}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          loading ? null : failed ? (
            <EmptyState icon="cloud-offline-outline" title="Diary unavailable" body="We could not load your diary. Check your connection and try again." />
          ) : (
            <EmptyState
              icon="calendar-outline"
              title="Nothing logged yet"
              body="Tap Mark watched on an episode, and it lands here on the day you watched it."
            />
          )
        }
        ListFooterComponent={
          hasMore ? (
            <View style={styles.footer}>
              <Button label={loadingMore ? 'Loading…' : 'Load older'} variant="secondary" onPress={onEndReached} />
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.day}>
            <Text variant="caption" tone="tertiary" style={styles.dayLabel}>
              {formatDay(item.day)} · {item.items.length} {item.items.length === 1 ? 'entry' : 'entries'}
            </Text>
            {item.items.map((entry) => (
              <View key={entry.id} style={styles.row}>
                <View style={styles.rowBody}>
                  <Text variant="body" numberOfLines={1}>
                    {entry.title}
                  </Text>
                  <Text variant="caption" tone="secondary" numberOfLines={1}>
                    {entry.unit === 'episode' && entry.season != null && entry.episode != null
                      ? `Season ${entry.season} · Episode ${entry.episode}`
                      : 'Movie'}
                    {entry.runtimeMinutes ? ` · ${entry.runtimeMinutes} min` : ''}
                    {entry.rating ? ` · ${entry.rating}★` : ''}
                  </Text>
                  {entry.note ? (
                    <Text variant="caption" tone="tertiary" numberOfLines={2}>
                      {entry.note}
                    </Text>
                  ) : null}
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${entry.title} from diary`}
                  hitSlop={10}
                  onPress={() => remove(entry)}
                >
                  <Ionicons name="trash-outline" size={18} color={colors.textTertiary} />
                </Pressable>
              </View>
            ))}
          </View>
        )}
      />
    </Screen>
  );
}

function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

const styles = StyleSheet.create({
  list: { gap: space.x4 },
  day: { gap: space.x2 },
  dayLabel: { textTransform: 'uppercase', letterSpacing: 0.6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x3,
    padding: space.x3,
    borderRadius: radius.md,
    backgroundColor: colors.surface1,
  },
  rowBody: { flex: 1, gap: 2 },
  footer: { paddingVertical: space.x3 },
});
