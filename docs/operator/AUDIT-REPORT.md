# Hallyu AI Operator — Phase 0 Audit Report

> **Status:** Phase 0 (audit-only) complete. No working systems were replaced during this audit.
> **Author:** SuperNinja (autonomous engineering agent)
> **Evidence rule:** every claim below carries one of the six required labels. Static source
> verifiers are treated as *supplementary only*; runtime and database evidence is used wherever
> access was available.

---

## 1. Current commit and branch audited

| Item | Value |
| --- | --- |
| Branch | `arena/c5e9499c-grok-hallyu` |
| Commit | `8fc1093` — *feat(operator): Hallyu AI Operator — isolated providers, central engine, secure tools, 24/7 ops, Control Centre* |
| Working tree | clean |
| Supabase project | `ltyymanoidagwsapgiql` (Postgres 17.11) |
| Live Edge Functions | `operator-admin` → **HTTP 404**, `operator-worker` → **HTTP 404** (`BLOCKED BY ACCESS` — not deployed on this branch) |

The operator backend exists in source and in the database, but **is not deployed as Edge
Functions on this branch**. Edge Functions deploy only when the branch merges to `main` (Rork
deploy pipeline). This single fact explains most of the "red errors" in the Admin Console and the
fact that no task has ever executed.

---

## 2. Architecture / component map

```
                 ┌──────────────────────────────────────────────────────────┐
                 │                     Hallyu app (Expo)                      │
                 │                                                            │
  Member  ──────▶│  app/messages/index.tsx   app/messages/[handle].tsx         │
                 │      (member↔member DM only — NO AI thread)                │
                 │                                                            │
  Executive ────▶│  components/admin/AdminDashboard.tsx                       │
                 │      └─ OperatorControlCentre.tsx  (10 tabs)               │
                 │           └─ "Control" tab = admin chat  ◀── DIVERGENCE    │
                 └───────────────┬────────────────────────────────────────────┘
                                 │ supabase-js (user JWT)
                                 ▼
                 ┌──────────────────────────────────────────┐
                 │  Edge Function: operator-admin (404 live) │
                 │   verifies JWT → profile → role∈{admin,ceo}│
                 └───────────────┬──────────────────────────┘
                                 │ service_role
                                 ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │  Postgres (source of truth)                                           │
   │   19 operator_* tables, RLS on all (21 policies)                      │
   │   triggers: direct_messages→operator_capture_member_dm                │
   │             comments→operator_capture_mention                         │
   │             operator_task→operator_dispatch_task (pg_net, non-block)  │
   │   pg_cron: hallyu-operator-tick (* * * * *) → operator_scheduler_tick │
   └───────────────┬───────────────────────────────────────────────────────┘
                   │ pg_net http_post (fire-and-forget)
                   ▼
   ┌──────────────────────────────────────────┐
   │  Edge Function: operator-worker (404 live) │
   │   claim task → provider call → tools → done│
   │   APINEX  (free/gpt-6-luna)  ── isolated ──┐│
   │   Coarena (claude-fable-5-2) ── isolated ──┘│
   └──────────────────────────────────────────┘
```

Component map (current filenames):

- **DMs:** `app/messages/index.tsx`, `app/messages/[handle].tsx`; API in `lib/api/features.ts`
  (`list_conversations`, `list_direct_messages`, `send_direct_message`, `mark_conversation_read`).
- **Admin Console:** `components/admin/AdminDashboard.tsx` → `OperatorControlCentre.tsx`;
  API client `lib/api/operator.ts` → `operator-admin` Edge Function.
- **Provider adapters:** `supabase/functions/_shared/operator/providers.ts`.
- **Prompt:** `supabase/functions/_shared/operator/prompt.ts`.
- **Tool gateway:** `supabase/functions/_shared/operator/tools.ts` (23 tools).
- **Worker:** `supabase/functions/operator-worker/index.ts`.
- **Admin API:** `supabase/functions/operator-admin/index.ts`.
- **DB:** migrations `20261115000000_79` … `20261115000005_84`.
- **Scheduler:** `20261115000004_83_operator_scheduler.sql` (`pg_cron`).
- **Verifiers:** `scripts/verify-operator.mjs`, `scripts/verify-backend-surface.mjs`.

