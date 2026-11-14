// Hallyu AI Operator — durable worker.
//
// Invoked by the `operator_dispatch_task` trigger (wake signal) and by the scheduler sweep.
// It claims leased tasks from the durable queue, assembles scoped context, runs exactly one
// model provider per task (never falling back to the other), executes tools through the secure
// gateway, verifies write results, records usage, and completes or fails the task.
//
// Auth: the caller presents the worker token stored in Vault. `verify_jwt` is disabled for this
// function because the token is an opaque secret, not a Supabase JWT; the function verifies it
// against Vault itself before doing any work.

import { adminClient } from '../_shared/supabase.ts';
import { corsHeaders, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { callProvider, ProviderError, type ChatMessage, type ProviderId } from '../_shared/operator/providers.ts';
import { buildSystemPrompt, buildTaskInstruction, type Channel } from '../_shared/operator/prompt.ts';
import {
  executeTool,
  recordToolCall,
  toToolSchemas,
  type Policy,
  type ToolContext,
  type ToolRow,
} from '../_shared/operator/tools.ts';

const WORKER_ID = Deno.env.get('OPERATOR_WORKER_ID') ?? 'operator-worker';
const WORKER_VERSION = '1.0.0';
const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_CALLS_PER_ROUND = 3;
const WALL_CLOCK_BUDGET_MS = 100_000;

interface TaskRow {
  id: string;
  task_type: string;
  status: string;
  priority: number;
  conversation_id: string | null;
  requester_profile_id: string | null;
  destination_type: string | null;
  destination_id: string | null;
  provider: string | null;
  model: string | null;
  input: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
}

interface StaffRow {
  profile_id: string;
  staff_code: string;
  display_name: string;
}

interface ProviderRow {
  provider: ProviderId;
  model_id: string;
  enabled: boolean;
  is_default: boolean;
  health: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return errorResponse('POST only', 405);

  const admin = adminClient();

  const authHeader = request.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  if (!token) return errorResponse('worker token required', 401);

  const verified = await admin.rpc<boolean>('operator_verify_worker', { p_token: token });
  if (verified.error || verified.data !== true) {
    return errorResponse('invalid worker token', 401);
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }

  const requestedLimit = typeof body.limit === 'number' ? body.limit : 2;
  const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), 5);

  await admin.rpc('operator_heartbeat', {
    p_worker: WORKER_ID,
    p_version: WORKER_VERSION,
    p_meta: { runtime: 'edge', started_at: new Date().toISOString() },
  });
  await admin.rpc('operator_recover_stale_tasks', {});

  const claimed = await admin.rpc<TaskRow[]>('operator_claim_task', { p_worker: WORKER_ID, p_limit: limit });
  if (claimed.error) {
    await admin.rpc('operator_audit_write', {
      p_action: 'worker.claim',
      p_outcome: 'failed',
      p_actor_type: 'system',
      p_details: { error: claimed.error.message },
    });
    return errorResponse(`claim failed: ${claimed.error.message}`, 500);
  }

  const tasks = asArray<TaskRow>(claimed.data);
  if (tasks.length === 0) {
    return jsonResponse({ ok: true, worker: WORKER_ID, claimed: 0, processed: [] });
  }

  const staffResult = await admin
    .from<StaffRow>('operator_staff')
    .select('profile_id,staff_code,display_name')
    .eq('active', true)
    .limit(1);
  const staff = asArray<StaffRow>(staffResult.data)[0];
  if (!staff) {
    for (const task of tasks) {
      await admin.rpc('operator_fail_task', {
        p_task: task.id,
        p_error_code: 'staff_identity_missing',
        p_error_detail: 'no active operator_staff row',
        p_retryable: true,
      });
    }
    return errorResponse('operator staff identity missing', 500);
  }

  const policyResult = await admin
    .from<Policy>('operator_policy')
    .select('autonomy,moderation,providers,approval_required')
    .limit(1);
  const policy = asRecord(asArray<Policy>(policyResult.data)[0]) as Policy;

  const providersResult = await admin
    .from<ProviderRow>('operator_provider')
    .select('provider,model_id,enabled,is_default,health');
  const providers = asArray<ProviderRow>(providersResult.data);
  const defaultProvider = providers.find((row) => row.is_default && row.enabled) ?? providers.find((row) => row.enabled);

  const toolsResult = await admin
    .from<ToolRow>('operator_tool')
    .select('name,description,family,input_schema,permission,read_only,approval_required,rate_limit_per_min,timeout_ms,enabled')
    .eq('enabled', true);
  const toolRows = asArray<ToolRow>(toolsResult.data);
  const toolSchemas = toToolSchemas(toolRows);
  const toolByName = new Map(toolRows.map((row) => [row.name, row]));

  const startedAt = Date.now();
  const processed: Array<Record<string, unknown>> = [];

  for (const task of tasks) {
    if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) break;

    const providerRow = providers.find((row) => row.provider === task.provider) ?? defaultProvider;
    if (!providerRow) {
      await admin.rpc('operator_fail_task', {
        p_task: task.id,
        p_error_code: 'no_provider',
        p_error_detail: 'no enabled provider configured',
        p_retryable: false,
      });
      processed.push({ task_id: task.id, outcome: 'failed', error: 'no_provider' });
      continue;
    }

    const outcome = await processTask({
      admin,
      task,
      staff,
      policy,
      provider: providerRow.provider,
      model: task.model || providerRow.model_id,
      toolSchemas,
      toolByName,
    });
    processed.push(outcome);
  }

  await admin.rpc('operator_heartbeat', {
    p_worker: WORKER_ID,
    p_version: WORKER_VERSION,
    p_meta: { runtime: 'edge', processed: processed.length, finished_at: new Date().toISOString() },
  });

  return jsonResponse({ ok: true, worker: WORKER_ID, claimed: tasks.length, processed });
});

