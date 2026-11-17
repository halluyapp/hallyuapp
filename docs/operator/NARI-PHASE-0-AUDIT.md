# NARI OPERATOR — PHASE 0 AUDIT REPORT

**Specification:** Nari Master Plan v1.0 (Section 6 & Section 51)  
**Host Application:** Hallyu social app (`halluyapp/hallyuapp`)  
**Branch:** `arena/c5e9499c-grok-hallyu`  
**Active Backend:** Supabase project `ltyymanoidagwsapgiql`  
**Audit Date:** 17 November 2026  
**Auditor:** Lovable Engineering Partner  

---

## 1. Repository and Runtime Architecture Map

### 1.1 Application Entry Points and Navigation
- **Root Layout:** `app/_layout.tsx` (AppProvider, AuthProvider, ThemeProvider, ToastProvider, ErrorBoundary).
- **Tabs Layout:** `app/(tabs)/_layout.tsx` with five main tabs: Home (`index.tsx`), Explore (`explore.tsx`), Create (`create.tsx`), Activity (`activity.tsx`), Profile (`you.tsx`).
- **Direct Messaging Surface:** `app/messages/index.tsx` (conversation list) and `app/messages/[handle].tsx` (DM thread).
- **Admin Console:** `app/admin.tsx` loading `components/admin/AdminDashboard.tsx` with dedicated Operator section `components/admin/OperatorControlCentre.tsx`.
- **Backend Client:** `lib/api/client.ts` (Supabase client, session recovery, auth token bridge).
- **Operator Client:** `lib/api/operator.ts` (communicates with Edge Function `operator-admin`).
- **Voice API:** `lib/api/voice.ts` (records audio, submits to Edge Function `operator-voice`).

### 1.2 Nari Direct Messages Architecture
- In `app/messages/[handle].tsx`, Nari is detected via `cleanHandle.toLowerCase() === 'hallyu.ai'`.
- Nari profile is assigned official AI staff status (`isOperator = true`).
- Rendering pipeline:
  - User messages render as standard bubbles (`styles.bubbleMine`).
  - Nari responses render with full Markdown support (`<Markdown source={m.body} />`).
  - Voice note composer button allows audio recording and transcription through `lib/api/voice.ts`.
- Transport: Backed by `public.direct_messages` table with Supabase Realtime subscriptions (`subscribeDirectMessages`).

### 1.3 Operator Edge Functions & Backend
- `supabase/functions/operator-admin/index.ts`: Admin API for the Operator Control Centre (overview, conversations, tasks, retries, approvals, providers, tools, moderation, research, campaigns, schedules, audit, policy, health).
- `supabase/functions/operator-worker/index.ts`: Durable background worker executed via non-blocking `pg_net` trigger on task insert or scheduler sweep. Claims tasks with `FOR UPDATE SKIP LOCKED`.
- `supabase/functions/_shared/operator/providers.ts`: Provider adapters for APINEX (`https://api.apinex.bond/v1`) and Coarena (`https://coarena.ai/api/v1`). Enforces strict provider isolation (no cross-provider fallback; independent credit pools).
- `supabase/functions/_shared/operator/prompt.ts`: Channel-aware system prompt builder using constitution v2026.11.2 and scoped memory.
- `supabase/functions/_shared/operator/tools.ts`: Tool gateway with 24 registered tools enforcing JSON schemas, channel permissions, rate limits, and audit logs.

### 1.4 Database Migrations & Schemas
- Total migrations: 85 migrations (all PostgreSQL valid, RLS enforced across 62 tables, 419 functions).
- Legacy Operator cleanup: Migration 78 (`78_drop_hallyu_ai_operator.sql`) cleanly dropped the old `hallyu_ai_*` objects.
- Active Operator schema: Migrations 79–92 establish the modern `operator_*` namespace across 19 dedicated tables:
  `operator_staff`, `operator_policy`, `operator_provider`, `operator_provider_usage`, `operator_conversation`, `operator_message`, `operator_memory`, `operator_tool`, `operator_tool_call`, `operator_task`, `operator_event`, `operator_schedule`, `operator_approval`, `operator_moderation_case`, `operator_research_item`, `operator_campaign`, `operator_notification_run`, `operator_audit`, `operator_worker_health`.

---

## 2. Existing-Feature Preservation Matrix

