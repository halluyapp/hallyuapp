import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { Button } from '../../components/ui/Button';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { TextField } from '../../components/ui/TextField';
import { TopBar } from '../../components/ui/TopBar';
import { intelligenceApi, type KnowledgeEntry, type KnowledgeRevision } from '../../lib/api/intelligence';
import { useApp } from '../../lib/hooks';
import { hasAdminAccess } from '../../lib/roles';
import { space } from '../../constants/theme';

const empty = (): KnowledgeEntry => ({ slug: '', title: '', body: '', source_url: null, visibility: 'staff', tags: [], version: 0, is_active: true });
export default function NariKnowledgeSettings() {
  const { me } = useApp();
  const allowed = hasAdminAccess(me.role);
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [entry, setEntry] = useState<KnowledgeEntry>(empty);
  const [revisions, setRevisions] = useState<KnowledgeRevision[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [activeVersion, setActiveVersion] = useState('');
  const [constitutionVersion, setConstitutionVersion] = useState('');
  const [constitutionBody, setConstitutionBody] = useState('');
  const load = useCallback(async () => {
    if (!allowed) return;
    setBusy(true); setNotice('');
    try {
      const [knowledge, policy] = await Promise.all([intelligenceApi.knowledge(), intelligenceApi.activeConstitution()]);
      setEntries(knowledge);
      if (policy) { setActiveVersion(policy.version); setConstitutionBody(policy.body); }
    }
    catch (err) { setNotice(err instanceof Error ? err.message : 'Knowledge unavailable'); }
    finally { setBusy(false); }
  }, [allowed]);
  useEffect(() => { void load(); }, [load]);
  const chooseEntry = async (item: KnowledgeEntry) => {
    setEntry(item); setRevisions([]); setBusy(true); setNotice('');
    try { setRevisions(await intelligenceApi.knowledgeHistory(item.slug)); }
    catch (err) { setNotice(err instanceof Error ? err.message : 'Revision history unavailable'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setNotice('');
    try {
      const version = await intelligenceApi.saveKnowledge(entry);
      setEntry({ ...entry, version }); setEntries(await intelligenceApi.knowledge()); setRevisions(await intelligenceApi.knowledgeHistory(entry.slug));
      setNotice(`Saved version ${version}. Future tasks retrieve the latest relevant active entry.`);
    } catch (err) { setNotice(err instanceof Error ? err.message : 'Save failed'); }
    finally { setBusy(false); }
  };
  const publish = async () => {
    setBusy(true); setNotice('');
    try { await intelligenceApi.publishConstitution(constitutionVersion, constitutionBody); setActiveVersion(constitutionVersion); setNotice('New constitution activated. Existing versions are preserved.'); }
    catch (err) { setNotice(err instanceof Error ? err.message : 'Activation failed'); }
    finally { setBusy(false); }
  };
  return <Screen header={<TopBar mode="stack" title="Nari knowledge & policy" />}><ScrollScreen keyboard>
    <View style={{ padding: space.x4, gap: space.x3 }}>
      {!allowed ? <Text>Administrator access required.</Text> : <>
        <Text>Curate sourced facts, not commands. Staff-only entries are excluded from member and public conversations. Security and approval checks cannot be overridden by knowledge or constitution text.</Text>
        {!!notice && <Text>{notice}</Text>}
        <Button label="Refresh knowledge" loading={busy} onPress={() => void load()} />
        {entries.map((item) => <Button key={item.slug} variant="secondary" size="sm" label={`${item.title} · v${item.version} · ${item.visibility}${item.is_active ? '' : ' · inactive'}`} disabled={busy} onPress={() => void chooseEntry(item)} />)}
        <Button label="New entry" variant="ghost" disabled={busy} onPress={() => { setEntry(empty()); setRevisions([]); }} />
        <TextField label="Unique slug" value={entry.slug} editable={!busy && entry.version === 0} maxLength={80} onChangeText={(slug) => setEntry({ ...entry, slug })} />
        <TextField label="Title" value={entry.title} editable={!busy} maxLength={200} onChangeText={(title) => setEntry({ ...entry, title })} />
        <TextField label="Knowledge body" value={entry.body} editable={!busy} multiline maxLength={8000} onChangeText={(body) => setEntry({ ...entry, body })} />
        <TextField label="HTTPS source URL (optional)" value={entry.source_url ?? ''} editable={!busy} maxLength={1000} autoCapitalize="none" onChangeText={(source_url) => setEntry({ ...entry, source_url })} />
        <TextField label="Search tags, comma-separated" value={entry.tags.join(',')} editable={!busy} onChangeText={(tags) => setEntry({ ...entry, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean) })} />
        <Button label={`Visibility: ${entry.visibility} · tap to change`} disabled={busy} variant="secondary" onPress={() => setEntry({ ...entry, visibility: entry.visibility === 'staff' ? 'public' : 'staff' })} />
        <Button label={`Entry is ${entry.is_active ? 'active' : 'inactive'} · tap to change`} disabled={busy} variant="secondary" onPress={() => setEntry({ ...entry, is_active: !entry.is_active })} />
        <Button label={`Save knowledge (expected version ${entry.version})`} loading={busy} onPress={() => void save()} />
        {revisions.length > 0 && <>
          <Text variant="titleSmall">Revision history (latest 20)</Text>
          {revisions.map((revision) => <View key={revision.version} style={{ gap: space.x2 }}>
            <Text variant="caption">v{revision.version} · {revision.visibility} · {new Date(revision.created_at).toLocaleString()}</Text>
            <Text>{revision.title}</Text><Text variant="bodySmall">{revision.body}</Text>
            {!!revision.source_url && <Text variant="caption">Source: {revision.source_url}</Text>}
          </View>)}
        </>}
        <Text variant="titleSmall">Publish a new constitution version</Text>
        <Text variant="caption">Active version: {activeVersion || 'not loaded'}</Text>
        <Text variant="caption">Publishing activates a new immutable version atomically. Use a unique version. Duplicate versions fail without deactivating the current one.</Text>
        <TextField label="New unique version" value={constitutionVersion} editable={!busy} maxLength={80} onChangeText={setConstitutionVersion} />
        <TextField label="New constitution body" value={constitutionBody} editable={!busy} multiline maxLength={12000} onChangeText={setConstitutionBody} />
        <Button label="Activate new constitution version" loading={busy} onPress={() => void publish()} />
      </>}
    </View>
  </ScrollScreen></Screen>;
}
