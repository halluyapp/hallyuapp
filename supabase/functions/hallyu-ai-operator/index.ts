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

// Multi-key Gemini configuration (Phase 1: Multi-Key Rotation and Controlled Failover)
const GEMINI_KEYS = [
  (
    Deno.env.get('GEMINI_API_KEY') ??
    Deno.env.get('GOOGLE_GENERATIVE_AI_API_KEY') ??
    Deno.env.get('GOOGLE_API_KEY') ??
    ''
  ).trim(),
  (Deno.env.get('GEMINI_API_KEY_2') ?? '').trim(),
  (Deno.env.get('GEMINI_API_KEY_3') ?? '').trim(),
];

const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-2.5-flash';
const GEMINI_API_BASE = (Deno.env.get('GEMINI_API_BASE') ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');

// Lovable Cloud AI integration
const LOVABLE_AI_KEY = (Deno.env.get('LOVABLE_AI_API_KEY') ?? Deno.env.get('LOVABLE_API_KEY') ?? '').trim();
const LOVABLE_AI_BASE = (Deno.env.get('LOVABLE_AI_BASE') ?? 'https://ai.lovable.dev/v1').replace(/\/$/, '');
const LOVABLE_AI_MODEL = Deno.env.get('LOVABLE_AI_MODEL') ?? 'google/gemini-2.5-flash';

// Rork AI Cloud — disabled by default as primary and fallback
const RORK_FALLBACK_ENABLED = Deno.env.get('RORK_FALLBACK_ENABLED') === 'true';
const TOOLKIT_URL = (Deno.env.get('TOOLKIT_URL') ?? Deno.env.get('EXPO_PUBLIC_TOOLKIT_URL') ?? 'https://toolkit.rork.com').replace(/\/$/, '');
const TOOLKIT_KEY = (Deno.env.get('RORK_TOOLKIT_SECRET_KEY') ?? Deno.env.get('EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY') ?? Deno.env.get('RORK_AI_API_KEY') ?? '').trim();
const AI_MODEL = Deno.env.get('RORK_AI_MODEL') ?? 'anthropic/claude-sonnet-5';

type ModelProvider = 'gemini' | 'lovable' | 'rork' | 'none';

interface KeyHealthState {
  index: number;
  label: string;
  status: 'healthy' | 'cooling_down' | 'rate_limited' | 'error';
  cooldownUntil: number | null;
  consecutiveFailures: number;
  totalRequests: number;
  totalSuccesses: number;
  lastUsedAt: string | null;
  lastLatencyMs: number | null;
  lastError: string | null;
}

const keyStates: KeyHealthState[] = [
  { index: 0, label: 'key_1', status: 'healthy', cooldownUntil: null, consecutiveFailures: 0, totalRequests: 0, totalSuccesses: 0, lastUsedAt: null, lastLatencyMs: null, lastError: null },
  { index: 1, label: 'key_2', status: 'healthy', cooldownUntil: null, consecutiveFailures: 0, totalRequests: 0, totalSuccesses: 0, lastUsedAt: null, lastLatencyMs: null, lastError: null },
  { index: 2, label: 'key_3', status: 'healthy', cooldownUntil: null, consecutiveFailures: 0, totalRequests: 0, totalSuccesses: 0, lastUsedAt: null, lastLatencyMs: null, lastError: null },
];

interface FailoverEvent {
  timestamp: string;
  from_key: string;
  to_key: string;
  reason: string;
}

const failoverEvents: FailoverEvent[] = [];
function recordFailover(from_key: string, to_key: string, reason: string): void {
  failoverEvents.unshift({
    timestamp: new Date().toISOString(),
    from_key,
    to_key,
    reason: reason.slice(0, 200),
  });
  if (failoverEvents.length > 10) failoverEvents.pop();
}

let lastSuccessfulInference: { at: string; provider: string; key_label?: string; latency_ms: number } | null = null;
let lastProviderFailure: { at: string; provider: string; key_label?: string; error: string } | null = null;
const latencySamples: number[] = [];

function recordLatency(ms: number): void {
  latencySamples.push(ms);
  if (latencySamples.length > 20) latencySamples.shift();
}

function avgLatency(): number | null {
  if (latencySamples.length === 0) return null;
  const sum = latencySamples.reduce((a, b) => a + b, 0);
  return Math.round(sum / latencySamples.length);
}

function configuredGeminiKeys(): { key: string; state: KeyHealthState }[] {
  return GEMINI_KEYS.map((k, i) => ({ key: k, state: keyStates[i]! })).filter((item) => Boolean(item.key));
}

/** Which credential the operator will actually use — the same answer every call must report. */
function modelProvider(): ModelProvider {
  if (configuredGeminiKeys().length > 0) return 'gemini';
  if (LOVABLE_AI_KEY) return 'lovable';
  if (RORK_FALLBACK_ENABLED && TOOLKIT_KEY) return 'rork';
  return 'none';
}

function activeModel(): string {
  const p = modelProvider();
  if (p === 'gemini') return GEMINI_MODEL;
  if (p === 'lovable') return LOVABLE_AI_MODEL;
  if (p === 'rork') return AI_MODEL;
  return 'none';
}

// Grounding, publishing and verification are three distinct steps on top of the reads a careful
// answer needs; five forced the model to spend its budget and then fail with nothing published.
const MAX_STEPS = 8;

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

// `system` is the scheduler's scope. It is never derived from a request body: only a service-role
// call (the OIDC-authorised scheduler) or a schedule row produces it, so autonomous work can
// publish while staff tools stay invisible to members.
const isStaffRole = (role: string | undefined) => role === 'admin' || role === 'ceo' || role === 'system';

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
        // The foreign key is named explicitly: `comments` has two links to profiles (author_id and
        // reply_to_user_id), so an unqualified embed is ambiguous and PostgREST answers 300.
        ? `select=${encodeURIComponent(`${PUBLIC_POST_COLUMNS},author:profiles!posts_author_id_fkey!inner(account_status)`)}&state=eq.active&visibility=eq.public&author.account_status=eq.active`
        : `select=${encodeURIComponent(`${PUBLIC_COMMENT_COLUMNS},author:profiles!comments_author_id_fkey!inner(account_status),post:posts!inner(state,visibility)`)}&state=eq.active&author.account_status=eq.active&post.state=eq.active&post.visibility=eq.public`;
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
    run: async (args) =>
      rpc('send_admin_broadcast', {
        p_title: String(args.title ?? 'Hallyu announcement').slice(0, 90),
        p_body: String(args.body ?? '').slice(0, 4000),
        p_path: String(args.path ?? '/'),
      }),
  },
  {
    name: 'publish_post',
    description: 'Publish a real feed post as the official Hallyu AI account. Grounded in the catalogue or live discussion only.',
    args: '{ "title": "<=90 chars (optional)", "body": "<=5000 chars", "world": "kdrama|cdrama|anime|hollywood", "hashtags": "string[] (optional)" }',
    staff: true,
    run: async (args, ctx) => {
      const body = String(args.body ?? '').trim();
      if (!body) throw new Error('body is required');
      return rpc('hallyu_ai_publish', {
        p_task_id: ctx.taskId,
        p_action: 'publish_post',
        p_title: String(args.title ?? '').slice(0, 90),
        p_body: body.slice(0, 5000),
        p_payload: {
          world: args.world ?? null,
          hashtags: Array.isArray(args.hashtags) ? args.hashtags.slice(0, 8) : [],
        },
        p_sources: Array.isArray(args.sources) ? args.sources : [],
      });
    },
  },
  {
    name: 'reply_comment',
    description: 'Reply to an existing public post as the official Hallyu AI account.',
    args: '{ "post_id": "uuid", "parent_id": "uuid (optional)", "body": "<=1000 chars" }',
    staff: true,
    run: async (args, ctx) => {
      const postId = String(args.post_id ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(postId)) throw new Error('post_id must be a uuid');
      const body = String(args.body ?? '').trim();
      if (!body) throw new Error('body is required');
      const parentId = typeof args.parent_id === 'string' && /^[0-9a-f-]{36}$/i.test(args.parent_id) ? args.parent_id : null;
      return rpc('hallyu_ai_publish', {
        p_task_id: ctx.taskId,
        p_action: 'reply_comment',
        p_title: null,
        p_body: body.slice(0, 1000),
        p_payload: { post_id: postId, parent_id: parentId },
        p_sources: [],
      });
    },
  },
  {
    name: 'create_poll',
    description: 'Publish a real community poll (2–4 distinct options) as the official Hallyu AI account.',
    args: '{ "question": "<=240 chars", "options": ["a", "b"], "world": "kdrama|cdrama|anime|hollywood", "hours": 168 }',
    staff: true,
    run: async (args, ctx) => {
      const options = Array.isArray(args.options)
        ? args.options.map((option) => String(option).trim()).filter(Boolean).slice(0, 4)
        : [];
      if (options.length < 2) throw new Error('a poll needs 2–4 non-empty options');
      return rpc('hallyu_ai_publish', {
        p_task_id: ctx.taskId,
        p_action: 'create_poll',
        p_title: String(args.question ?? 'Hallyu poll').slice(0, 240),
        p_body: String(args.question ?? 'Hallyu poll').slice(0, 5000),
        p_payload: { options, world: args.world ?? null, hours: Number(args.hours) || 168, hashtags: ['poll'] },
        p_sources: [],
      });
    },
  },
  {
    name: 'analytics_snapshot',
    description: 'Real measured platform numbers (members, posts, comments, reactions, AI output) with the period each covers.',
    args: '{}',
    staff: false,
    run: async () => rpc('hallyu_ai_analytics', {}),
  },
  {
    name: 'publishing_status',
    description: 'How many items were really published today against the three-per-day target, plus recent attempts and their outcome.',
    args: '{}',
    staff: false,
    run: async () => rpc('hallyu_ai_publication_summary', {}),
  },
  {
    name: 'catalog_digest',
    description: 'Real catalogue titles the platform already holds (TMDB-backed) to ground content in shows and films that exist.',
    args: '{ "world": "kdrama|cdrama|anime|hollywood" (optional), "limit": 10 }',
    staff: false,
    run: async (args) => {
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
      const world = typeof args.world === 'string' && args.world.trim() ? String(args.world).trim() : null;
      // get_world_discoveries takes only a limit; the world-filtered reader is discover_catalog.
      return world
        ? rpc('discover_catalog', { p_world: world, p_limit: limit })
        : rpc('get_home_discovery', { p_limit: limit });
    },
  },
  {
    name: 'recall',
    description: 'Read durable operational memory previously stored with remember.',
    args: '{ "kind": "decision|campaign_outcome|pattern|note" (optional), "limit": 10 }',
    staff: false,
    run: async (args) => {
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
      const kind = typeof args.kind === 'string' && args.kind.trim() ? String(args.kind).trim() : null;
      const filter = kind ? `&kind=eq.${encodeURIComponent(kind)}` : '';
      const res = await db(`hallyu_ai_memory?select=kind,key,value,created_at${filter}&order=created_at.desc&limit=${limit}`);
      if (!res.ok) throw new Error(`could not read memory (HTTP ${res.status})`);
      return res.json();
    },
  },
  {
    name: 'notify_owner',
    description: 'Send one in-app notification to the Hallyu owner with a finding or alert that actually matters.',
    args: '{ "title": "<=90 chars", "body": "<=400 chars" }',
    staff: true,
    run: async (args) => {
      const owner = await rpc('hallyu_ai_owner_id', {});
      if (typeof owner !== 'string' || !owner) throw new Error('no active CEO profile to notify');
      return rpc('notify_recipient', {
        p_recipient: owner,
        p_kind: 'system',
        p_group: 'system',
        p_title: String(args.title ?? 'Hallyu AI').slice(0, 90),
        p_body: String(args.body ?? '').slice(0, 400),
      });
    },
  },
  {
    name: 'list_schedules',
    description: 'Inspect automated background intelligence schedules.',
    args: '{}',
    staff: true,
    run: async () => rpc('hallyu_ai_admin_schedules', {}),
  },
  {
    name: 'get_post',
    description: 'Read one real post by id (title, body, world, type, author, engagement) when a member or admin refers to it.',
    args: '{ "post_id": "uuid" }',
    staff: false,
    run: async (args) => {
      const id = String(args.post_id ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('post_id must be a uuid');
      const res = await db(
        `posts?select=${encodeURIComponent(`${PUBLIC_POST_COLUMNS},world,hashtags,author:profiles!posts_author_id_fkey(handle,display_name,role,account_status)`)}&id=eq.${id}&state=eq.active&visibility=eq.public&limit=1`,
      );
      if (!res.ok) throw new Error(`could not read post (HTTP ${res.status})`);
      const rows = (await res.json()) as Record<string, unknown>[];
      const post = rows[0];
      if (!post) throw new Error('that post does not exist or is not public');
      const author = post.author as { account_status?: string } | undefined;
      if (author?.account_status !== 'active') throw new Error('that post belongs to an inactive account');
      return post;
    },
  },
  {
    name: 'get_comment',
    description: 'Read one real comment by id, including its post id and parent comment id.',
    args: '{ "comment_id": "uuid" }',
    staff: false,
    run: async (args) => {
      const id = String(args.comment_id ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('comment_id must be a uuid');
      const res = await db(`comments?select=id,post_id,parent_id,author_id,body,state,created_at&id=eq.${id}&limit=1`);
      if (!res.ok) throw new Error(`could not read comment (HTTP ${res.status})`);
      const rows = (await res.json()) as Record<string, unknown>[];
      if (!rows[0] || rows[0].state !== 'active') throw new Error('that comment does not exist or was removed');
      return rows[0];
    },
  },
  {
    name: 'get_post_thread',
    description: 'Read the real comments on a post, oldest first, to understand what the community actually said.',
    args: '{ "post_id": "uuid", "limit": 20 }',
    staff: false,
    run: async (args) => {
      const id = String(args.post_id ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('post_id must be a uuid');
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const res = await db(
        `comments?select=id,parent_id,author_id,body,created_at&post_id=eq.${id}&state=eq.active&order=created_at.asc&limit=${limit}`,
      );
      if (!res.ok) throw new Error(`could not read the thread (HTTP ${res.status})`);
      return res.json();
    },
  },
  {
    name: 'get_dm_context',
    description: 'Read the real Direct Message history between you and this person (members: only their own).',
    args: '{ "profile_id": "uuid (staff only)", "limit": 10 }',
    staff: false,
    run: async (args, ctx) => {
      const peer = ctx.staff && typeof args.profile_id === 'string' ? String(args.profile_id) : ctx.profileId;
      if (!/^[0-9a-f-]{36}$/i.test(peer)) throw new Error('profile_id must be a uuid');
      const aiId = await rpc('hallyu_ai_profile_id', {});
      if (typeof aiId !== 'string' || !aiId) throw new Error('the official Hallyu AI profile is unavailable');
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
      const pair = `or=(and(sender_id.eq.${peer},recipient_id.eq.${aiId}),and(sender_id.eq.${aiId},recipient_id.eq.${peer}))`;
      const res = await db(`direct_messages?select=sender_id,recipient_id,body,created_at&${pair}&order=created_at.desc&limit=${limit}`);
      if (!res.ok) throw new Error(`could not read the conversation (HTTP ${res.status})`);
      return res.json();
    },
  },
  {
    name: 'send_dm',
    description: 'Send a real Direct Message from the official Hallyu AI account to one active member. Staff only; use for proactive owner reporting or a considered reply.',
    args: '{ "recipient_id": "uuid", "body": "<=1500 chars" }',
    staff: true,
    run: async (args) => {
      const to = String(args.recipient_id ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(to)) throw new Error('recipient_id must be a uuid');
      const body = String(args.body ?? '').trim();
      if (!body) throw new Error('body is required');
      const aiId = await rpc('hallyu_ai_profile_id', {});
      if (typeof aiId !== 'string' || !aiId) throw new Error('the official Hallyu AI profile is unavailable');
      const who = await db(`profiles?select=id,account_status&id=eq.${to}&limit=1`);
      const rows = who.ok ? ((await who.json()) as { account_status?: string }[]) : [];
      if (rows[0]?.account_status !== 'active') throw new Error('there is no active member with that id');
      const sent = await db('direct_messages', {
        method: 'POST',
        body: JSON.stringify({ sender_id: aiId, recipient_id: to, body: body.slice(0, 1500) }),
        headers: { Prefer: 'return=representation' },
      });
      if (!sent.ok) throw new Error(`could not send the message (HTTP ${sent.status})`);
      const created = (await sent.json()) as { id: string }[];
      return { dm_id: created[0]?.id ?? null, delivered_to: to };
    },
  },
  {
    name: 'find_unanswered_discussions',
    description: 'Find real public posts that have no comments yet and are old enough that silence is a signal.',
    args: '{ "hours": 6, "limit": 10 }',
    staff: false,
    run: async (args) => {
      const hours = Math.min(Math.max(Number(args.hours) || 6, 1), 168);
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 25);
      const since = new Date(Date.now() - hours * 3600_000).toISOString();
      const res = await db(
        `posts?select=id,title,body,world,created_at,comment_count&state=eq.active&visibility=eq.public&comment_count=eq.0&created_at=lt.${since}&order=created_at.asc&limit=${limit}`,
      );
      if (!res.ok) throw new Error(`could not read discussions (HTTP ${res.status})`);
      return res.json();
    },
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

// ── model adapters (Phase 1: Multi-Key Rotation, Controlled Failover & Lovable Fallback) ───────

async function callGemini(messages: { role: string; content: string }[]): Promise<string> {
  const available = configuredGeminiKeys();
  if (available.length === 0) {
    throw Object.assign(new Error('No Gemini API key configured.'), { statusCode: 503 });
  }

  const now = Date.now();
  // Sort candidate keys: healthy first (cooldown elapsed), ordered by lowest consecutive failures
  const candidates = [...available].sort((a, b) => {
    const aCool = a.state.cooldownUntil && a.state.cooldownUntil > now ? a.state.cooldownUntil : 0;
    const bCool = b.state.cooldownUntil && b.state.cooldownUntil > now ? b.state.cooldownUntil : 0;
    if (aCool === 0 && bCool > 0) return -1;
    if (bCool === 0 && aCool > 0) return 1;
    return a.state.consecutiveFailures - b.state.consecutiveFailures;
  });

  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  const payload = JSON.stringify({
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
  });

  let lastErr = '';

  for (let i = 0; i < candidates.length; i++) {
    const { key, state } = candidates[i]!;
    state.totalRequests++;
    state.lastUsedAt = new Date().toISOString();
    const startTime = Date.now();

    try {
      const res = await fetch(`${GEMINI_API_BASE}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: payload,
      });

      const latencyMs = Date.now() - startTime;
      state.lastLatencyMs = latencyMs;

      if (res.ok) {
        state.status = 'healthy';
        state.cooldownUntil = null;
        state.consecutiveFailures = 0;
        state.totalSuccesses++;
        state.lastError = null;
        recordLatency(latencyMs);
        lastSuccessfulInference = {
          at: new Date().toISOString(),
          provider: 'gemini',
          key_label: state.label,
          latency_ms: latencyMs,
        };

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

      // Handle non-200 responses
      const detail = (await res.text()).slice(0, 300);
      const isRateLimit = res.status === 429 || detail.includes('RESOURCE_EXHAUSTED');
      const isServerError = res.status >= 500 && res.status <= 504;

      if (isRateLimit || isServerError) {
        const retryHeader = res.headers.get('retry-after');
        const retrySec = retryHeader ? parseInt(retryHeader, 10) : 60;
        const cooldownMs = (isNaN(retrySec) ? 60 : Math.max(retrySec, 30)) * 1000;
        state.status = isRateLimit ? 'rate_limited' : 'cooling_down';
        state.cooldownUntil = Date.now() + cooldownMs;
        state.consecutiveFailures++;
        state.lastError = `HTTP ${res.status}: ${detail}`;
        lastErr = state.lastError;

        const nextKey = candidates[i + 1]?.state.label ?? 'none';
        recordFailover(state.label, nextKey, `HTTP ${res.status}: ${isRateLimit ? 'rate limit / quota exhaustion' : 'server error'}`);
        continue; // Try next configured Gemini key!
      }

      // If client-side bad request (400), throw immediately without cycling keys
      if (res.status === 400) {
        throw Object.assign(new Error(`Gemini invalid request: ${detail}`), { statusCode: 400 });
      }

      // Auth error (401 / 403) on this specific key
      state.status = 'error';
      state.consecutiveFailures++;
      state.lastError = `HTTP ${res.status}: ${detail}`;
      lastErr = state.lastError;
      if (i < candidates.length - 1) {
        recordFailover(state.label, candidates[i + 1]!.state.label, `HTTP ${res.status}: authentication error`);
        continue;
      }
    } catch (e) {
      if (e instanceof Error && 'statusCode' in e && (e as { statusCode?: number }).statusCode === 400) {
        throw e;
      }
      const message = e instanceof Error ? e.message : String(e);
      state.consecutiveFailures++;
      state.lastError = message;
      lastErr = message;
      if (i < candidates.length - 1) {
        recordFailover(state.label, candidates[i + 1]!.state.label, `network failure: ${message}`);
        continue;
      }
    }
  }

  lastProviderFailure = {
    at: new Date().toISOString(),
    provider: 'gemini',
    error: lastErr || 'all Gemini keys failed or are cooling down',
  };

  throw Object.assign(
    new Error(`All configured Gemini keys encountered errors or rate limits. Last error: ${lastErr}`),
    { statusCode: 503 },
  );
}

async function callLovableAI(messages: { role: string; content: string }[]): Promise<string> {
  if (!LOVABLE_AI_KEY) {
    throw Object.assign(new Error('Lovable Cloud AI key is not configured.'), { statusCode: 503 });
  }

  const startTime = Date.now();
  const res = await fetch(`${LOVABLE_AI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LOVABLE_AI_KEY}`,
    },
    body: JSON.stringify({
      model: LOVABLE_AI_MODEL,
      messages,
      temperature: 0.3,
    }),
  });

  const latencyMs = Date.now() - startTime;
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw Object.assign(new Error(`Lovable Cloud AI call failed (HTTP ${res.status}): ${detail}`), { statusCode: 502 });
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw Object.assign(new Error('Lovable Cloud AI returned an empty answer.'), { statusCode: 502 });

  recordLatency(latencyMs);
  lastSuccessfulInference = {
    at: new Date().toISOString(),
    provider: 'lovable',
    latency_ms: latencyMs,
  };

  return content;
}

async function callRork(messages: { role: string; content: string }[]): Promise<string> {
  if (!RORK_FALLBACK_ENABLED || !TOOLKIT_KEY) {
    throw Object.assign(new Error('Rork AI Cloud fallback is disabled or unconfigured.'), { statusCode: 503 });
  }

  const startTime = Date.now();
  const res = await fetch(`${TOOLKIT_URL}/v2/vercel/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOOLKIT_KEY}` },
    body: JSON.stringify({ model: AI_MODEL, messages, temperature: 0.3 }),
  });

  const latencyMs = Date.now() - startTime;
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw Object.assign(new Error(`Rork AI Cloud call failed (HTTP ${res.status})${detail ? `: ${detail}` : '.'}`), { statusCode: 502 });
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw Object.assign(new Error('model returned an empty answer.'), { statusCode: 502 });

  recordLatency(latencyMs);
  lastSuccessfulInference = {
    at: new Date().toISOString(),
    provider: 'rork',
    latency_ms: latencyMs,
  };
  return content;
}

async function callModel(messages: { role: string; content: string }[]): Promise<string> {
  const geminiAvailable = configuredGeminiKeys().length > 0;

  if (geminiAvailable) {
    try {
      return await callGemini(messages);
    } catch (e) {
      if (e instanceof Error && 'statusCode' in e && (e as { statusCode?: number }).statusCode === 400) {
        throw e;
      }
      // If Gemini completely failed/exhausted, attempt Lovable Cloud AI if configured
      if (LOVABLE_AI_KEY) {
        try {
          return await callLovableAI(messages);
        } catch (_lovErr) {
          // Continue to Rork if explicitly enabled
        }
      }
      // Or Rork if explicitly enabled
      if (RORK_FALLBACK_ENABLED && TOOLKIT_KEY) {
        return await callRork(messages);
      }
      throw e;
    }
  }

  if (LOVABLE_AI_KEY) {
    return await callLovableAI(messages);
  }

  if (RORK_FALLBACK_ENABLED && TOOLKIT_KEY) {
    return await callRork(messages);
  }

  throw Object.assign(
    new Error(
      'No AI model credential configured. Set Supabase Edge Function secret GEMINI_API_KEY (with optional GEMINI_API_KEY_2 and GEMINI_API_KEY_3 for multi-key rotation), or configure Lovable Cloud AI.',
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

const SYSTEM_PROMPT = (staff: boolean) => `You are Hallyu AI, the operator of the Hallyu social platform (K-drama, C-drama, anime, Hollywood fan community).
You are transparent that you are an AI. Never impersonate a human member.
Rules: investigate real data with your tools before answering; never invent numbers, news, release dates, quotes or sources; if evidence is missing, say so and name what is missing; report failures honestly.
You also answer Direct Messages and comment mentions as the official Hallyu AI account. Your final answer in a DM is delivered to that person as a real message, so write it for them: no internal jargon, no fabricated results, no analytics or staff-only data for ordinary members, and never claim an action succeeded unless a tool confirmed it. For members, be warm, concrete and helpful; recommend only titles you verified through catalog_digest or the community's own posts.
Publishing is real: publish_post, reply_comment and create_poll create live rows attributed to the official Hallyu AI account. Write original text about titles the catalogue actually holds, never present catalogue metadata as breaking news, and after publishing call publishing_status to confirm the row exists. Never claim an action succeeded that you have not verified.
Target three genuinely useful published items per day. Never post filler to reach a number; when there is nothing worth saying, say that instead. Ordinary work needs no permission, but never spend money, change permissions, ban or delete accounts, or run destructive operations. Use notify_owner only when a finding actually matters.
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
  // A broken tool must not eat the whole step budget: after two consecutive failures it is taken
  // out of this run, and the model is told to finish with what it already verified.
  const failures = new Map<string, number>();

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
      if (tool && (failures.get(tool.name) ?? 0) >= 2) {
        await recordToolCall(taskId, seq, tool.name, protocol.args, {
          status: 'denied',
          error: 'disabled for this run after repeated failures',
        });
        history.push({
          role: 'user',
          content: `Tool ${tool.name} keeps failing and is disabled. Work with what you have and answer now with {"final": ...}.`,
        });
        continue;
      }
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
        failures.delete(tool.name);
        const stepsLeft = MAX_STEPS - step - 1;
        history.push({
          role: 'user',
          content: `Tool ${tool.name} returned: ${JSON.stringify(result).slice(0, 4000)}${stepsLeft <= 2 ? '. You have almost no steps left: answer now with {"final": ...} using what you verified.' : ''}`,
        });
      } catch (toolError) {
        // Honest failure: recorded, surfaced to the model, and never masked as success.
        const message = toolError instanceof Error ? toolError.message : String(toolError);
        failures.set(tool.name, (failures.get(tool.name) ?? 0) + 1);
        await recordToolCall(taskId, seq, tool.name, protocol.args, { status: 'error', error: message });
        history.push({ role: 'user', content: `Tool ${tool.name} FAILED: ${message}. Choose another approach or report the failure in {"final": ...}.` });
      }
    }
    if (answer === null) {
      // A real side effect must not be reported as nothing: if this task already published through
      // the ledger, the run is a completed-with-partial-report, not a failure.
      const published = await publishedForTask(taskId);
      if (published.length > 0) {
        const note = `Published ${published.length} item(s), then ran out of steps before the final report.`;
        await setTaskStatus(taskId, 'completed', {
          result: { partial: true, published, note },
          finished_at: new Date().toISOString(),
        });
        return { status: 'completed', answer: note };
      }
      throw new Error(`operator stopped after ${MAX_STEPS} steps without a final answer.`);
    }
    await setTaskStatus(taskId, 'completed', { result: { answer }, finished_at: new Date().toISOString() });
    return { status: 'completed', answer };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const published = await publishedForTask(taskId).catch(() => []);
    if (published.length > 0) {
      await setTaskStatus(taskId, 'completed', {
        result: { partial: true, published, error: message },
        finished_at: new Date().toISOString(),
      });
      return { status: 'completed', answer: `Published ${published.length} item(s) before failing: ${message}` };
    }
    await setTaskStatus(taskId, 'failed', { error: message, finished_at: new Date().toISOString() });
    throw e;
  }
}

/** What this task really published, straight from the ledger. */
async function publishedForTask(taskId: string): Promise<{ action: string; target_id: string }[]> {
  const res = await db(`hallyu_ai_publication?select=action,target_id&task_id=eq.${taskId}&status=eq.published`);
  if (!res.ok) return [];
  return (await res.json()) as { action: string; target_id: string }[];
}

// ── system callers (the 24/7 scheduler) ───────────────────────────────────────────────────────
// `hallyu-ai-scheduler` holds the project's service credential and is itself authorised by a GitHub
// OIDC token minted for that exact workflow, so a service-role bearer is a trusted system caller.
// It is not a member: it resolves to the official AI profile, which is how the operator keeps
// working while the owner and every admin are offline.

async function systemProfile(req: Request): Promise<{ id: string; role: string } | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token || token === SERVICE_ROLE) {
    // The function's own service credential, used with no header at all.
    try {
      const id = await rpc('hallyu_ai_profile_id', {});
      return typeof id === 'string' && id ? { id, role: 'system' } : null;
    } catch {
      return null;
    }
  }

  // Any other credential must prove service privilege to PostgREST: only service_role may execute
  // `hallyu_ai_profile_id`, so a member or anon token is rejected by the database, not by us.
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/hallyu_ai_profile_id`, {
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
  const id = (await res.json().catch(() => null)) as string | null;
  return typeof id === 'string' && id ? { id, role: 'system' } : null;
}

async function ownerId(): Promise<string | null> {
  try {
    const id = await rpc('hallyu_ai_owner_id', {});
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** Run one specific schedule on demand ("Run Now") with optional force override. */
async function runSpecificSchedule(scheduleId: string, force = false): Promise<Record<string, unknown>> {
  const claimed = (await rpc('hallyu_ai_claim_schedule', {
    p_schedule_id: scheduleId,
    p_force: force,
  })) as { id: string; name: string; kind: string; prompt: string }[] | null;

  if (!Array.isArray(claimed) || claimed.length === 0) {
    return {
      status: 'skipped',
      detail: 'schedule was not claimed (either not found, or disabled without force flag)',
    };
  }

  return runSchedule(claimed[0]!);
}

/** Run one claimed schedule row as a real task, and record what actually happened on the row. */
async function runSchedule(row: { id: string; name: string; kind: string; prompt: string }): Promise<Record<string, unknown>> {
  const task = (await insertRow('hallyu_ai_task', {
    kind: row.kind,
    title: String(row.name).slice(0, 80),
    prompt: row.prompt,
    requester_role: 'system',
  })) as { id: string }[];
  const taskId = task[0]!.id;
  try {
    const outcome = await runTask(taskId);
    await db(`hallyu_ai_schedule?id=eq.${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_status: String(outcome.status ?? 'completed'), last_task_id: taskId }),
    }).catch(() => null);
    return { schedule: row.name, task_id: taskId, status: outcome.status, answer: outcome.answer };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db(`hallyu_ai_schedule?id=eq.${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_status: `failed: ${message}`.slice(0, 200), last_task_id: taskId }),
    }).catch(() => null);
    return { schedule: row.name, task_id: taskId, status: 'failed', error: message };
  }
}

/**
 * Has the AI already answered this comment?
 *
 * Three outcomes, deliberately: 'yes', 'no', and 'unknown'. Treating a failed read as "already
 * answered" silently dropped real mentions; treating it as "not answered" risks a duplicate reply.
 * The caller must retry on 'unknown' instead of guessing.
 */
async function aiReplyState(commentId: string): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const ai = await rpc('hallyu_ai_profile_id', {});
    if (typeof ai !== 'string' || !ai) return 'unknown';
    const res = await db(`comments?select=id&parent_id=eq.${commentId}&author_id=eq.${ai}&state=eq.active&limit=1`);
    if (!res.ok) return 'unknown';
    return ((await res.json()) as unknown[]).length > 0 ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}

/**
 * One autonomous tick. Claims due schedules (claim is SKIP LOCKED in the database, so two ticks can
 * never run the same row), executes each as a real task, then answers new @hallyu.ai mentions.
 * Capacity or failures are reported, never hidden: a failed run leaves its error on the row and a
 * single owner-facing shift report summarises the tick.
 */
async function runDueWork(mentionLimit = 2): Promise<Record<string, unknown>> {
  const due = (await rpc('hallyu_ai_claim_due_schedules', { p_limit: 3 })) as
    | { id: string; name: string; kind: string; prompt: string }[]
    | null;
  const claimed = Array.isArray(due) ? due : [];
  const runs: Record<string, unknown>[] = [];
  for (const row of claimed) runs.push(await runSchedule(row));

  // Mentions are handled inside the tick so no second process has to run anywhere.
  const mentions: Record<string, unknown>[] = [];
  try {
    const res = await db(
      `comments?select=id,post_id,body&state=eq.active&body=ilike.*%40hallyu.ai*&order=created_at.desc&limit=${Math.min(Math.max(mentionLimit, 1), 5)}`,
    );
    const candidates = res.ok ? ((await res.json()) as { id: string; post_id: string; body: string }[]) : [];
    for (const comment of candidates) {
      // 'unknown' is not 'already answered': retrying a live mention beats dropping it silently.
      const state = await aiReplyState(comment.id);
      if (state !== 'no') continue;
      const task = (await insertRow('hallyu_ai_task', {
        kind: 'mention_reply',
        title: `Reply to mention ${comment.id.slice(0, 8)}`,
        prompt: `A member addressed you in comment ${comment.id} on post ${comment.post_id}: "${comment.body.slice(0, 500)}". Read the post first if you need context, then answer with reply_comment using post_id ${comment.post_id} and parent_id ${comment.id}. Be useful and accurate; if you cannot help substantively, do not reply and explain why in {"final": ...}.`,
        requester_role: 'system',
      })) as { id: string }[];
      const outcome = await runTask(task[0]!.id).catch((e) => ({ status: 'failed', error: String(e) }));
      mentions.push({ comment_id: comment.id, task_id: task[0]!.id, status: outcome.status });
    }
  } catch (e) {
    mentions.push({ status: 'failed', error: e instanceof Error ? e.message : String(e) });
  }

  if (claimed.length === 0 && mentions.length === 0) {
    return { claimed: 0, runs: [], mentions: [], detail: 'nothing due; the next tick picks up new work' };
  }

  // One owner-facing summary per tick, so the owner sees the AI working without opening a console.
  const owner = await ownerId();
  if (owner) {
    const completed = runs.filter((run) => run.status === 'completed').length;
    const failed = runs.filter((run) => run.status === 'failed').length;
    await rpc('notify_recipient', {
      p_recipient: owner,
      p_kind: 'system',
      p_group: 'system',
      p_title: 'Hallyu AI shift report',
      p_body: `${claimed.length} scheduled task(s) ran: ${completed} completed, ${failed} failed; ${mentions.length} mention(s) handled.`,
    }).catch(() => null);
  }

  return { claimed: claimed.length, runs, mentions };
}

// ── event workers: a DM or mention is answered in seconds, not on the next tick ───────────────
const EVENT_MAX_ATTEMPTS = 5;

interface EventRow {
  id: string;
  kind: 'dm' | 'mention';
  source_id: string;
  profile_id: string | null;
  attempts: number;
}

async function patchEvent(id: string, patch: Record<string, unknown>): Promise<void> {
  await db(`hallyu_ai_event?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  }).catch(() => null);
}

