import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync('supabase/functions/_shared/operator/tools.ts','utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
globalThis.Deno={env:{get:()=>undefined}};
const {executeTool,permissionAllowed}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const tool={name:'campaign.create',permission:'campaign.write',enabled:true,approval_required:true,timeout_ms:1000,input_schema:{type:'object',required:['name'],properties:{name:{type:'string'}}},rate_limit_per_min:30};
const context={taskId:'task',channel:'admin_control',policy:{autonomy:{publish_content:true}}};
test('approval-gated execution validates and consumes before any write',async()=>{
  const original=globalThis.fetch;
  let writes=0,consumes=0,allow=false;
  const admin={rpc:async(name,args)=>{assert.equal(name,'operator_consume_approval');consumes++;assert.equal(args.p_task,'task');assert.equal(args.p_action,'campaign.create');assert.deepEqual(args.p_arguments,{name:'Plan'});return {data:allow,error:null};}};
  globalThis.fetch=async(_url,options={})=>{
    if(options.method==='POST') {writes++;return new Response(JSON.stringify([{id:'created',name:'Plan',status:'draft'}]),{status:201});}
    return new Response('[]');
  };
  try {
    const ctx={...context,admin};
    assert.equal((await executeTool(ctx,tool,'{"name":"Plan"}')).code,'approval_required');
    assert.equal((await executeTool(ctx,tool,'{}','approval')).code,'schema_validation');
    assert.equal((await executeTool({...ctx,policy:{}},tool,'{"name":"Plan"}','approval')).code,'permission_denied');
    assert.equal((await executeTool({...ctx,channel:'member_ai'},tool,'{"name":"Plan"}','approval')).code,'permission_denied');
    assert.equal(consumes,0);assert.equal(writes,0);
    assert.equal((await executeTool(ctx,tool,'{"name":"Plan"}','approval')).code,'approval_invalid');
    assert.equal(writes,0);
    allow=true;
    assert.equal((await executeTool(ctx,tool,'{"name":"Plan"}','approval')).ok,true);
    assert.equal(writes,1);assert.equal(consumes,2);
    admin.rpc=async()=>{throw new Error('unavailable');};
    assert.equal((await executeTool(ctx,tool,'{"name":"Plan"}','approval')).code,'approval_invalid');
    assert.equal(writes,1);
  } finally {globalThis.fetch=original;}
});
test('high-impact actions cannot become autonomous by omitting registry approval flags',()=>{
  for(const name of ['post.create','post.publish','post.delete','poll.create','notification.send','moderation.suspend','moderation.ban','moderation.restore','moderation.remove_content']) {
    assert.equal(permissionAllowed({...tool,name,approval_required:false},context).reason,'approval_required');
  }
});
test('worker replays stored action before spending provider budget and never regenerates its arguments',()=>{
  const worker=readFileSync('supabase/functions/operator-worker/index.ts','utf8');
  const begin=worker.indexOf("if (typeof input._approved_action_id === 'string')");
  const end=worker.indexOf('// Spend guard.',begin);
  assert.ok(begin>0 && end>begin);
  const replay=worker.slice(begin,end);
  assert.match(replay,/eq\('task_id', task.id\)/);
  assert.match(replay,/executeTool\(toolCtx, tool, raw, approvalId\)/);
  assert.doesNotMatch(replay,/callProvider\(/);
  assert.match(replay,/p_retryable: false/);
});
