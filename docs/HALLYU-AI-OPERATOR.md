# Hallyu AI Operator — architecture, safety and rollout

Hallyu AI is an explicitly identified executive, community and member assistant. It uses the real
Hallyu Supabase backend and the server-side Rork Toolkit credential. It is not a scripted chatbot:
the model selects steps from a fixed tool registry, every result is persisted, and failures remain
visible in the Command Centre.

## Request and execution flow

```text
Mobile/web Admin Command Centre or signed-in member
  │ Rork Auth access token (not a Supabase Auth session)
  ▼
hallyu-ai-operator (gateway verify_jwt = false; application auth mandatory)
  │ 1. PostgREST validates the Rork JWT used by all existing app RPCs
  │ 2. current_profile_id() maps its opaque subject; service role reads the live active profile/role
  │ 3. hourly task quota and fixed member/staff tool registry
  ▼
Rork Toolkit /v2/vercel/v1/chat/completions
  │ bounded six-step JSON protocol: one tool OR one final response
  ▼
Typed tools → existing public RPC/schema → durable tool/task/approval/publication records
```

A JWT payload is never trusted merely because it decodes. Staff tools are both omitted from a
member's model manifest and denied again at execution. A task also re-reads its requester's live
role when resumed, so demotion/deactivation removes staff authority. There is no arbitrary SQL,
shell, secret-reading, deployment, schema-edit, billing or destructive-moderation tool.

Model input, member content and external results are untrusted data. Tool results are wrapped as
such in the model transcript. The model cannot grant itself a permission or convert text inside a
post into an operator instruction.

## Durable state

Migration `20261112000000_67_hallyu_ai_operator.sql` creates task, tool-call, approval, schedule
and memory records. Migration `20261112120000_68_hallyu_ai_operations.sql` adds:

- the transparent `hallyu.ai` official profile and `profiles.is_ai`;
- resumable model state, retry/backoff fields, request idempotency keys and unique tool sequences;
- durable drafts and idempotent post/comment/poll publication;
- preference-aware notification queueing through the existing `enqueue_notification` RPC;
- atomic due-schedule claiming and bounded staff read RPCs;
- real aggregate platform diagnostics and attributable staff approval decisions.

All AI tables have RLS enabled, explicit deny policies and no direct anon/authenticated table
grants. Staff reads use role-checking RPCs. Service-role writes are mediated by the operator.

## Tool registry

| Tool | Member | Staff | Behavior |
|---|---:|---:|---|
| `community_discovery` | yes | yes | Active public discussions only |
| `my_context` | yes | yes | Caller's own entertainment preferences only |
| `entertainment_research` | yes | yes | Live TMDB catalogue metadata and exact source links |
| `schedule_reminder` | yes | yes | Queues a reminder only for the signed-in member |
| `platform_overview` | no | yes | Real aggregate counts and failed-job evidence |
| `community_pulse` | no | yes | Active public posts/comments, never private content |
| `member_context` | no | yes | Minimal public profile fields, no credentials/contact data |
| `operational_diagnostics` | no | yes | Recent failed catalogue and scheduled jobs |
| `catalogue_gap_check` | no | yes | Bounded stale/missing metadata candidates; read only |
| `remember` | no | yes | Idempotent operational memory by kind/key |
| `draft_content` | no | yes | Durable draft; does not publish |
| `publish_post` | no | yes | Attributed to Hallyu AI; publication mode applies |
| `reply_comment` | no | yes | Active public post only; publication mode applies |
| `create_poll` | no | yes | 2–4 non-empty distinct options; publication mode applies |
| `notify_member` | no | yes | Preference-aware targeted queue; publication mode applies |
| `send_broadcast` | no | yes | Maximum 500 eligible recipients per approved task; always gated |

TMDB is catalogue research, not a breaking-news wire. The model is instructed to identify that
limit. Content citations must exactly match a source URL returned by research in the same task;
made-up citations are rejected. If TMDB is not configured or returns an error, the tool reports it
and no result is invented. General web/news search is not claimed as available.

Notifications and broadcasts report **queued**, **suppressed**, or **ineligible**, never delivered.
Only the existing push delivery system can establish device delivery.

## Approvals and autonomy

`publishing_mode` defaults to `approval` and is stored in `hallyu_ai_memory`.

- Research, analysis, public discovery and drafts may run without approval.
- In `approval` mode, posts, comments, polls and targeted staff notifications pause for approval.
- In `autonomous` mode, those routine publishing actions may proceed for staff/system tasks.
- `send_broadcast` always requires approval in both modes.
- Approval is bound to the task, tool and exact JSON arguments. Changing the action requires a new
  approval. Rejection cancels the task. Approval records the independently verified staff profile.