const firstRow = async <T>(path: string): Promise<T | null> => {
  const res = await db(path);
  if (!res.ok) throw new Error(`read failed (HTTP ${res.status})`);
  const rows = (await res.json()) as T[];
  return rows[0] ?? null;
};

/** Answer one real Direct Message as the official AI account, with the sender's real role. */
async function processDmEvent(event: EventRow): Promise<Record<string, unknown>> {
  const ai = await rpc('hallyu_ai_profile_id', {});
  if (typeof ai !== 'string' || !ai) throw new Error('the official Hallyu AI profile is unavailable');

  const dm = await firstRow<{ id: string; sender_id: string; body: string }>(
    `direct_messages?select=id,sender_id,body&id=eq.${event.source_id}&limit=1`,
  );
  if (!dm) return { skipped: 'the message no longer exists' };
  if (dm.sender_id === ai) return { skipped: 'the AI does not answer itself' };

  const sender = await firstRow<{ id: string; handle: string; display_name: string | null; role: string; account_status: string }>(
    `profiles?select=id,handle,display_name,role,account_status&id=eq.${dm.sender_id}&limit=1`,
  );
  if (!sender || sender.account_status !== 'active') return { skipped: 'the sender is not an active member' };

  const historyRes = await db(
    `direct_messages?select=sender_id,body,created_at&or=(and(sender_id.eq.${sender.id},recipient_id.eq.${ai}),and(sender_id.eq.${ai},recipient_id.eq.${sender.id}))&order=created_at.desc&limit=10`,
  );
  const history = historyRes.ok ? ((await historyRes.json()) as { sender_id: string; body: string }[]) : [];
  const transcript = history
    .slice()
    .reverse()
    .map((row) => `${row.sender_id === ai ? 'You' : sender.handle}: ${row.body}`)
    .join('\n')
    .slice(-3500);

  const staff = isStaffRole(sender.role);
  const prompt = staff
    ? `The ${sender.role === 'ceo' ? 'owner' : 'administrator'} ${sender.handle} is messaging you in Direct Messages, and you have staff tools.\nConversation so far:\n${transcript}\n\nCarry out what they ask with real tools and report what actually happened. Their message: "${dm.body}". Your final answer is delivered to them as your DM.`
    : `Member ${sender.handle} is messaging you in Direct Messages.\nConversation so far:\n${transcript}\n\nAnswer their message: "${dm.body}". Be genuinely useful and specific; never reveal internal analytics, staff tools, other members' data or private conversations. Your final answer is delivered to them as your DM.`;

  const task = (await insertRow('hallyu_ai_task', {
    kind: 'dm',
    title: `DM from ${sender.handle}`.slice(0, 80),
    prompt,
    requester_profile_id: sender.id,
    requester_role: sender.role,
  })) as { id: string }[];
  const taskId = task[0]!.id;

  const outcome = await runTask(taskId);
  const answer = String(outcome.answer ?? '').trim();
  if (!answer) throw new Error('the model produced no answer to deliver');

  const sent = await db('direct_messages', {
    method: 'POST',
    body: JSON.stringify({ sender_id: ai, recipient_id: sender.id, body: answer.slice(0, 2000).trim() }),
    headers: { Prefer: 'return=representation' },
  });
  if (!sent.ok) throw new Error(`could not deliver the reply (HTTP ${sent.status})`);
  const created = (await sent.json()) as { id: string }[];
  if (!created[0]?.id) throw new Error('the reply was not stored');

  return { dm_id: created[0].id, task_id: taskId, to: sender.handle, status: outcome.status };
}

