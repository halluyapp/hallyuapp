// hallyu-ai-operator — the Hallyu AI executive agent, server-side.
//
// Spec: docs/HALLYU_AI_PROJECT.md ("a real agent, not hardcoded chat responses"). One endpoint,
// five actions, one tool-using loop: the model plans and calls real backend tools from a fixed
// allowlist, records every call in hallyu_ai_tool_call, and reports failures honestly. It never
// fakes success: a failed tool is recorded as failed and told to the caller.
//
// Public-facing actions always require an exact, current staff approval. No configuration can disable this gate.
//
// Model: Gemini (the server-side AI capability this app declares in `metadata.json`) when its key is
// present, otherwise the Rork Toolkit gateway (`RORK_TOOLKIT_SECRET_KEY`). Until ONE of those two
// credentials exists, every action answers 503 naming exactly what is missing — the operator never
// pretends to run without a model.

// Inlined rather than imported from `_shared/cors.ts` on purpose: this is the one function the app
// invokes straight from the client, and keeping it a single self-contained artifact means it can be
// (re)deployed from its own source URL without the sibling module.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const TOOLKIT_URL = (Deno.env.get('TOOLKIT_URL') ?? Deno.env.get('EXPO_PUBLIC_TOOLKIT_URL') ?? 'https://toolkit.rork.com').replace(/\/$/, '');
const TOOLKIT_KEY = Deno.env.get('RORK_TOOLKIT_SECRET_KEY') ?? Deno.env.get('EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY') ?? Deno.env.get('RORK_AI_API_KEY') ?? '';
const AI_MODEL = Deno.env.get('RORK_AI_MODEL') ?? 'anthropic/claude-sonnet-5';
// Server-side Gemini capability (metadata.json MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API). Accept the
// names the platform and the Google SDKs use, so provisioning one of them is enough.
const GEMINI_KEY =
  Deno.env.get('GEMINI_API_KEY') ??
  Deno.env.get('GOOGLE_GENERATIVE_AI_API_KEY') ??
  Deno.env.get('GOOGLE_API_KEY') ??
  '';
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-2.5-flash';
const GEMINI_API_BASE = (Deno.env.get('GEMINI_API_BASE') ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');

type ModelProvider = 'gemini' | 'rork' | 'none';

/** Which credential the operator will actually use — the same answer every call must report. */
function modelProvider(): ModelProvider {
  if (GEMINI_KEY) return 'gemini';
  if (TOOLKIT_KEY) return 'rork';
  return 'none';
}

function activeModel(): string {
  return modelProvider() === 'gemini' ? GEMINI_MODEL : AI_MODEL;
}

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

// ── caller identity ───────────────────────────────────────────────────────────────────────────
//
// This function MUST deploy with `verify_jwt = false` (supabase/config.toml says so): members sign
// in through Rork Auth, and the edge gateway cannot verify Rork-issued tokens, so `verify_jwt = true`
// rejects every real call at the edge with UNAUTHORIZED_INVALID_JWT_FORMAT and the function never
// runs. Turning off the gateway check is not a hole, because identity is verified below by PostgREST:
// we hand the caller's own Bearer credential to `hallyu_ai_caller_profile()`, PostgREST validates the
// signature, and only a genuine active member resolves to a profile. Nothing here trusts a claim the
// caller could write themselves.

async function callerProfile(req: Request): Promise<{ id: string; role: string } | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  // PostgREST is the verifier: same JWT validation every RLS-guarded app query already goes through.
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/hallyu_ai_caller_profile`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: '{}',
  }).catch(() => null);
  if (!res || !res.ok) return null;

  const rows = (await res.json().catch(() => null)) as { id: string; role: string }[] | null;
  const profile = Array.isArray(rows) ? rows[0] : null;
  return profile?.id ? { id: profile.id, role: profile.role } : null;
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

const PUBLIC_POST_COLUMNS = 'id,created_at,type,kind,title,body,community_id,loved_count,cried_count,screamed_count,swooned_count,laughed_count,furious_count,comment_count';
const PUBLIC_COMMENT_COLUMNS = 'id,post_id,created_at,body,loved_count,cried_count,screamed_count,swooned_count,laughed_count,furious_count';

const TOOLS: Tool[] = [
  {
    name: 'platform_overview',
    description: 'Live platform health evidence: verified member, post, comment and operational counters.',
    args: '{}',
    staff: false,
    run: async () => rpc('hallyu_ai_platform_overview', {}),
  },
  {
    name: 'community_pulse',
    description: 'Read the newest public posts and comments to sense what the community is discussing.',
    args: '{ "table": "posts" | "comments", "limit": 20 }',
    staff: false,
    run: async (args) => {
      const table = args.table === 'comments' ? 'comments' : 'posts';
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const filters = table === 'posts'
        ? `select=${encodeURIComponent(`${PUBLIC_POST_COLUMNS},author:profiles!inner(account_status)`)}&state=eq.active&visibility=eq.public&author.account_status=eq.active`
        : `select=${encodeURIComponent(`${PUBLIC_COMMENT_COLUMNS},author:profiles!inner(account_status),post:posts!inner(state,visibility)`)}&state=eq.active&author.account_status=eq.active&post.state=eq.active&post.visibility=eq.public`;
      const res = await db(`${table}?${filters}&order=created_at.desc&limit=${limit}`);
      if (!res.ok) throw new Error(`could not read public ${table} (HTTP ${res.status})`);
      const rows = (await res.json()) as Record<string, unknown>[];
      // Service-role reads bypass RLS, so visibility and active-account rules are explicit above.
      // Remove embedded permission-check rows before handing community content to the model.
      return rows.map(({ author: _author, post: _post, ...row }) => row);
    },
  },
  {
    name: 'member_context',
    description: 'Minimal profile facts for one member id (handle, role, joined date) for personalisation.',
    args: '{ "profile_id": "uuid" }',
    staff: false,
    run: async (args, ctx) => {
      const id = String(args.profile_id ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('profile_id must be a uuid');
      if (!ctx.staff && id !== ctx.profileId) throw new Error('members may only inspect their own profile');
      const res = await db(`profiles?select=id,handle,display_name,role,created_at,account_status&id=eq.${id}&limit=1`);
      if (!res.ok) throw new Error(`could not read profile (HTTP ${res.status})`);
      const rows = (await res.json()) as Record<string, unknown>[];
      if (!ctx.staff && rows[0]?.account_status !== 'active') return [];
      return rows;
    },
  },
  {
    name: 'remember',
    description: 'Persist one durable operational memory (decision, campaign outcome, pattern).',
    args: '{ "kind": "decision|campaign_outcome|pattern|note", "key": "short unique key", "value": {} }',
    staff: true,
    run: async (args, ctx) => {
      const allowedKinds = new Set(['decision', 'campaign_outcome', 'pattern', 'note']);
      const kind = String(args.kind ?? 'note');
      const key = String(args.key ?? '').trim().slice(0, 120);
      if (!allowedKinds.has(kind)) throw new Error('memory kind must be decision, campaign_outcome, pattern, or note');
      if (!key) throw new Error('memory key is required');
      const value = args.value ?? {};
      if (JSON.stringify(value).length > 4000) throw new Error('memory value exceeds 4000 characters');
      const res = await db('hallyu_ai_memory?on_conflict=kind,key', {
        method: 'POST',
        body: JSON.stringify({ kind, key, value, task_id: ctx.taskId }),
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      });
      if (!res.ok) throw new Error(`could not save memory (HTTP ${res.status})`);
      return { stored: `${kind}/${key}`, updated_existing: true };
    },
  },
  {
    name: 'recall_memory',
    description: 'Search a small, relevant subset of approved operational memories. Staff only; config records are never returned.',
    args: '{ "query": "topic or question" }',
    staff: true,
    run: async (args) => {
      const res = await db('hallyu_ai_memory?select=kind,key,value,task_id,created_at&kind=in.(decision,campaign_outcome,pattern,note)&order=created_at.desc&limit=100');
      if (!res.ok) throw new Error(`could not retrieve memories (HTTP ${res.status})`);
      const rows = (await res.json()) as { kind: string; key: string; value: unknown; task_id: string | null; created_at: string }[];
      const terms = String(args.query ?? '').toLowerCase().split(/[^a-z0-9]{2,}/).filter((term) => term.length >= 3).slice(0, 8);
      if (!terms.length) return { matches: [], note: 'Provide a specific query to search memories.' };
      const ranked = rows.map((row) => {
        const haystack = `${row.key} ${JSON.stringify(row.value)}`.toLowerCase();
        return { row, score: terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0) };
      }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || b.row.created_at.localeCompare(a.row.created_at)).slice(0, 5);
      return { matches: ranked.map(({ row }) => row), scanned: rows.length };
    },
  },
  {
    name: 'send_broadcast',
    description: 'Send an official Hallyu announcement/broadcast to the whole community.',
    args: '{ "title": "...", "body": "...", "path": "/ or /events or /(tabs)/explore" }',
    staff: true,
    approval: true,
    run: async (args, ctx) =>
      rpc('hallyu_ai_execute_broadcast', {
        p_task: ctx.taskId,
        p_args: args,
      }),
  },
  {
    name: 'publish_post',
    description: 'Publish a public post or update to the Hallyu feed. Gated behind staff approval.',
    args: '{ "title": "string (optional)", "body": "string", "hashtags": "string[] (optional)" }',
    staff: true,
    approval: true,
    run: async (args, ctx) =>
      rpc('hallyu_ai_publish', {
        p_task: ctx.taskId,
        p_kind: 'publish_post',
        p_args: args,
      }),
  },
  {
    name: 'reply_comment',
    description: 'Post a comment reply to an existing public post. Gated behind staff approval.',
    args: '{ "post_id": "uuid", "body": "string" }',
    staff: true,
    approval: true,
    run: async (args, ctx) =>
      rpc('hallyu_ai_publish', {
        p_task: ctx.taskId,
        p_kind: 'reply_comment',
        p_args: args,
      }),
  },
  {
    name: 'create_poll',
    description: 'Create a community poll attached to a public post. Gated behind staff approval.',
    args: '{ "question": "string", "options": "string[]", "body": "string (optional)" }',
    staff: true,
    approval: true,
    run: async (args, ctx) =>
      rpc('hallyu_ai_publish', {
        p_task: ctx.taskId,
        p_kind: 'create_poll',
        p_args: args,
      }),
  },
  {
    name: 'list_schedules',
    description: 'Inspect automated background intelligence schedules.',
    args: '{}',
    staff: true,
    run: async () => rpc('hallyu_ai_admin_schedules', {}),
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

// Public-facing actions always fail closed behind a human approval. Configuration cannot turn this off.
async function approvalMode(): Promise<'on'> {
  return 'on';
}

// ── model adapters ────────────────────────────────────────────────────────────────────────────

async function callGemini(messages: { role: string; content: string }[]): Promise<string> {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  const res = await fetch(`${GEMINI_API_BASE}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents,
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw Object.assign(
      new Error(`Gemini call failed (HTTP ${res.status})${detail ? `: ${detail}` : '.'}`),
      { statusCode: 502 },
    );
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    promptFeedback?: { blockReason?: string };
  };
  const content = (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join('')
    .trim();
  if (!content) {
    const blocked = data.promptFeedback?.blockReason;
    throw Object.assign(
      new Error(blocked ? `Gemini blocked this request (${blocked}).` : 'model returned an empty answer.'),
      { statusCode: 502 },
    );
  }
  return content;
}