- Production/schema changes, deployments, destructive operations and sensitive moderation are not
  exposed as autonomous tools and retain their human change-control boundaries.

## Retries and idempotency

A caller can supply an `idempotency_key` when creating work. Publication RPCs also key their target
by `(task_id, action)`: a repeated successful call returns the original target instead of creating
a second post or comment. Publishing is atomic; a failed poll does not leave an orphaned post.
Tool calls have a unique `(task_id, seq)` constraint and retain actual errors.

Failed tasks retain model/tool state and a bounded retry time (maximum three attempts by default).
The step limit counts tool calls across resumes, not model iterations, so it cannot be bypassed by
a final response or an approval round-trip. Schedules that fail or need approval are paused for
staff resolution rather than creating an unbounded backlog of duplicate actions.

## Real scheduling

Schedules are durable but **disabled by default**. Staff can enable/pause them in the Command Centre.
`schedule.run_due` claims due rows atomically, advances their next run before model execution and
records the resulting task.

The scheduler is not represented as active merely because a table exists:

1. Deploy `hallyu-ai-operator` and `hallyu-ai-scheduler`.
2. Deploy `.github/workflows/hallyu-ai-scheduler.yml` to the repository's actual default branch
   (`arena/c5e9499c-grok-hallyu`, not `main`).
3. The workflow runs every 15 minutes and mints a GitHub OIDC token; no Supabase secret is stored
   in GitHub.
4. `hallyu-ai-scheduler` has transport JWT verification off, but cryptographically verifies the
   GitHub signature, issuer, audience `hallyu-ai-scheduler`, repository, event, exact workflow and
   the configured `GITHUB_SCHEDULER_REF` (`refs/heads/arena/c5e9499c-grok-hallyu`). It then makes
   the internal service-role operator request.
5. Enable only the desired schedules after a successful staff-supervised run.

A schedule is not active before steps 1–2. Manual workflow dispatch is also restricted to the
actual default branch.

## Command Centre

`components/admin/HallyuAIPanel.tsx` renders only backend state:

- configured model/credential state (configuration is not mislabeled as a successful health check);
- immediate answers and real task failures;
- exact pending approval arguments;
- publishing mode and schedule controls;
- durable drafts, source URLs and published target IDs;
- per-task tool sequence, result and error audit.

A missing backend, missing migration, provider error or rejected permission is shown as an error.
The panel does not substitute generated analytics or simulated action results.

## Rork credential and model

The function reads the Rork Toolkit credential only from server environment secrets
(`RORK_TOOLKIT_SECRET_KEY`, the existing Rork-provisioned server equivalent, or `RORK_AI_API_KEY`).
The browser receives only a boolean indicating whether a credential is configured—never its value.

Default gateway: `TOOLKIT_URL` or `https://toolkit.rork.com`.
Default model: `anthropic/claude-sonnet-5`; override with `RORK_AI_MODEL` only after validating the
model name against the Rork account. Provider quotas and billing controls are never bypassed.
Cost is bounded by six steps, 1,400 output tokens per call, short retained history, hourly quotas,
small result sets and disabled schedules.

A secret's presence does not prove model connectivity. Validate with a real supervised staff task
after deployment; a non-2xx, empty or malformed provider response fails the task honestly.

## Web login repair

`auth-broker` is the CORS-safe relay for non-Rork web origins and has `verify_jwt = false` because it
runs before a Supabase session exists. It forwards only the three fixed Rork Auth endpoints and
adds no credential. It must be deployed separately; checking the source file does not fix web login.

## Rollout (human-approved production change)

Run the repository gates first, then use the normal reviewed migration/deployment process:

```bash
npm run check
npm run build
# Reproduce the Gradle release path separately; web export is not an APK test.
supabase db push                         # migrations 67 and 68, only after approval
supabase functions deploy auth-broker
supabase functions deploy hallyu-ai-operator
supabase functions deploy hallyu-ai-scheduler --no-verify-jwt
```

Use the project's normal CLI syntax if it differs; `supabase/config.toml` is authoritative for JWT
settings. Do not copy credentials into source, workflow logs or the client bundle.

## Verification and known environment limits

`npm run test:ai-policy` covers approval invariants, protocol parsing, malformed arguments, Auth
validation, privileged grant lockdown and honest notification state. SQL/type gates validate the
migration and generated contracts. The migrations have also been executed transactionally against
the live schema and rolled back, including the aggregate overview RPC; rollback was verified.

A transactional schema check is not a substitute for a supervised deployed model task, real member
authorization tests, push-device confirmation or a Gradle APK build. Branch-based Supabase testing
requires the Pro plan; do not upgrade or bypass that restriction merely to run tests. Local
`test:db-exec` additionally requires `psql` and a PostgreSQL server.
