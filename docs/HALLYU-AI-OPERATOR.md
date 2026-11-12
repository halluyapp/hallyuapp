# Hallyu AI Operator — architecture and rollout

The AI executive from `HALLYU_AI_PROJECT.md`, built on the existing Rork Cloud backend. Nothing
here duplicates existing systems: the operator runs as one edge function, its tools call the
backend's existing RPCs/tables, and its entire activity is recorded in new `hallyu_ai_*` tables.

## Architecture

```
Admin Command Centre (components/admin/HallyuAIPanel.tsx, section "ai")
        │  supabase.functions.invoke('hallyu-ai-operator')  +  admin RPCs
        ▼
hallyu-ai-operator edge function   ← verify_jwt, re-checks live profiles.role per call
  • agent loop: model plan → tool call → verify → answer (max 5 steps)
  • fixed tool allowlist (never arbitrary SQL from the model)
  • approval gate for restricted tools
  • Rork AI Cloud for the model (OpenAI-compatible adapter)
        ▼
Existing backend: get_bootstrap, posts/comments (read-only), send_admin_broadcast,
hallyu_ai_* state tables (service-role only, RLS deny-all to clients)
```

## Permission tiers (spec §6)

- **Autonomous:** `platform_overview`, `community_pulse`, `member_context`, `remember`.
- **Staff approval required:** `send_broadcast` — the loop parks the task as
  `awaiting_approval`, creates an `hallyu_ai_approval` row, and resumes only after an admin or
  the CEO approves in the Command Centre.
- **Non-staff callers** never see staff tools at all — they are removed from the model's
  registry, not merely blocked at run time.

## Honesty rules implemented

- Every tool call is recorded (`hallyu_ai_tool_call`) with its real outcome, errors included.
- A task that fails is set `failed` with the real error, and the panel shows it verbatim.
- With model credentials unset, every action answers 503 naming the missing configuration —
  the panel prints exactly that instead of pretending the AI works.

## To activate (one-time, after the migration applies)

```bash
supabase db push                                          # applies migration 67
supabase functions deploy hallyu-ai-operator
supabase functions deploy auth-broker                    # also fixes web sign-in (see docs/WEB-AUTH-CONNECTION-FIX.md)
supabase secrets set RORK_AI_BASE_URL=<rork-ai-cloud endpoint> \
                    RORK_AI_API_KEY=<gateway key> \
                    RORK_AI_MODEL=<model id>
```

The adapter speaks the OpenAI chat-completions protocol, so Rork AI Cloud's gateway (or any
compatible provider) can be swapped by changing these three secrets — no code changes.

## What ships now vs. next

- **Now:** real agent loop, real tools, approval workflow, full audit trail, admin panel, chat
  for every signed-in member (non-staff get a member-safe tool set).
- **Next stages (extensible by design):** scheduled intelligence jobs via `hallyu_ai_schedule`
  (the table and dispatcher pattern exist; wire the cron caller into catalog-jobs), an
  entertainment-news research tool once an external search integration is configured, and
  content publishing as its own tool once the owner confirms the post-creation RPC surface.
