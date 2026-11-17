// Narrow OIDC test-fixture authority. No service-role key leaves the backend. Never accepts
// existing user/profile IDs, arbitrary roles, SQL, source URLs, or credentials from callers.
import { verifyGitHubActionsToken, type GitHubActionsIdentity } from '../_shared/githubActions.ts';
import { jsonResponse, errorResponse } from '../_shared/cors.ts';
const base = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/,'');
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
async function api(path: string, method='GET', body?: unknown): Promise<any> {
  const response = await fetch(base+path,{method,headers:{apikey:service,Authorization:`Bearer ${service}`,'Content-Type':'application/json',Prefer:'return=representation'},body:body===undefined ? undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const result = await response.json().catch(()=>null);
  if (!response.ok) throw new Error(`fixture_backend_${response.status}:${String(result?.code ?? result?.error_code ?? 'request_failed')}`);
  return result;
}
async function runs(identity: GitHubActionsIdentity): Promise<any[]> {
  return await api(`/rest/v1/operator_acceptance_run?select=id,fixture_user_ids,report,state&report->>kind=eq.ui_fixture&report->>github_run_id=eq.${identity.runId}&report->>github_attempt=eq.${identity.runAttempt}`);
}
async function fixtureProfile(run: any): Promise<any> {
  const user = run.fixture_user_ids?.[0];
  if (!user || run.fixture_user_ids.length !== 1) throw new Error('fixture_user_missing');
  const auth = await api(`/auth/v1/admin/users/${user}`);
  if (auth?.user_metadata?.nari_ui_fixture !== run.id) throw new Error('fixture_identity_mismatch');
  return (await api(`/rest/v1/profiles?select=id,role&auth_sub=eq.${user}`))[0] ?? null;
}
async function cleanup(run: any): Promise<void> {
  for (const user of run.fixture_user_ids ?? []) {
    const auth = await api(`/auth/v1/admin/users/${user}`).catch((error)=>{
      if(String(error).includes('fixture_backend_404')) return null;
      throw error;
    });
    if (!auth) continue;
    if (auth.user_metadata?.nari_ui_fixture !== run.id) throw new Error('fixture_cleanup_identity_mismatch');
    const profiles = await api(`/rest/v1/profiles?select=id&auth_sub=eq.${user}`);
    for (const profile of profiles) {
      await api(`/rest/v1/operator_memory?scope=eq.member&scope_id=eq.${profile.id}`,'DELETE');
      await api(`/rest/v1/profiles?id=eq.${profile.id}`,'DELETE');
    }
    await api(`/auth/v1/admin/users/${user}`,'DELETE');
  }
  // The slug is generated here, stored only in a service-writable ledger and bound to the run.
  if (run.report?.slug === `nari-ui-${run.id}`) await api(`/rest/v1/operator_knowledge?slug=eq.${run.report.slug}`,'DELETE');
  await api(`/rest/v1/operator_acceptance_run?id=eq.${run.id}`,'PATCH',{state:'finished',finished_at:new Date().toISOString(),report:{...run.report,cleanup:'pass'}});
}
Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return errorResponse('POST only',405);
  let identity: GitHubActionsIdentity;
  try {
    const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
    if (!token || token.length>20000) return errorResponse('GitHub OIDC required',401);
    identity = await verifyGitHubActionsToken(token,'halluyapp/hallyuapp',{
      audience:'hallyu-nari-ui',workflowFile:'deploy-web.yml',ref:'refs/heads/arena/3e7f1083-hallyuapp',repositoryId:'1374619123',
    });
  } catch { return errorResponse('GitHub workflow identity not authorized',403); }
  try {
    const body = await request.json();
    const action = body?.action;
    if (!['create','inspect','promote','cleanup'].includes(action)) return errorResponse('unsupported fixture action',400);
    const current = await runs(identity);
    if (action==='cleanup') { for(const run of current) await cleanup(run); return jsonResponse({ok:true,cleaned:current.length}); }
    if (action==='create') {
      if (current.length) return errorResponse('fixture already reserved for this workflow attempt',409);
      const id = crypto.randomUUID();
      const report = {kind:'ui_fixture',github_run_id:identity.runId,github_attempt:identity.runAttempt,slug:`nari-ui-${id}`,expires_at:new Date(Date.now()+20*60000).toISOString()};
      await api('/rest/v1/operator_acceptance_run','POST',{id,state:'running',report});
      const email = `nari.ui.${id}@example.invalid`;
      const password = crypto.randomUUID()+'Aa7!';
      let user: any;
      try {
        user = await api('/auth/v1/admin/users','POST',{email,password,email_confirm:true,user_metadata:{full_name:'Nari UI Acceptance',nari_ui_fixture:id}});
        await api(`/rest/v1/operator_acceptance_run?id=eq.${id}`,'PATCH',{fixture_user_ids:[user.id]});
      } catch (error) {
        if(user?.id) await api(`/auth/v1/admin/users/${user.id}`,'DELETE');
        await api(`/rest/v1/operator_acceptance_run?id=eq.${id}`,'PATCH',{state:'failed',finished_at:new Date().toISOString()});
        throw error;
      }
      return new Response(JSON.stringify({email,password,slug:report.slug}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    }
    if (current.length!==1 || current[0].state!=='running') return errorResponse('active fixture not found',404);
    const run = current[0];
    if(Date.parse(run.report.expires_at)<Date.now()) { await cleanup(run); return errorResponse('fixture expired',410); }
    const profile = await fixtureProfile(run);
    if (!profile) return errorResponse('fixture profile not provisioned',409);
    if (action==='promote') {
      // Elevated only after the member-boundary assertions, and only this run's generated fixture.
      await api(`/rest/v1/profiles?id=eq.${profile.id}`,'PATCH',{role:'admin'});
      await api('/rest/v1/rpc/operator_audit_write','POST',{p_action:'acceptance.fixture_promote',p_outcome:'succeeded',p_actor_type:'system',p_resource_type:'profile',p_resource_id:profile.id,p_details:{github_run_id:identity.runId}});
      return jsonResponse({ok:true});
    }
    const memory = await api(`/rest/v1/operator_memory?select=key&scope=eq.member&scope_id=eq.${profile.id}`);
    return jsonResponse({profile_id:profile.id,role:profile.role,memory_count:memory.length});
  } catch (error) { return errorResponse(error instanceof Error ? error.message : 'fixture_failed',500); }
});