---

## 3. Executive DM flow

**Evidence: `BROKEN` (product divergence) + `MISSING` (no DM surface).**

- The executive's conversation with the Operator does **not** exist in Direct Messages.
  `grep` for `operator`, `admin_control`, `staff`, or `AI` across `app/messages/*` returns
  **zero** matches. The DMs screens are pure member↔member.
- The executive chat lives only in the Admin Console, in `OperatorControlCentre` → **"Control"
  tab**, which calls `operatorApi.sendAdminMessage()` → `operator-admin` action `admin_message`
  → RPC `operator_ensure_conversation('admin_control', …)`.
- The `admin_control` channel has **0 conversations** in the database (only `member_ai`=1,
  `public_thread`=2 exist). The executive has never opened a working thread.
- This directly violates the master spec's non-negotiable product decision: *"The executive's
  primary conversation with Hallyu AI lives in the existing Direct Messages experience. The Admin
  Console manages the AI; it is not the executive chat interface."*
- Even if the executive DM'd the staff profile directly, `operator_capture_member_dm` would
  classify it as **`member_ai`**, not `admin_control` — the trigger does not branch on the
  sender's role. So there is no path today for an executive DM to become an admin-control thread.

---

## 4. Member DM flow

**Evidence: `WORKING WITH LIMITATIONS`.**

- Members DM the staff profile (`operator_staff.profile_id = a1111111-…`, display name
  "Hallyu AI"). The trigger `operator_capture_member_dm` on `direct_messages` fires when
  `recipient_id = staff`, creates/gets a `member_ai` conversation, records an inbound
  `operator_message`, enqueues an event and a `reply_member_dm` task.
- **Verified data:** 4 DMs to the staff profile exist; `operator_message` shows **6 inbound
  member messages, 0 outbound**. So capture works, but **the AI has never replied** — because
  `operator-worker` is 404 and 4 `reply_member_dm` tasks sit in `queued`.
- Limitation: the reply path (`operator_send_staff_message` → insert into `direct_messages`) is
  `CODE PRESENT, NOT VERIFIED` at runtime.

---

## 5. Public comment / mention flow

**Evidence: `WORKING WITH LIMITATIONS` (capture) / `CODE PRESENT, NOT VERIFIED` (reply).**

- Trigger `operator_capture_mention` on `comments` fires only when the comment body contains
  `@<staff_handle>`. It creates a `public_thread` conversation keyed on the comment id, records
  the inbound message, enqueues `public_mention`, and creates a `reply_public_mention` task.
- **Verified data:** 2 mention comments exist → 2 `public_thread` conversations → 2
  `reply_public_mention` tasks (queued, never executed).
- **Limitation:** only *mentions* are captured. Ordinary public comments that do not mention the
  AI are **not** observed. If the spec's type D ("public comments and mentions") is meant to
  include general comment moderation, that path is `MISSING`.
- Reply delivery (`operator_send_staff_message` → insert into `comments` as a threaded reply) is
  `CODE PRESENT, NOT VERIFIED`.

---

## 6. Admin Console flow

**Evidence: `BROKEN` (live) / `CODE PRESENT, NOT VERIFIED` (source).**

- `OperatorControlCentre` has 10 tabs: Overview, **Control**, Queue, Approvals, Providers, Tools,
  Moderation, Research, Campaigns, Health. It is embedded in `AdminDashboard` under the
  "AI OPERATOR" nav group.
- **Root cause of every red error:** all tabs call `operator-admin`, which returns **HTTP 404**
  on this branch. Every request fails at the network layer, not in application logic.
- **Specific missing-function investigation (required by §4.3):**
  1. Frontend caller: `lib/api/operator.ts` → `callOperatorAdmin('admin_message', { body,
     conversation_id })`.
  2. RPC name: `operator_ensure_conversation`, `operator_create_task`, `operator_send_staff_message`.
  3. Argument names/types: `p_channel text`, `p_member uuid`, `p_thread uuid`, `p_subject text`;
     `p_task_type text`, `p_input jsonb`, … (all present in migration 80).
  4. Migration: `20261115000001_80_operator_functions.sql` — exists locally **and** is recorded
     in `supabase_migrations.schema_migrations`.
  5. Remote signature: verified present via `pg_proc` (all 32 `operator_*` functions exist).
  6. Project: app points at `ltyymanoidagwsapgiql` — correct.
  7. Schema cache / deployment: the **Edge Function itself is not deployed** (404). This is the
     real mismatch — not an RPC signature problem. The RPCs are correct; the *transport* is absent.
  8. Correct fix: deploy `operator-admin` and `operator-worker` (happens on merge to `main`), then
     re-test the exact request. Do **not** add a duplicate RPC.
