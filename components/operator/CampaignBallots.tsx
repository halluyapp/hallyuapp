import React,{useCallback,useEffect,useRef,useState} from 'react';
import {View} from 'react-native';
import {router,type Href} from 'expo-router';
import * as Crypto from 'expo-crypto';
import {Button} from '../ui/Button';import {Text} from '../ui/Text';import {TextField} from '../ui/TextField';
import {space} from '../../constants/theme';
import type {CampaignDraft} from '../../lib/api/campaigns';
import {campaignBallotsApi,type BallotProposal,type CampaignReport} from '../../lib/api/campaignBallots';
export function CampaignBallots({campaign,onChanged}:{campaign:CampaignDraft;onChanged:()=>Promise<void>}){
 const [question,setQuestion]=useState('');const [options,setOptions]=useState('');const [closes,setCloses]=useState('');const [month,setMonth]=useState('');
 const [proposal,setProposal]=useState<BallotProposal|null>(null);const [report,setReport]=useState<CampaignReport|null>(null);
 const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);const [finish,setFinish]=useState<'complete'|'cancel'|null>(null);const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const load=useCallback(async()=>{if(!campaign.id)return;try{const r=await campaignBallotsApi.report(campaign.id);if(alive.current)setReport(r);}catch(e){if(alive.current)setNotice(e instanceof Error?e.message:'Report unavailable');}},[campaign.id]);
 useEffect(()=>{void load();},[load,campaign.version]);
 const run=async(action:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setNotice('');try{await action();if(!alive.current)return;setNotice('Verified in backend.');setProposal(null);setFinish(null);await load();await onChanged();}catch(e){if(alive.current)setNotice(e instanceof Error?e.message:'Operation failed');}finally{if(alive.current)setBusy(false);}};
 return <View style={{gap:space.x3}}>
  <Text>Campaign voting and measured performance</Text>
  <Text variant="caption">Ballots use the existing public post poll and one current vote per signed-in member. Options cannot be changed after launch. Monthly drama voting allows one non-cancelled ballot per calendar month.</Text>
  {!!notice&&<Text>{notice}</Text>}
  {campaign.status==='draft'&&['poll','vote'].includes(campaign.kind)&&<>
   <TextField label="Ballot question" value={question} onChangeText={setQuestion} editable={!busy&&!proposal}/>
   <TextField label="Ballot choices (one per line, 2–4)" value={options} onChangeText={setOptions} multiline editable={!busy&&!proposal}/>
   <TextField label="Ballot closes at" value={closes} onChangeText={setCloses} placeholder="2026-12-01T18:00:00+01:00" editable={!busy&&!proposal}/>
   {campaign.kind==='vote'&&<TextField label="Monthly drama vote month (optional YYYY-MM-01)" value={month} onChangeText={setMonth} editable={!busy&&!proposal}/>}
   <Text variant="caption">Launch opens voting now, posts publicly under your admin account, and uses the existing follower-notification pipeline. Closing time requires an explicit offset. For a future event, keep the draft and schedule an announcement; launch the ballot when ready.</Text>
   {!proposal?<Button label="Review public ballot launch" disabled={busy||!question.trim()||!closes||!options.trim()} onPress={()=>setProposal({campaign:campaign.id!,version:campaign.version,key:Crypto.randomUUID(),question,options:options.split('\n').map(x=>x.trim()).filter(Boolean),closes,month})}/>:<>
    <Text selectable>{`Approve public ballot:\n${proposal.question}\n${proposal.options.join('\n')}\nCloses: ${proposal.closes}\nMonthly slot: ${proposal.month||'none'}`}</Text>
    <Button label="Approve and launch ballot (or retry same approval)" disabled={busy} onPress={()=>void run(()=>campaignBallotsApi.launch(proposal))}/>
    <Button label="Back (refresh report after an uncertain result)" variant="ghost" disabled={busy} onPress={()=>setProposal(null)}/>
   </>}
  </>}
  <Button label="Refresh campaign performance" variant="secondary" disabled={busy} onPress={()=>void load()}/>
  {!!report&&<>
   <Text>{`Status: ${report.status} · Persisted votes: ${report.total_votes} · Active comments on ballot: ${report.comments}`}</Text>
   {Object.entries(report.announcement_counts).map(([status,n])=><Text key={status}>{status} announcements: {n}</Text>)}
   {report.ballot_options?.map((option,i)=><Text key={i}>{option.option}: {option.votes} vote(s)</Text>)}
   <Text variant="caption">{report.limitation} · {new Date(report.measured_at).toLocaleString()}</Text>
   {!!report.post_id&&<Button label="Open public ballot post" variant="secondary" onPress={()=>router.push(`/post/${report.post_id}` as Href)}/>}
  </>}
  {!['cancelled','completed'].includes(campaign.status)&&<>
   <Button label="Review campaign completion" variant="secondary" disabled={busy} onPress={()=>setFinish('complete')}/>
   <Button label="Review campaign cancellation" variant="danger" disabled={busy} onPress={()=>setFinish('cancel')}/>
   {!!finish&&<><Text>{finish==='cancel'?'Cancel':'Complete'} this campaign, close its ballot and cancel all remaining announcements? Published posts and aggregate votes are preserved.</Text><Button label={`Confirm ${finish} campaign`} disabled={busy} onPress={()=>void run(()=>campaignBallotsApi.finish(campaign.id!,campaign.version,finish==='cancel'))}/><Button label="Keep campaign running" variant="ghost" disabled={busy} onPress={()=>setFinish(null)}/></>}
  </>}
 </View>;
}
