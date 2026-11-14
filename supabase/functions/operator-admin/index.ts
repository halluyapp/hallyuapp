// Hallyu AI Operator — Control Centre API.
//
// Every screen in the admin Control Centre talks to this function. It authenticates the caller's
// Supabase session, resolves their Hallyu profile, and requires an admin/CEO role before returning
// any operator data. It never accepts a profile id from the client as proof of identity.

import { adminClient } from '../_shared/supabase.ts';
import { corsHeaders, jsonResponse, errorResponse } from '../_shared/cors.ts';

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

interface Caller {
  profileId: string;
  role: string;
  handle: string;
  displayName: string;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function resolveCaller(token: string): Promise<Caller | null> {
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userResponse.ok) return null;
  const user = (await userResponse.json().catch(() => null)) as { id?: string } | null;
  if (!user?.id) return null;

  const admin = adminClient();
  const profile = await admin
    .from<Record<string, unknown>>('profiles')
    .select('id,role,handle,display_name,account_status')
    .eq('auth_sub', user.id)
    .limit(1);
  const row = asArray<Record<string, unknown>>(profile.data)[0];
  if (!row || row.account_status !== 'active') return null;
  if (row.role !== 'admin' && row.role !== 'ceo') return null;

  return {
    profileId: String(row.id),
    role: String(row.role),
    handle: String(row.handle ?? ''),
    displayName: String(row.display_name ?? ''),
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return errorResponse('POST only', 405);

  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!token) return errorResponse('authorization required', 401);