- The "Control" tab being the executive chat is itself the product divergence described in §3.

---

## 7. Provider integration findings

**Evidence: `CODE PRESENT, NOT VERIFIED` (runtime) / `VERIFIED WORKING` (config).**

| Check | Finding |
| --- | --- |
| Two isolated providers | ✅ `apinex` → `https://api.apinex.bond/v1`, `coarena` → `https://coarena.ai/api/v1`; exactly two base URLs |
| One model per task, no fallback | ✅ `callProvider` resolves the requested provider only; no cross-provider loop |
| Server-side credentials | ✅ env `APINEX_API_KEY` / `COARENA_API_KEY`, with Vault fallback via `operator_provider_secret` (service_role only). Keys stored in Vault (lengths 53 / 36), never in client |
| `Authorization` header | ✅ `await providerCredential(provider)` (the old un-awaited lookup was already fixed) |
| Model IDs | `free/gpt-6-luna` / `claude-fable-5-2` (seeded in `operator_provider`) |
| Streaming | ❌ `stream: false` — no true streaming (spec §9 requires it) |
| Budget enforcement | ❌ **none** — no budget columns on `operator_provider`, no check in worker; `operator_policy.providers` has `daily_request_budget_apinex: 500` / `coarena: 200` but nothing reads them |
| Health probe | ⚠️ `probeProvider` is labelled "non-billable" but sends a real `chat/completions` ("Reply with PONG") → **it is billable** |
| Runtime test | `BLOCKED BY ACCESS` — worker 404; could not exercise a live completion |

---

## 8. Database and migration findings

**Evidence: mixed.**

- **Tables:** 19 `operator_*` tables exist; RLS enabled on all 19; 21 policies.
- **Functions:** 32 `operator_*` functions exist in `pg_proc` — signatures match migrations.
- **Migration drift:** `BLOCKED BY ACCESS`/`BROKEN` — remote `schema_migrations` has **89** rows,
  local files number **77**. Twelve remote-only migrations (`20261110163329` … `2026111016xxxx`)
  exist in the deployed history with no corresponding local file. History does **not** match the
  repository.
- **`operator_task.status` constraint:** allows `queued, running, awaiting_approval, completed,
  failed, cancelled, retrying`. **Missing** 8 of the spec's lifecycle states: `received`,
  `understanding`, `investigating`, `planning`, `executing`, `verifying`, `partially_completed`,
  `blocked`.
- **`operator_tool_call`:** column is `tool` (not `tool_name`); `outcome` CHECK allows
  `succeeded, partially_succeeded, rejected, failed, pending, not_verified`.
- **`operator_provider`:** no budget columns at all.
- **`profiles`:** has `account_status` (enum) and `is_ai`, but **no `suspended_until` / ban
  columns** — suspension expiry and permanent-ban distinction are structurally impossible today.
- **`operator_audit`:** RLS on, but **no immutability trigger** — service role can silently
  UPDATE/DELETE audit rows.
- **`operator_policy`:** one row containing `autonomy`, `moderation` (thresholds
  `contain_below_confidence 0.55`, `other_violation_confidence 0.70`,
  `explicit_removal_confidence 0.85`, `ban_after_offences 3`, …), `notifications`
  (`max_per_day 12`, `max_per_hour 4`, `quiet_hours 00:00–07:00`, `dedupe_window_hours 72`),
  `providers` (budgets, `no_cross_provider_fallback: true`), `approval_required` list.

---

## 9. Queue / worker / scheduler findings

**Evidence: `BROKEN` (drain) / `VERIFIED WORKING` (scheduler).**

