import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button } from '../components/ui/Button';
import { Screen } from '../components/ui/Screen';
import { EmptyState } from '../components/ui/States';
import { Text } from '../components/ui/Text';
import { TextField } from '../components/ui/TextField';
import { useToast } from '../components/ui/Toast';
import { TopBar } from '../components/ui/TopBar';
import { colors, radius, space } from '../constants/theme';
import { useAuth } from '../lib/auth';
import {
  importMatchedRows,
  ImportMatch,
  ImportResult,
  matchImportRows,
  parseDiaryCsv,
} from '../lib/api/tracker';
import { friendlyImportReason, summarizeRejections } from '../lib/diaryRules';

/**
 * CSV import (Letterboxd-style diary). Paste the CSV text, check matches, then import.
 * Only titles already in Hallyu's catalogue, matched by exact title AND year, are imported.
 * Nothing is written until you press Import.
 */
export default function ImportScreen() {
  const router = useRouter();
  const auth = useAuth();
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [matches, setMatches] = useState<ImportMatch[] | null>(null);
  const [outcome, setOutcome] = useState<ImportResult | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const header = <TopBar mode="stack" title="Import diary" onBack={() => router.back()} />;

  if (auth.status !== 'signedIn') {
    return (
      <Screen header={header}>
        <EmptyState icon="cloud-upload-outline" title="Sign in to import" body="Imports go to your private tracker. Sign in first." />
      </Screen>
    );
  }

  const check = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const parsed = parseDiaryCsv(csv);
    setSkipped(parsed.skipped);
    if (parsed.rows.length === 0) {
      setMatches(null);
      setError('No rows found. The file needs Date and Name columns (Year and Rating are optional).');
      setBusy(false);
      return;
    }
    if (parsed.rows.length > 5000) {
      setError('Please import at most 5,000 rows at a time.');
      setBusy(false);
      return;
    }
    const result = await matchImportRows(parsed.rows);
    if (!result) setError('We could not check matches. Check your connection and try again.');
    setMatches(result);
    setBusy(false);
  };

  const run = async () => {
    if (busy || !matches) return;
    const matched = matches.filter((m) => m.titleId);
    if (matched.length === 0) return;
    setBusy(true);
    setError(null);
    const result = await importMatchedRows(matches);
    setBusy(false);
    if ('error' in result) {
      setError(`${result.error} Re-running is safe: rows already imported are skipped.`);
      return;
    }
    setOutcome(result);
    if (result.rejected === 0) {
      toast.show(`Imported ${result.inserted}. ${result.duplicates} already in your diary.`);
      router.back();
    }
  };

  const matchedCount = matches?.filter((m) => m.titleId).length ?? 0;
  const unmatched = matches?.filter((m) => !m.titleId) ?? [];

  return (
    <Screen header={header}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.panel}>
          <Text variant="headline">Paste your diary CSV</Text>
          <Text variant="body" tone="secondary">
            Works with Letterboxd exports (Date, Name, Year, Rating). Only titles already on Hallyu, matched by exact
            title and year, are imported. Half-star ratings are rounded to whole stars.
          </Text>
          <TextField
            value={csv}
            onChangeText={(t) => {
              setCsv(t);
              setMatches(null);
            }}
            multiline
            multilineHeight={180}
            placeholder={'Date,Name,Year,Rating\n2026-10-01,Parasite,2019,5'}
            accessibilityLabel="Diary CSV text"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button label={busy && !matches ? 'Checking…' : 'Check matches'} block disabled={!csv.trim() || busy} onPress={check} />
        </View>

        {error ? <Text variant="body" tone="danger">{error}</Text> : null}

        {outcome ? (
          <View style={styles.panel}>
            <Text variant="headline">{`Imported ${outcome.inserted}`}</Text>
            <Text variant="body" tone="secondary">
              {`${outcome.duplicates} already in your diary. ${outcome.rejected} not imported.`}
            </Text>
            {summarizeRejections(outcome.rejections).map((group) => (
              <View key={group.reason} style={{ gap: 2 }}>
                <Text variant="body">{`${group.count} × ${friendlyImportReason(group.reason)}`}</Text>
                <Text variant="caption" tone="tertiary">
                  {outcome.rejections
                    .filter((r) => r.reason === group.reason)
                    .slice(0, 5)
                    .map((r) => `${r.title} (${r.watchedOn})`)
                    .join(', ')}
                </Text>
              </View>
            ))}
            <Button label="Done" block variant="secondary" onPress={() => router.back()} />
          </View>
        ) : null}

        {matches ? (
          <View style={styles.panel}>
            <Text variant="headline">{`${matchedCount} of ${matches.length} rows matched`}</Text>
            {skipped > 0 ? <Text variant="caption" tone="tertiary">{`${skipped} rows skipped (missing title or date).`}</Text> : null}
            {unmatched.length > 0 ? (
              <View style={{ gap: space.x1 }}>
                <Text variant="caption" tone="tertiary">NOT ON HALLYU YET (not imported)</Text>
                {unmatched.slice(0, 20).map((m, i) => (
                  <Text key={`${m.title}-${m.watchedOn}-${i}`} variant="body" tone="secondary">
                    {`${m.title}${m.year ? ` (${m.year})` : ' (no year)'} · ${m.watchedOn}`}
                  </Text>
                ))}
                {unmatched.length > 20 ? <Text variant="caption" tone="tertiary">{`…and ${unmatched.length - 20} more`}</Text> : null}
              </View>
            ) : null}
            <Button
              label={busy ? 'Importing…' : `Import ${matchedCount} matched`}
              block
              disabled={busy || matchedCount === 0}
              onPress={run}
            />
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.x4, gap: space.x4 },
  panel: { gap: space.x3, padding: space.x4, borderRadius: radius.lg, backgroundColor: colors.surface1 },
});