async function callRork(messages: { role: string; content: string }[]): Promise<string> {
  const res = await fetch(`${TOOLKIT_URL}/v2/vercel/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOOLKIT_KEY}` },
    body: JSON.stringify({ model: AI_MODEL, messages, temperature: 0.3 }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw Object.assign(new Error(`Rork AI Cloud call failed (HTTP ${res.status})${detail ? `: ${detail}` : '.'}`), { statusCode: 502 });
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw Object.assign(new Error('model returned an empty answer.'), { statusCode: 502 });
  return content;
}

async function callModel(messages: { role: string; content: string }[]): Promise<string> {
  const provider = modelProvider();
  if (provider === 'gemini') return callGemini(messages);
  if (provider === 'rork') return callRork(messages);
  throw Object.assign(
    new Error(
      'No AI model credential on this backend. Set ONE function secret: GEMINI_API_KEY (server-side Gemini capability declared in metadata.json) or RORK_TOOLKIT_SECRET_KEY (Rork AI Cloud), then redeploy hallyu-ai-operator.',
    ),
    { statusCode: 503 },
  );
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

const SYSTEM_PROMPT = (staff: boolean) => `You are Hallyu AI, the AI operator of the Hallyu social platform (K-drama, C-drama, anime, Hollywood fan community).
You are transparent that you are an AI. Never impersonate a human member.
Rules: investigate real data with your tools before answering; never invent numbers or news; if evidence is missing, say so and name what is missing; report failures honestly. Public actions require staff approval and will pause in the Command Centre.
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

async function hasApprovalFor(taskId: string, tool: string, args: Record<string, unknown>): Promise<boolean> {
  const res = await db(`hallyu_ai_approval?select=id&task_id=eq.${taskId}&tool=eq.${encodeURIComponent(tool)}&args=eq.${encodeURIComponent(JSON.stringify(args ?? {}))}&status=eq.approved&requested_at=gt.${encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())}&limit=1`);
  if (!res.ok) throw new Error(`could not verify approval (HTTP ${res.status})`);
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

  await setTaskStatus(taskId, 'running', { model: activeModel() });

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
      if (tool.approval && !(await hasApprovalFor(taskId, tool.name, protocol.args ?? {}))) {
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
    const profile = await callerProfile(req);
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
          model_configured: modelProvider() !== 'none',
          provider: modelProvider(),
          model: activeModel(),
          staff,
          approval_mode: await approvalMode(),
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
        const outcome = await rpc('hallyu_ai_decide_approval_verified', {
          p_approval: body.approval_id,
          p_approve: Boolean(body.approve),
          p_note: body.note ?? null,
          p_approver: profile.id,
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
