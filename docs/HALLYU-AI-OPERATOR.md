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
  • autonomous by default (approval gate optional, off unless enabled)
  • Rork AI Cloud for the model (toolkit gateway → OpenAI-compatible chat completions)
        ▼
Existing backend: get_bootstrap, posts/comments (read-only), send_admin_broadcast,
hallyu_ai_* state tables (service-role only, RLS deny-all to clients)
```

## Autonomy model

The operator is **fully autonomous by default** — no approval stops. The AI sends broadcasts and
acts on real data whenever it decides to, day or night.

- **Autonomous tools:** `platform_overview`, `community_pulse`, `member_context`, `remember`, and
  `send_broadcast` (runs immediately).
- **Optional approval gate (default off):** write one config row to re-enable it —
  `insert into hallyu_ai_memory (kind, key, value) values ('config','approval_mode','{"mode":"on"}')`.
  With the gate on, `send_broadcast` parks as `awaiting_approval` and resumes only after an admin
  or the CEO approves it in the Command Centre. Delete the row (or set `"mode":"off"`) to return
  to full autonomy.
- **Non-staff callers** never see staff tools at all — they are removed from the model's
  registry, not merely blocked at run time.

## Honesty rules implemented

- Every tool call is recorded (`hallyu_ai_tool_call`) with its real outcome, errors included.
- A task that fails is set `failed` with the real error, and the panel shows it verbatim.
- With Rork AI Cloud unreachable, every action answers 503 naming the exact missing secret —
  the panel prints exactly that instead of pretending the AI works.

## The model: Rork AI Cloud, no owner secrets needed

The model adapter calls the **Rork Toolkit gateway** (`TOOLKIT_URL`, default
`https://toolkit.rork.com`, path `/v2/vercel/v1/chat/completions`) with the **Rork toolkit secret
key** — the same credential Rork Cloud provisions on its own backends. Default model:
`anthropic/claude-sonnet-5` (override with the `RORK_AI_MODEL` function secret).

On a Rork-managed backend the toolkit envs are provisioned automatically — **nothing to set**.
On a self-owned Supabase project, copy one secret:

```bash
supabase secrets set RORK_TOOLKIT_SECRET_KEY=<Rork toolkit secret key>
```

## To activate (one-time, after the migration applies)

```bash
supabase db push                                          # applies migration 67
supabase functions deploy hallyu-ai-operator
supabase functions deploy auth-broker                    # also fixes web sign-in (see docs/WEB-AUTH-CONNECTION-FIX.md)
# no model secrets needed on a Rork-managed backend — see the section above
```

The adapter speaks the OpenAI chat-completions protocol against the Rork AI Cloud gateway, so the
model can be swapped with the `RORK_AI_MODEL` secret — no code changes.

## What ships now vs. next

- **Now:** real agent loop, real tools, approval workflow, full audit trail, admin panel, chat
  for every signed-in member (non-staff get a member-safe tool set).
- **Next stages (extensible by design):** scheduled intelligence jobs via `hallyu_ai_schedule`
  (the table and dispatcher pattern exist; wire the cron caller into catalog-jobs), an
  entertainment-news research tool once an external search integration is configured, and
  content publishing as its own tool once the owner confirms the post-creation RPC surface.
