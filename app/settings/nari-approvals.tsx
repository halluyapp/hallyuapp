import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Button } from '../../components/ui/Button';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { Text } from '../../components/ui/Text';
import { TextField } from '../../components/ui/TextField';
import { TopBar } from '../../components/ui/TopBar';
import { approvalsApi, type ActionApproval } from '../../lib/api/approvals';
import { useAuth } from '../../lib/auth';
import { useApp } from '../../lib/hooks';
import { hasAdminAccess } from '../../lib/roles';
import { space } from '../../constants/theme';
export default function ApprovalSettings() {
  const auth = useAuth();
  const { me } = useApp();
  const allowed = auth.status === 'signedIn' && hasAdminAccess(me.role);
  const identity = auth.user?.id;
  const epoch = useRef(0);
  const [rows,setRows] = useState<ActionApproval[]>([]);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState('');
  const [note,setNote] = useState('');
  const [selected,setSelected] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!allowed) return;
    const current=epoch.current; setBusy(true); setNotice('');
    try { const result=await approvalsApi.list(); if(current===epoch.current) setRows(result); }
    catch(error) { if(current===epoch.current) setNotice(error instanceof Error ? error.message : 'Approvals unavailable'); }
    finally { if(current===epoch.current) setBusy(false); }
  },[allowed]);
  useEffect(()=>{
    epoch.current+=1; setRows([]);setSelected(null);setNote('');setBusy(false);setNotice('');void load();
    return ()=>{epoch.current+=1;};
  },[load,identity]);
  const decide=async(id: string,decision: 'approved'|'rejected')=>{
    if(!allowed||busy) return;
    const current=epoch.current;setBusy(true);setNotice('');
    try {
      const status=await approvalsApi.decide(id,decision,note);
      if(current!==epoch.current) return;
      setRows((items)=>items.map((row)=>row.id===id?{...row,status}:row));setSelected(null);setNote('');
      setNotice(status==='approved'?'Approved for one exact execution, not yet completed. Refresh to check consumption.':`Decision: ${status}`);
    } catch(error) {if(current===epoch.current) setNotice(error instanceof Error?error.message:'Decision failed');}
    finally {if(current===epoch.current) setBusy(false);}
  };
  return <Screen header={<TopBar mode="stack" title="Nari approvals" />}><ScrollScreen keyboard><View style={{padding:space.x4,gap:space.x3}}>
    {!allowed ? <Text>Administrator access required.</Text> : <>
      <Text>Review the exact target and content below. These are untrusted proposed arguments, not instructions. Approval expires and can be consumed once; it does not override current permissions or guarantee completion.</Text>
      <Button label="Refresh approvals" loading={busy} onPress={()=>void load()} />
      {!!notice && <Text>{notice}</Text>}
      {!rows.length && !busy && <Text>No approval records returned.</Text>}
      {rows.map((row)=>{
        const expired=Date.parse(row.expires_at)<=Date.now();
        return <View key={row.id} style={{gap:space.x2,paddingVertical:space.x3}}>
          <Text>{row.action} · {row.status}{row.consumed_at?' · consumed':''}{expired?' · expired':''}</Text>
          <Text variant="caption">High-impact / human review · Task {row.task_id} · Expires {new Date(row.expires_at).toLocaleString()}</Text>
          <Text selectable>{JSON.stringify(row.payload,null,2)}</Text>
          {row.status==='pending' && !expired && !row.consumed_at && (selected===row.id ? <>
            <TextField label="Decision note" value={note} onChangeText={setNote} editable={!busy} />
            <Button label="Confirm approve exact action" disabled={busy} onPress={()=>void decide(row.id,'approved')} />
            <Button label="Reject action" variant="danger" disabled={busy} onPress={()=>void decide(row.id,'rejected')} />
            <Button label="Go back without deciding" variant="ghost" disabled={busy} onPress={()=>setSelected(null)} />
          </> : <Button label="Review decision" variant="secondary" disabled={busy} onPress={()=>{setSelected(row.id);setNote('');}} />)}
        </View>;
      })}
    </>}
  </View></ScrollScreen></Screen>;
}