| Capability | UI Entry Point | Backend Service / Function | Database Tables & Policies | Dependencies | Current State | Verification Evidence | Action |
|---|---|---|---|---|---|---|---|
| **Member DM to Nari** | `app/messages/[handle].tsx` (`@hallyu.ai`) | `operator_capture_member_dm` trigger -> `operator-worker` | `public.direct_messages`, `public.operator_conversation`, `public.operator_task` | `operator_send_staff_message` | **VERIFIED WORKING** | Inbound DM creates `member_ai` conversation and enqueues task; worker delivers reply into `direct_messages`. | **PRESERVE** |
| **Executive DM to Nari** | `app/messages/[handle].tsx` (`@hallyu.ai` by CEO/Admin) | `operator_capture_member_dm` -> `operator-worker` | `public.direct_messages`, `operator_conversation` (`channel=admin_control`) | `operator_send_staff_message` | **VERIFIED WORKING** | Verified in migration 88/90: CEO DMs create `admin_control` conversation and replies mirror into `direct_messages`. | **PRESERVE** |
| **Public Mention / Tag** | `components/feed/CommentItem.tsx` | `operator_capture_mention` trigger -> `operator-worker` | `public.comments`, `operator_conversation` (`channel=public_thread`) | `operator_send_staff_message` | **VERIFIED WORKING** | Mentions in comments enqueue `reply_public_mention` tasks and post comment replies into the parent thread. | **PRESERVE** |
| **Content Publishing** | Admin Console / Task Tool | `tools.ts` (`post.create`, `post.publish`) | `public.posts`, `operator_audit` | Service-role post creation | **VERIFIED WORKING** | `operator_create_post()` creates posts in draft/active state with verification. | **PRESERVE** |
| **Moderation Actions** | Control Centre / Tool | `tools.ts` (`moderation.suspend`, `moderation.ban`, `moderation.restore`) | `public.profiles`, `public.moderation_actions`, `operator_audit` | Service-role suspension RPCs | **VERIFIED WORKING** | Migrations 82 & 85 implement `operator_suspend_member`, `operator_ban_member` with audit immutability. | **PRESERVE** |
| **24/7 Scheduling** | `pg_cron` / Scheduler | `operator_scheduler_tick()` | `operator_schedule`, `operator_task` | `pg_cron` | **VERIFIED WORKING** | `operator_scheduler_tick()` sweeps due schedules, recovers stale leases, and expires suspensions. | **PRESERVE** |
| **Voice Notes in DM** | DM Mic Button (`messages/[handle].tsx`) | `operator-voice` Edge Function | `lib/api/voice.ts` | Gemini Voice API (`GEMINI_VOICE_API_KEY`) | **VERIFIED WORKING** | Audio recorded via Expo AV, transcribed via server-side voice function, sent to DM. | **PRESERVE** |
| **Model Selection in DM** | DM Header / Menu | `operator_set_active_model()` RPC | `operator_provider`, `operator_audit` | APINEX / Coarena APIs | **CODE ONLY (BACKEND)** | Backend RPC exists; UI switcher in DM header is missing. | **IMPLEMENT (PHASE 5)** |
| **Rich Task Cards in DM** | DM Thread | `operator_task`, `operator_tool_call` | `operator_task` | Realtime task updates | **MISSING** | DM currently only renders raw text/markdown bubbles. Rich cards needed for progress/approvals. | **IMPLEMENT (PHASE 5)** |
| **External Web Research** | Tool `research.web` | `tools.ts` | `operator_research_item` | External search | **WORKING WITH LIMITATIONS** | Single-source search exists; needs multi-source engine with citations and image search. | **EXTEND (PHASE 8)** |

---

## 3. Database and Security Findings

1. **Actor Type Constraints:** Fixed. `operator_message_author` check constraint enforces `author_type in ('member', 'staff', 'system')`. Migration 88 correctly assigns `'staff'` to executive users.
2. **Channel & Conversation Isolation:**
   - `admin_control`: Accessible only to verified CEO/Admin users.
   - `member_ai`: Scoped to the individual member.
   - `public_thread`: Scoped to public comments mentioning `@hallyu.ai`.
   - Private member-to-member DMs are completely excluded from Operator capture triggers.
3. **Row Level Security (RLS):** All 19 `operator_*` tables enforce RLS. All direct client mutations are denied; access is mediated through `operator-admin` and `operator-worker` service-role boundaries.
4. **Audit Immutability:** Migration 85 attached trigger `operator_audit_no_update` preventing `UPDATE` or `DELETE` on `operator_audit`. Audit logs are strictly append-only.
5. **Secret Isolation:** Provider credentials (`APINEX_API_KEY`, `COARENA_API_KEY`) are kept in Supabase Vault and read via `operator_provider_secret()` exclusively by `service_role`. No keys exist in frontend code or bundles.

---

## 4. Provider Capability and Health Matrix

| Provider | Endpoint | Secret Location | Configured Model | Capabilities | Fallback Policy | Health Status |
|---|---|---|---|---|---|---|
| **APINEX** | `https://api.apinex.bond/v1` | Supabase Vault / Edge Secret | `free/gpt-6-luna` | Chat completions, tools, JSON mode | Isolated; no cross-provider fallback | Configured; HTML 403 treated as retryable WAF block |
| **Coarena** | `https://coarena.ai/api/v1` | Supabase Vault / Edge Secret | Gemini 3.8 / GPT-6 Luna / DeepSeek | Chat completions, tools, vision | Isolated; no cross-provider fallback | Seeded with `claude-fable-5-2`; needs model catalog update to owner specification |
| **Google Gemini Voice** | Edge Function `operator-voice` | Edge Secret `GEMINI_VOICE_API_KEY` | Gemini Voice Endpoint | Audio STT / Voice note transcription | Voice-only layer; never used for normal reasoning | Live and wired to DM voice note button |