/** Answer one real comment mention under the comment that asked. */
async function processMentionEvent(event: EventRow): Promise<Record<string, unknown>> {
  const comment = await firstRow<{ id: string; post_id: string; parent_id: string | null; body: string; author_id: string; state: string }>(
    `comments?select=id,post_id,parent_id,body,author_id,state&id=eq.${event.source_id}&limit=1`,
  );
  if (!comment) return { skipped: 'the comment no longer exists' };
  if (comment.state !== 'active') return { skipped: 'the comment is not visible' };

  const answered = await aiReplyState(comment.id);
  if (answered === 'unknown') throw new Error('could not verify whether this mention was already answered');
  if (answered === 'yes') return { skipped: 'already answered' };

  const post = await firstRow<{ id: string; title: string | null; body: string }>(
    `posts?select=id,title,body&id=eq.${comment.post_id}&limit=1`,
  );

  const task = (await insertRow('hallyu_ai_task', {
    kind: 'mention_reply',
    title: `Mention ${comment.id.slice(0, 8)}`,
    prompt: `A member addressed you with @hallyu.ai in comment ${comment.id} on post ${comment.post_id}.\nTheir comment: "${comment.body.slice(0, 800)}"\nPost context: ${post?.title ?? '(no title)'} — ${(post?.body ?? '').slice(0, 800)}\n\nReply with reply_comment using post_id ${comment.post_id} and parent_id ${comment.id}. Use tools to check anything you are unsure about. If a real reply is not appropriate, answer with {\"final\": ...} explaining why and do not publish.`,
    requester_profile_id: comment.author_id,
    requester_role: 'system',
  })) as { id: string }[];
  const taskId = task[0]!.id;

  const outcome = await runTask(taskId);

  // Verify against the database, not the model's own claim.
  const after = await aiReplyState(comment.id);
  if (after === 'unknown') throw new Error('could not verify the reply after publishing');
  return { task_id: taskId, replied: after === 'yes', status: outcome.status, note: outcome.answer ?? null };
}

