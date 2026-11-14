# Hallyu AI Operator — Phase 0 audit

Audited branch: `arena/c5e9499c-grok-hallyu` (repository default branch), tip `275d8a7` at the start of
this audit, with fixes committed on top. Live project: `ltyymanoidagwsapgiql`.

Evidence labels: **VERIFIED WORKING**, **WORKING WITH LIMITATIONS**, **CODE PRESENT, NOT VERIFIED**,
**BROKEN**, **MISSING**, **BLOCKED BY EXTERNAL SERVICE**.

---

## 1. Architecture as deployed

| Piece | Where | State |
|---|---|---|
| Control Centre API | Edge Function `operator-admin` (repo `supabase/functions/operator-admin`) | was **BROKEN** (not deployed), now deployed |
| Durable worker | Edge Function `operator-worker` (repo `supabase/functions/operator-worker`) | was **BROKEN** (not deployed), now deployed |
| Queue + tasks | `operator_task`, `operator_event`, `operator_conversation`, `operator_message` | present, 45 tasks accumulated without ever running |
| Dispatch | `operator_dispatch_task()` trigger → `net.http_post` → `operator-worker` with the Vault worker token | works, but was pointing at a function that did not exist |
| Scheduler | `operator_scheduler_tick()` / `operator_scheduler_sweep()` | works; did not recover stranded queued tasks (fixed) |
| Providers | `operator_provider` rows `apinex` (default, `free/gpt-6-luna`) and `coarena` (`claude-fable-5-2`), keys in Vault | credentials resolve; APINEX edge intermittently blocks requests |
| Knowledge | `operator_constitution` (versioned), `operator_knowledge` (5 entries), `operator_policy`, 24 `operator_tool` rows | constitution was incomplete (fixed in v2026.11.2) |

## 2. Reproducible defects found

### D1 — Control Centre returned `{"code":"NOT_FOUND","message":"Requested function was not found"}` (BROKEN, fixed)
`lib/api/operator.ts` posts to `/functions/v1/operator-admin`. The live project had
`hallyu-operator` (v2) and `hallyu-operator-worker` (v3) but **no** `operator-admin` /
`operator-worker`. Proof: `net._http_response` row at 10:51 carries the exact 404 body.
Fix: deploy both functions from the repository source (bundled by `scripts/build-operator-bundles.mjs`
because the single-file deploy path cannot resolve `supabase/functions/_shared`). After deploy,
an anonymous call returns `403 {"error":"admin access required"}` — real auth, not a missing route.

### D2 — First executive DM failed with `operator_conversation_participant` (BROKEN, fixed)
`operator_capture_member_dm()` opened the `admin_control` conversation with a NULL
`member_profile_id`, while the constraint requires a member for every non-`public_thread` channel.
Fix (`20261116000000_88_operator_conversation_fix.sql`): an executive conversation is keyed by the
executive's own profile id. Verified: inserting a CEO DM now creates conversation `admin_control`
with `member_profile_id` = the CEO, one message row, one queued task.

### D3 — Same path violated two more constraints (BROKEN, fixed)
The trigger wrote `author_type = 'admin'` (allowed: member/staff/system) and the Control Centre wrote
`delivery_status = 'delivered'` (allowed: pending/sent/failed/not_required). Fix: an executive is
`staff`, and a message written straight into the conversation is `not_required`.

### D4 — Every queued task was stranded (BROKEN, fixed)
Dispatch happens once, on insert. All 45 tasks created while `operator-worker` did not exist stayed
`queued` forever, and `operator_scheduler_tick()` had no recovery for them. Fix: new
`operator_redispatch_queued(p_limit)` wakes tasks queued for more than two minutes with no lease, and
the tick calls it. Verified: `operator_scheduler_tick()` → `{"redispatched": 5}`.

### D5 — A Cloudflare HTML 403 was classified as a credential failure (BROKEN, fixed)
APINEX answered `403` with an HTML body; `classifyStatus()` mapped it to a non-retryable
`auth_error`, permanently failing healthy tasks and pointing at the wrong cause. Fix: an HTML 403 is
`provider_blocked` (retryable); a JSON 403 remains `auth_error`. Verified: the same tasks now show
`status = retrying`, `error_code = provider_blocked`.