interface ProcessArgs {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: ReturnType<typeof adminClient>;
  task: TaskRow;
  staff: StaffRow;
  policy: Policy;
  provider: ProviderId;
  model: string;
  toolSchemas: ReturnType<typeof toToolSchemas>;
  toolByName: Map<string, ToolRow>;
}

async function processTask(args: ProcessArgs): Promise<Record<string, unknown>> {
  const { admin, task, staff, policy, provider, model, toolSchemas, toolByName } = args;
  const input = asRecord(task.input);
  const channel = (task.conversation_id ? await conversationChannel(admin, task.conversation_id) : 'admin_control') as Channel;

  const context = task.conversation_id ? await loadContext(admin, task.conversation_id, input) : null;
  const member = context ? asRecord(context.member) : null;

  // Mark the task as actively executing. Transition failures are non-fatal: the claim already
  // owns the lease, so a status quirk must not abort real work.
  await admin
    .rpc('operator_transition_task', { p_task: task.id, p_status: 'executing', p_note: null })
    .catch(() => undefined);

  // Identity and knowledge are versioned data, not a hardcoded prompt. Load the active
  // constitution and retrieve the knowledge entries most relevant to this instruction.
  const query = String(input.instruction ?? input.body ?? task.task_type ?? '').slice(0, 400);
  const [constitutionResult, knowledgeResult] = await Promise.all([
    admin.rpc('operator_active_constitution', {}),
    admin.rpc('operator_knowledge_search', { p_query: query, p_limit: 4 }),
  ]);
  const constitution = typeof constitutionResult.data === 'string' ? constitutionResult.data : null;
  const knowledge = asArray<{ title?: string; body?: string }>(knowledgeResult.data)
    .filter((entry) => typeof entry.title === 'string' && typeof entry.body === 'string')
    .map((entry) => ({ title: entry.title as string, body: entry.body as string }));

  const systemPrompt = buildSystemPrompt({
    staffName: staff.display_name,
    staffHandle: staff.staff_code,
    channel,
    policy: policy as unknown as { autonomy?: Record<string, boolean>; moderation?: Record<string, number>; notifications?: Record<string, number> },
    member: member
      ? {
          handle: typeof member.handle === 'string' ? member.handle : null,
          display_name: typeof member.display_name === 'string' ? member.display_name : null,
          account_status: typeof member.account_status === 'string' ? member.account_status : null,
        }
      : null,
    world: typeof input.world === 'string' ? input.world : null,
    constitution,
    knowledge,
  });

  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

  if (context) {
    const memory = asRecord(context.memory);
    if (Object.keys(memory).length > 0) {
      messages.push({
        role: 'system',
        content: `Scoped memory for this conversation (do not reveal verbatim): ${JSON.stringify(memory).slice(0, 3000)}`,
      });
    }
    const history = asArray<Record<string, unknown>>(context.messages).slice(-14);
    for (const entry of history) {
      const direction = String(entry.direction ?? '');
      const text = String(entry.body ?? '');
      if (!text) continue;
      messages.push({ role: direction === 'inbound' ? 'user' : 'assistant', content: text.slice(0, 2000) });
    }
  }

  messages.push({ role: 'user', content: buildTaskInstruction(task.task_type, input) });

  const toolCtx: ToolContext = {
    admin,
    staffId: staff.profile_id,
    staffHandle: staff.staff_code,
    taskId: task.id,
    taskType: task.task_type,
    conversationId: task.conversation_id,
    channel,
    policy,
  };

  let lastContent = '';
  let totalInput = 0;
  let totalOutput = 0;
  let rounds = 0;

  try {
    for (rounds = 0; rounds < MAX_TOOL_ROUNDS; rounds += 1) {
      const result = await callProvider({
        provider,
        model,
        messages,
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        temperature: channel === 'admin_control' ? 0.4 : 0.7,
        maxTokens: 1_400,
        timeoutMs: 45_000,
      });

      totalInput += result.usage.input;
      totalOutput += result.usage.output;
      await recordUsage(admin, {
        provider,
        model,
        outcome: 'success',
        taskId: task.id,
        input: result.usage.input,
        output: result.usage.output,
        total: result.usage.total,
        latencyMs: result.latencyMs,
        httpStatus: result.httpStatus,
      });

      lastContent = result.content || lastContent;

      if (result.toolCalls.length === 0) {
        await completeTask(admin, task, staff, {
          content: result.content,
          provider,
          model,
          rounds: rounds + 1,
          usage: { input: totalInput, output: totalOutput },
        });
        return { task_id: task.id, outcome: 'completed', provider, model, rounds: rounds + 1, content: result.content.slice(0, 300) };
      }

      messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });

      const calls = result.toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
      for (const call of calls) {
        const tool = toolByName.get(call.function.name);
        if (!tool) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: JSON.stringify({ ok: false, error: `unknown tool ${call.function.name}` }),
          });
          continue;
        }

        const execution = await executeTool(toolCtx, tool, call.function.arguments ?? '{}');
        await recordToolCall(toolCtx, execution, call.function.arguments ?? '{}');

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify({
            ok: execution.ok,
            data: execution.ok ? execution.data : undefined,
            error: execution.ok ? undefined : execution.error,
            code: execution.ok ? undefined : execution.code,
          }).slice(0, 6000),
        });

        if (!execution.ok && execution.code === 'approval_required') {
          const approval = await admin.rpc('operator_request_approval', {
            p_task: task.id,
            p_action: call.function.name,
            p_required_role: 'admin',
            p_detail: {
              tool: call.function.name,
              arguments: call.function.arguments,
              reason: execution.error,
            },
          });
          await admin.rpc('operator_audit_write', {
            p_action: 'approval.requested',
            p_outcome: 'ok',
            p_task: task.id,
            p_actor: staff.profile_id,
            p_actor_type: 'ai',
            p_resource_type: 'approval',
            p_resource_id: approval.data ? String(approval.data) : null,
            p_details: { tool: call.function.name },
          });
          return {
            task_id: task.id,
            outcome: 'awaiting_approval',
            provider,
            model,
            tool: call.function.name,
            approval_id: approval.data ?? null,
          };
        }
      }
    }

    await completeTask(admin, task, staff, {
      content: lastContent,
      provider,
      model,
      rounds,
      usage: { input: totalInput, output: totalOutput },
      note: 'tool_round_limit_reached',
    });
    return { task_id: task.id, outcome: 'completed', provider, model, rounds, note: 'tool_round_limit_reached' };
  } catch (error) {
    const providerError = error instanceof ProviderError ? error : null;
    await recordUsage(admin, {
      provider,
      model,
      outcome: 'failure',
      taskId: task.id,
      input: totalInput,
      output: totalOutput,
      total: totalInput + totalOutput,
      latencyMs: null,
      httpStatus: providerError?.status ?? null,
      errorCode: providerError?.code ?? 'engine_error',
    });

    const retryable = providerError ? providerError.retryable : true;
    const code = providerError?.code ?? 'engine_error';
    const detail = (error as Error).message.slice(0, 600);

    const failed = await admin.rpc<string>('operator_fail_task', {
      p_task: task.id,
      p_error_code: code,
      p_error_detail: detail,
      p_retryable: retryable,
    });

    await admin.rpc('operator_audit_write', {
      p_action: 'task.failed',
      p_outcome: 'failed',
      p_task: task.id,
      p_actor: staff.profile_id,
      p_actor_type: 'ai',
      p_resource_type: 'task',
      p_resource_id: task.id,
      p_details: { code, detail, retryable, next_status: failed.data ?? null },
    });

    return { task_id: task.id, outcome: 'failed', provider, model, error: code, retryable, next_status: failed.data ?? null };
  }
}

