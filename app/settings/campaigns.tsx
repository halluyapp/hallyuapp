import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Button } from '../../components/ui/Button';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { TextField } from '../../components/ui/TextField';
import { TopBar } from '../../components/ui/TopBar';
import { campaignsApi, type CampaignDraft } from '../../lib/api/campaigns';
import { CampaignSchedule } from '../../components/operator/CampaignSchedule';
import { useAuth } from '../../lib/auth';
import { useApp } from '../../lib/hooks';
import { hasAdminAccess } from '../../lib/roles';
import { space } from '../../constants/theme';
const empty = (): CampaignDraft => ({ id: null, version: 0, name: '', kind: 'campaign', description: '', objective: '', timezone: 'UTC', starts_at: null, ends_at: null, status: 'draft' });
export default function CampaignSettings() {
  const auth = useAuth();
  const { me } = useApp();
  const allowed = auth.status === 'signedIn' && hasAdminAccess(me.role);
  const identity = auth.user?.id;
  const epoch = useRef(0);
  const [entries, setEntries] = useState<CampaignDraft[]>([]);
  const [entry, setEntry] = useState<CampaignDraft>(empty);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    if (!allowed) return;
    const current = epoch.current;
    setBusy(true); setNotice('');
    try { const rows = await campaignsApi.list(); if (current === epoch.current) { setEntries(rows); setEntry(selected => selected.id ? rows.find(row => row.id === selected.id) ?? selected : selected); } }
    catch (err) { if (current === epoch.current) setNotice(err instanceof Error ? err.message : 'Campaigns unavailable'); }
    finally { if (current === epoch.current) setBusy(false); }
  }, [allowed]);
  useEffect(() => {
    epoch.current += 1; setEntries([]); setEntry(empty()); setNotice(''); setBusy(false);
    void load();
    return () => { epoch.current += 1; };
  }, [load, identity]);
  const save = async (cancel = false) => {
    if (!allowed || busy) return;
    const current = epoch.current;
    setBusy(true); setNotice('');
    try {
      const saved = await campaignsApi.save({ ...entry, status: cancel ? 'cancelled' : 'draft' });
      if (current !== epoch.current) return;
      setEntry(saved); setEntries((rows) => [saved, ...rows.filter((row) => row.id !== saved.id)]);
      setNotice(`Saved version ${saved.version}. ${cancel ? 'Campaign cancelled.' : 'Draft only; nothing was published or sent.'}`);
    } catch (err) { if (current === epoch.current) setNotice(err instanceof Error ? err.message : 'Save failed'); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  const editable = entry.status === 'draft';
  return <Screen header={<TopBar mode="stack" title="Campaign planner" />}><ScrollScreen keyboard>
    <View style={{ padding: space.x4, gap: space.x3 }}>
      {!allowed ? <Text>Administrator access required.</Text> : <>
        <Text>Create and edit campaign plans without Nari. Saving a draft does not schedule announcements, open voting or send reminders. Save first, then explicitly review and approve public announcement posts below. Poll/vote collection is not implemented by this planner.</Text>
        {!!notice && <Text>{notice}</Text>}
        <Button label="Refresh campaigns" loading={busy} onPress={() => void load()} />
        {entries.map((row) => <Button key={row.id} label={`${row.name} · ${row.status} · v${row.version}`} variant="secondary" disabled={busy} onPress={() => { setEntry(row); setNotice(''); }} />)}
        <Button label="New campaign" disabled={busy} variant="ghost" onPress={() => { setEntry(empty()); setNotice(''); }} />
        <TextField label="Campaign name" value={entry.name} onChangeText={(name) => setEntry({ ...entry, name })} editable={editable && !busy} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.x2 }}>
          {(['campaign', 'event', 'poll', 'vote'] as const).map((kind) => <Button key={kind} label={kind} size="sm" variant={entry.kind === kind ? 'primary' : 'secondary'} disabled={!editable || busy} onPress={() => setEntry({ ...entry, kind })} />)}
        </View>
        <TextField label="Campaign description" value={entry.description} multiline onChangeText={(description) => setEntry({ ...entry, description })} editable={editable && !busy} />
        <TextField label="Campaign objective" value={entry.objective} onChangeText={(objective) => setEntry({ ...entry, objective })} editable={editable && !busy} />
        <TextField label="IANA timezone" value={entry.timezone} placeholder="Africa/Lagos" autoCapitalize="none" onChangeText={(timezone) => setEntry({ ...entry, timezone })} editable={editable && !busy} />
        <Text variant="caption">Dates require explicit offsets (e.g. 2026-12-01T18:00:00+01:00). They are stored as UTC instants; the named timezone is retained for planning.</Text>
        <TextField label="Campaign start" value={entry.starts_at ?? ''} autoCapitalize="none" onChangeText={(starts_at) => setEntry({ ...entry, starts_at })} editable={editable && !busy} />
        <TextField label="Campaign end" value={entry.ends_at ?? ''} autoCapitalize="none" onChangeText={(ends_at) => setEntry({ ...entry, ends_at })} editable={editable && !busy} />
        {editable ? <>
          <Button label={`Save campaign draft (version ${entry.version})`} disabled={busy || !entry.name.trim()} loading={busy} onPress={() => void save()} />
          {!!entry.id && <Button label="Cancel campaign draft" variant="danger" disabled={busy} onPress={() => void save(true)} />}
        </> : <Text>This {entry.status} campaign is read only in the draft editor.</Text>}
        {!!entry.id && <CampaignSchedule key={`${identity}:${entry.id}`} campaign={entry} onChanged={load} />}
      </>}
    </View>
  </ScrollScreen></Screen>;
}