- **Scheduler `VERIFIED WORKING`:** `cron.job` shows `hallyu-operator-tick | * * * * * | active`;
  `cron.job_run_details` shows **333 succeeded** runs. `operator_scheduler_tick()` enqueues due
  schedules and recovers stale tasks.
- **Queue `BROKEN`:** **237 tasks, all `queued`, zero processed.** Breakdown: `queue_sweep` 207,
  `moderation_sweep` 22, `reply_member_dm` 4, `reply_public_mention` 2, `analytics_report` 1,
  `research_digest` 1. Nothing drains because `operator-worker` is 404.
- **Wasted model credits `BROKEN`:** `queue_sweep` fires every 60s and creates a **model task**
  each time (207 so far). A maintenance sweep should not be a billable model task. This is the
  exact "frequent queue-sweep job creating unnecessary model tasks" audit lead, confirmed.
- **Schedule/handler name match:** `analytics_report`, `research_digest`, `moderation_sweep`,
  `queue_sweep` are seeded; the worker must have matching handlers — `CODE PRESENT, NOT VERIFIED`
  (worker never ran). Needs runtime confirmation.
- **Claim/lease:** `operator_claim_task` uses `FOR UPDATE SKIP LOCKED` + 90s lease
  (`CODE PRESENT, NOT VERIFIED` at runtime).
- **Stale recovery:** `operator_recover_stale_tasks` exists and is called by the tick.

---

## 10. Security and permission findings

**Evidence: mixed.**

| Item | Finding |
| --- | --- |
| Admin API auth | ✅ `operator-admin` verifies JWT → profile → `role ∈ {admin, ceo}` |
| Model switching | ✅ `operator_set_active_model` requires `is_admin()` (DB-gated). Admin action path `CODE PRESENT, NOT VERIFIED` (404) |
| Service-role-only RPCs | ✅ `operator_require_service()` + `revoke … from anon, authenticated` on sensitive funcs |
| Provider secrets | ✅ Vault only; `operator_provider_secret` granted to `service_role` only |
| Conversation binding | ❌ tools read `conversation_id` from **model input** (`str(input,'conversation_id')`) with fallback to ctx — a model could target another conversation id. Must bind to authenticated task context |
| Rate limiting | ❌ `rateLimitExceeded` queries `tool_name` (column is `tool`) → PostgREST 400 → `!result.ok` → **fails open**; rate limit never enforced |
| Tool-call audit | ❌ `recordToolCall` writes `outcome: 'ok'|'error'`, violating the CHECK constraint → insert fails; tool audit is lost |
| Moderation thresholds | ❌ `operator_moderate_content` takes no confidence param; configured thresholds never enforced |
| Suspension expiry | ❌ no expiry column; `p_days` only recorded in audit detail |
| Ban vs suspension | ❌ `operator_ban_member` sets `account_status='suspended'` — indistinguishable from a suspension |
| Notification caps/quiet-hours/dedup | ❌ not enforced in the notify tool; dedupe prefix uses `taskId`/`Date.now()` so it never dedupes across runs |
| Audit immutability | ❌ no trigger prevents UPDATE/DELETE of `operator_audit` |
| Staff/admin protection | ✅ suspend/ban refuse `role<>'member'` and `is_ai` targets |

---

## 11. UI/UX findings

**Evidence: `BROKEN` (live) / `WORKING WITH LIMITATIONS` (source).**

- Executive chat is in the Admin Console, not DMs (product divergence — §3).
- No Markdown rendering in the operator chat; no true streaming; no task-lifecycle indicators
  (understanding → investigating → planning → executing → verifying) in the UI.
- No distinction between a normal reply and a long-running assignment.
- No "Operator can continue after the screen closes" affordance, because the worker never runs.
- Admin Console tabs have loading/empty states in source but all requests 404 live.
- No fake/hardcoded metrics observed in `OperatorControlCentre` — values come from the API
  (`CODE PRESENT, NOT VERIFIED`).

---

## 12. Reproducible errors

1. **Every Admin Console Operator tab** → network 404 from `operator-admin`. Repro:
   `curl -X POST .../functions/v1/operator-admin -d '{}'` → `404`.
2. **Executive "send message"** → 404 (same function), surfaced as a red error in the Control tab.
3. **No AI reply to member DMs** → 6 inbound, 0 outbound; 4 `reply_member_dm` tasks stuck
   `queued` because `operator-worker` is 404.