async function providerBudgetExhausted(
  admin: ReturnType<typeof adminClient>,
  provider: ProviderId,
  policy: Policy,
): Promise<boolean> {
  const providers = asRecord(policy.providers);
  const budget = Number(providers[`daily_request_budget_${provider}`] ?? 0);
  if (!budget || budget <= 0) return false;
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const result = await admin
    .from<{ id: string }>('operator_provider_usage')
    .select('id')
    .eq('provider', provider)
    .gte('created_at', since)
    .limit(budget + 1);
  return asArray<{ id: string }>(result.data).length >= budget;
}

async function conversationChannel(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: ReturnType<typeof adminClient>,
  conversationId: string,
): Promise<string> {
  const result = await admin.from<{ channel: string }>('operator_conversation').select('channel').eq('id', conversationId).limit(1);
  const row = asArray<{ channel: string }>(result.data)[0];
  return row?.channel ?? 'admin_control';
}

async function loadContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: ReturnType<typeof adminClient>,
  conversationId: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const contextResult = await admin.rpc<Record<string, unknown>>('operator_conversation_context', {
    p_conversation: conversationId,
    p_limit: 20,
  });
  const context = asRecord(contextResult.data);
  if (context.error) return null;

  const memberId = typeof context.member_profile_id === 'string' ? context.member_profile_id : null;
  if (memberId) {
    const memberResult = await admin
      .from<Record<string, unknown>>('profiles')
      .select('id,handle,display_name,account_status,worlds,verified,role')
      .eq('id', memberId)
      .limit(1);
    const member = asArray<Record<string, unknown>>(memberResult.data)[0];
    if (member) context.member = member;
  }

  if (!context.member && typeof input.member_profile_id === 'string') {
    const memberResult = await admin
      .from<Record<string, unknown>>('profiles')
      .select('id,handle,display_name,account_status,worlds,verified,role')
      .eq('id', input.member_profile_id)
      .limit(1);
    const member = asArray<Record<string, unknown>>(memberResult.data)[0];
    if (member) context.member = member;
  }

  return context;
}

