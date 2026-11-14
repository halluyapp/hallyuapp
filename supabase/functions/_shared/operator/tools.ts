// Secure tool gateway for the Hallyu AI Operator.
//
// Models never touch the database. Every capability is a named tool with a JSON schema, a
// permission class, a per-task rate limit and a hard timeout. This module validates the model's
// arguments, checks the permission against live policy, enforces the rate limit, executes the
// handler against the service-role gateway, and returns a structured outcome the engine can feed
// back to the model. Nothing here trusts the model's claims: write tools return the verified row
// they actually produced.

import type { AdminClient } from '../supabase.ts';
import type { ToolSchema } from './providers.ts';

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

export interface Policy {
  autonomy?: Record<string, boolean>;
  moderation?: Record<string, number>;
  notifications?: Record<string, number>;
  providers?: Record<string, unknown>;
  approval_required?: string[];
}

export interface ToolRow {
  name: string;
  description: string;
  family: string;
  input_schema: Record<string, unknown>;
  permission: string;
  read_only: boolean;
  approval_required: boolean;
  rate_limit_per_min: number | null;
  timeout_ms: number;
  enabled: boolean;
}

export interface ToolContext {
  admin: AdminClient;
  staffId: string;
  staffHandle: string;
  taskId: string | null;
  taskType: string;
  conversationId: string | null;
  channel: string;
  policy: Policy;
}

