import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const code = ts.transpileModule(readFileSync('supabase/functions/_shared/githubActions.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
globalThis.Deno = {env:{get:()=>undefined}};
const {verifyGitHubActionsToken} = await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const scope={audience:'hallyu-nari-ui',workflowFile:'deploy-web.yml',ref:'refs/heads/arena/3e7f1083-hallyuapp',repositoryId:'1374619123'};
const now=Math.floor(Date.now()/1000);
const payload={iss:'https://token.actions.githubusercontent.com',aud:scope.audience,repository:'halluyapp/hallyuapp',repository_id:scope.repositoryId,ref:scope.ref,workflow_ref:`halluyapp/hallyuapp/.github/workflows/deploy-web.yml@${scope.ref}`,event_name:'workflow_dispatch',exp:now+300,nbf:now-10,run_id:'1234',run_attempt:'1'};
test('fixture OIDC requires signed exact repository, workflow, branch, audience and dispatch event',async()=>{
  const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const jwk=await crypto.subtle.exportKey('jwk',keys.publicKey);
  const original=globalThis.fetch;
  globalThis.fetch=async(url)=>{assert.equal(url,'https://token.actions.githubusercontent.com/.well-known/jwks');return new Response(JSON.stringify({keys:[{...jwk,kid:'fixture'}]}));};
  const token=async(claims)=>{
    const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture'})).toString('base64url');
    const body=Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(header+'.'+body));
    return header+'.'+body+'.'+Buffer.from(signature).toString('base64url');
  };
  try {
    const good=await token(payload);
    assert.equal((await verifyGitHubActionsToken(good,'halluyapp/hallyuapp',scope)).runId,'1234');
    for(const bad of [{aud:'other'},{repository:'attacker/repo'},{repository_id:'9'},{ref:'refs/heads/main'},{workflow_ref:'attacker/workflow'},{event_name:'pull_request'},{exp:now-1},{run_id:'bad'}]) {
      await assert.rejects(verifyGitHubActionsToken(await token({...payload,...bad}),'halluyapp/hallyuapp',scope));
    }
    const parts=good.split('.');parts[1]=Buffer.from(JSON.stringify({...payload,run_id:'9999'})).toString('base64url');
    await assert.rejects(verifyGitHubActionsToken(parts.join('.'),'halluyapp/hallyuapp',scope),/signature/);
    await assert.rejects(verifyGitHubActionsToken(good,'halluyapp/hallyuapp'),/workflow/); // APK scope unchanged
  } finally {globalThis.fetch=original;}
});
test('browser workflow does not need the invalid service-role secret',()=>{
  const workflow=readFileSync('.github/workflows/deploy-web.yml','utf8');
  const step=workflow.slice(workflow.indexOf('- name: Explicit Nari deployed UI acceptance'),workflow.indexOf('- name: Ensure the backend catalog'));
  assert.ok(!step.includes('SUPABASE_SERVICE_ROLE_KEY'));
  assert.match(step,/always\(\)/);
  const fixtureSource=readFileSync('supabase/functions/operator-ui-fixture/index.ts','utf8');
  assert.match(fixtureSource,/fixture_identity_mismatch/);
  assert.match(fixtureSource,/fixture_cleanup_identity_mismatch/);
  assert.ok(!fixtureSource.includes('body.profile_id'));
  assert.ok(!fixtureSource.includes('body.user_id'));
});
test('fixture verifies ordinary signup without an admin email-confirm shortcut',()=>{
  const fixtureSource=readFileSync('supabase/functions/operator-ui-fixture/index.ts','utf8');
  assert.match(fixtureSource,/api\('\/auth\/v1\/signup'/);
  assert.match(fixtureSource,/!signup\.access_token \|\| !user\.email_confirmed_at/);
  assert.doesNotMatch(fixtureSource,/email_confirm:true/);
  assert.match(fixtureSource,/actor_profile_id=eq\.\$\{profile\.id\}&action=eq\.campaign\.created/);
});