4. **Tool-call audit silently lost** → `outcome:'ok'` violates CHECK; insert rejected.
5. **Rate limit never trips** → `tool_name` column error → fail-open.
6. **Queue grows unbounded** → 237 queued tasks, `queue_sweep` adds one every minute.

---

## 13. Working capabilities worth preserving

- Two strictly isolated providers with fixed base URLs and no cross-provider fallback
  (`VERIFIED WORKING` config).
- Server-side credential resolution with Vault fallback (`VERIFIED WORKING`).
- `pg_cron` scheduler ticking every minute, 333 successful runs (`VERIFIED WORKING`).
- Member-DM and mention capture triggers (`VERIFIED WORKING` data).
- RLS on all 19 operator tables, 21 policies (`VERIFIED WORKING`).
- Admin API role gate (`admin`/`ceo`) and DB-gated model switching (`VERIFIED WORKING`).
- Staff/admin protection in suspend/ban (`VERIFIED WORKING`).
- 23-tool registry with schema validation, permission classes, timeouts (`CODE PRESENT, NOT
  VERIFIED` at runtime).

---

## 14. Incomplete capabilities

- Worker drain / task execution (`BROKEN` — 404).
- Tool-call audit persistence (`BROKEN` — constraint mismatch).
- Rate limiting (`BROKEN` — fail-open + wrong column).
- Notification caps / quiet hours / dedup (`MISSING` enforcement).
- Provider budget enforcement (`MISSING`).
- Moderation confidence thresholds (`MISSING` enforcement).
- Suspension expiry & ban distinction (`MISSING` schema + logic).
- Conversation-ID binding to authenticated context (`BROKEN`).
- Migration history parity (`BROKEN` — 12 remote-only).
- Audit immutability (`MISSING`).

---

## 15. Missing capabilities

- Executive conversation inside the Direct Messages experience (`MISSING` — the core product
  decision).
- Instruction classification (`conversation/question/instruction/assignment/investigation/
  decision_request/follow_up/status_request`) — `MISSING`; worker maps `task_type` directly.
- Full task lifecycle states (`received … verifying … partially_completed/blocked`) — `MISSING`
  from both schema and engine.
- True streaming and Markdown rendering — `MISSING`.
- Versioned organisational constitution + knowledge retrieval — `MISSING`; `prompt.ts` is one
  hardcoded identity block.
- External research (web) — `MISSING`; `research.search` queries only the local `titles` table.
- Planning/decomposition and multi-step resumable work — `MISSING`.
- Non-billable health probe — `BROKEN` (probe is billable).

---

## 16. Prioritised repair plan (file-by-file)

### P0 — Unblock the engine (Phase 1 stabilisation)
1. **Deploy `operator-admin` + `operator-worker`** (merge to `main` / Rork). Verify 200 + a real
   round-trip. *This alone turns most red errors green.*
2. `supabase/functions/_shared/operator/tools.ts`
   - `rateLimitExceeded`: `tool_name` → `tool`; on query failure **fail closed** (or count
     defensively), never fail-open.
   - `recordToolCall`: `outcome: execution.ok ? 'succeeded' : 'failed'` to satisfy the CHECK.
   - Bind `conversation_id` to `ctx.conversationId` only; reject model-supplied ids that differ.
3. `supabase/functions/_shared/operator/providers.ts`
   - Make `probeProvider` genuinely non-billable (e.g. `GET /models` or a 1-token ping) or
     document it as billable and gate it.
4. `supabase/migrations/*` — new migration to:
   - Extend `operator_task.status` CHECK with the 8 lifecycle states.
   - Add `suspended_until timestamptz` + `is_banned boolean` to `profiles`; update
     `operator_suspend_member` (set expiry) and `operator_ban_member` (set `is_banned`).
   - Add an immutability trigger on `operator_audit` (block UPDATE/DELETE).
   - Add budget columns to `operator_provider` (or read from `operator_policy.providers`).
5. `20261115000004_83_operator_scheduler.sql` — stop enqueuing `queue_sweep` as a **model**
   task; make it a pure maintenance sweep (no provider call).