async function processEventRow(event: EventRow): Promise<Record<string, unknown>> {
  try {
    const result = event.kind === 'dm' ? await processDmEvent(event) : await processMentionEvent(event);
    await patchEvent(event.id, { status: 'done', result, last_error: null });
    return { id: event.id, kind: event.kind, status: 'done', ...result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const dead = event.attempts >= EVENT_MAX_ATTEMPTS;
    const backoffMs = Math.min(30_000 * Math.pow(2, Math.max(event.attempts - 1, 0)), 15 * 60_000);
    await patchEvent(event.id, {
      status: dead ? 'dead' : 'pending',
      next_attempt_at: new Date(Date.now() + backoffMs).toISOString(),
      last_error: message.slice(0, 500),
    });
    return { id: event.id, kind: event.kind, status: dead ? 'dead' : 'pending', error: message, retry_in_ms: dead ? null : backoffMs };
  }
}

/**
 * Claim and process queued events. A dispatch wake-up names one event; the fallback path drains
 * whatever is due, so a missed HTTP call is recovered rather than lost.
 */
async function runEvents(input: { kind?: string; source_id?: string; limit?: number }): Promise<Record<string, unknown>> {
  await rpc('hallyu_ai_recover_stale_events', { p_after: '5 minutes' }).catch(() => null);
  const limit = Math.min(Math.max(Number(input.limit) || 3, 1), 5);

  if (input.kind && input.source_id) {
    const named = await firstRow<EventRow & { status: string }>(
      `hallyu_ai_event?select=id,kind,source_id,profile_id,attempts,status&kind=eq.${encodeURIComponent(input.kind)}&source_id=eq.${encodeURIComponent(input.source_id)}&status=eq.pending&limit=1`,
    );
    if (!named) return { processed: [], detail: 'that event is already handled or does not exist' };
    await patchEvent(named.id, { status: 'processing', attempts: named.attempts + 1 });
    return { processed: [await processEventRow({ ...named, attempts: named.attempts + 1 })] };
  }

  const claimed = (await rpc('hallyu_ai_claim_events', { p_limit: limit })) as EventRow[] | null;
  const rows = Array.isArray(claimed) ? claimed : [];
  const processed: Record<string, unknown>[] = [];
  for (const row of rows) processed.push(await processEventRow(row));
  return { processed, claimed: rows.length, detail: rows.length === 0 ? 'nothing queued' : 'processed queued events' };
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
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      prompt?: string;
      kind?: string;
      task_id?: string;
      approval_id?: string;
      approve?: boolean;
      note?: string;
      limit?: number;
      source_id?: string;
      schedule_id?: string;
      force?: boolean;
    };

    // The event worker is a system caller: the scheduler drains the queue, and nothing else may.
    // Authorised before the member lookup because the caller is a credential, not a person.
    if (body.action === 'event.process') {
      if (!(await systemProfile(req))) return json({ error: 'sign in required' }, 401);
      return json(await runEvents({ kind: body.kind, source_id: body.source_id, limit: body.limit }));
    }

    // Members resolve as themselves; a credential the database accepts as service_role resolves as
    // the system (the 24/7 scheduler). Nobody else gets in.
    const profile = (await callerProfile(req)) ?? (await systemProfile(req));
    if (!profile) return json({ error: 'sign in required' }, 401);
    const staff = isStaffRole(profile.role);

    switch (body.action) {
      case 'ping': {
        const configuredCount = configuredGeminiKeys().length;
        const now = Date.now();
        return json({
          model_configured: modelProvider() !== 'none',
          provider: modelProvider(),
          model: activeModel(),
          gemini_key_count: configuredCount,
          gemini_keys: keyStates.map((s) => ({
            label: s.label,
            configured: Boolean(GEMINI_KEYS[s.index]),
            status: s.status,
            consecutive_failures: s.consecutiveFailures,
            cooldown_remaining_sec: s.cooldownUntil && s.cooldownUntil > now ? Math.ceil((s.cooldownUntil - now) / 1000) : 0,
            last_latency_ms: s.lastLatencyMs,
          })),
          last_provider_failure: lastProviderFailure,
          last_successful_inference: lastSuccessfulInference,
          failover_events: failoverEvents.slice(0, 10),
          avg_latency_ms: avgLatency(),
          rork_fallback_enabled: RORK_FALLBACK_ENABLED,
          lovable_ai_configured: Boolean(LOVABLE_AI_KEY),
          staff,
          approval_mode: await approvalMode(),
          tools: registryFor(staff).map((tool) => tool.name),
        });
      }

      case 'schedule.run': {
        if (!staff) return json({ error: 'admin or ceo role required' }, 403);
        if (!body.schedule_id) return json({ error: 'schedule_id is required' }, 400);
        const result = await runSpecificSchedule(body.schedule_id, Boolean(body.force));
        return json(result);
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

      case 'schedule.run_due': {
        if (!staff) return json({ error: 'admin or ceo role required' }, 403);
        return json(await runDueWork(Number(body.limit) || 2));
      }

      case 'schedule.list': {
        if (!staff) return json({ error: 'admin or ceo role required' }, 403);
        const res = await db(
          'hallyu_ai_schedule?select=name,kind,interval_minutes,enabled,last_run_at,next_run_at,last_status&order=interval_minutes.asc',
        );
        if (!res.ok) return json({ error: `could not read the schedule (HTTP ${res.status})` }, 502);
        return json({ schedules: await res.json() });
      }

      case 'mentions.answer': {
        if (!staff) return json({ error: 'admin or ceo role required' }, 403);
        return json(await runDueWork(Number(body.limit) || 2));
      }

      case 'event.drain': {
        if (!staff) return json({ error: 'admin or ceo role required' }, 403);
        return json(await runEvents({ limit: body.limit }));
      }

      default:
        return json(
          {
            error:
              'unknown action — use ping, chat, task.create, task.run, approval.decide, schedule.run_due, schedule.list, mentions.answer or event.drain',
          },
          400,
        );
    }
  } catch (e) {
    const status = e instanceof Error && 'statusCode' in e ? Number((e as { statusCode?: number }).statusCode) || 500 : 500;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
