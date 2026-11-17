import React,{useCallback,useEffect,useRef,useState} from 'react';
import {View} from 'react-native';
import {Screen,ScrollScreen} from '../../components/ui/Screen';import {TopBar} from '../../components/ui/TopBar';import {Text} from '../../components/ui/Text';import {Button} from '../../components/ui/Button';
import {ensureBackendSessionToken,supabase} from '../../lib/api/client';import {useAuth} from '../../lib/auth';import {useApp} from '../../lib/hooks';import {hasAdminAccess} from '../../lib/roles';import {space} from '../../constants/theme';
export default function NariStatus(){
 const auth=useAuth();const {me}=useApp();const allowed=auth.status==='signedIn'&&hasAdminAccess(me.role);const epoch=useRef(0);
 const [data,setData]=useState<Record<string,unknown>|null>(null);const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);
 const load=useCallback(async()=>{if(!allowed)return;const e=epoch.current;setBusy(true);setNotice('');try{if(!supabase||!(await ensureBackendSessionToken()))throw new Error('Sign in to inspect operator state');const {data:result,error}=await supabase.rpc('operator_stage4_status',{});if(error)throw new Error(error.message);if(!result?.checked_at)throw new Error('No verified status returned');if(e===epoch.current)setData(result);}catch(error){if(e===epoch.current){setData(null);setNotice(error instanceof Error?error.message:'Status unavailable');}}finally{if(e===epoch.current)setBusy(false);}},[allowed]);
 useEffect(()=>{epoch.current++;setData(null);void load();return()=>{epoch.current++;};},[load,auth.user?.id]);
 return <Screen header={<TopBar mode="stack" title="Nari operations status"/>}><ScrollScreen><View style={{padding:space.x4,gap:space.x3}}>
 {!allowed?<Text>Administrator access required.</Text>:<>
 <Text>Live backend observations, not a simulated health indicator. Refresh for current state. Detailed work and decisions remain in the existing admin control centre and approval queue.</Text>
 <Button label="Refresh live operator status" loading={busy} onPress={()=>void load()}/>{!!notice&&<Text>{notice}</Text>}
 {data&&Object.entries(data).map(([key,value])=><View key={key} style={{gap:space.x2}}><Text>{key.replaceAll('_',' ')}</Text><Text selectable variant="caption">{typeof value==='string'?value:JSON.stringify(value,null,2)}</Text></View>)}
 <Text variant="caption">Draft-only specialists can be requested in admin instructions using [specialist:research], [specialist:community], [specialist:campaign], [specialist:moderation] or [specialist:operations]. One pass maximum, no nested delegation or tools; Nari validates and independently checks the draft before any ordinary approved action.</Text>
 </>}
 </View></ScrollScreen></Screen>;
}