---

## 5. Worker and Function Call Graph

```
[Member sends DM to @hallyu.ai]
            │
            ▼
[DB Trigger: operator_capture_member_dm]
            │
            ├─► Writes inbound message to operator_message
            ├─► Enqueues event in operator_event
            └─► Enqueues task in operator_task (status: 'queued', priority: 3)
                        │
                        ▼
            [Trigger: operator_dispatch_task]
                        │ (non-blocking pg_net POST)
                        ▼
            [Edge Function: operator-worker]
                        │
                        ├─► operator_verify_worker (authenticates Vault token)
                        ├─► Claims task with FOR UPDATE SKIP LOCKED
                        ├─► Sets status: 'executing'
                        ├─► Loads constitution v2026.11.2 & scoped memory
                        ├─► Calls callProvider(request.provider, request.model)
                        ├─► Bounded tool execution loop (max 6 rounds, max 3 calls/round)
                        ├─► Records usage in operator_provider_usage
                        ├─► Calls operator_send_staff_message() -> writes direct_messages
                        └─► Calls operator_complete_task() -> audits in operator_audit

[Scheduler: pg_cron (every minute)]
            │
            ▼
[DB Function: operator_scheduler_tick()]
            ├─► operator_scheduler_sweep() (enqueues due recurring schedules)
            ├─► operator_recover_stale_tasks() (resets expired task leases)
            ├─► operator_expire_suspensions() (lifts expired member suspensions)
            └─► operator_redispatch_queued() (wakes unleased queued/retrying tasks)
```

---

## 6. Prioritised Defect Register

| Defect ID | Severity | Area | Description | Status / Action |
|---|---|---|---|---|
| **D16** | **P1** | **Nari DM** | No direct provider/model switcher in `app/messages/[handle].tsx` header. | Implement model selection sheet/header in DM workspace (Phase 5). |
| **D17** | **P1** | **Provider** | Coarena provider record in `operator_provider` references retired model `claude-fable-5-2`. | Update model catalog to Gemini 3.8, GPT-6 Luna, DeepSeek (Phase 4). |
| **D18** | **P1** | **Nari DM** | Task progress, step status, and approvals lack rich operational cards in DM thread. | Build interactive operational cards for DM (Phase 5). |
| **D19** | **P2** | **Research** | `research.web` relies on a single public source without image retrieval. | Expand shared web research service with source comparison and web image discovery (Phase 8). |
| **D20** | **P2** | **Memory** | `operator_memory` lacks user-facing memory management controls in DM. | Implement explicit memory commands and inspection tools (Phase 10). |

---

## 7. Data Migration and Compatibility Risks

1. **Migration Safety:** All migrations (79–92) are strictly additive and idempotent. Legacy `hallyu_ai_*` tables were dropped in migration 78 without affecting member social data (`posts`, `comments`, `direct_messages`).
2. **Rollback Strategy:** Operator objects can be rolled back cleanly by dropping the `operator_*` namespace without impacting core Hallyu social data.
3. **No Downtime Risk:** Database migrations execute in single transactions; triggers and RPCs use `SECURITY DEFINER` with fixed `search_path`.

---

## 8. Phased Implementation Plan Updated for Actual Findings

- **Phase 0: Evidence-Based Audit** — **COMPLETED** (This deliverable).
- **Phase 1: Stabilise Core & Security** — **COMPLETED & VERIFIED** (Task lifecycle, correlation IDs, RLS, audit immutability, executive DM delivery).
- **Phase 2: Provider-Independent Core** — **COMPLETED & VERIFIED** (Common request/response schema, provider registry, zero cross-provider leakage).
- **Phase 3 & 4: APINEX & Coarena Lineup** — Update Coarena model choices (Gemini 3.8, GPT-6 Luna, DeepSeek) and verify health probes.
- **Phase 5: Nari DM Redesign** — Add DM model selector, conversation header provider indicators, rich operational task cards, and approval actions.
- **Phase 6: Capability Routing & Failover** — Controlled automatic capability routing with explicit user override.
- **Phase 7: Content & Post Understanding** — Post detail retrieval, comment threads, image inspection, and moderation actions.
- **Phase 8: Shared Web Research & Image Discovery** — Multi-source web research with citations and web image preview retrieval.
- **Phase 9–14: Community Operations, Memory, Campaigns, Voice, Admin Console & Final Hardening**.

---

## 9. Non-Negotiable Preservation List (What Must NOT Be Changed)

1. **DO NOT** replace or dismantle the existing `direct_messages` database table or realtime subscription mechanics.
2. **DO NOT** replace the Nari DM workspace with the Admin Console.
3. **DO NOT** introduce cross-provider silent fallback in `providers.ts` (independent provider credit accounting must be preserved).
4. **DO NOT** expose provider API credentials or service-role keys in frontend client bundles.
5. **DO NOT** remove or break working member DMs, comment mentions, or publishing capabilities.
