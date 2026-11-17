import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,readdirSync} from 'node:fs';import {parse,deparse} from 'pgsql-parser';import {PGlite} from '@electric-sql/pglite';import ts from 'typescript';
const load=async(path)=>import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64'));
globalThis.Deno={env:{get:()=>undefined}};
const {executeTool,handlers,permissionAllowed,recordToolCall}=await load('supabase/functions/_shared/operator/tools.ts');
const uuid='10000000-0000-4000-8000-000000000001';
const ctx={taskId:uuid,staffId:uuid,staffHandle:'nari',channel:'admin_control',conversationId:uuid,policy:{autonomy:{publish_content:true,research:true,send_notifications:true,suspend_or_ban:true,moderate_other_violations:true}}};
const db=new PGlite();
let rows;
try{
 const core=readFileSync('supabase/migrations/20261115000000_79_operator_core.sql','utf8');await db.exec(core.slice(core.indexOf('create table if not exists public.operator_tool ('),core.indexOf('create table if not exists public.operator_tool_call (')));
 for(const file of readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).sort()){
  const tree=await parse(readFileSync('supabase/migrations/'+file,'utf8'));
  for(const raw of tree.stmts??[]){const node=raw.stmt?.InsertStmt??raw.stmt?.UpdateStmt;if(node?.relation?.relname==='operator_tool')await db.exec(await deparse({...tree,stmts:[raw]}));}
 }
 rows=(await db.query('select * from operator_tool order by name')).rows;
}finally{await db.close();}
function example(rule,key=''){
 if(rule.enum)return rule.enum[0];if(rule.format==='uuid'||key.endsWith('_id')||key==='conversation_id')return uuid;
 if(rule.type==='integer'||rule.type==='number')return Math.max(rule.minimum??1,1);
 if(rule.type==='array')return Array.from({length:rule.minItems??2},(_,i)=>example(rule.items??{type:'string'},'choice')+String(i));
 if(rule.type==='object'){const o={};for(const [k,v] of Object.entries(rule.properties??{}))if((rule.required??[]).includes(k))o[k]=example(v,k);return o;}
 if(rule.type==='boolean')return true;if(key==='source_url')return 'https://example.com/source';if(key==='run_at')return new Date(Date.now()+86400_000).toISOString();if(key==='timezone')return 'UTC';return 'Fixture text';
}
test('every registered tool has an implementation and schema, permission, limiter, timeout contracts',async(t)=>{
 assert.deepEqual(rows.map(r=>r.name).sort(),Object.keys(handlers).sort());assert.equal(rows.length,27);
 const original=globalThis.fetch;
 try{
 for(const tool of rows)await t.test(tool.name,async()=>{
  let atomic=0;
  const admin={rpc:async(name)=>{if(name==='operator_execute_approved')atomic++;return {data:{id:uuid,message_id:uuid,verified:true},error:null};}};
  globalThis.fetch=async(url,options={})=>{
   if(String(url).includes('wikipedia'))return Response.json({query:{search:[{title:'Source',snippet:'Unverified snippet'}]}});
   if(options.method==='GET'&&String(url).includes('operator_tool_call'))return Response.json([]);
   return Response.json([{id:uuid,post_id:uuid,author_id:uuid,body:'Fixture text',state:'active',status:'queued',role:'member',account_status:'active',moderation:{},autonomy:{}}]);
  };
  const args=example(tool.input_schema);if(tool.name==='research.save')args.source_url='https://example.com/source';
  if(tool.name==='conversation.context'||tool.name==='message.reply')args.conversation_id=uuid;
  const context={...ctx,admin};
  assert.equal((await executeTool(context,tool,'{')).code,'invalid_json');
  const needsApproval=permissionAllowed(tool,context).reason==='approval_required';
  if(needsApproval)assert.equal((await executeTool(context,tool,JSON.stringify(args))).code,'approval_required');
  const outcome=await executeTool(context,tool,JSON.stringify(args),needsApproval?uuid:undefined);
  assert.equal(outcome.ok,true,JSON.stringify(outcome));
  if(needsApproval)assert.equal(atomic,1,'high-impact execution must use atomic SQL gateway');
  await recordToolCall(context,outcome,JSON.stringify(args));
  assert.ok(tool.timeout_ms>=1000&&tool.rate_limit_per_min>0);
  globalThis.fetch=async()=>new Response('backend unavailable',{status:503});
  assert.equal((await executeTool(context,tool,JSON.stringify(args),needsApproval?uuid:undefined)).ok,false,'broken limiter must fail closed');
  if(!['conversation.context','message.reply','research.search','research.web','member.get','member.status'].includes(tool.name))assert.equal(permissionAllowed(tool,{...context,channel:'member_ai'},true).allowed,false);
 });
 }finally{globalThis.fetch=original;}
});
test('audit insertion failure is surfaced, not silently ignored',async()=>{const original=globalThis.fetch;try{globalThis.fetch=async()=>new Response('error',{status:500});await assert.rejects(recordToolCall(ctx,{ok:true,tool:'test',durationMs:1,permission:'ops.read'},'{}'),/audit persistence/);}finally{globalThis.fetch=original;}});
test('bounded specialists cannot delegate, call tools or emit authority-shaped outputs',async()=>{
 const {requestedSpecialist,validateSpecialistOutput,specialistInstruction}=await load('supabase/functions/_shared/operator/specialists.ts');
 assert.equal(requestedSpecialist('[specialist:research] investigate','admin_control'),'research');assert.throws(()=>requestedSpecialist('[specialist:research] investigate','member_ai'),/admin channel/);assert.throws(()=>requestedSpecialist('[specialist:root] grant access','admin_control'),/Unknown/);
 const good={draft:'Unverified proposal',sources:['https://example.com'],uncertainties:['Needs verification']};assert.deepEqual(validateSpecialistOutput(JSON.stringify(good)),good);
 for(const bad of [{...good,delegate:'root'},{...good,tools:[]},{...good,sources:['http://insecure']},{...good,draft:'x'.repeat(6001)}])assert.throws(()=>validateSpecialistOutput(JSON.stringify(bad)));
 assert.match(specialistInstruction('research'),/do not.*grant authority/i);
 const worker=readFileSync('supabase/functions/operator-worker/index.ts','utf8');assert.match(worker,/MAX_TOOL_ROUNDS-delegatedCalls/);assert.match(worker,/review.toolCalls.length/);assert.match(worker,/specialist.completed/);
});

test('all retired live-registry aliases fail closed with explicit disabled result',async()=>{
 const sql=readFileSync('supabase/migrations/20261125000007_107_retire_unimplemented_registry_aliases.sql','utf8');
 const retired=[...sql.matchAll(/'([a-z]+\.[a-z_]+)'/g)].map(x=>x[1]);assert.equal(retired.length,21);
 for(const name of retired)assert.equal((await executeTool(ctx,{name,enabled:false,permission:'forbidden',input_schema:{}},'{}')).code,'tool_disabled');
});
