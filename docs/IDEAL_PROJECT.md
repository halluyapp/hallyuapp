# IDEAL project — implementation evidence

## Status: foundation stage partially implemented

This is not a completion or deployment certificate. Stages 1–5 in the attached implementation brief have not all been executed.

## Changes in this pass

- `supabase/functions/_shared/operator/providers.ts`: reject malformed completion messages; distinguish access denial, missing model, quota exhaustion and unsupported requests; retain deadline while consuming completion bodies; require selected model in health-check model list and explicitly label generation unverified.
- `supabase/functions/operator-worker/index.ts`: an assigned missing/disabled provider no longer silently resolves to the default provider. Unassigned tasks require an explicitly enabled default.
- `scripts/test-provider-runtime.mjs`: executable adapter contract tests with HTTP test doubles; no production mocks introduced.
- `package.json`: test:provider-runtime script.
- `docs/NARI_TOOL_INVENTORY.md` and `docs/operator/IMPLEMENTATION-PLAN.md`: reconcile handler count to 24.

## Verification

- `node --test scripts/test-provider-runtime.mjs`: PASS, 5 nested contract tests (6 reported including parent).
- `npm run test:operator`: PASS, static assertions only; does not verify actual tool execution.
- `npm run typecheck`: PASS; existing tsconfig excludes Edge Functions. Runtime tests transpile the provider adapter but are not a full Deno type check.
- `git diff --check`: PASS.
- Dependency installation required `--legacy-peer-deps` because the existing React dependency ranges conflict; no lockfile changed.
- No migrations created or applied. No functions deployed in this pass.

## Production evidence (read-only connector inspection)

Existing project confirmed against repository backend URL: `ltyymanoidagwsapgiql`.

- `operator-worker`: ACTIVE, version 11.
- `operator-admin`: ACTIVE, version 4.
- `operator-voice`: ACTIVE, version 2, missing source in checkout. The source retrieval returned a truncated bundle, so it has NOT been reconstructed from incomplete output.
- Provider rows: APINEX default `gpt-6-luna`, health `billing_error`; Coarena enabled `gpt-6-luna`, health `available`. These are stored database states, not fresh generation results.
- Visible deployed voice code attempts multiple Gemini endpoints/models and invokes the worker with a service-role bearer token, while the checked-in worker expects a Vault worker token. This discrepancy needs reconciliation before voice deployment. The truncated response prevents a full deployed-source audit.

## Completion matrix

| Area | Status | Evidence / gap |
|---|---|---|
| Adapter validation and model-aware probes | Implemented but not production-verified | Contract tests pass; real generation not run |
| Assigned-provider fail-closed behavior | Implemented but not production-verified | Worker source repaired; no deployed queue test |
| Model availability | Not verified | Stored health is insufficient; sandbox outbound allowlist excludes provider hosts |
| APINEX credit availability | External account blocker indicated | Stored billing_error; account owner must verify credit/billing status |
| Budget concurrency, worker leases, idempotency, RLS | Not fully audited or verified | Existing implementation remains; acceptance tests outstanding |
| Voice | Not completed | Deployed endpoint exists; tracked source absent; source retrieval truncated |
| Memory/knowledge, campaigns, multi-agent, final integration | Not completed | Later stages not executed in this pass |
| Deployment and full end-to-end acceptance | Not completed | No deployment claimed |

Supabase connector access is available; lack of Supabase access is NOT a blocker. Remaining implementation work must not be described as an external blocker. Do not switch the active provider or consume another credit pool as a billing workaround without an explicit policy decision.


## Stage 2 update (supersedes initial voice-source/deployment gaps above)

Tracked voice backend, bounded input validation, authenticated message-bound synthesis, editable transcript workflow, local spoken-response preference, chunked playback controls, and voice usage reservation migration are now implemented. See [NARI_VOICE.md](NARI_VOICE.md) for architecture, complete changed-file list, tests and release gates.

Migration `operator_voice_limits` was applied to the existing Supabase project through the connector; catalog verification confirmed RLS and privileged reservation grants. No new function/client deployment occurred. Model env vars are absent; existing voice secret exists. A coordinated contract migration is required because old clients use free-text synthesis/voice_turn whereas the new safer client uses transcription plus the ordinary DM send and message-bound synthesis.

Status: voice-note/speech code **Implemented but not production-verified**; missing explicit account-verified model choices **Blocked by external account configuration**; live two-way voice **Not implemented**. Actual recording/playback and PostgreSQL concurrency tests remain unverified implementation work, not permission blockers. Stage 1 also remains only partially complete.


## Stage 3 release update (supersedes earlier intelligence deployment status)

