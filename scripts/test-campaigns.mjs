import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync('lib/api/campaigns.ts','utf8');
function load(db, token = true) {
  const module = {exports:{}};
  const code = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(`(function(exports,require,module){${code}\n})`,{Date,Error})(module.exports,()=>({supabase:db,ensureBackendSessionToken:async()=>token}),module);
  return module.exports;
}
test('campaign dates require explicit offsets and normalize to UTC',()=>{
  const {campaignTimestamp}=load(null);
  assert.equal(campaignTimestamp('2026-12-01T18:00:00+01:00'),'2026-12-01T17:00:00.000Z');
  assert.equal(campaignTimestamp(''),null);
  for(const value of ['tomorrow','2026-12-01T18:00','2026-99-01T18:00:00Z']) assert.throws(()=>campaignTimestamp(value),/ISO date/);
});
test('campaign save sends version and timezone, requires returned persisted record',async()=>{
  const entry={id:null,version:0,name:'Test',kind:'event',description:'Draft',objective:'Plan',timezone:'Africa/Lagos',starts_at:'2026-12-01T18:00:00+01:00',ends_at:null,status:'draft'};
  let body;
  const db={rpc:async(name,args)=>{assert.equal(name,'operator_campaign_save');body=args;return {data:{...entry,id:'test',version:1}};}};
  const saved=await load(db).campaignsApi.save(entry);
  assert.equal(saved.version,1); assert.equal(body.p_expected_version,0);
  assert.equal(body.p_timezone,'Africa/Lagos'); assert.equal(body.p_starts_at,'2026-12-01T17:00:00.000Z');
  db.rpc=async()=>({data:null,error:{message:'campaign changed; reload before editing'}});
  await assert.rejects(load(db).campaignsApi.save(entry),/reload/);
  db.rpc=async()=>({data:{}});
  await assert.rejects(load(db).campaignsApi.save(entry),/no verified record/);
  await assert.rejects(load(db,false).campaignsApi.save(entry),/Sign in/);
});
test('sign-up has no confirmation link route, redirect request or false session success',()=>{
  const auth=readFileSync('lib/auth.tsx','utf8');
  const signup=auth.slice(auth.indexOf('  const signUp ='),auth.indexOf('  const sendReset ='));
  assert.doesNotMatch(signup,/emailRedirectTo|return 'verify'/);
  assert.match(signup,/data\.session\?\.access_token && data\.user\?\.id/);
  assert.match(signup,/throw new AuthError\('credentials', 'No active session/);
  assert.doesNotMatch(readFileSync('app/(auth)/sign-up.tsx','utf8'),/auth\)\/verify/);
  assert.doesNotMatch(readFileSync('app/(auth)/verify.tsx','utf8'),/resendVerification|verification link/);
});