export interface ToolOutcome {
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

type Handler = (ctx: ToolContext, input: Record<string, unknown>) => Promise<ToolOutcome>;

/**
 * Server-side notification guardrails. Returns a suppression outcome when the send must not
 * happen, or null when it may proceed. Reads `operator_policy.notifications`.
 */
async function enforceNotificationPolicy(ctx: ToolContext, title: string): Promise<ToolOutcome | null> {
  const policy = (ctx.policy.notifications ?? {}) as Record<string, unknown>;
  const maxPerDay = Number(policy.max_per_day ?? 0);
  const maxPerHour = Number(policy.max_per_hour ?? 0);
  const dedupeHours = Number(policy.dedupe_window_hours ?? 0);
  const quiet = (policy.quiet_hours ?? null) as { start?: string; end?: string } | null;

  const now = new Date();
  const hour = now.getUTCHours();
  if (quiet?.start && quiet?.end) {
    const start = Number(String(quiet.start).split(':')[0]);
    const end = Number(String(quiet.end).split(':')[0]);
    const inWindow = start <= end ? hour >= start && hour < end : hour >= start || hour < end;
    if (inWindow) return { ok: true, data: { suppressed: true, reason: 'quiet_hours', verified: true } };
  }

  if (dedupeHours > 0) {
    const since = new Date(now.getTime() - dedupeHours * 3600_000).toISOString();
    const dup = await restSelect(
      'operator_notification_run',
      `select=id&title=eq.${encodeURIComponent(title)}&created_at=gte.${since}&limit=1`,
    );
    if (dup.ok && Array.isArray(dup.data) && dup.data.length > 0) {
      return { ok: true, data: { suppressed: true, reason: 'duplicate', verified: true } };
    }
  }

  if (maxPerDay > 0) {
    const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const day = await restSelect('operator_notification_run', `select=id&created_at=gte.${since}&limit=1000`);
    if (day.ok && Array.isArray(day.data) && day.data.length >= maxPerDay) {
      return { ok: true, data: { suppressed: true, reason: 'daily_cap', verified: true } };
    }
  }
  if (maxPerHour > 0) {
    const since = new Date(now.getTime() - 3600_000).toISOString();
    const hr = await restSelect('operator_notification_run', `select=id&created_at=gte.${since}&limit=1000`);
    if (hr.ok && Array.isArray(hr.data) && hr.data.length >= maxPerHour) {
      return { ok: true, data: { suppressed: true, reason: 'hourly_cap', verified: true } };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// PostgREST helpers (service role only; never exposed to the model)
// ---------------------------------------------------------------------------

async function restRequest(
  method: 'GET' | 'POST' | 'PATCH',
  table: string,
  query: string,
  body?: unknown,
): Promise<{ ok: boolean; data: unknown; error?: string }> {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query ? `?${query}` : ''}`;
  const headers: Record<string, string> = {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'x-application-name': 'hallyu-operator-tools',
    Accept: 'application/json',
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers.Prefer = 'return=representation';
  }
  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    return { ok: false, data: null, error: text.slice(0, 400) || `HTTP ${response.status}` };
  }
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { ok: true, data: parsed };
}

async function restInsert(table: string, values: Record<string, unknown>) {
  return restRequest('POST', table, '', values);
}

async function restSelect(table: string, query: string) {
  return restRequest('GET', table, query);
}

async function restPatch(table: string, query: string, values: Record<string, unknown>) {
  return restRequest('PATCH', table, query, values);
}

async function rpc<T = unknown>(ctx: ToolContext, fn: string, params: Record<string, unknown>) {
  const { data, error } = await ctx.admin.rpc<T>(fn, params);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

function str(input: Record<string, unknown>, key: string, fallback = ''): string {
  const value = input[key];
  return typeof value === 'string' ? value : fallback;
}

function num(input: Record<string, unknown>, key: string, fallback: number): number {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function fail(code: string, error: string): ToolOutcome {
  return { ok: false, code, error };
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return (data[0] as Record<string, unknown>) ?? null;
  if (data && typeof data === 'object') return data as Record<string, unknown>;
  return null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const MEMBER_FIELDS =
  'id,handle,display_name,bio,worlds,verified,role,account_status,follower_count,following_count,post_count,comment_count,is_ai,created_at';

const handlers: Record<string, Handler> = {
  'member.get': async (ctx, input) => {
    const id = str(input, 'profile_id');
    const result = await restSelect('profiles', `select=${MEMBER_FIELDS}&id=eq.${id}&limit=1`);
    if (!result.ok) return fail('lookup_failed', result.error ?? 'lookup failed');
    const row = firstRow(result.data);
    return row ? { ok: true, data: row } : fail('not_found', 'no member with that id');
  },

  'member.status': async (_ctx, input) => {
    const id = str(input, 'profile_id');
    const result = await restSelect(
      'profiles',
      `select=id,handle,role,account_status,is_ai,verified,deleted_at&id=eq.${id}&limit=1`,
    );
    if (!result.ok) return fail('lookup_failed', result.error ?? 'lookup failed');
    const row = firstRow(result.data);
    return row ? { ok: true, data: row } : fail('not_found', 'no member with that id');
  },

  'conversation.context': async (ctx, input) => {
    const conversationId = boundConversationId(ctx, input) ?? '';
    if (!conversationId) return fail('conversation_not_bound', 'conversation id is not bound to this task');
    const data = await rpc(ctx, 'operator_conversation_context', {
      p_conversation: conversationId,
      p_limit: num(input, 'limit', 20),
    });
    return { ok: true, data };
  },

  'message.reply': async (ctx, input) => {
    const conversationId = str(input, 'conversation_id') || ctx.conversationId || '';
    const body = str(input, 'body').trim();
    if (!conversationId) return fail('missing_conversation', 'no conversation id available');
    if (!body) return fail('empty_body', 'reply body is empty');
    const data = await rpc(ctx, 'operator_send_staff_message', {
      p_conversation: conversationId,
      p_body: body.slice(0, 2000),
      p_task: ctx.taskId,
    });
    return { ok: true, data };
  },

  'post.create': async (ctx, input) => {
    const body = str(input, 'body').trim();
    if (!body) return fail('empty_body', 'post body is empty');
    const data = await rpc(ctx, 'operator_create_post', {
      p_title: str(input, 'title', '') || null,
      p_body: body.slice(0, 4000),
      p_type: str(input, 'type', 'post'),
      p_world: str(input, 'world', '') || null,
      p_kind: null,
      p_spoiler: 'none',
      p_visibility: 'public',
      p_hashtags: [],
    });
    return { ok: true, data };
  },

  'post.publish': async (_ctx, input) => {
    const postId = str(input, 'post_id');
    const patched = await restPatch('posts', `id=eq.${postId}`, { state: 'active' });
    if (!patched.ok) return fail('publish_failed', patched.error ?? 'publish failed');
    const verify = await restSelect('posts', `select=id,state,visibility&id=eq.${postId}&limit=1`);
    if (!verify.ok) return fail('verify_failed', verify.error ?? 'verify failed');
    const row = firstRow(verify.data);
    if (!row) return fail('not_found', 'post not found after publish');
    if (row.state !== 'active') return fail('not_published', `post state is ${String(row.state)}`);
    return { ok: true, data: { ...row, verified: true } };
  },

  'post.delete': async (ctx, input) => {
    const postId = str(input, 'post_id');
    const reason = str(input, 'reason', 'Removed by Hallyu AI Operator');
    const data = await rpc(ctx, 'operator_moderate_content', {
      p_target_type: 'post',
      p_target_id: postId,
      p_action: 'remove',
      p_reason: reason,
      p_case_id: null,
    });
    return { ok: true, data };
  },

  'comment.reply': async (ctx, input) => {
    const commentId = str(input, 'comment_id');
    const body = str(input, 'body').trim();
    if (!body) return fail('empty_body', 'reply body is empty');
    const parent = await restSelect('comments', `select=id,post_id,author_id&id=eq.${commentId}&limit=1`);
    if (!parent.ok) return fail('lookup_failed', parent.error ?? 'lookup failed');
    const parentRow = firstRow(parent.data);
    if (!parentRow) return fail('not_found', 'comment not found');
    const inserted = await restInsert('comments', {
      post_id: parentRow.post_id,
      author_id: ctx.staffId,
      body: body.slice(0, 2000),
      parent_id: commentId,
      reply_to_user_id: parentRow.author_id,
    });
    if (!inserted.ok) return fail('reply_failed', inserted.error ?? 'reply failed');
    return { ok: true, data: { comment: firstRow(inserted.data), verified: true } };
  },

  'poll.create': async (_ctx, input) => {
    const postId = str(input, 'post_id');
    const options = Array.isArray(input.options) ? (input.options as string[]) : [];
    const inserted = await restInsert('post_polls', {
      post_id: postId,
      question: str(input, 'question', 'Vote'),
      options,
    });
    if (!inserted.ok) return fail('poll_failed', inserted.error ?? 'poll failed');
    return { ok: true, data: { poll: firstRow(inserted.data), verified: true } };
  },

  'notification.send': async (ctx, input) => {
    const title = str(input, 'title').slice(0, 120);
    const body = str(input, 'body').slice(0, 500);
    const audience = str(input, 'audience', 'all');
    const world = str(input, 'world', '');
    if (!title || !body) return fail('invalid_notification', 'title and body are required');

    let recipientIds: string[] = [];
    if (audience === 'world' && world) {
      const result = await restSelect('profiles', `select=id&worlds=cs.{${world}}&account_status=eq.active&limit=5000`);
      if (!result.ok) return fail('audience_failed', result.error ?? 'audience lookup failed');
      recipientIds = (Array.isArray(result.data) ? result.data : []).map((r) => String((r as Record<string, unknown>).id));
    } else if (audience === 'followers') {
      const result = await restSelect('follows', `select=follower_id&target_id=eq.${ctx.staffId}&limit=5000`);
      if (!result.ok) return fail('audience_failed', result.error ?? 'audience lookup failed');
      recipientIds = (Array.isArray(result.data) ? result.data : []).map((r) => String((r as Record<string, unknown>).follower_id));
    }

    let delivered = 0;
    if (recipientIds.length > 0) {
      const rows = recipientIds.map((recipientId) => ({
        recipient_id: recipientId,
        kind: 'system',
        group: 'system',
        title,
        body,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const inserted = await restInsert('notifications', chunk);
        if (!inserted.ok) return fail('notify_failed', inserted.error ?? 'notify failed');
        delivered += chunk.length;
      }
    } else {
      const count = await rpc<number>(ctx, 'notify_all_members', {
        p_kind: 'system',
        p_group: 'system',
        p_title: title,
        p_body: body,
        p_deep_link: '/',
        p_dedupe_prefix: `operator:${ctx.taskId ?? Date.now()}`,
      });
      delivered = typeof count === 'number' ? count : 0;
    }

    const run = await restInsert('operator_notification_run', {
      title,
      body,
      audience,
      audience_filter: world ? { world } : {},
      kind: 'system',
      status: 'completed',
      target_count: delivered,
      delivered_count: delivered,
      failed_count: 0,
      task_id: ctx.taskId,
      finished_at: new Date().toISOString(),
    });
    if (!run.ok) return fail('run_log_failed', run.error ?? 'notification run log failed');
    return { ok: true, data: { delivered, audience, verified: true } };
  },

  'moderation.queue': async (ctx, input) => {
    const data = await rpc(ctx, 'operator_moderation_queue', { p_limit: num(input, 'limit', 25) });
    return { ok: true, data };
  },

  'moderation.rules': async (ctx) => {
    const result = await restSelect('operator_policy', 'select=moderation,approval_required,autonomy&limit=1');
    if (!result.ok) return fail('policy_unavailable', result.error ?? 'policy unavailable');
    const row = firstRow(result.data) ?? {};
    return {
      ok: true,
      data: {
        thresholds: row.moderation ?? {},
        approval_required: row.approval_required ?? [],
        autonomy: row.autonomy ?? {},
        guidance:
          'Remove clearly explicit sexual content at or above the explicit threshold. For other violations use proportionate warnings, suspensions or bans. Restoring removed content always requires human approval.',
      },
    };
  },

  'moderation.remove_content': async (ctx, input) => {
    const targetType = str(input, 'target_type');
    const targetId = str(input, 'target_id');
    const ruleCode = str(input, 'rule_code', 'policy_violation');
    const reason = str(input, 'reason', 'Policy violation');
    const confidence = num(input, 'confidence', 0);
    const caseRow = await restInsert('operator_moderation_case', {
      target_type: targetType,
      target_id: targetId,
      rule_code: ruleCode,
      rule_text: reason,
      confidence,
      decision: 'remove',
      task_id: ctx.taskId,
      decided_by: ctx.staffId,
    });
    if (!caseRow.ok) return fail('case_failed', caseRow.error ?? 'case creation failed');
    const caseId = String((firstRow(caseRow.data) ?? {}).id ?? '');
    const data = await rpc(ctx, 'operator_moderate_content', {
      p_target_type: targetType,
      p_target_id: targetId,
      p_action: 'remove',
      p_reason: `${ruleCode}: ${reason}`.slice(0, 500),
      p_case_id: caseId || null,
    });
    return { ok: true, data };
  },

  'moderation.suspend': async (ctx, input) => {
    const profileId = str(input, 'profile_id');
    const ruleCode = str(input, 'rule_code', 'policy_violation');
    const reason = str(input, 'reason', 'Policy violation');
    const days = num(input, 'days', 7);
    const caseRow = await restInsert('operator_moderation_case', {
      target_type: 'user',
      target_id: profileId,
      rule_code: ruleCode,
      rule_text: reason,
      confidence: num(input, 'confidence', 0),
      decision: 'suspend',
      task_id: ctx.taskId,
      decided_by: ctx.staffId,
    });
    if (!caseRow.ok) return fail('case_failed', caseRow.error ?? 'case creation failed');
    const data = await rpc(ctx, 'operator_suspend_member', {
      p_profile_id: profileId,
      p_reason: `${ruleCode}: ${reason}`.slice(0, 500),
      p_days: days,
    });
    return { ok: true, data };
  },

  'moderation.ban': async (ctx, input) => {
    const profileId = str(input, 'profile_id');
    const ruleCode = str(input, 'rule_code', 'policy_violation');
    const reason = str(input, 'reason', 'Policy violation');
    const caseRow = await restInsert('operator_moderation_case', {
      target_type: 'user',
      target_id: profileId,
      rule_code: ruleCode,
      rule_text: reason,
      confidence: num(input, 'confidence', 0),
      decision: 'ban',
      task_id: ctx.taskId,
      decided_by: ctx.staffId,
    });
    if (!caseRow.ok) return fail('case_failed', caseRow.error ?? 'case creation failed');
    const data = await rpc(ctx, 'operator_ban_member', {
      p_profile_id: profileId,
      p_reason: `${ruleCode}: ${reason}`.slice(0, 500),
    });
    return { ok: true, data };
  },

  'moderation.restore': async (ctx, input) => {
    const actionId = str(input, 'moderation_action_id');
    const reason = str(input, 'reason', 'Restored after review');
    const lookup = await restSelect(
      'moderation_actions',
      `select=id,target_type,target_id,action&id=eq.${actionId}&limit=1`,
    );
    if (!lookup.ok) return fail('lookup_failed', lookup.error ?? 'lookup failed');
    const row = firstRow(lookup.data);
    if (!row) return fail('not_found', 'moderation action not found');
    const targetType = String(row.target_type ?? '');
    if (targetType !== 'post' && targetType !== 'comment') {
      return fail('unsupported_target', `cannot restore target type ${targetType}`);
    }
    const data = await rpc(ctx, 'operator_moderate_content', {
      p_target_type: targetType,
      p_target_id: String(row.target_id),
      p_action: 'restore',
      p_reason: reason.slice(0, 500),
      p_case_id: null,
    });
    return { ok: true, data };
  },

  'analytics.platform': async (ctx) => {
    const data = await rpc(ctx, 'operator_platform_analytics', {});
    return { ok: true, data };
  },

  'research.search': async (_ctx, input) => {
    const query = str(input, 'query');
    const world = str(input, 'world', '');
    const escaped = query.replace(/[%,()]/g, ' ').trim();
    const filters = [
      `or=(title.ilike.*${encodeURIComponent(escaped)}*,original_title.ilike.*${encodeURIComponent(escaped)}*)`,
      world ? `world=eq.${world}` : '',
      'limit=12',
    ]
      .filter(Boolean)
      .join('&');
    const result = await restSelect(
      'titles',
      `select=id,title,original_title,media_type,world,year,popularity,community_rating,follower_count,synopsis,genres,next_episode_at&${filters}`,
    );
    if (!result.ok) return fail('search_failed', result.error ?? 'search failed');
    return { ok: true, data: { results: result.data ?? [] } };
  },

  'research.web': async (_ctx, input) => {
    const query = str(input, 'query').trim();
    if (query.length < 2) return fail('invalid_query', 'query is too short');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const url =
        'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*' +
        `&srlimit=6&srsearch=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'HallyuOperator/1.0 (research; contact: staff@hallyu.app)' },
        signal: controller.signal,
      });
      if (!response.ok) return fail('web_search_failed', `upstream HTTP ${response.status}`);
      const payload = (await response.json()) as {
        query?: { search?: { title?: string; snippet?: string }[] };
      };
      const results = (payload.query?.search ?? [])
        .filter((row) => typeof row.title === 'string')
        .map((row) => ({
          title: row.title as string,
          snippet: String(row.snippet ?? '').replace(/<[^>]+>/g, '').trim(),
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent((row.title as string).replace(/ /g, '_'))}`,
        }));
      return { ok: true, data: { source: 'wikipedia', query, results } };
    } catch (error) {
      return fail('web_search_failed', (error as Error).message.slice(0, 200));
    } finally {
      clearTimeout(timer);
    }
  },

  'research.save': async (ctx, input) => {
    const inserted = await restInsert('operator_research_item', {
      topic: str(input, 'topic'),
      headline: str(input, 'headline'),
      summary: str(input, 'summary', '') || null,
      source_name: str(input, 'source_name', '') || null,
      source_url: str(input, 'source_url', '') || null,
      verification: str(input, 'verification', 'unverified'),
      world: str(input, 'world', '') || null,
    });
    if (!inserted.ok) return fail('save_failed', inserted.error ?? 'save failed');
    return { ok: true, data: { item: firstRow(inserted.data), verified: true } };
  },

  'campaign.create': async (ctx, input) => {
    const inserted = await restInsert('operator_campaign', {
      name: str(input, 'name'),
      kind: str(input, 'kind', 'campaign'),
      status: 'draft',
      starts_at: str(input, 'starts_at', '') || null,
      ends_at: str(input, 'ends_at', '') || null,
      payload: (input.payload as Record<string, unknown>) ?? {},
    });
    if (!inserted.ok) return fail('campaign_failed', inserted.error ?? 'campaign failed');
    return { ok: true, data: { campaign: firstRow(inserted.data), verified: true } };
  },

  'ops.task_list': async (_ctx, input) => {
    const status = str(input, 'status', '');
    const limit = Math.min(Math.max(num(input, 'limit', 20), 1), 100);
    const filters = [
      'select=id,task_type,status,priority,attempt_count,error_code,created_at,updated_at,available_at',
      status ? `status=eq.${status}` : '',
      'order=created_at.desc',
      `limit=${limit}`,
    ]
      .filter(Boolean)
      .join('&');
    const result = await restSelect('operator_task', filters);
    if (!result.ok) return fail('list_failed', result.error ?? 'list failed');
    return { ok: true, data: { tasks: result.data ?? [] } };
  },

  'ops.task_retry': async (_ctx, input) => {
    const taskId = str(input, 'task_id');
    const patched = await restPatch(
      'operator_task',
      `id=eq.${taskId}&status=in.(failed,dead,retrying)`,
      {
        status: 'queued',
        available_at: new Date().toISOString(),
        error_code: null,
        error_detail: null,
        lease_owner: null,
        lease_expires_at: null,
      },
    );
    if (!patched.ok) return fail('retry_failed', patched.error ?? 'retry failed');
    const verify = await restSelect('operator_task', `select=id,status&id=eq.${taskId}&limit=1`);
    const row = firstRow(verify.data);
    if (!row || row.status !== 'queued') return fail('retry_not_applied', 'task was not re-queued');
    return { ok: true, data: { ...row, verified: true } };
  },

  'ops.health': async (ctx) => {
    const [providers, workers, tasks] = await Promise.all([
      restSelect(
        'operator_provider',
        'select=provider,label,model_id,enabled,is_default,health,last_ok_at,last_error_at,last_error_code,rpm_limit',
      ),
      restSelect('operator_worker_health', 'select=worker_id,last_seen_at,version,tasks_processed,last_error&order=last_seen_at.desc&limit=5'),
      restSelect('operator_task', 'select=status&limit=5000'),
    ]);
    const counts: Record<string, number> = {};
    if (tasks.ok && Array.isArray(tasks.data)) {
      for (const row of tasks.data as Array<Record<string, unknown>>) {
        const key = String(row.status ?? 'unknown');
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return {
      ok: true,
      data: {
        providers: providers.ok ? providers.data : [],
        workers: workers.ok ? workers.data : [],
        task_counts: counts,
        checked_at: new Date().toISOString(),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// JSON Schema validation (the subset used by operator_tool.input_schema)
// ---------------------------------------------------------------------------

interface SchemaRule {
  type?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, SchemaRule>;
  additionalProperties?: boolean;
  items?: SchemaRule;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
}

function validateValue(rule: SchemaRule, value: unknown, path: string): string | null {
  if (rule.enum && !rule.enum.includes(value)) {
    return `${path} must be one of: ${rule.enum.join(', ')}`;
  }
  switch (rule.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} must be an object`;
      const obj = value as Record<string, unknown>;
      for (const key of rule.required ?? []) {
        if (!(key in obj) || obj[key] === undefined || obj[key] === null) return `${path}.${key} is required`;
      }
      if (rule.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(rule.properties ?? {})[key]) return `${path}.${key} is not allowed`;
        }
      }
      for (const [key, child] of Object.entries(rule.properties ?? {})) {
        if (key in obj && obj[key] !== undefined && obj[key] !== null) {
          const error = validateValue(child, obj[key], `${path}.${key}`);
          if (error) return error;
        }
      }
      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (rule.minItems !== undefined && value.length < rule.minItems) return `${path} needs at least ${rule.minItems} items`;
      if (rule.maxItems !== undefined && value.length > rule.maxItems) return `${path} allows at most ${rule.maxItems} items`;
      if (rule.items) {
        for (let i = 0; i < value.length; i += 1) {
          const error = validateValue(rule.items, value[i], `${path}[${i}]`);
          if (error) return error;
        }
      }
      return null;
    }
    case 'string': {
      if (typeof value !== 'string') return `${path} must be a string`;
      if (rule.minLength !== undefined && value.length < rule.minLength) return `${path} is too short`;
      if (rule.maxLength !== undefined && value.length > rule.maxLength) return `${path} is too long`;
      if (rule.pattern && !new RegExp(rule.pattern).test(value)) return `${path} has an invalid format`;
      return null;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return `${path} must be an integer`;
      if (rule.minimum !== undefined && value < rule.minimum) return `${path} must be >= ${rule.minimum}`;
      if (rule.maximum !== undefined && value > rule.maximum) return `${path} must be <= ${rule.maximum}`;
      return null;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} must be a number`;
      if (rule.minimum !== undefined && value < rule.minimum) return `${path} must be >= ${rule.minimum}`;
      if (rule.maximum !== undefined && value > rule.maximum) return `${path} must be <= ${rule.maximum}`;
      return null;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return `${path} must be a boolean`;
      return null;
    }
    default:
      return null;
  }
}

export function validateAgainstSchema(schema: Record<string, unknown>, input: unknown): string | null {
  return validateValue(schema as SchemaRule, input, 'input');
}

// ---------------------------------------------------------------------------
// Permission + rate limiting
// ---------------------------------------------------------------------------

const READ_ONLY_PERMISSIONS = new Set([
  'member.read',
  'conversation.read',
  'analytics.read',
  'moderation.read',
  'research.read',
  'ops.read',
]);

export function permissionAllowed(tool: ToolRow, ctx: ToolContext): { allowed: boolean; reason?: string } {
  if (tool.approval_required) {
    return { allowed: false, reason: 'approval_required' };
  }
  if (READ_ONLY_PERMISSIONS.has(tool.permission)) return { allowed: true };

  const autonomy = ctx.policy.autonomy ?? {};

  switch (tool.permission) {
    case 'message.send':
      if (ctx.channel === 'admin_control') return { allowed: true };
      if (ctx.channel === 'member_ai') return autonomy.reply_member_dm === true ? { allowed: true } : { allowed: false, reason: 'autonomy_disabled:reply_member_dm' };
      if (ctx.channel === 'public_thread') return autonomy.reply_public_mention === true ? { allowed: true } : { allowed: false, reason: 'autonomy_disabled:reply_public_mention' };
      return { allowed: false, reason: 'channel_not_permitted' };
    case 'content.write':
      return autonomy.publish_content === true ? { allowed: true } : { allowed: false, reason: 'autonomy_disabled:publish_content' };
    case 'campaign.write':
      return autonomy.publish_content === true ? { allowed: true } : { allowed: false, reason: 'autonomy_disabled:publish_content' };
    case 'notification.send':
      return autonomy.send_notifications === true ? { allowed: true } : { allowed: false, reason: 'autonomy_disabled:send_notifications' };
    case 'moderation.enforce':
      if (tool.name === 'moderation.suspend' || tool.name === 'moderation.ban') {
        return autonomy.suspend_or_ban === true ? { allowed: true } : { allowed: false, reason: 'autonomy_disabled:suspend_or_ban' };
      }
      return autonomy.moderate_explicit_sexual === true || autonomy.moderate_other_violations === true
        ? { allowed: true }
        : { allowed: false, reason: 'autonomy_disabled:moderation' };
    case 'moderation.reverse':
      return { allowed: false, reason: 'approval_required' };
    case 'research.write':
      return autonomy.research === true ? { allowed: true } : { allowed: false, reason: 'autonomy_disabled:research' };
    case 'ops.write':
      return ctx.channel === 'admin_control' ? { allowed: true } : { allowed: false, reason: 'admin_channel_only' };
    default:
      return { allowed: false, reason: `unknown_permission:${tool.permission}` };
  }
}

export async function rateLimitExceeded(ctx: ToolContext, tool: ToolRow): Promise<boolean> {
  if (!ctx.taskId) return false;
  // Column is `tool` (not `tool_name`). If the count query fails we FAIL CLOSED: a broken
  // limiter must never silently allow unbounded tool execution.
  const result = await restSelect(
    'operator_tool_call',
    `select=id&task_id=eq.${ctx.taskId}&tool=eq.${encodeURIComponent(tool.name)}&limit=1000`,
  );
  if (!result.ok || !Array.isArray(result.data)) return true;
  const rpm = tool.rate_limit_per_min ?? 30;
  const perTaskCap = Math.max(rpm * 3, 10);
  return result.data.length >= perTaskCap;
}

/**
 * Resolve the conversation id a tool may act on. The id is bound to the authenticated task
 * context; a model-supplied id is only accepted when it matches that context exactly, so a model
 * can never redirect a reply into someone else's conversation.
 */
function boundConversationId(ctx: ToolContext, input: Record<string, unknown>): string | null {
  const supplied = str(input, 'conversation_id').trim();
  if (supplied && ctx.conversationId && supplied !== ctx.conversationId) return null;
  return ctx.conversationId ?? (supplied || null);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function toToolSchemas(rows: ToolRow[]): ToolSchema[] {
  return rows
    .filter((row) => row.enabled && handlers[row.name])
    .map((row) => ({
      type: 'function' as const,
      function: {
        name: row.name,
        description: row.description,
        parameters: row.input_schema,
      },
    }));
}

export interface ToolExecution extends ToolOutcome {
  tool: string;
  durationMs: number;
  permission: string;
}

export async function executeTool(
  ctx: ToolContext,
  tool: ToolRow,
  rawArguments: string,
): Promise<ToolExecution> {
  const startedAt = Date.now();
  const finish = (outcome: ToolOutcome): ToolExecution => ({
    ...outcome,
    tool: tool.name,
    durationMs: Date.now() - startedAt,
    permission: tool.permission,
  });

  const handler = handlers[tool.name];
  if (!handler) return finish(fail('unknown_tool', `no handler for ${tool.name}`));
  if (!tool.enabled) return finish(fail('tool_disabled', `${tool.name} is disabled`));

  let input: Record<string, unknown>;
  try {
    const parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return finish(fail('invalid_arguments', 'arguments must be a JSON object'));
    }
    input = parsed as Record<string, unknown>;
  } catch (error) {
    return finish(fail('invalid_json', `arguments are not valid JSON: ${(error as Error).message.slice(0, 160)}`));
  }

  const schemaError = validateAgainstSchema(tool.input_schema, input);
  if (schemaError) return finish(fail('schema_validation', schemaError));

  const permission = permissionAllowed(tool, ctx);
  if (!permission.allowed) {
    return finish(fail(permission.reason === 'approval_required' ? 'approval_required' : 'permission_denied', permission.reason ?? 'not permitted'));
  }

  if (await rateLimitExceeded(ctx, tool)) {
    return finish(fail('rate_limited', `${tool.name} exceeded its per-task rate limit`));
  }

  const timeoutMs = Math.min(Math.max(tool.timeout_ms ?? 15_000, 1_000), 60_000);
  try {
    const outcome = await Promise.race([
      handler(ctx, input),
      new Promise<ToolOutcome>((resolve) =>
        setTimeout(() => resolve(fail('timeout', `${tool.name} timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return finish(outcome);
  } catch (error) {
    return finish(fail('tool_error', (error as Error).message.slice(0, 400)));
  }
}

export async function recordToolCall(
  ctx: ToolContext,
  execution: ToolExecution,
  argumentsJson: string,
): Promise<void> {
  await restInsert('operator_tool_call', {
    task_id: ctx.taskId,
    tool: execution.tool,
    args: safeJson(argumentsJson),
    result: summarize(execution),
    // operator_tool_call only accepts succeeded/partially_succeeded/rejected/failed/pending/
    // not_verified. Writing 'ok'/'error' made every insert fail, which left the tool audit trail
    // empty and made the per-task rate limiter count nothing.
    outcome: execution.ok ? 'succeeded' : 'failed',
    error_code: execution.code ?? null,
    error_detail: execution.ok ? null : (execution.error ?? null),
    duration_ms: execution.durationMs,
  });
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return { raw: value.slice(0, 500) };
  }
}

function summarize(execution: ToolExecution): Record<string, unknown> {
  if (!execution.ok) return { error: execution.error?.slice(0, 300) ?? null };
  const data = execution.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data as Record<string, unknown>).slice(0, 12);
    return { keys };
  }
  if (Array.isArray(data)) return { count: data.length };
  return { value: String(data).slice(0, 120) };
}
