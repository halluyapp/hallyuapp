import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, View } from 'react-native';
import { Button } from '../components/ui/Button';
import { Screen } from '../components/ui/Screen';
import { EmptyState } from '../components/ui/States';
import { Text } from '../components/ui/Text';
import { TopBar } from '../components/ui/TopBar';
import { colors, radius, space } from '../constants/theme';
import { useAuth } from '../lib/auth';
import { runtimeCoverageLine } from '../lib/diaryRules';
import {
  exportTrackerData,
  fetchTrackerBadges,
  fetchTrackerSummary,
  fetchYearReview,
  localDateKey,
  TrackerBadge,
  TrackerSummary,
  YearReview,
} from '../lib/api/tracker';

/** Tracker — today, streaks, totals and a year of days at a glance. Private to you. */
export default function Tracker() {
  const router = useRouter();
  const auth = useAuth();
  const [summary, setSummary] = useState<TrackerSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [review, setReview] = useState<YearReview | null>(null);
  const [badges, setBadges] = useState<TrackerBadge[]>([]);
  const [exporting, setExporting] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([fetchTrackerSummary(localDateKey()), fetchYearReview(new Date().getFullYear()), fetchTrackerBadges()])
      .then(([s, y, b]) => {
        setSummary(s);
        setReview(y);
        setBadges(b ?? []);
        setFailed(!s);
      })
      .finally(() => setLoading(false));
  };

  const exportData = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const data = await exportTrackerData();
      if (!data) {
        Alert.alert('Export failed', 'We could not prepare your export. Try again in a moment.');
        return;
      }
      await Share.share({ title: 'Hallyu tracker export', message: JSON.stringify(data, null, 2) });
    } catch {
      Alert.alert('Export failed', 'The export was not shared.');
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    if (auth.status === 'signedIn') load();
    else setLoading(false);
  }, [auth.status]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    summary?.heatmap.forEach((d) => map.set(d.day, d.count));
    return map;
  }, [summary]);

  const cells = useMemo(() => {
    const out: { key: string; count: number }[] = [];
    const end = new Date();
    for (let i = 364; i >= 0; i -= 1) {
      const d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
      const key = localDateKey(d);
      out.push({ key, count: counts.get(key) ?? 0 });
    }
    return out;
  }, [counts]);

  const header = <TopBar mode="stack" title="Tracker" onBack={() => router.back()} />;

  if (auth.status !== 'signedIn') {
    return (
      <Screen header={header}>
        <EmptyState icon="stats-chart-outline" title="Sign in to track" body="Your tracker is private to you. Sign in to start counting what you watch." />
      </Screen>
    );
  }

  if (!loading && failed) {
    return (
      <Screen header={header}>
        <EmptyState icon="cloud-offline-outline" title="Tracker unavailable" body="We could not load your tracker. Check your connection and try again." />
        <View style={{ paddingHorizontal: space.x4 }}>
          <Button label="Try again" variant="secondary" onPress={load} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <Text variant="caption" tone="tertiary">TODAY</Text>
          <Text variant="display">{summary?.todayCount ?? 0}</Text>
          <Text variant="body" tone="secondary">
            {(summary?.todayCount ?? 0) === 1 ? 'entry logged today' : 'entries logged today'}
          </Text>
        </View>

        <View style={styles.grid}>
          <Stat label="Current streak" value={`${summary?.currentStreak ?? 0} d`} />
          <Stat label="Longest streak" value={`${summary?.longestStreak ?? 0} d`} />
          <Stat label="Days watched" value={String(summary?.daysActive ?? 0)} />
          <Stat label="Total entries" value={String(summary?.totalEntries ?? 0)} />
          <Stat label="Hours watched" value={formatHours(summary?.totalMinutes ?? 0)} />
        </View>
        {summary ? (
          <Text variant="caption" tone="tertiary">{runtimeCoverageLine(summary.runtimeKnownEntries, summary.runtimeUnknownEntries) ?? ''}</Text>
        ) : null}

        <View style={styles.panel}>
          <Text variant="headline">Last 365 days</Text>
          <View style={styles.heatGrid}>
            {cells.map((c) => (
              <View
                key={c.key}
                accessibilityLabel={`${c.key}: ${c.count} entries`}
                style={[styles.cell, { backgroundColor: heatColor(c.count) }]}
              />
            ))}
          </View>
          <Text variant="caption" tone="tertiary">Brighter squares mean more entries that day.</Text>
        </View>

        {review ? (
          <View style={styles.panel}>
            <Text variant="headline">Year in review {review.year}</Text>
            <View style={styles.grid}>
              <Stat label="Entries" value={String(review.entries)} />
              <Stat label="Days watched" value={String(review.daysWatched)} />
              <Stat label="Hours" value={formatHours(review.minutes)} />
              <Stat label="Best day" value={review.bestDay ? `${review.bestDay} (${review.bestDayEntries})` : '-'} />
              <Stat label="Pages read" value={String(review.pagesRead)} />
              <Stat label="Books finished" value={String(review.booksFinished)} />
            </View>
            {review.runtimeUnknownEntries > 0 ? (
              <Text variant="caption" tone="tertiary">{`${review.runtimeUnknownEntries} of ${review.entries} entries have no runtime, so Hours leaves them out.`}</Text>
            ) : null}
            {review.topTitles.length > 0 ? (
              <View style={{ gap: space.x2 }}>
                <Text variant="caption" tone="tertiary">MOST LOGGED</Text>
                {review.topTitles.map((t) => (
                  <Text key={t.title} variant="body">{`${t.title} · ${t.entries}`}</Text>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {badges.length > 0 ? (
          <View style={styles.panel}>
            <Text variant="headline">Badges</Text>
            {badges.map((b) => (
              <View key={b.id} style={{ gap: space.x1 }}>
                <Text variant="body">{`${b.name}${b.earned ? ' · earned' : ''}`}</Text>
                <Text variant="caption" tone="tertiary">{`${b.detail} · ${Math.min(b.progress, b.target)}/${b.target}`}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <Button label="Open diary" variant="secondary" block onPress={() => router.push('/diary')} />
        <Button label="Import a diary CSV" variant="secondary" block onPress={() => router.push('/import')} />
        <Button label={exporting ? 'Preparing export…' : 'Export my data'} variant="secondary" block disabled={exporting} onPress={exportData} />
      </ScrollView>
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text variant="caption" tone="tertiary">{label}</Text>
      <Text variant="headline">{value}</Text>
    </View>
  );
}

function formatHours(minutes: number): string {
  const h = minutes / 60;
  return h >= 10 ? `${Math.round(h)} h` : `${Math.round(h * 10) / 10} h`;
}

function heatColor(count: number): string {
  if (count <= 0) return colors.surface1;
  if (count === 1) return 'rgba(225, 29, 72, 0.35)';
  if (count <= 3) return 'rgba(225, 29, 72, 0.6)';
  return 'rgba(225, 29, 72, 0.95)';
}

const styles = StyleSheet.create({
  content: { padding: space.x4, gap: space.x4 },
  hero: { gap: space.x1, padding: space.x4, borderRadius: radius.lg, backgroundColor: colors.surface1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x3 },
  stat: { width: '47%', gap: space.x1, padding: space.x3, borderRadius: radius.md, backgroundColor: colors.surface1 },
  panel: { gap: space.x3, padding: space.x4, borderRadius: radius.lg, backgroundColor: colors.surface1 },
  heatGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 3 },
  cell: { width: 9, height: 9, borderRadius: 2 },
});
