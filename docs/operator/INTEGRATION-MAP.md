# Hallyu AI Operator — Integration Map

This document is the authoritative map of how the Operator is wired into the existing Hallyu
platform. It lists every real contract the Operator depends on, so nothing is invented and nothing
is duplicated. All names below were verified against the live database (`ltyymanoidagwsapgiql`) and
the existing app source.

## 1. Namespace

The Operator lives entirely in a new `operator_*` namespace. The legacy `hallyu_operator_*` objects
from the retired Operator are left untouched and are **not** read or written by this build.

| Layer | Location |
| --- | --- |
| Schema / RLS / seed | `supabase/migrations/20261115000000_79_operator_core.sql` … `20261115000005_84_operator_provider_secret.sql` |
| Shared provider adapters | `supabase/functions/_shared/operator/providers.ts` |
| Shared prompt / identity | `supabase/functions/_shared/operator/prompt.ts` |
| Secure tool gateway | `supabase/functions/_shared/operator/tools.ts` |
| Execution engine (worker) | `supabase/functions/operator-worker/index.ts` |
| Admin control API | `supabase/functions/operator-admin/index.ts` |
| Client API | `lib/api/operator.ts` |
| Control Centre UI | `components/admin/OperatorControlCentre.tsx` |
| Admin console entry | `components/admin/AdminDashboard.tsx` (`operator` section) |

## 2. Four conversation types (strictly separated)

| Type | `operator_conversation.channel` | Created by | Never touches |
| --- | --- | --- | --- |
| A. Admin ↔ AI control | `admin_control` | `operator-admin` `admin_message` | member DMs |
| B. Member ↔ AI staff DM | `member_ai` | `operator_capture_member_dm` trigger on `direct_messages` | member↔member DMs |
| C. Member ↔ member DM | *(none)* | existing app code | **Operator never reads or writes these** |
| D. Public comments / mentions | `public_thread` | `operator_capture_mention` trigger on `comments` | private DMs |

The capture triggers only fire for messages whose recipient is the AI staff profile
(`operator_staff_profile_id()`), or comments that explicitly mention the staff handle. Member↔member
DMs are invisible to the Operator at the database level.

## 3. Real platform contracts used by tools

Every tool handler in `tools.ts` calls an existing table or function. No table is invented.

| Tool | Backing contract |
| --- | --- |
| `member.get`, `member.status` | `profiles` |
| `conversation.context` | `operator_conversation_context(uuid, int)` |
| `message.reply` | `operator_send_staff_message(uuid, text, uuid)` → writes `direct_messages` |
| `post.create` | `operator_create_post(...)` → writes `posts` |
| `post.publish` | `posts.state = 'active'` (verified after write) |
| `post.delete` | `operator_moderate_content(...)` |
| `comment.reply` | `comments` (parent lookup + insert) |
| `poll.create` | `post_polls` |
| `notification.send` | `notifications` + `operator_notification_run` |
| `moderation.queue` | `operator_moderation_queue(int)` |
| `moderation.rules` | `operator_policy` |
| `moderation.remove_content` | `operator_moderation_case` + `operator_moderate_content` |
| `moderation.suspend` | `operator_suspend_member(uuid, text, int)` |
| `moderation.ban` | `operator_ban_member(uuid, text)` |
| `moderation.restore` | `moderation_actions` + `operator_moderate_content` |
| `analytics.platform` | `operator_platform_analytics()` |
| `research.search` | `titles` |
| `research.save` | `operator_research_item` |
| `campaign.create` | `operator_campaign` |
| `ops.task_list` | `operator_task` |
| `ops.task_retry` | `operator_task` (status reset + verify) |
| `ops.health` | `operator_provider`, `operator_worker_health`, `operator_task` |

## 4. Providers (isolated, no fallback)

| Provider | Model | Base URL | Credential source |
| --- | --- | --- | --- |
| `apinex` | `free/gpt-6-luna` | `https://api.apinex.bond/v1` | Edge secret `APINEX_API_KEY`, else Vault `operator_provider_apinex_key` |
| `coarena` | `claude-fable-5-2` | `https://coarena.ai/api/v1` | Edge secret `COARENA_API_KEY`, else Vault `operator_provider_coarena_key` |

`callProvider()` resolves exactly one provider from the task row and either returns that provider's
answer or throws. There is no branch that tries the other provider on failure, rate limit, or credit
exhaustion. Switching models is a database policy action (`operator_set_active_model`), never a
transport decision.

## 5. Event → task → worker flow

```
direct_messages insert ─┐
comments insert ────────┼─► operator_capture_* ─► operator_task (queued)
operator_schedule due ──┘                              │
                                                       ▼
                                    operator_dispatch_task trigger
                                    (pg_net http_post, non-blocking)
                                                       │
                                                       ▼
                         operator-worker (verify token → claim → engine → tools)
                                                       │
                                                       ▼
                         operator_task.result + operator_tool_call + operator_audit
```

`pg_cron` job `hallyu-operator-tick` runs `operator_scheduler_tick()` every minute: it enqueues due
schedules and recovers tasks whose lease expired. The `operator_dispatch_task` trigger provides the
sub-minute wake for member events.

## 6. Security boundaries

- Model output never touches the database directly. Every action goes through `executeTool`, which
  validates the JSON schema, checks the permission against `operator_policy`, enforces a per-task
  rate limit, applies a timeout, and records `operator_tool_call`.
- All `operator_*` tables have RLS enabled. Server functions are `SECURITY DEFINER` with a pinned
  `search_path` and are granted to `service_role` only.
- Provider keys live in Edge secrets or Supabase Vault, never in the repo or the client bundle.
- The worker authenticates with an opaque token verified against Vault (`operator_verify_worker`).
- The admin API authenticates with a real admin session JWT and re-checks `role in ('admin','ceo')`.

## 7. Human approval

Mandatory approval is limited to: admin role/permission changes, core security/ownership changes,
and any tool flagged `approval_required` (currently `moderation.restore`). Everything else — DM
replies, comment replies, research, routine publishing, notifications, removal of explicit sexual
content, and proportionate warnings/suspensions/bans — is autonomous and backend-enforced.