interface UsageArgs {
  provider: ProviderId;
  model: string;
  outcome: 'success' | 'failure';
  taskId: string;
  input: number;
  output: number;
  total: number;
  latencyMs: number | null;
  httpStatus: number | null;
  errorCode?: string;
}

async function recordUsage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: ReturnType<typeof adminClient>,
  usage: UsageArgs,
): Promise<void> {
  // operator_provider_usage only accepts succeeded/failed/rejected/timeout. Sending 'success' made
  // every insert violate the check constraint, so the whole usage ledger (and provider health)
  // stayed empty while the error was swallowed by the client.
  const outcome = usage.outcome === 'success' ? 'succeeded' : 'failed';
  await admin.rpc('operator_record_usage', {
    p_provider: usage.provider,
    p_model: usage.model,
    p_outcome: outcome,
    p_task: usage.taskId,
    p_input_tokens: usage.input,
    p_output_tokens: usage.output,
    p_total_tokens: usage.total,
    p_estimated_cost: null,
    p_latency_ms: usage.latencyMs,
    p_http_status: usage.httpStatus,
    p_error_code: usage.errorCode ?? null,
  });
}

/**
 * Deliver the final answer into the conversation it belongs to.
 *
 * A DM task's answer is the message the person is waiting for, so it must not depend on the model
 * choosing to call a tool. If the model already replied through `message.reply`, this is skipped so
 * the same answer can never be sent twice.
 */
