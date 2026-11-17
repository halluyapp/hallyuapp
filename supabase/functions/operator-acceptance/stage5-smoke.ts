// Temporary authenticated production integration probe; no existing member data is read.
import { adminClient } from '../_shared/supabase.ts';
import { geminiInteraction, outputContent } from '../_shared/operator/voice.ts';
export async function stage5Smoke(run:string,ref:string):Promise<Record<string,unknown>> {
 const base=Deno.env.get('SUPABASE_URL')??'';const service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'';
 const admin=adminClient();const checks:Record<string,unknown>={};let authId='';let profileId='';let error='';
 const api=async(path:string,method='GET',body?:unknown,token=service):Promise<any>=>{const r=await fetch(base+path,{method,headers:{apikey:service,Authorization:'Bearer '+token,'Content-Type':'application/json',Prefer:'return=representation'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const d=await r.json().catch(()=>null);if(!r.ok)throw new Error(path+':'+r.status+':'+JSON.stringify(d).slice(0,160));return d;};
 const check=(name:string,ok:boolean)=>{checks[name]=ok?'pass':'fail';if(!ok)throw new Error(name);};
 await api('/rest/v1/operator_acceptance_run','POST',{id:run,state:'running',report:{kind:'stage5_smoke'}});
 try{
  if(!/^[a-f0-9]{40}$/.test(ref))throw new Error('immutable asset ref required');
  const image=await fetch('https://api.github.com/repos/halluyapp/hallyuapp/contents/public/nari-avatar.png?ref='+ref,{headers:{Accept:'application/vnd.github.raw+json'},signal:AbortSignal.timeout(15000)});
  if(!image.ok)throw new Error('avatar source unavailable');const bytes=await image.arrayBuffer();
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  check('avatar_integrity',digest==='b9b4a43e3fc89e08f919f1b3e1f4d08114f6cb432a4681bb98036f10677452cd');
  const upload=await fetch(base+'/storage/v1/object/media/avatars/nari/portrait-v1.png',{method:'POST',headers:{apikey:service,Authorization:'Bearer '+service,'Content-Type':'image/png','x-upsert':'true'},body:bytes,signal:AbortSignal.timeout(20000)});if(!upload.ok)throw new Error('avatar upload failed:'+upload.status);
  const staff=(await api('/rest/v1/operator_staff?active=eq.true&select=profile_id'))[0]?.profile_id;if(!staff)throw new Error('staff missing');
  await api('/rest/v1/profiles?id=eq.'+staff,'PATCH',{avatar_path:'avatars/nari/portrait-v1.png',display_name:'Nari'});
  check('avatar_installed',(await api('/rest/v1/profiles?id=eq.'+staff+'&select=avatar_path'))[0]?.avatar_path==='avatars/nari/portrait-v1.png');
  const email='stage5-'+run.slice(0,8)+'@example.invalid',password=crypto.randomUUID()+'Aa7!';
  const user=await api('/auth/v1/admin/users','POST',{email,password,email_confirm:true});authId=user.id;
  await api('/rest/v1/operator_acceptance_run?id=eq.'+run,'PATCH',{fixture_user_ids:[authId]});
  const signed=await api('/auth/v1/token?grant_type=password','POST',{email,password});const token=signed.access_token;
  profileId=await api('/rest/v1/rpc/register_profile','POST',{p_handle:'s5'+run.replace(/-/g,'').slice(0,16),p_display_name:'Stage5 isolated fixture'},token);
  // Exact legacy APK request must resolve without PostgREST overload ambiguity.
  const sent=await admin.rpc('operator_send_staff_message',{p_conversation:(await api('/rest/v1/operator_conversation','POST',{channel:'member_ai',member_profile_id:profileId}))[0].id,p_body:'Nari visible text acceptance '+run});if(sent.error)throw new Error(sent.error.message);
  const history=await api('/rest/v1/rpc/list_direct_messages','POST',{p_peer_handle:'hallyu.ai',p_limit:80},token);
  check('legacy_apk_history_visible',Array.isArray(history)&&history.some((m:any)=>m.body==='Nari visible text acceptance '+run));
  const page=await api('/rest/v1/rpc/list_direct_messages','POST',{p_peer_handle:'hallyu.ai',p_limit:80,p_before:null},token);
  check('paginated_history_visible',Array.isArray(page.messages)&&page.messages.length===1);
  let denied=false;try{await api('/functions/v1/operator-admin','POST',{action:'campaigns'},token);}catch(e){denied=String(e).includes(':403:');}check('member_admin_denial',denied);
  await api('/rest/v1/profiles?id=eq.'+profileId,'PATCH',{role:'admin'});
  const campaigns=await api('/functions/v1/operator-admin','POST',{action:'campaigns'},token);check('admin_campaign_access',campaigns!==null);
  const status=await api('/functions/v1/operator-voice','POST',{action:'status'},token);checks.voice_status=status;
  // TTS -> genuine Gemini audio -> authenticated public STT endpoint. No fake audio input.
  const key=Deno.env.get('GEMINI_VOICE_API_KEY')??'',model=Deno.env.get('GEMINI_VOICE_TTS_MODEL')??'';
  const generated=await geminiInteraction(key,{model,input:[{type:'user_input',content:[{type:'text',text:'Hello Nari. Please recommend a Korean drama.'}]}]});
  const audio=outputContent(generated).find((p:any)=>p.type==='audio');check('real_tts_wav',audio?.mime_type==='audio/wav'&&audio.data.length>100);
  try { const direct=await geminiInteraction(key,{model:Deno.env.get('GEMINI_VOICE_STT_MODEL'),input:[{type:'text',text:'Transcribe only.'},{type:'audio',data:audio!.data,mime_type:'audio/wav'}]}); checks.stt_direct=outputContent(direct).map((p:any)=>({type:p.type,text:String(p.text??'').slice(0,250)})); } catch(e) { checks.stt_diagnostic=(e as any).providerDetail ?? String(e); throw e; }
  const transcript=await api('/functions/v1/operator-voice','POST',{action:'transcribe',audio_base64:audio!.data,mime_type:'audio/wav'},token);
  check('real_voice_transcription',transcript.ok&&/drama/i.test(transcript.transcript));checks.transcript=String(transcript.transcript).slice(0,200);
 }catch(e){error=String(e).slice(0,500);}
 finally{
  try{
   if(profileId){await api('/rest/v1/operator_conversation?member_profile_id=eq.'+profileId,'DELETE');await api('/rest/v1/direct_messages?recipient_id=eq.'+profileId,'DELETE');await api('/rest/v1/profiles?id=eq.'+profileId,'DELETE');}
   if(authId)await api('/auth/v1/admin/users/'+authId,'DELETE');checks.cleanup='pass';
  }catch(e){checks.cleanup=String(e).slice(0,200);}
  await api('/rest/v1/operator_acceptance_run?id=eq.'+run,'PATCH',{state:error?'failed':'finished',finished_at:new Date().toISOString(),report:{kind:'stage5_smoke',checks,error:error||null}});
 }
 return {ok:!error,checks,error:error||null};
}
