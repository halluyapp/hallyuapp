import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { Button } from '../ui/Button';
import { Text } from '../ui/Text';
import { TextField } from '../ui/TextField';
import { campaignScheduleApi, type CampaignAction, type ScheduleProposal } from '../../lib/api/campaignSchedule';
import type { CampaignDraft } from '../../lib/api/campaigns';
import { space } from '../../constants/theme';

export function CampaignSchedule({ campaign, onChanged }: { campaign: CampaignDraft; onChanged: () => Promise<void> }) {
  const [rows,setRows]=useState<CampaignAction[]>([]);
  const [body,setBody]=useState('');
  const [at,setAt]=useState('');
  const [timezone,setTimezone]=useState(campaign.timezone);
  const [repeat,setRepeat]=useState(0);
  const [count,setCount]=useState('1');
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [review,setReview]=useState<ScheduleProposal | null>(null);
  const [attempted,setAttempted]=useState(false);
  const epoch=useRef(0);
  const load=useCallback(async()=>{
    if(!campaign.id) return;
    const current=epoch.current;
    try {const result=await campaignScheduleApi.list(campaign.id);if(current===epoch.current)setRows(result);}
    catch(error){if(current===epoch.current)setNotice(error instanceof Error?error.message:'History unavailable');}
  },[campaign.id]);
  useEffect(()=>{epoch.current+=1;void load();return()=>{epoch.current+=1;};},[load]);
  const approve=async()=>{
    if(!review||busy) return;
    const current=epoch.current;setBusy(true);setAttempted(true);setNotice('');
    try {
      const saved=await campaignScheduleApi.schedule(review);
      if(current!==epoch.current)return;
      setNotice(`Approved ${saved.occurrences} occurrence(s). Nothing is published until each scheduled time.`);
      setReview(null);setAttempted(false);setBody('');setAt('');
      await load();await onChanged();
    }catch(error){if(current===epoch.current)setNotice(error instanceof Error?error.message:'Schedule failed');}
    finally{if(current===epoch.current)setBusy(false);}
  };
  const cancel=async(id:string)=>{
    if(busy)return;
    const current=epoch.current;setBusy(true);setNotice('');
    try{await campaignScheduleApi.cancel(id);if(current!==epoch.current)return;setNotice('Occurrence cancelled; an already-published post is not deleted.');await load();await onChanged();}
    catch(error){if(current===epoch.current)setNotice(error instanceof Error?error.message:'Cancellation failed');}
    finally{if(current===epoch.current)setBusy(false);}
  };
  return <View style={{gap:space.x3}}>
    <Text>Campaign announcements and reminder posts</Text>
    <Text variant="caption">Independent of Nari. Publishes the exact text as a public post under your admin account; the existing follower-notification pipeline applies. This does not send a mass reminder notification.</Text>
    {!!notice&&<Text>{notice}</Text>}
    {['draft','scheduled','active'].includes(campaign.status)&&<>
      <TextField label="Scheduled announcement text" value={body} onChangeText={setBody} multiline editable={!busy&&!review} />
      <TextField label="First announcement time" value={at} onChangeText={setAt} placeholder="2026-12-01T18:00:00+01:00" autoCapitalize="none" editable={!busy&&!review} />
      <TextField label="Schedule timezone" value={timezone} onChangeText={setTimezone} autoCapitalize="none" editable={!busy&&!review} />
      <View style={{flexDirection:'row',flexWrap:'wrap',gap:space.x2}}>
        {([[0,'Once'],[1,'Daily'],[7,'Weekly']] as const).map(([value,label])=><Button key={value} label={label} size="sm" variant={repeat===value?'primary':'secondary'} disabled={busy||!!review} onPress={()=>{setRepeat(value);if(value===0)setCount('1');}}/>)}
      </View>
      <TextField label="Number of occurrences (1–31)" value={count} onChangeText={setCount} keyboardType="number-pad" editable={!busy&&!review&&repeat!==0} />
      <Text variant="caption">Times require an explicit offset. Daily/weekly repeats keep local clock time in the named zone, within 90 days. DST gaps/overlaps use PostgreSQL standard-time preference. Outages catch up once within 24 hours; older occurrences are marked missed.</Text>
      {!review ? <Button label="Review announcement schedule" disabled={busy||!body.trim()||!at.trim()||!campaign.id} onPress={()=>setReview({campaign:campaign.id!,version:campaign.version,key:Crypto.randomUUID(),body,at,timezone,repeatDays:repeat,count:Number(count)})}/> : <>
        <Text selectable>{`Approve public text:\n${review.body}\nFirst time: ${review.at}\nTimezone: ${review.timezone}\nEvery ${review.repeatDays || 'one-time'} day(s), ${review.count} occurrence(s).`}</Text>
        <Button label={attempted?'Retry same approved schedule':'Approve and schedule public posts'} disabled={busy} loading={busy} onPress={()=>void approve()}/>
        <Button label={attempted?'Discard local proposal (check history first)':'Back to edit proposal'} variant="ghost" disabled={busy} onPress={()=>{setReview(null);setAttempted(false);}}/>
      </>}
    </>}
    <Button label="Refresh announcement history" variant="secondary" disabled={busy} onPress={()=>void load()}/>
    <Text variant="caption">Latest 100 occurrences. Published means a post was persisted; it does not measure views or participation.</Text>
    {!rows.length&&<Text>No scheduled announcements returned.</Text>}
    {rows.map(row=><View key={row.id} style={{gap:space.x2,paddingVertical:space.x2}}>
      <Text>{row.status} · {new Date(row.run_at).toLocaleString()} · {row.timezone}</Text>
      <Text selectable>{row.body}</Text>
      {!!row.post_id&&<Text variant="caption">Published post: {row.post_id}</Text>}
      {!!row.error_code&&<Text>Error: {row.error_code}</Text>}
      {row.status==='scheduled'&&<Button label="Cancel this announcement" variant="danger" disabled={busy} onPress={()=>void cancel(row.id)}/>}
    </View>)}
  </View>;
}