### D6 — The Operator did not know what Hallyu is (BROKEN, fixed)
Asked "what are your six departments", the live Operator answered that it had no access to Hallyu's
internal structure. Honest, but the knowledge was missing: constitution v2026.11.1 described honesty
and identity only. Fix (`20261117000000_89_...`): constitution v2026.11.2 adds what Hallyu is, the four
worlds, the six departments, verified-capability rules, and authority boundaries. Verified active.

## 3. Verified working after the fixes

- Executive DM round trip: CEO message → `operator_conversation` + `operator_message` +
  `operator_task` (`admin_command`, provider `apinex`, model `free/gpt-6-luna`) → worker claims →
  provider answers → reply stored in `direct_messages` from the staff profile →
  `delivery_verified: true`.
- Member DM capture and reply path (rows from 06:37 exist and were answered the same way).
- Moderation tasks continue to be enqueued by the scheduler.
- Control Centre authentication: anon → 403 admin access required.

### D7 — The provider key was never awaited (BROKEN, fixed)
`callProvider()` did `const apiKey = providerCredential(...)` and used it directly, so every
completion sent `Authorization: Bearer [object Promise]`. The health probe in the same file awaited
it correctly. Fix: `await providerCredential(...)`. After the fix the same task went from
`provider_blocked` to `completed` with a real answer.

### D8 — A DM answer was only delivered if the model called a tool (BROKEN, fixed)
A task could finish successfully with nothing sent: delivery depended on the model choosing
`message.reply`. Fix: the worker now delivers the final answer through
`operator_send_staff_message` before closing the task, and skips delivery when a tool already sent
the reply.

### D9 — Executive replies were never mirrored into `direct_messages` (BROKEN, fixed)
`operator_send_staff_message()` inserted into `direct_messages` only for `member_ai`, so an
executive conversation wrote only the operator record — the CEO saw no reply in the DM screen.
Fix (`20261118000000_90_...`): both DM channels deliver into the real DM table.

## 3b. Verified end to end after the fixes

Executive DM, live: CEO message → conversation `admin_control` (owner = CEO) → task
`admin_command` (apinex / `free/gpt-6-luna`) → worker (attempt 1, no error) → `completed` →
`operator_message` outbound `delivery_status = sent` → `direct_messages` row from the staff profile:

> "Hallyu is a social platform for fans of K-drama, C-drama, anime and Hollywood — a community where
> members follow titles, discuss episodes, post reviews and polls, and connect in dedicated worlds.
> My six departments are: Community Operations, ..."

That answer is the constitution v2026.11.2 text, which proves the knowledge layer now reaches the
model (input 4,820 tokens) and that the round trip completes inside the existing DM screen.

## 4. Remaining defects (not fixed this phase)

1. **APINEX availability (WATCH).** Before the credential fix, calls returned a Cloudflare HTML 403.
   With the key properly awaited, calls succeed; the earlier 403s were the malformed Authorization
   header, not a WAF decision. Re-check if 403s return.
2. **Worker heartbeat table empty (MISSING).** `operator_worker_health` has no rows; the worker does
   not write a heartbeat, so worker health cannot be observed from the Control Centre.
3. **Structured DM rendering (MISSING).** Messages are plain text; `message_type`/`rich_content`
   columns do not exist in the current schema and no Markdown/card renderer is wired into the DM
   screen.
4. **Streaming (MISSING).** Responses arrive whole; no provider-to-client stream.
5. **Tool catalogue gaps (MISSING).** No web-research, image, campaign or notification tools in the
   live registry (24 tools exist, all database-backed).
6. **Usage/cost ledger (CODE PRESENT, NOT VERIFIED).** `operator_provider_usage` exists; budgets are
   read by the worker but enforcement was not exercised.
7. **Admin console sections** (departments, memory, knowledge editing, health) are present in code;
   only `overview` was exercised against the live backend.
8. **Push tokens**: `push_tokens` is empty in this project, so notification delivery cannot be proven.

## 5. Next priorities

1. Worker heartbeat + health surface (small, unblocks observability).
2. Confirm APINEX availability and, if it is intermittent, add backoff visibility to the Control
   Centre rather than failing silently.
3. Rich DM rendering (message_type/rich_content + renderer) — Phase 5.
4. Web research and image tools — Phase 4.
5. Usage/budget enforcement test — Phase 8.