### P1 — Executive DM (Phase 5, the core product decision)
6. `app/messages/index.tsx` — pin the Operator thread at the top of the inbox with the disclosed
   AI-staff identity.
7. `app/messages/[handle].tsx` — when the peer is the staff profile, route through the operator
   pipeline (admin_control for the executive, member_ai for members) instead of plain DM send;
   render Markdown + streaming + task lifecycle.
8. `supabase/migrations` — make `operator_capture_member_dm` branch on sender role: executive →
   `admin_control`, member → `member_ai`. Add `operator_ensure_conversation('admin_control', …)`
   reachable from DMs.
9. `components/admin/OperatorControlCentre.tsx` — remove the "Control" (chat) tab; keep the
   Admin Console management-only (Overview, Queue, Approvals, Providers, Tools, Moderation,
   Research, Campaigns, Health).

### P2 — Intelligence & lifecycle (Phases 2–3)
10. `prompt.ts` — replace the single hardcoded identity with a versioned constitution +
    knowledge retrieval (DB-backed `operator_knowledge`).
11. `operator-worker/index.ts` — add classification, lifecycle transitions
    (`received→understanding→…→verifying→completed/partially_completed/blocked`), planning,
    and honest failure reporting.
12. Enforce moderation thresholds, notification caps/quiet-hours/dedup, and provider budgets
    in `tools.ts` / worker.

### P3 — Research, departments, 24/7, acceptance (Phases 4, 6–9)
13. External research tool (web search) beyond local `titles`.
14. Six departments; 12 Admin Console management areas; reliability hardening; acceptance tests.

---

## 17. Tests needed to prove each repair

- **Deploy:** `POST operator-admin` with a CEO JWT returns 200 and `{ok:true}`; `operator-worker`
  returns 200 on a synthetic task.
- **Rate limit:** insert `tool` rows past the cap → `executeTool` returns `rate_limited`; a
  PostgREST error path must **not** allow execution.
- **Tool audit:** after a tool call, `operator_tool_call.outcome ∈ {succeeded, failed, …}` and the
  row exists.
- **Conversation binding:** a model-supplied foreign `conversation_id` is rejected.
- **Suspension expiry:** suspend 1 day → `suspended_until` set; a sweep restores after expiry.
- **Ban distinction:** ban → `is_banned=true`; suspend → `is_banned=false` + `suspended_until`.
- **Notification caps:** >12/day suppressed; quiet-hours window suppresses; identical body within
  72h deduped.
- **Budget:** exceeding `daily_request_budget_apinex` blocks further APINEX calls (no fallback).
- **Moderation threshold:** confidence below `contain_below_confidence` is not auto-removed.
- **Executive DM:** executive opens DMs → Operator thread present → send → `admin_control`
  conversation + task created → reply delivered into the same thread → survives reload.
- **Queue sweep:** a tick enqueues **no** provider task; task count stable.
- **Migration parity:** local file count == remote `schema_migrations` count.

---

## 18. Deployment blockers

1. **`operator-admin` and `operator-worker` are not deployed** on this branch (404). They deploy
   only on merge to `main`. Until then, the entire Operator is inert.
2. **PR #16 is `CONFLICTING`** (branch is 273 commits behind `main`, 2 ahead) — merge is blocked
   by divergence, so the deploy cannot happen yet.
3. **Migration history drift** (89 remote vs 77 local) must be reconciled before adding new
   migrations, or the drift will compound.
4. **Product divergence** (executive chat in Admin Console) must be corrected before the build can
   be called spec-compliant, regardless of deployment.

---

## Summary verdict

The *infrastructure* is largely sound: isolated providers, Vault secrets, RLS, a live scheduler,
event-capture triggers, and a 23-tool registry are all present and mostly verified. The
*product* is not yet functional: the engine is undeployed (404), so 237 tasks never drain and the
AI never replies; and the executive conversation is in the wrong place (Admin Console instead of
Direct Messages). A cluster of real defects — fail-open rate limiting, constraint-violating tool
audit, unbound conversation IDs, unenforced moderation/notification/budget policy, missing
suspension-expiry/ban distinction, billable health probe, and a credit-wasting queue sweep — are
confirmed and have a clear, prioritised repair path above.
