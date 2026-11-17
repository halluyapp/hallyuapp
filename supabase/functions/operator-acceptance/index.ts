import { stage5Smoke } from './stage5-smoke.ts';
// Temporary release verifier: deploy only for acceptance, invoke with the Vault worker token,
// then remove the deployed endpoint. Never returns credentials. Fixture users are removed in finally.
import { verifyStage4Tools, verifyStage4Push } from './stage4-tools.ts';
import { reasoningCases, gradeReasoningReply } from '../_shared/operator/evaluation.ts';
import { adminClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse } from '../_shared/cors.ts';
const base = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const admin = adminClient();

async function api(path: string, method = 'GET', body?: unknown, token = service): Promise<any> {
  const response = await fetch(base + path, { method, headers: { apikey: service, Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`HTTP_${response.status}:${String(data?.code ?? data?.error_code ?? 'request_failed')}`);
  return data;
}
const rpc = (name: string, body: unknown, token = service) => api('/rest/v1/rpc/' + name, 'POST', body, token);
Deno.serve(async (request: Request) => {
  const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (request.method !== 'POST' || !token || (await admin.rpc('operator_verify_worker', { p_token: token })).data !== true) return errorResponse('unauthorized',401);
  const body = await request.json().catch(() => null);
  const run = typeof body?.run_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.run_id) ? body.run_id : null;
  if (!run) return errorResponse('run_id required',400);
  if (body?.mode === 'voice_models') {
    const key=Deno.env.get('GEMINI_VOICE_API_KEY')??'';
    const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',{headers:{'x-goog-api-key':key},signal:AbortSignal.timeout(15000)});
    const data=await response.json();
    return jsonResponse({http_status:response.status,models:(data.models??[]).filter((m:any)=>m.supportedGenerationMethods?.includes('generateContent')).map((m:any)=>({name:m.name,methods:m.supportedGenerationMethods}))});
  }
  if (body?.mode === 'stage5_smoke') return jsonResponse(await stage5Smoke(run,body.release_ref));
  if (body?.mode === 'stage4_push') return jsonResponse(await verifyStage4Push());
  if (body?.mode === 'stage4_tools') return jsonResponse(await verifyStage4Tools(run));
  const reserved = await api('/rest/v1/operator_acceptance_run', 'POST', { id: run, state: 'running' }).catch(() => null);
  if (!reserved) return errorResponse('run already exists or ledger unavailable',409);
  const checks: Record<string, unknown> = {};
  const users: { auth: string; profile: string; token: string }[] = [];
  const fixtureKnowledge: string[] = [];
  const prefix = 'ideal-' + run.slice(0,8);
  const check = (name: string, value: boolean) => { checks[name] = value ? 'pass' : 'fail'; if (!value) throw new Error('assertion:' + name); };
  let failure: string | null = null;
  try {
    for (const suffix of ['a','b']) {
      const email = `${prefix}-${suffix}@example.invalid`;
      const password = crypto.randomUUID() + 'Aa7!';
      const created = await api('/auth/v1/admin/users','POST',{ email,password,email_confirm:true,user_metadata:{handle:prefix.replace(/-/g,'')+suffix,full_name:'IDEAL Acceptance',ideal_acceptance_run:run} });
      const user = { auth: String(created.id), profile: '', token: '' }; users.push(user);
      await api(`/rest/v1/operator_acceptance_run?id=eq.${run}`,'PATCH',{ fixture_user_ids: users.map((entry) => entry.auth) });
      const signed = await api('/auth/v1/token?grant_type=password','POST',{email,password});
      user.token = signed.access_token;
      // Match the actual app: authentication and application profile provisioning are separate.
      user.profile = await rpc('register_profile',{p_handle:prefix.replace(/-/g,'')+suffix,p_display_name:'IDEAL Acceptance'},user.token);
      if (!user.profile) throw new Error('test_profile_provisioning_failed');
      check('identity_' + suffix,(await rpc('current_profile_id',{},user.token)) === user.profile);
    }
    const [a,b] = users;
    await rpc('operator_my_memory',{p_key:'favorite_genre',p_value:'thriller'},a.token);
    await rpc('operator_my_memory',{p_key:'favorite_genre',p_value:'comedy'},b.token);
    check('self_memory',(await rpc('operator_my_memory',{},a.token))[0]?.value === 'thriller');
    check('cross_user_memory',(await rpc('operator_my_memory',{},b.token))[0]?.value === 'comedy');
    await rpc('operator_my_memory',{p_key:'favorite_genre',p_value:'romance'},a.token);
    check('memory_correction',(await rpc('operator_my_memory',{},a.token)).length === 1);
    await rpc('operator_my_memory',{p_key:'favorite_genre',p_delete:true},a.token);
    check('memory_delete',(await rpc('operator_my_memory',{},a.token)).length === 0);
    await rpc('operator_my_memory',{p_key:'favorite_genre',p_value:'thriller'},a.token);
    let denied = false;
    try { await rpc('operator_knowledge_edit',{p_slug:prefix,p_title:'Fixture',p_body:'Fixture evidence',p_source_url:null,p_visibility:'public',p_tags:['fixture'],p_expected_version:0},b.token); } catch { denied = true; }
    check('member_cannot_edit_knowledge',denied);
    await api(`/rest/v1/profiles?id=eq.${a.profile}`,'PATCH',{role:'admin'}); // only the newly-created fixture, never existing members
    const slug = prefix + '-knowledge'; fixtureKnowledge.push(slug);
    const edit = (version: number, text: string) => rpc('operator_knowledge_edit',{p_slug:slug,p_title:'IDEAL fixture knowledge',p_body:text,p_source_url:'https://github.com/halluyapp/hallyuapp',p_visibility:'staff',p_tags:['ideal-fixture'],p_expected_version:version},a.token);
    check('knowledge_create',(await edit(0,'Fixture version one.')) === 1);
    check('knowledge_update',(await edit(1,'Fixture version two.')) === 2);
    denied = false; try { await edit(1,'Stale fixture.'); } catch { denied = true; }
    check('knowledge_conflict',denied);
    const knowledge = await api(`/rest/v1/operator_knowledge?select=id,version&slug=eq.${slug}`);
    check('knowledge_revisions',(await api(`/rest/v1/operator_knowledge_revision?select=version&knowledge_id=eq.${knowledge[0].id}`)).length === 2);
    const active = await rpc('operator_active_constitution',{});
    check('active_constitution',typeof active === 'string' && active.startsWith('Active constitution version:'));
    // Restore the fixture to member before exercising normal member DM behavior.
    await api(`/rest/v1/profiles?id=eq.${a.profile}`,'PATCH',{role:'member'});
    const providers = await api('/rest/v1/operator_provider?select=provider,model_id&is_default=eq.true&enabled=eq.true');
    if (providers.length !== 1) throw new Error('explicit_default_provider_missing');
    checks.active_provider = providers[0];
    // Uses actual user -> ordinary DM RPC -> durable task -> deployed worker -> configured provider.
    const dm = await rpc('send_direct_message',{p_recipient_handle:'hallyu.ai',p_body:'Acceptance check: What favorite genre have I explicitly saved? Reply with that saved preference only. Do not publish anything or message anyone else.',p_shared_drama_id:null,p_shared_post_id:null},a.token);
    const convs = await api(`/rest/v1/operator_conversation?select=id&channel=eq.member_ai&member_profile_id=eq.${a.profile}`);
    if (!convs[0]?.id) throw new Error('ordinary_dm_conversation_missing');
    const conv = convs[0].id;
    const tasks = await api(`/rest/v1/operator_task?select=id&conversation_id=eq.${conv}&order=created_at.desc&limit=1`);
    if (!tasks[0]?.id) throw new Error('ordinary_dm_task_missing');
    const task = tasks[0].id;
    await api(`/rest/v1/operator_task?id=eq.${task}`,'PATCH',{max_attempts:1});
    checks.task_id = task; checks.dm_id = dm?.id ?? null;
    await fetch(base + '/functions/v1/operator-worker',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({task_id:task,limit:1}),signal:AbortSignal.timeout(70000)}).catch(() => null);
    let row: any;
    for (let attempt=0;attempt<12;attempt++) {
      row = (await api(`/rest/v1/operator_task?select=status,error_code,error_detail,provider,model,result&id=eq.${task}`))[0];
      if (['completed','failed','cancelled','blocked'].includes(row?.status)) break;
      await new Promise((resolve)=>setTimeout(resolve,2000));
    }
    checks.live_task = {status:row?.status,error_code:row?.error_code,error_detail:row?.error_code === 'bad_response' ? row?.error_detail : undefined,provider:row?.provider,model:row?.model};
    const audits = await api(`/rest/v1/operator_audit?select=details&task_id=eq.${task}&action=eq.context.loaded`);
    check('deployed_context_loaded',audits.some((entry:any)=>entry.details?.constitution_loaded === true && entry.details?.preferences_supplied === 1));
    if (row?.status !== 'completed') { checks.real_provider_reasoning = 'blocked:' + (row?.error_code ?? row?.status); checks.reasoning_evaluations = {status:'blocked',cases:reasoningCases.map((entry)=>entry.id),reason:row?.error_code ?? row?.status}; }
    else {
      const replies = await api(`/rest/v1/direct_messages?select=body&recipient_id=eq.${a.profile}&order=created_at.desc&limit=1`);
      check('live_saved_memory_reply',/thriller/i.test(String(replies[0]?.body ?? '')));
      checks.real_provider_reasoning = 'pass';
      checks.reply_excerpt = String(replies[0]?.body ?? '').slice(0,200);
      const evaluations: Record<string, unknown> = {
        saved_preference: gradeReasoningReply(reasoningCases[0], String(replies[0]?.body ?? '')),
      };
      for (const test of reasoningCases.slice(1)) {
        const sent = await rpc('send_direct_message',{p_recipient_handle:'hallyu.ai',p_body:test.prompt,p_shared_drama_id:null,p_shared_post_id:null},a.token);
        const queued = await api(`/rest/v1/operator_task?select=id&conversation_id=eq.${conv}&order=created_at.desc&limit=1`);
        if (!queued[0]?.id) throw new Error('evaluation_task_missing');
        const evaluationTask = queued[0].id;
        await api(`/rest/v1/operator_task?id=eq.${evaluationTask}`,'PATCH',{max_attempts:1});
        await fetch(base+'/functions/v1/operator-worker',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({task_id:evaluationTask,limit:1}),signal:AbortSignal.timeout(70000)}).catch(()=>null);
        const state = (await api(`/rest/v1/operator_task?select=status,error_code&id=eq.${evaluationTask}`))[0];
        if (state?.status !== 'completed') { evaluations[test.id] = {blocked:state?.error_code ?? state?.status}; break; }
        const answer = (await api(`/rest/v1/direct_messages?select=body&recipient_id=eq.${a.profile}&order=created_at.desc&limit=1`))[0]?.body ?? '';
        evaluations[test.id] = {...gradeReasoningReply(test,String(answer)),reply_excerpt:String(answer).slice(0,500),inbound_message:sent?.id ?? null};
      }
      checks.reasoning_evaluations = evaluations;

    }
  } catch (error) { failure = error instanceof Error ? error.message.slice(0,200) : 'acceptance_error'; }
  finally {
    const cleanupErrors: string[] = [];
    for (const slug of fixtureKnowledge) await api(`/rest/v1/operator_knowledge?slug=eq.${slug}`,'DELETE').catch(()=>cleanupErrors.push('knowledge_cleanup'));
    for (const user of users.reverse()) {
      if (user.profile) {
        await api(`/rest/v1/operator_memory?scope=eq.member&scope_id=eq.${user.profile}`,'DELETE').catch(()=>cleanupErrors.push('memory_cleanup'));
        const conversations = await api(`/rest/v1/operator_conversation?select=id&member_profile_id=eq.${user.profile}`).catch(()=>[]);
        for (const conv of conversations) {
          await api(`/rest/v1/operator_task?conversation_id=eq.${conv.id}`,'DELETE').catch(()=>cleanupErrors.push('task_cleanup'));
          await api(`/rest/v1/operator_conversation?id=eq.${conv.id}`,'DELETE').catch(()=>cleanupErrors.push('conversation_cleanup'));
        }
        await api(`/rest/v1/profiles?id=eq.${user.profile}`,'DELETE').catch(()=>cleanupErrors.push('profile_cleanup'));
      }
      await api(`/auth/v1/admin/users/${user.auth}`,'DELETE').catch(()=>cleanupErrors.push('auth_cleanup'));
    }
    checks.cleanup = cleanupErrors.length ? cleanupErrors : 'pass';
    await api(`/rest/v1/operator_acceptance_run?id=eq.${run}`,'PATCH',{state:failure ? 'failed':'finished',report:{checks,error:failure},finished_at:new Date().toISOString()});
  }
  return jsonResponse({run_id:run,checks,error:failure},failure ? 500:200);
});