See [NARI_INTELLIGENCE.md](NARI_INTELLIGENCE.md) for the current architecture, precise evidence,
release source hashes and remaining acceptance gates.

- Implemented and deployed: owner-only opt-in preference lifecycle, expiry/deletion, admin
  knowledge/source editing and revision browser, versioned constitution loading, task-bound
  relevant retrieval, transient source-preserving extractive recaps, explicit context limits,
  channel/tool/approval boundaries, and distinct research publication/event dates and uncertainty.
- Migrations **96–99** are applied to the existing Supabase project. Existing user data and the
  active `2026.11.3` constitution are preserved. New sourced knowledge covers feature status,
  community rules, roles, event/announcement evidence and operational/release limitations.
- Settings client is deployed READY at **https://hallyuapp.vercel.app** from source `ad4bb1e`.
  Worker source `b6bf635` is deployed and boot-verified. Voice contract-v2 source is deployed;
  voice device/model acceptance is not inferred from deployment.
- Actual live authenticated tests passed identity provisioning, cross-user memory isolation,
  correction/deletion, unauthorized knowledge refusal, admin knowledge revision/conflict behavior
  and ordinary-DM worker context/constitution loading. Temporary fixture cleanup passed and the
  temporary acceptance endpoint was deleted.
- The actual configured APINEX / GPT-6 Luna generation attempt returned **billing_error**.
  No fallback provider or alternate credit pool was used. Successful reasoning/factuality
  acceptance is **Blocked by external billing/account state**, not marked complete.
- Explicit live browser workflow `44045085580` failed with **Invalid API key** from its configured
  Supabase admin request. Its repository `SUPABASE_SERVICE_ROLE_KEY` secret needs administrator
  repair through secure GitHub settings. The available GitHub integration cannot administer
  repository secrets. Browser UI acceptance is not counted as passed.
- Intelligence suite: **24 tests reported**, provider contracts: **6**, voice contracts: **10**.
  These include parent counts and HTTP doubles; see the evidence document for limits. Full static/
  type/regression check, Deno checks, SQL/type contracts and lint pass (one existing lint warning).
- Bounded live factuality cases are implemented for saved recall, sourced features, unsupported
  statistics and injection/refusal; model execution of them remains billing-blocked.

No arbitrary free-text personal memory or unbounded recall is advertised. Summarization is
bounded, source-preserving, transient and scoped to the authorized conversation. Physical
Android/voice verification and full-duplex voice remain prior-stage gaps; stages 4–5 have not
been represented as complete. Do not advance past the unresolved acceptance gates by relabelling
failed or blocked tests as successes.

## Current update — Stage 4 started (2026-11-17)

This update supersedes the older billing-blocked/browser-unverified statements
above: Coarena/gpt-6-luna reasoning and deployed memory/knowledge UI acceptance
have passed (see NARI_TEST_REPORT). At the user's direction work has advanced to
Stage 4; earlier device/full-duplex voice gaps remain explicit, not relabelled.

Stage 4 now includes a deployed independent admin campaign **draft planner** with
server authorization, objective/description, UTC instants/IANA timezone, optimistic
versioning, cancellation and audit. Live database checks and deployed browser
create/reload/edit/cancel acceptance passed. Launches, recurring actions, reminders,
full approval execution, specialist delegation and full tool coverage remain open.

Email signup no longer requests a confirmation redirect or routes users to a
verification waiting room. Production already has auto-confirm enabled; ordinary
signup's immediate confirmed session was checked by the deployed fixture. Password
recovery remains intact. Source, deployment and test IDs: NARI_TEST_REPORT.md.

## Stage5 integration handover (2026-11-17)

Current authoritative integration map: [NARI_ARCHITECTURE.md](NARI_ARCHITECTURE.md).
Release/source versions, configuration names and rollback:
[NARI_DEPLOYMENT.md](NARI_DEPLOYMENT.md). Completion matrix and real acceptance
boundaries: [NARI_TEST_REPORT.md](NARI_TEST_REPORT.md), Stage5 section. Exact
Firebase requirements: [NARI_FCM_SETUP.md](NARI_FCM_SETUP.md).

Priority fixes implemented: DM history overload compatibility, array/envelope
parsing, realtime-independent refresh and Retry, outbound delivery verification,
visible approval notices, authoritative admin identity resolution, independent
campaign navigation, Nari-only inbox name and portrait/verification display.
Existing app/project/data/admins were preserved.

Stage5 is **not fully accepted**: real STT still returns empty text, full voice
and physical Android/notification receipt remain unproven, APINEX has a billing
block, and live full-duplex voice is not implemented. A successful build or
configured flag does not override those results.
