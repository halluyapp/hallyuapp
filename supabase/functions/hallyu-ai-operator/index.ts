// hallyu-ai-operator — the Hallyu AI executive agent, server-side.
//
// Spec: docs/HALLYU_AI_PROJECT.md ("a real agent, not hardcoded chat responses"). One endpoint,
// five actions, one tool-using loop: the model plans, calls real backend tools from a fixed
// allowlist, records every call in hallyu_ai_tool_call, and asks staff for approval before any
// restricted action. It never fakes success: a failed tool is recorded as failed and reported.
//
// Model credentials (set once, never in the repo):
//   supabase secrets set RORK_AI_BASE_URL=... RORK_AI_API_KEY=... RORK_AI_MODEL=...
// Until they are set, every action answers 503 with exactly that reason — the operator does not
// pretend to run without a model.

import { corsHeaders } from '../_shared/cors.ts';

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const AI_BASE_URL = (Deno.env.get('RORK_AI_BASE_URL') ?? '').replace(/\/$/, '');
const AI_API_KEY = Deno.env.get('RORK_AI_API_KEY') ?? '';
const AI_MODEL = Deno.env.get('RORK_AI_MODEL') ?? 'gpt-5';

const MAX_STEPS = 5;

// ── PostgREST helpers (service role — the only writer to the hallyu_ai_* tables) ───────────────

