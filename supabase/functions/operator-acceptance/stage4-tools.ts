// Temporary real-transport release verifier. Fixtures must be reserved in the acceptance ledger.
// No fetch/RPC mocks. High-impact writes are separately covered by rollback-only real SQL.
import { executeTool, recordToolCall, type ToolContext, type ToolRow } from '../_shared/operator/tools.ts';
import { adminClient } from '../_shared/supabase.ts';
export async function verifyStage4Tools(run: string): Promise<Record<string, unknown>> {
 const base=(Deno.env.get('SUPABASE_URL')??'').replace(/\/$/,'');
 const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'';
 const api=async(path:string,method='GET',body?:unknown):Promise<any>=>{
  const r=await fetch(base+'/rest/v1/'+path,{method,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',Prefer:'return=representation'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const data=await r.json().catch(()=>null);if(!r.ok)throw new Error('backend '+r.status+':'+JSON.stringify(data).slice(0,300));return data;
 };
 const ledger=(await api('operator_acceptance_run?id=eq.'+run))[0];
 if(ledger?.state!=='running'||ledger?.report?.kind!=='stage4_tools'||Date.parse(ledger.report.expires_at)<Date.now())throw new Error('live fixture reservation required');
 const claimed=await api('operator_acceptance_run?id=eq.'+run+'&state=eq.running','PATCH',{state:'failed'});
 if(claimed.length!==1)throw new Error('fixture already claimed');
 const f=ledger.report;const checks:Record<string,unknown>={};
 const assert=(name:string,yes:boolean)=>{if(!yes)throw new Error('readback:'+name);};
 const ctx:ToolContext={admin:adminClient(),staffId:f.profile_id,staffHandle:f.handle,taskId:f.task_id,taskType:'admin_command',conversationId:f.conversation_id,channel:'admin_control',policy:{autonomy:{publish_content:true,research:true,send_notifications:true,suspend_or_ban:true,moderate_other_violations:true}}};
 const tools:ToolRow[]=await api('operator_tool?enabled=eq.true&select=*');
 const cases:Record<string,Record<string,unknown>>={
  'member.get':{profile_id:f.profile_id},'member.status':{profile_id:f.profile_id},
  'conversation.context':{conversation_id:f.conversation_id,limit:5},
  'message.reply':{conversation_id:f.conversation_id,body:'Isolated Stage4 gateway reply '+run},
  'comment.reply':{comment_id:f.comment_id,body:'Isolated Stage4 gateway comment '+run},
  'moderation.flag':{target_type:'post',target_id:f.post_id,reason:'Rollback follow-up fixture review',confidence:0.5},
  'moderation.queue':{limit:5},'moderation.rules':{},'analytics.platform':{},
  'research.search':{query:'Korea'},'research.web':{query:'Korean drama'},
  'research.save':{topic:run,headline:'Stage4 unverified fixture',summary:'Test evidence only',source_url:'https://github.com/halluyapp/hallyuapp',uncertainty:'Not independently verified'},
  'campaign.create':{name:'Stage4 '+run,kind:'campaign',payload:{acceptance_run:run}},
  'ops.task_list':{status:'failed',limit:5},'ops.task_retry':{task_id:f.retry_task_id},'ops.health':{},
 };
 try{
  for(const [name,args] of Object.entries(cases)){
   const tool=tools.find(t=>t.name===name);if(!tool)throw new Error('missing live registry tool:'+name);
   const invalid=await executeTool(ctx,tool,'{');assert(name+' malformed JSON',invalid.code==='invalid_json');
   const out=await executeTool(ctx,tool,JSON.stringify(args));
   await recordToolCall(ctx,out,JSON.stringify(args));
   if(!out.ok)throw new Error(name+':'+out.code+':'+out.error);
   const d:any=out.data;
   switch(name){
    case 'member.get':case 'member.status':assert(name,d.id===f.profile_id);break;
    case 'message.reply':assert(name,(await api('operator_message?task_id=eq.'+f.task_id+'&direction=eq.outbound')).some((r:any)=>r.body===args.body));break;
    case 'comment.reply':assert(name,(await api('comments?id=eq.'+d.comment.id))[0]?.body===args.body);break;
    case 'moderation.flag':assert(name,(await api('operator_moderation_case?id=eq.'+d.case.id))[0]?.target_id===f.post_id);break;
    case 'research.search':assert(name,Array.isArray(d.results));break;
    case 'research.web':assert(name,Array.isArray(d.results)&&d.results.length>0&&d.results.every((r:any)=>r.url.startsWith('https://en.wikipedia.org/')));break;
    case 'research.save':assert(name,(await api('operator_research_item?id=eq.'+d.item.id))[0]?.verification==='unverified');break;
    case 'campaign.create':assert(name,(await api('operator_campaign?id=eq.'+d.campaign.id))[0]?.status==='draft');break;
    case 'ops.task_retry':assert(name,d.id===f.retry_task_id&&d.status==='queued');await api('operator_task?id=eq.'+f.retry_task_id,'PATCH',{status:'cancelled'});break;
    case 'ops.task_list':assert(name,Array.isArray(d.tasks));break;
    case 'ops.health':assert(name,Array.isArray(d.providers)&&Array.isArray(d.workers)&&typeof d.checked_at==='string');break;
    default:assert(name,d!==null&&d!==undefined);
   }
   assert(name+' persisted audit',(await api('operator_tool_call?task_id=eq.'+f.task_id+'&tool=eq.'+name)).length===1);
   checks[name]={status:'pass',transport:'live',readback:true,audit:true};
   await api('operator_acceptance_run?id=eq.'+run,'PATCH',{report:{...f,checks}});
  }
  return {ok:true,checks};
 }catch(e){return {ok:false,checks,error:String(e).slice(0,500)};}
}
