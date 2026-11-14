# Hallyu AI Operator — Implementation Plan & Status

## Build phases

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Pre-flight: providers reachable, DB reachable, repo audited | ✅ done |
| 1 | Documentation (this file + `INTEGRATION-MAP.md`) | ✅ done |
| 2 | Backend foundation: 19 `operator_*` tables, RLS, functions, seed | ✅ applied live (migrations 79–81) |
| 3 | Provider adapters: isolated APINEX + Coarena, no fallback | ✅ done |
| 4 | Central intelligence engine + model-selection controller | ✅ done (`operator-worker`) |
| 5 | Secure tool gateway: 23 tools, schema/permission/rate-limit/audit | ✅ done (`tools.ts`) |
| 6 | 24/7 operations: event triggers, durable queue, pg_cron scheduler, recovery, health | ✅ done (migrations 82–83) |
| 7 | Premium Control Centre: 10 screens wired to real endpoints | ✅ done (`OperatorControlCentre.tsx`) |
| 8 | Validation: type contract, surface checks, acceptance verifier | ✅ done (`scripts/verify-operator.mjs`) |
| 9 | Release: branch push, PR, three CI checks green | ⏳ in progress |

## What each phase delivers

**Phase 2 — backend foundation.** `operator_staff`, `operator_policy`, `operator_provider`,
`operator_provider_usage`, `operator_conversation`, `operator_message`, `operator_memory`,
`operator_tool`, `operator_tool_call`, `operator_task`, `operator_event`, `operator_schedule`,
`operator_approval`, `operator_moderation_case`, `operator_research_item`, `operator_campaign`,
`operator_notification_run`, `operator_audit`, `operator_worker_health`. Every table has RLS. The
seed creates one AI staff row, two provider rows, 23 tool rows, four schedules, and a baseline
audit entry.

**Phase 3 — providers.** `providers.ts` fixes the base URLs in code, classifies HTTP failures into
stable error codes, clamps timeouts to 5–120 s, and never falls back. Credentials resolve from Edge
secrets first, then Supabase Vault through a `service_role`-only RPC.

**Phase 4 — engine.** `operator-worker` verifies the worker token, heartbeats, recovers stale
tasks, claims up to five tasks with `FOR UPDATE SKIP LOCKED`, builds a channel-aware system prompt,
replays scoped memory and recent history, then runs a bounded tool loop (6 rounds, 3 calls/round,
100 s wall clock). It records usage on every provider call and audits every completion/failure.

**Phase 5 — tool gateway.** Each of the 23 tools has a JSON schema, a permission, a read-only flag,
an approval flag, and a per-minute rate limit. `executeTool` validates, authorises, rate-limits, and
times out. `recordToolCall` writes the real `operator_tool_call` row.

**Phase 6 — 24/7.** Triggers capture member DMs and mentions and enqueue tasks. `pg_cron` job
`hallyu-operator-tick` enqueues due schedules and recovers expired leases every minute. The dispatch
trigger wakes the worker via non-blocking `pg_net`.

**Phase 7 — Control Centre.** Ten tabs — Overview, Control, Queue, Approvals, Providers, Tools,
Moderation, Research, Campaigns, Health — all backed by `operator-admin` actions. No mock data.

**Phase 8 — validation.** `scripts/verify-operator.mjs` statically proves: exactly two providers
with distinct credentials, no cross-provider fallback, all four channels present, the tool gateway
has validation/permission/rate-limit/audit, and the approval boundary is enforced.

## Acceptance criteria

1. A member DM to the staff profile creates one `member_ai` conversation and one `reply_member_dm`
   task, and the worker replies with a real `direct_messages` row.
2. A public comment mentioning the staff handle creates one `public_thread` conversation and one
   `reply_public_mention` task; a non-mention creates nothing.
3. Member↔member DMs are never captured.
4. Provider A failing never produces a call to provider B; usage rows stay per-provider.
5. A tool call without permission is rejected before any write.
6. `moderation.restore` and admin role changes require approval; routine moderation does not.
7. `pg_cron` tick enqueues due schedules exactly once per occurrence.
8. Every completed task has `operator_tool_call` and `operator_audit` rows.

## Rollback

Each migration is additive. To roll back, drop the `operator_*` objects in reverse order (84 → 79)
and `select cron.unschedule('hallyu-operator-tick')`. The legacy `hallyu_operator_*` objects are not
affected.