async function db(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE}`,
      apikey: SERVICE_ROLE,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

async function rpc(name: string, args: unknown): Promise<unknown> {
  const res = await db(`rpc/${name}`, { method: 'POST', body: JSON.stringify(args ?? {}) });
  const text = await res.text();
  if (!res.ok) throw new Error(`backend rejected ${name} (HTTP ${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function insertRow(table: string, row: unknown): Promise<unknown> {
  const res = await db(table, { method: 'POST', body: JSON.stringify(row), headers: { Prefer: 'return=representation' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`could not record into ${table} (HTTP ${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// ── caller identity (JWT already verified by the platform; we re-check the live role) ──────────

function jwtSub(req: Request): string | null {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

async function callerProfile(sub: string | null): Promise<{ id: string; role: string } | null> {
  if (!sub) return null;
  const rows = (await rpc('hallyu_ai_profile_by_sub', { p_sub: sub }).catch(() => null)) as
    | { id: string; role: string }[]
    | null;
  if (rows && rows[0]?.id) return rows[0];
  // Fallback: direct read on the canonical column pair.
  const res = await db(`profiles?select=id,role,account_status&auth_sub=eq.${encodeURIComponent(sub)}&limit=1`);
  if (!res.ok) return null;
  const list = (await res.json()) as { id: string; role: string; account_status: string }[];
  const profile = list[0];
  return profile && profile.account_status === 'active' ? { id: profile.id, role: profile.role } : null;
}

const isStaffRole = (role: string | undefined) => role === 'admin' || role === 'ceo';

// ── tool registry: fixed allowlist, real backend actions only ──────────────────────────────────
// `staff` tools are removed from the registry entirely for non-admin callers, so the model cannot
// even see them. `approval` tools park the task until staff approve it in the Command Centre.

interface Tool {
  name: string;
  description: string;
  args: string;
  staff: boolean;
  approval?: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

interface ToolContext {
  staff: boolean;
  profileId: string;
  taskId: string;
}

const READ_COLUMNS = 'id, created_at, kind, title, body, author_id, community_id, like_count, comment_count';

const TOOLS: Tool[] = [
  {
    name: 'platform_overview',
    description: 'Live platform health evidence: bootstrap KPIs, config and counters for the real backend.',
    args: '{}',
    staff: false,
    run: async () => rpc('get_bootstrap', {}),
  },
  {
    name: 'community_pulse',
    description: 'Read the newest public posts and comments to sense what the community is discussing.',
    args: '{ "table": "posts" | "comments", "limit": 20 }',
    staff: false,
    run: async (args) => {
      const table = args.table === 'comments' ? 'comments' : 'posts';
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const res = await db(`${table}?select=${READ_COLUMNS}&order=created_at.desc&limit=${limit}`);
      if (!res.ok) throw new Error(`could not read ${table} (HTTP ${res.status})`);
      return res.json();
    },
  },
  {
    name: 'member_context',
    description: 'Minimal profile facts for one member id (handle, role, joined date) for personalisation.',
    args: '{ "profile_id": "uuid" }',
    staff: false,
    run: async (args) => {
      const id = String(args.profile_id ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('profile_id must be a uuid');
      const res = await db(`profiles?select=id,handle,display_name,role,created_at&id=eq.${id}&limit=1`);
      if (!res.ok) throw new Error(`could not read profile (HTTP ${res.status})`);
      return res.json();
    },
  },
  {
    name: 'remember',
    description: 'Persist one durable operational memory (decision, campaign outcome, pattern).',
    args: '{ "kind": "decision|campaign_outcome|pattern|note", "key": "short unique key", "value": {} }',
    staff: true,
    run: async (args, ctx) => {
      const kind = String(args.kind ?? 'note');
      const key = String(args.key ?? '').slice(0, 120);
      if (!key) throw new Error('memory key is required');
      await insertRow('hallyu_ai_memory', { kind, key, value: args.value ?? {}, task_id: ctx.taskId });
      return { stored: `${kind}/${key}` };
    },
  },
  {
    name: 'send_broadcast',
    description: 'Send an official Hallyu announcement/broadcast to the community. STAFF APPROVAL REQUIRED.',
    args: '{ "title": "...", "body": "...", "path": "/ or /events or /(tabs)/explore" }',
    staff: true,
    approval: true,
    run: async (args) =>
      rpc('send_admin_broadcast', {
        p_title: String(args.title ?? 'Hallyu announcement'),
        p_body: String(args.body ?? ''),
        p_path: String(args.path ?? '/'),
      }),
  },
];

function registryFor(staff: boolean): Tool[] {
  return TOOLS.filter((tool) => (staff ? true : !tool.staff));
}

function toolManifest(staff: boolean): string {
  return registryFor(staff)
    .map((tool) => `- ${tool.name}(${tool.args}): ${tool.description}`)
    .join('\n');
}

// ── model adapter (OpenAI-compatible; Rork AI Cloud endpoint is set via secrets) ───────────────

async function callModel(messages: { role: string; content: string }[]): Promise<string> {
  if (!AI_BASE_URL || !AI_API_KEY) {
    throw Object.assign(
      new Error(
        'Hallyu AI model credentials are not configured on the backend. Set RORK_AI_BASE_URL, RORK_AI_API_KEY and RORK_AI_MODEL with `supabase secrets set`, then retry.',
      ),
      { statusCode: 503 },
    );
  }
  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
    body: JSON.stringify({ model: AI_MODEL, messages, temperature: 0.3 }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`model call failed (HTTP ${res.status}).`), { statusCode: 502 });
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw Object.assign(new Error('model returned an empty answer.'), { statusCode: 502 });
  return content;
}

/** The operator protocol: either {"tool": "...", "args": {...}} or {"final": "..."} */
function parseProtocol(content: string): { tool?: string; args?: Record<string, unknown>; final?: string } {
  const start = content.indexOf('{');
  const candidate = start >= 0 ? content.slice(start, content.lastIndexOf('}') + 1) : content;
  try {
    const parsed = JSON.parse(candidate) as { tool?: string; args?: Record<string, unknown>; final?: string };
    return parsed ?? {};
  } catch {
    return { final: content.trim() };
  }
}

const SYSTEM_PROMPT = (staff: boolean) => `You are Hallyu AI, the autonomous AI executive of the Hallyu social platform (K-drama, C-drama, anime, Hollywood fan community).
You are transparent that you are an AI. Never impersonate a human member.
Rules: investigate real data with your tools before answering; never invent numbers or news; if evidence is missing, say so and name what is missing; report failures honestly.
Available tools:\n${toolManifest(staff)}
Answer ONLY with JSON: either {"tool": "<name>", "args": {...}} to run one tool step, or {"final": "<your answer to the member>"} when you can answer without tools.`;

// ── task state helpers ─────────────────────────────────────────────────────────────────────────

async function setTaskStatus(taskId: string, status: string, patch: Record<string, unknown> = {}): Promise<void> {
  const res = await db(`hallyu_ai_task?id=eq.${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, ...patch }),
  });
  if (!res.ok) throw new Error(`could not update task status (HTTP ${res.status})`);
}

async function recordToolCall(taskId: string, seq: number, tool: string, args: unknown, outcome: {
  status: string;
  result?: unknown;
  error?: string;
}): Promise<void> {
  await insertRow('hallyu_ai_tool_call', {
    task_id: taskId,
    seq,
    tool,
    args: args ?? {},
    status: outcome.status,
    result: outcome.result === undefined ? null : outcome.result,
    error: outcome.error ?? null,
    finished_at: new Date().toISOString(),
  });
}

async function approvedFor(taskId: string, tool: string): Promise<boolean> {
  const res = await db(`hallyu_ai_approval?select=id&task_id=eq.${taskId}&tool=eq.${tool}&status=eq.approved&limit=1`);
  if (!res.ok) return false;
  const rows = (await res.json()) as { id: string }[];
  return rows.length > 0;
}

// ── the operator loop ──────────────────────────────────────────────────────────────────────────

async function runTask(taskId: string): Promise<Record<string, unknown>> {
  const res = await db(`hallyu_ai_task?id=eq.${taskId}&select=*&limit=1`);
  const rows = (await res.json()) as {
    id: string;
    prompt: string;
    kind: string;
    requester_role: string;
    requester_profile_id: string | null;
    status: string;
  }[];
  const task = rows[0];
  if (!task) throw Object.assign(new Error('task not found.'), { statusCode: 404 });
  if (task.status === 'awaiting_approval') {
    return { status: 'awaiting_approval', detail: 'staff approval is pending in the Command Centre.' };
  }
  if (!['queued', 'running'].includes(task.status)) {
    return { status: task.status, detail: 'task already settled; start a new one for further work.' };
  }

  const staff = isStaffRole(task.requester_role);
  const tools = registryFor(staff);
  const history: { role: string; content: string }[] = [
    { role: 'system', content: SYSTEM_PROMPT(staff) },
    { role: 'user', content: task.prompt },
  ];
  let answer: string | null = null;
  let seq = 0;

  await setTaskStatus(taskId, 'running', { model: AI_MODEL });

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const protocol = parseProtocol(await callModel(history));
      if (protocol.final !== undefined) {
        answer = String(protocol.final);
        break;
      }
      const tool = tools.find((entry) => entry.name === protocol.tool);
      seq += 1;
      if (!tool) {
        await recordToolCall(taskId, seq, String(protocol.tool ?? 'unknown'), protocol.args, {
          status: 'denied',
          error: 'tool not in this caller registry',
        });
        history.push({ role: 'user', content: `Tool "${protocol.tool}" is not available. Use another tool or answer with {"final": ...}.` });
        continue;
      }
      if (tool.approval && !(await approvedFor(taskId, tool.name))) {
        await recordToolCall(taskId, seq, tool.name, protocol.args, { status: 'awaiting_approval' });
        await insertRow('hallyu_ai_approval', {
          task_id: taskId,
          tool: tool.name,
          args: protocol.args ?? {},
          reason: 'restricted action declared by the operator; staff authorisation required',
        });
        await setTaskStatus(taskId, 'awaiting_approval');
        return { status: 'awaiting_approval', detail: `${tool.name} needs staff approval — it is waiting in the Command Centre.` };
      }
      try {
        const result = await tool.run(protocol.args ?? {}, {
          staff,
          profileId: task.requester_profile_id ?? '',
          taskId,
        });
        await recordToolCall(taskId, seq, tool.name, protocol.args, { status: 'ok', result });
        history.push({ role: 'user', content: `Tool ${tool.name} returned: ${JSON.stringify(result).slice(0, 4000)}` });
      } catch (toolError) {
        // Honest failure: recorded, surfaced to the model, and never masked as success.
        const message = toolError instanceof Error ? toolError.message : String(toolError);
        await recordToolCall(taskId, seq, tool.name, protocol.args, { status: 'error', error: message });
        history.push({ role: 'user', content: `Tool ${tool.name} FAILED: ${message}. Choose another approach or report the failure in {"final": ...}.` });
      }
    }
    if (answer === null) {
      throw new Error(`operator stopped after ${MAX_STEPS} steps without a final answer.`);
    }
    await setTaskStatus(taskId, 'completed', { result: { answer }, finished_at: new Date().toISOString() });
    return { status: 'completed', answer };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await setTaskStatus(taskId, 'failed', { error: message, finished_at: new Date().toISOString() });
    throw e;
  }
}

