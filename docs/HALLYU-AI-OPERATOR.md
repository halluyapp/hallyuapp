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

## The model: Gemini first, Rork AI Cloud as the fallback

`metadata.json` declares `MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API`, so the operator runs on that
Gemini capability:

```bash
supabase secrets set GEMINI_API_KEY=<server-side Gemini key>   # then redeploy the function
```

- Provider `gemini` — Google Generative Language `generateContent` (`gemini-2.5-flash` by default,
  override with `GEMINI_MODEL`). Key names accepted: `GEMINI_API_KEY`,
  `GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY`.
- Provider `rork` — the **Rork Toolkit gateway** (`TOOLKIT_URL`, default `https://toolkit.rork.com`,
  path `/v2/vercel/v1/chat/completions`) with `RORK_TOOLKIT_SECRET_KEY`; default model
  `anthropic/claude-sonnet-5` (override with `RORK_AI_MODEL`). Used only when no Gemini key exists.
- Provider `none` — every action answers 503 naming both secrets. The panel prints that verbatim.

`{"action":"ping"}` reports which provider is live (`provider`, `model`, `model_configured`), so a
misconfigured deployment is visible before anyone asks it a question.

## To activate (one-time, after the migration applies)

```bash
supabase db push                                          # applies migration 67
supabase secrets set GEMINI_API_KEY=<server-side Gemini key>   # see the section above
supabase functions deploy hallyu-ai-operator              # the model adapter lives in the function
supabase functions deploy auth-broker                    # also fixes web sign-in (see docs/WEB-AUTH-CONNECTION-FIX.md)
```

Deploying the web bundle does **not** update the edge function, and redeploying the function does
**not** update the web bundle: the Admin Command Centre shows the AI panel only after the web/APK
build that contains it ships (`deploy-web.yml` / `build-apk.yml`).

The adapter speaks the OpenAI chat-completions protocol against the Rork AI Cloud gateway, so the
model can be swapped with the `RORK_AI_MODEL` secret — no code changes.

## What ships now vs. next

- **Now:** real agent loop, real tools, approval workflow, full audit trail, admin panel, chat
  for every signed-in member (non-staff get a member-safe tool set).
- **Next stages (extensible by design):** scheduled intelligence jobs via `hallyu_ai_schedule`
  (the table and dispatcher pattern exist; wire the cron caller into catalog-jobs), an
  entertainment-news research tool once an external search integration is configured, and
  content publishing as its own tool once the owner confirms the post-creation RPC surface.
