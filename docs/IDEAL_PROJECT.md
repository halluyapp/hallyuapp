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


## Stage 3 update (supersedes initial intelligence gaps above)

See [NARI_INTELLIGENCE.md](NARI_INTELLIGENCE.md) for full changed files, architecture, migrations, evidence and release gates.

Implemented explicit opt-in preference lifecycle and settings, owner/public isolation, admin knowledge/source editing with revision conflicts/history, atomic versioned constitution activation, task-bound relevant knowledge retrieval, lower-trust evidence assembly, bounded context, conversation/profile-bound tool access, publication approval enforcement and honest sourced-research storage. General free-text semantic memory and generated historical summaries remain unimplemented.

Migrations **96–97** were successfully applied to the existing production database. Verified grants/RLS, 7 knowledge baseline revisions, the active retention cron, preserved active constitution `2026.11.3`, no legacy staff-knowledge leakage in tested queries, and zero irrelevant matches. No production user preferences were fabricated or existing constitution/knowledge bodies overwritten.

`test:intelligence`: 18 tests including parent; combined provider/voice/intelligence: 34 passed. Real PostgreSQL/PGlite lifecycle and isolation tests supplement runtime assembly/gateway tests. Typecheck, Deno check, SQL/type contracts, web build and targeted regression checks pass; lint has one existing warning.

**Worker and settings client are not deployed; no real-provider conversation acceptance is claimed.** Database safeguards are deployed, while the new prompt/gateway/context pipeline and UI remain implemented but not production-verified. No missing Supabase permission is claimed. Earlier provider/voice release gaps and unfinished foundation/operator work still apply.
