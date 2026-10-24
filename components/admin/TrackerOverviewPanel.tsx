import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { AdminTrackerOverview, fetchAdminTrackerOverview } from '../../lib/api/tracker';
import { colors, radius, space } from '../../constants/theme';
import { Text } from '../ui/Text';

/** Admin: aggregate Watch Tracker health. Counts only; no member diary or titles are shown. */
export function TrackerOverviewPanel() {
  const [data, setData] = useState<AdminTrackerOverview | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    let cancelled = false;
    fetchAdminTrackerOverview().then((d) => {
      if (cancelled) return;
      setData(d);
      setState(d ? 'ready' : 'failed');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state !== 'ready' || !data) {
    return (
      <View style={styles.panel}>
        <Text variant="body" tone="secondary">
          {state === 'loading' ? 'Loading tracker overview…' : 'Tracker overview is unavailable for this account.'}
        </Text>
      </View>
    );
  }

  const max = Math.max(1, ...data.perDayLast14.map((d) => d.entries));
  const buckets = ['1 day', '2-6 days', '7-29 days', '30+ days'];

  return (
    <View style={{ gap: space.x4 }}>
      <View style={styles.grid}>
        <Stat label="Entries logged (all time)" value={data.entriesTotal} />
        <Stat label="Members logging (30 days)" value={data.membersLogging30} />
        <Stat label="Books on shelves" value={data.shelfBooksTotal} />
      </View>
      <View style={styles.panel}>
        <Text variant="headline">Entries, last 14 days</Text>
        <View style={styles.bars}>
          {data.perDayLast14.map((d) => (
            <View key={d.day} accessibilityLabel={`${d.day}: ${d.entries}`} style={styles.barCol}>
              <View style={[styles.bar, { height: Math.max(2, (d.entries / max) * 80) }]} />
              <Text variant="caption" tone="tertiary">{d.day.slice(8)}</Text>
            </View>
          ))}
        </View>
      </View>
      <View style={styles.panel}>
        <Text variant="headline">Longest streaks per member</Text>
        {buckets.map((b) => (
          <Text key={b} variant="body">{`${b}: ${data.streakDistribution[b] ?? 0}`}</Text>
        ))}
      </View>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.stat}>
      <Text variant="caption" tone="tertiary">{label}</Text>
      <Text variant="headline">{String(value)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x3 },
  stat: { width: '47%', gap: space.x1, padding: space.x3, borderRadius: radius.md, backgroundColor: colors.surface1 },
  panel: { gap: space.x3, padding: space.x4, borderRadius: radius.lg, backgroundColor: colors.surface1 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 110 },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  bar: { width: '100%', borderRadius: 3, backgroundColor: colors.accent },
});