// ── HTTP surface ───────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const profile = await callerProfile(jwtSub(req));
    if (!profile) return json({ error: 'sign in required' }, 401);
    const staff = isStaffRole(profile.role);

    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      prompt?: string;
      kind?: string;
      task_id?: string;
      approval_id?: string;
      approve?: boolean;
      note?: string;
    };

    switch (body.action) {
      case 'ping': {
        return json({
          model_configured: Boolean(AI_BASE_URL && AI_API_KEY),
          model: AI_MODEL,
          staff,
          tools: registryFor(staff).map((tool) => tool.name),
        });
      }

      case 'chat': {
        const prompt = (body.prompt ?? '').trim();
        if (!prompt) return json({ error: 'a question is required' }, 400);
        const task = (await insertRow('hallyu_ai_task', {
          kind: 'chat',
          title: prompt.slice(0, 80),
          prompt,
          requester_profile_id: profile.id,
          requester_role: profile.role,
        })) as { id: string }[];
        return json(await runTask(task[0]!.id));
      }

      case 'task.create': {
        if (!staff) return json({ error: 'admin or ceo role required' }, 403);
        const prompt = (body.prompt ?? '').trim();
        if (!prompt) return json({ error: 'a task prompt is required' }, 400);
        const task = (await insertRow('hallyu_ai_task', {
          kind: body.kind ?? 'ops',
          title: prompt.slice(0, 80),
          prompt,
          requester_profile_id: profile.id,
          requester_role: profile.role,
        })) as { id: string }[];
        return json({ task_id: task[0]!.id, ...(await runTask(task[0]!.id)) });
      }

      case 'task.run': {
        if (!staff) return json({ error: 'admin or ceo role required' }, 403);
        if (!body.task_id) return json({ error: 'task_id is required' }, 400);
        return json(await runTask(body.task_id));
      }

      case 'approval.decide': {
        if (!staff) return json({ error: 'admin or ceo role required' }, 403);
        if (!body.approval_id) return json({ error: 'approval_id is required' }, 400);
        const outcome = await rpc('hallyu_ai_decide_approval', {
          p_approval: body.approval_id,
          p_approve: Boolean(body.approve),
          p_note: body.note ?? null,
        });
        return json({ decided: outcome });
      }

      default:
        return json({ error: 'unknown action — use ping, chat, task.create, task.run or approval.decide' }, 400);
    }
  } catch (e) {
    const status = e instanceof Error && 'statusCode' in e ? Number((e as { statusCode?: number }).statusCode) || 500 : 500;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
