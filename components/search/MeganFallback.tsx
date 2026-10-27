import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { MeganSearchHit, searchMegan } from '../../lib/api/megan';
import { colors, radius, space } from '../../constants/theme';
import { Text } from '../ui/Text';

/**
 * Shown under an empty search: other titles Megan knows about. Metadata only. These titles are not on
 * Hallyu yet, so rows are informational and do not open anything.
 */
export function MeganFallback({ query }: { query: string }) {
  const [hits, setHits] = useState<MeganSearchHit[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHits(null);
    if (query.trim().length < 2) return;
    searchMegan(query.trim()).then((r) => {
      if (!cancelled) setHits(r.ok ? r.value.slice(0, 6) : []);
    });
    return () => {
      cancelled = true;
    };
  }, [query]);

  if (!hits || hits.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <Text variant="caption" tone="tertiary">ALSO FOUND ELSEWHERE · NOT ON HALLYU YET</Text>
      {hits.map((h) => (
        <View key={h.id} style={styles.row} accessibilityLabel={`${h.title}${h.year ? `, ${h.year}` : ''}`}>
          <Text variant="body">{h.title}</Text>
          <Text variant="caption" tone="tertiary">{[h.year, h.rating ? `★ ${h.rating.toFixed(1)}` : null].filter(Boolean).join(' · ')}</Text>
        </View>
      ))}
      <Text variant="caption" tone="tertiary">Information only. Hallyu does not play or link these titles.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: space.margin, marginTop: space.x3, padding: space.x4, gap: space.x2, borderRadius: radius.lg, backgroundColor: colors.surface1 },
  row: { gap: 2, paddingVertical: space.x1 },
});