  const caller = await resolveCaller(token);
  if (!caller) return errorResponse('admin access required', 403);

  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return errorResponse('invalid JSON body', 400);
  }

  const action = String(body.action ?? '');
  const admin = adminClient();

  try {
    switch (action) {
      case 'overview': {
        const [analytics, providers, workers, tasks, approvals] = await Promise.all([
          admin.rpc('operator_platform_analytics', {}),
          admin.from('operator_provider').select('provider,label,model_id,enabled,is_default,health,last_ok_at,last_error_at,last_error_code,rpm_limit'),
          admin.from('operator_worker_health').select('worker_id,last_seen_at,version,tasks_processed,last_error').order('last_seen_at', { ascending: false }).limit(5),
          admin.from('operator_task').select('status').limit(5000),
          admin.from('operator_approval').select('id,status').eq('status', 'pending'),
        ]);
        const counts: Record<string, number> = {};
        for (const row of asArray<Record<string, unknown>>(tasks.data)) {
          const key = String(row.status ?? 'unknown');
          counts[key] = (counts[key] ?? 0) + 1;
        }
        return jsonResponse({
          analytics: analytics.data ?? null,
          providers: providers.data ?? [],
          workers: workers.data ?? [],
          task_counts: counts,
          pending_approvals: asArray(approvals.data).length,
          caller,
        });
      }

      case 'conversations': {
        const result = await admin
          .from('operator_conversation')
          .select('id,channel,member_profile_id,external_thread_id,subject,status,last_inbound_at,last_outbound_at,created_at')
          .order('last_inbound_at', { ascending: false, nullsFirst: false })
          .limit(60);
        return jsonResponse({ conversations: result.data ?? [] });
      }

      case 'conversation': {
        const conversationId = String(body.conversation_id ?? '');
        if (!conversationId) return errorResponse('conversation_id required', 400);
        const context = await admin.rpc('operator_conversation_context', { p_conversation: conversationId, p_limit: 60 });
        const messages = await admin
          .from('operator_message')
          .select('id,direction,author_type,author_profile_id,body,delivery_status,created_at')
          .eq('conversation_id', conversationId)
          .order('created_at', { ascending: true })
          .limit(100);
        return jsonResponse({ context: context.data ?? null, messages: messages.data ?? [] });
      }

      case 'admin_message': {
        const text = String(body.body ?? '').trim();
        if (!text) return errorResponse('body required', 400);
        const conversationId = body.conversation_id
          ? String(body.conversation_id)
          : String(
              (await admin.rpc('operator_ensure_conversation', {
                p_channel: 'admin_control',
                p_member: caller.profileId,
                p_thread: null,
                p_subject: 'Admin control',
              })).data ?? '',
            );
        if (!conversationId) return errorResponse('could not open admin conversation', 500);

        const inserted = await fetch(`${SUPABASE_URL}/rest/v1/operator_message`, {
          method: 'POST',
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
          },
          body: JSON.stringify({
            conversation_id: conversationId,
            direction: 'inbound',
            author_profile_id: caller.profileId,
            // `operator_message_author` allows member/staff/system, and `operator_message_delivery`
            // allows pending/sent/failed/not_required. An executive is staff, and a message that
            // was written straight into the conversation needs no delivery step.
            author_type: 'staff',
            body: text.slice(0, 4000),
            delivery_status: 'not_required',
          }),
        });
        if (!inserted.ok) return errorResponse('could not record message', 500);

        const task = await admin.rpc('operator_create_task', {
          p_task_type: 'admin_command',
          p_input: { instruction: text.slice(0, 4000), conversation_id: conversationId },
          p_conversation: conversationId,
          p_requester: caller.profileId,
          p_destination_type: 'operator_conversation',
          p_destination_id: conversationId,
          p_idempotency_key: `admin:${caller.profileId}:${Date.now()}`,
          p_priority: 2,
          p_source_event: null,
        });
        if (task.error) return errorResponse(`could not queue command: ${task.error.message}`, 500);
        return jsonResponse({ ok: true, conversation_id: conversationId, task_id: task.data });
      }

      case 'tasks': {
        const status = body.status ? String(body.status) : '';
        let query = admin
          .from('operator_task')
          .select('id,task_type,status,priority,attempt_count,max_attempts,error_code,error_detail,provider,model,created_at,updated_at,available_at,finished_at')
          .order('created_at', { ascending: false })
          .limit(Math.min(Math.max(Number(body.limit ?? 40), 1), 100));
        if (status) query = query.eq('status', status);
        const result = await query;
        return jsonResponse({ tasks: result.data ?? [] });
      }

      case 'task_retry': {
        const taskId = String(body.task_id ?? '');
        if (!taskId) return errorResponse('task_id required', 400);
        const patched = await admin
          .from('operator_task')
          .update({
            status: 'queued',
            available_at: new Date().toISOString(),
            error_code: null,
            error_detail: null,
            lease_owner: null,
            lease_expires_at: null,
          })
          .eq('id', taskId);
        if (patched.error) return errorResponse(patched.error.message, 500);
        const verify = await admin.from('operator_task').select('id,status').eq('id', taskId).limit(1);
        const row = asArray<Record<string, unknown>>(verify.data)[0];
        if (!row || row.status !== 'queued') return errorResponse('task was not re-queued', 409);
        return jsonResponse({ ok: true, task: row });
      }

      case 'approvals': {
        const result = await admin
          .from('operator_approval')
          .select('id,task_id,action,requested_by,required_role,status,decided_by,decided_at,note,payload,created_at')
          .order('created_at', { ascending: false })
          .limit(60);
        return jsonResponse({ approvals: result.data ?? [] });
      }

      case 'approval_decide': {
        const approvalId = String(body.approval_id ?? '');
        const decision = String(body.decision ?? '');
        if (!approvalId || !['approved', 'rejected'].includes(decision)) {
          return errorResponse('approval_id and decision (approved|rejected) required', 400);
        }
        // This RPC is deliberately admin-identity-bound (`current_profile_id()` + `is_admin()`),
        // so it must run as the caller, not as the service role.
        const rpcResponse = await fetch(`${SUPABASE_URL}/rest/v1/rpc/operator_decide_approval`, {
          method: 'POST',
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            p_approval: approvalId,
            p_decision: decision,
            p_note: body.note ? String(body.note).slice(0, 500) : null,
          }),
        });
        const rpcText = await rpcResponse.text().catch(() => '');
        if (!rpcResponse.ok) return errorResponse(rpcText.slice(0, 300) || 'approval decision failed', 500);
        return jsonResponse({ ok: true, result: rpcText ? JSON.parse(rpcText) : null });
      }

      case 'providers': {
        const result = await admin
          .from('operator_provider')
          .select('provider,label,model_id,base_url,enabled,is_default,health,last_ok_at,last_error_at,last_error_code,last_error_detail,rpm_limit,notes,updated_at');
        const usage = await admin
          .from('operator_provider_usage')
          .select('provider,outcome,input_tokens,output_tokens,total_tokens,latency_ms,created_at')
          .order('created_at', { ascending: false })
          .limit(200);
        return jsonResponse({ providers: result.data ?? [], recent_usage: usage.data ?? [] });
      }

      case 'tools': {
        const result = await admin
          .from('operator_tool')
          .select('name,description,family,permission,read_only,approval_required,rate_limit_per_min,timeout_ms,enabled')
          .order('family', { ascending: true });
        return jsonResponse({ tools: result.data ?? [] });
      }

      case 'moderation': {
        const queue = await admin.rpc('operator_moderation_queue', { p_limit: 50 });
        const cases = await admin
          .from('operator_moderation_case')
          .select('id,target_type,target_id,rule_code,rule_text,confidence,decision,action_taken,appeal_status,created_at')
          .order('created_at', { ascending: false })
          .limit(50);
        return jsonResponse({ queue: queue.data ?? [], cases: cases.data ?? [] });
      }

      case 'research': {
        const result = await admin
          .from('operator_research_item')
          .select('id,topic,headline,summary,source_name,source_url,verification,world,used_in_post_id,created_at')
          .order('created_at', { ascending: false })
          .limit(60);
        return jsonResponse({ research: result.data ?? [] });
      }

      case 'campaigns': {
        const result = await admin
          .from('operator_campaign')
          .select('id,name,kind,status,starts_at,ends_at,payload,post_id,created_at')
          .order('created_at', { ascending: false })
          .limit(60);
        return jsonResponse({ campaigns: result.data ?? [] });
      }

      case 'schedules': {
        const result = await admin
          .from('operator_schedule')
          .select('name,task_type,cadence_seconds,enabled,last_run_at,next_run_at,input,priority')
          .order('name', { ascending: true });
        return jsonResponse({ schedules: result.data ?? [] });
      }

      case 'audit': {
        const result = await admin
          .from('operator_audit')
          .select('id,task_id,actor_profile_id,actor_type,action,outcome,resource_type,resource_id,details,created_at')
          .order('created_at', { ascending: false })
          .limit(80);
        return jsonResponse({ audit: result.data ?? [] });
      }

      case 'policy': {
        const result = await admin.from('operator_policy').select('autonomy,moderation,notifications,providers,approval_required,updated_at,updated_by').limit(1);
        return jsonResponse({ policy: asArray(result.data)[0] ?? null });
      }

      case 'policy_update': {
        const patch: Record<string, unknown> = {};
        for (const key of ['autonomy', 'moderation', 'notifications', 'providers']) {
          if (body[key] && typeof body[key] === 'object') patch[key] = body[key];
        }
        if (Object.keys(patch).length === 0) return errorResponse('nothing to update', 400);
        patch.updated_at = new Date().toISOString();
        patch.updated_by = caller.profileId;
        const result = await admin.from('operator_policy').update(patch).eq('id', true);
        if (result.error) return errorResponse(result.error.message, 500);
        await admin.rpc('operator_audit_write', {
          p_action: 'policy.updated',
          p_outcome: 'ok',
          p_actor: caller.profileId,
          p_actor_type: 'admin',
          p_resource_type: 'operator_policy',
          p_resource_id: 'singleton',
          p_details: { keys: Object.keys(patch) },
        });
        return jsonResponse({ ok: true });
      }

      case 'health': {
        const [providers, workers, tasks] = await Promise.all([
          admin.from('operator_provider').select('provider,label,model_id,enabled,is_default,health,last_ok_at,last_error_at,last_error_code,rpm_limit'),
          admin.from('operator_worker_health').select('worker_id,last_seen_at,version,tasks_processed,last_error').order('last_seen_at', { ascending: false }).limit(5),
          admin.from('operator_task').select('status').limit(5000),
        ]);
        const counts: Record<string, number> = {};
        for (const row of asArray<Record<string, unknown>>(tasks.data)) {
          const key = String(row.status ?? 'unknown');
          counts[key] = (counts[key] ?? 0) + 1;
        }
        return jsonResponse({ providers: providers.data ?? [], workers: workers.data ?? [], task_counts: counts });
      }

      default:
        return errorResponse(`unknown action: ${action || '(none)'}`, 400);
    }
  } catch (error) {
    return errorResponse((error as Error).message.slice(0, 400), 500);
  }
});
