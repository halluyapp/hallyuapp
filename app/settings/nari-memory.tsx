import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { SettingsGroup } from '../../components/settings/Rows';
import { Button } from '../../components/ui/Button';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { intelligenceApi, type NariPreference } from '../../lib/api/intelligence';
import { space } from '../../constants/theme';

const OPTIONS: Record<string, { label: string; values: string[] }> = {
  preferred_language: { label: 'Reply language', values: ['en','ko','zh','ja'] },
  favorite_genre: { label: 'Favorite genre', values: ['romance','thriller','comedy','fantasy','drama','action','animation','historical'] },
  spoiler_preference: { label: 'Spoiler preference', values: ['avoid','allow'] },
};
export default function NariMemorySettings() {
  const [rows, setRows] = useState<NariPreference[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setRows(await intelligenceApi.memory()); setLoaded(true); }
    catch (err) { setError(err instanceof Error ? err.message : 'Memory unavailable'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async (key: string, value: string | null, remove = false) => {
    setLoading(true); setError('');
    try { setRows(await intelligenceApi.memory(key, value, remove)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not update memory'); }
    finally { setLoading(false); }
  };
  return <Screen header={<TopBar mode="stack" title="Nari memory" />}><ScrollScreen>
    <View style={{ padding: space.x4, gap: space.x3 }}>
      <Text>Choose what Nari may remember. Nothing is saved automatically. Preferences expire 90 days after saving and are used only in your private Nari conversations, never public replies.</Text>
      <Text variant="caption">This does not delete DM history. Passwords, secrets, and free-text personal details cannot be stored here.</Text>
      {error ? <Text>{error}</Text> : null}
      <Button label={loading ? 'Loading…' : 'Refresh saved preferences'} loading={loading} onPress={() => void load()} />
    </View>
    {loaded && Object.entries(OPTIONS).map(([key, option]) => {
      const saved = rows.find((row) => row.key === key);
      return <SettingsGroup key={key} title={option.label}>
        <View style={{ padding: space.x4, gap: space.x3 }}>
          <Text variant="caption">{saved ? `Saved: ${saved.value} · Expires ${new Date(saved.expires_at).toLocaleDateString()}` : 'Not stored'}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.x2 }}>
            {option.values.map((value) => <Button key={value} label={value} variant={saved?.value === value ? 'primary' : 'secondary'} disabled={loading} size="sm" onPress={() => void save(key, value)} />)}
          </View>
          {saved && <Button label="Forget this preference" variant="danger" disabled={loading} onPress={() => void save(key, null, true)} />}
        </View>
      </SettingsGroup>;
    })}
  </ScrollScreen></Screen>;
}