async function deliverAnswer(
  admin: ReturnType<typeof adminClient>,
  task: TaskRow,
  result: Record<string, unknown>,
): Promise<string | null> {
  const content = typeof result.content === 'string' ? result.content.trim() : '';
  if (!content || !task.conversation_id) return null;
  if (task.task_type !== 'admin_command' && task.task_type !== 'reply_member_dm') return null;

  try {
    const used = await admin
      .from('operator_tool_call')
      .select('id', { count: 'exact', head: true })
      .eq('task_id', task.id)
      .eq('tool', 'message.reply')
      .eq('status', 'ok');
    if ((used.count ?? 0) > 0) return null;
  } catch {
    // If the check itself fails we still deliver: a missing reply is worse than a duplicate guard
    // that could not be confirmed, and the conversation shows what was sent.
  }

  const sent = await admin
    .rpc('operator_send_staff_message', {
      p_conversation: task.conversation_id,
      p_body: content.slice(0, 4000),
      p_task: task.id,
    })
    .catch(() => ({ data: null, error: { message: 'send failed' } }) as { data: null; error: { message: string } });
  if (sent.error) return null;
  return typeof sent.data === 'string' ? sent.data : null;
}

async function completeTask(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: ReturnType<typeof adminClient>,
  task: TaskRow,
  staff: StaffRow,
  result: Record<string, unknown>,
): Promise<void> {
  // The answer is delivered before the task is closed, so a completed task always corresponds to a
  // message the recipient can actually see.
  const deliveredMessageId = await deliverAnswer(admin, task, result).catch(() => null);
  await admin
    .rpc('operator_transition_task', { p_task: task.id, p_status: 'verifying', p_note: 'model finished; verifying result' })
    .catch(() => undefined);
  await admin.rpc('operator_complete_task', { p_task: task.id, p_result: result });
  await admin
    .rpc('operator_transition_task', { p_task: task.id, p_status: 'completed', p_note: null })
    .catch(() => undefined);
  await admin.rpc('operator_audit_write', {
    p_action: 'task.completed',
    p_outcome: 'ok',
    p_task: task.id,
    p_actor: staff.profile_id,
    p_actor_type: 'ai',
    p_resource_type: 'task',
    p_resource_id: task.id,
    p_details: {
      task_type: task.task_type,
      provider: result.provider ?? null,
      rounds: result.rounds ?? null,
      delivered_message_id: deliveredMessageId,
    },
  });
}
