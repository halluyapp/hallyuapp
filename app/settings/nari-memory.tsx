import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { SettingsGroup } from '../../components/settings/Rows';
import { Button } from '../../components/ui/Button';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { TopBar } from '../../components/ui/TopBar';
import { intelligenceApi, type NariPreference } from '../../lib/api/intelligence';
import { useAuth } from '../../lib/auth';
import { space } from '../../constants/theme';

const OPTIONS: Record<string, { label: string; values: string[] }> = {
  preferred_language: { label: 'Reply language', values: ['en','ko','zh','ja'] },
  favorite_genre: { label: 'Favorite genre', values: ['romance','thriller','comedy','fantasy','drama','action','animation','historical'] },
  spoiler_preference: { label: 'Spoiler preference', values: ['avoid','allow'] },
};
export default function NariMemorySettings() {
  const auth = useAuth();
  const epoch = useRef(0);
  const [rows, setRows] = useState<NariPreference[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    if (auth.status !== 'signedIn') return;
    const requestEpoch = epoch.current;
    setLoading(true); setError('');
    try {
      const result = await intelligenceApi.memory();
      if (requestEpoch === epoch.current) { setRows(result); setLoaded(true); }
    } catch (err) {
      if (requestEpoch === epoch.current) setError(err instanceof Error ? err.message : 'Memory unavailable');
    } finally { if (requestEpoch === epoch.current) setLoading(false); }
  }, [auth.status, auth.user?.id]);
  useEffect(() => {
    epoch.current += 1;
    setRows([]); setLoaded(false); setError(''); setLoading(false);
    if (auth.status === 'signedIn') void load();
    return () => { epoch.current += 1; };
  }, [load, auth.status]);
  const save = async (key: string, value: string | null, remove = false) => {
    if (auth.status !== 'signedIn') return;
    const requestEpoch = epoch.current;
    setLoading(true); setError('');
    try {
      const result = await intelligenceApi.memory(key, value, remove);
      if (requestEpoch === epoch.current) setRows(result);
    } catch (err) {
      if (requestEpoch === epoch.current) setError(err instanceof Error ? err.message : 'Could not update memory');
    } finally { if (requestEpoch === epoch.current) setLoading(false); }
  };
  return <Screen header={<TopBar mode="stack" title="Nari memory" />}><ScrollScreen>
    <View style={{ padding: space.x4, gap: space.x3 }}>
      <Text>Choose what Nari may remember. Nothing is saved automatically. Preferences expire 90 days after saving and are used only in your private Nari conversations, never public replies.</Text>
      <Text variant="caption">This does not delete DM history. Passwords, secrets, and free-text personal details cannot be stored here.</Text>
      {auth.status === 'loading' && <Text>Restoring your session…</Text>}
      {auth.status !== 'loading' && auth.status !== 'signedIn' && <Text>Sign in to manage Nari intelligence.</Text>}
      {error ? <Text>{error}</Text> : null}
      <Button label={loading ? 'Loading…' : 'Refresh saved preferences'} loading={loading} disabled={auth.status !== 'signedIn'} onPress={() => void load()} />
    </View>
    {loaded && auth.status === 'signedIn' && Object.entries(OPTIONS).map(([key, option]) => {
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
