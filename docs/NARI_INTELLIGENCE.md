# Stage 3 — Intelligence implementation and release evidence

## Current status (2026-11-17)

**Implemented and deployed; live backend isolation/lifecycle acceptance passed. Successful model
reasoning remains blocked by a confirmed APINEX `billing_error`.** This is not a certificate that
all five IDEAL stages or every live acceptance criterion are complete. Stage 4 has not started.

## Memory lifecycle

Settings → **Nari memory** (`app/settings/nari-memory.tsx`) provides explicit opt-in storage of
language (`en/ko/zh/ja`), favorite genre (eight choices), and spoiler preference (`avoid/allow`).
The server derives the owner from the authenticated identity and requires an active account;
clients cannot supply another profile ID. A unique owner/key record supports atomic correction,
deduplication and deletion. Saving renews a 90-day expiry. Retrieval excludes expired values
immediately; the daily `operator-memory-retention` job at 03:17 UTC removes expired preferences.
Audits record keys and actors, not private values. The UI displays stored values and expiry.

This deliberately constrained memory contract cannot accept passwords, arbitrary free-text
personal details, addresses or health records. No silent fact extraction or cross-user semantic
memory exists. Existing legacy memories are preserved but excluded from automatic prompts.
Private preferences enter only the owner's private Nari conversation, never public replies.
Conversation history and temporary task state remain separate from durable preferences and
organizational knowledge. Deleting a preference does not purport to delete DM history.

General free-text semantic recall and permanently stored generated summaries are not supported.
The implemented context strategy uses scoped history plus transient extractive summarization;
it does not claim unbounded or invented recall.

## Constitution, knowledge and authorization

Settings → **Nari knowledge & policy** is shown only to admin/CEO users. Its server RPCs require
actual administrator authorization, regardless of UI visibility. Editors can create, correct,
deactivate and classify entries as public/staff; set HTTPS sources and tags; and inspect the
latest 20 immutable revisions. Optimistic version checks reject stale writes.

Constitution publication preserves immutable versions and atomically activates exactly one.
The existing active constitution `2026.11.3` was preserved. The worker loads it from the database
for each task, with its version label. Missing/oversized constitution or failed knowledge
retrieval stops the task rather than silently discarding policy. Immutable security instructions
remain above editable policy. Retrieved evidence is untrusted user-role data, never system
instructions. Knowledge cannot grant permissions or override approvals.

Task-bound lexical knowledge retrieval rejects zero-relevance matches and derives visibility
from durable conversation/task state and the requester's current role/account status. Public
entries describe real features, tone, safe preferences and community standards. Sourced staff
entries cover role boundaries, campaigns/events/announcements evidence requirements and release/
operations limitations. Static knowledge explicitly does not invent an active campaign, event,
announcement, deployment, bug resolution or model health. Existing human-maintained bodies were
not overwritten. New entries and their baseline revisions were added by migration 99.

`context.loaded` audits record channel, knowledge slugs/versions, preference count and constitution
loading, not raw prompts or private preference values. Live acceptance confirmed this path ran
for an ordinary authenticated member DM before its provider rejected generation for billing.

## Context and reasoning limits

The authorized conversation loader requests at most 60 messages. The latest 14 are individual
excerpts, capped at 2,000 characters each and marked when truncated. Up to five relevant older
quotations form a deterministic chronological **extractive recap**, with direction/timestamp.
It is labelled incomplete/untrusted and is never persisted. Corrections remain quoted evidence,
not inferred new permanent facts. Unrelated older messages do not enter the recap.

`APINEX_CONTEXT_BYTE_LIMIT` and `COARENA_CONTEXT_BYTE_LIMIT` default to 32,000 UTF-8 JSON bytes,
including schemas and conservative overhead. These are not claims of exact model token windows.
Pruning retains instructions, explicit retrieved preference/knowledge evidence and the current
task; expendable older history goes first. Tool calls/results and JSON documents are not cut in
half. Oversized mandatory state and provider context failures fail non-retryably.

Member/public requests receive channel-permitted tool schemas. Actual tool execution separately
checks channel, bound conversation/profile, autonomy and approvals. Administrator tasks retain
approval-requiring schemas so requests can be escalated instead of silently executed. Publication
obeys registry flags, configured tool/permission approval lists and `require_approval_for_publish`.

## Research provenance

Authorized catalog search and the fixed Wikipedia search endpoint retain source references.
External snippets are untrusted evidence, not instructions or verified current news. Unknown
publication and event dates are explicitly unknown. `research.save` requires an HTTPS source,
validates supplied ISO dates, stores publication and event dates separately, records retrieval
time and uncertainty, and always saves `unverified` regardless of a model's claimed confidence.
Storage success is never represented as factual verification. Current approval policy still
applies before publication. This is not an unrestricted URL crawler or comprehensive news feed.

## Deployed artifacts and migrations

Existing Supabase project: `ltyymanoidagwsapgiql`; no new backend/project or data reset.

- Migration 95: voice reservation limits (earlier stage, preserved).
- Migrations 96–97: owner-only preferences, scoped context, knowledge/version/constitution controls,
  expiry job and legacy knowledge isolation — applied.
- Migration 98: atomic task-ID-specific claiming and release-verification ledger — applied and
  tested with real PostgreSQL/PGlite. Members cannot execute claims or write release ledgers.
- Migration 99: distinct research dates/uncertainty and sourced knowledge coverage — applied.

Connector migration responses returned null versions. Reconcile migration history before any bulk
CLI push; do not reapply CREATE TABLE statements blindly.

Client source `ad4bb1e8d53585f28ed4f75f6066e9fe75b5f799` is deployed READY/PROMOTED to
**https://hallyuapp.vercel.app**, deployment `dpl_3BY9rjHtGmf6hTTfzCtJmiC4k7mw` in the existing project.
The new memory, knowledge and revision-history UI is included. Later commits changed backend/tests,
not that client UI.

Worker source is pinned to `b6bf6352b2616e074bae4754fdf265a57fbf25c4`, bundle SHA-256
`a886956e1e790c1578376e06485aa5b48b4988e5494014f22fca4104aaf86180`.
Voice source is pinned to `ad4bb1e8d53585f28ed4f75f6066e9fe75b5f799`, bundle SHA-256
`89a4bbfa3a75ac77344fba704a80a9ca498fa5a1ab6bae1c13bec0cecec907aa`.
The client only enables new voice controls when the endpoint reports `contract_version: 2`.
Voice generation/device acceptance is not established by this Stage 3 release.

Deployment transport caveat: this connector's static remote-import entrypoint failed to boot.
The active entrypoints instead fetch the exact public GitHub API bundle at cold start, require
an exact SHA-256 match, then execute that reviewed self-contained bundle. There are no dynamic
user URLs, branch tracking or secret-bearing source files. Missing/altered source fails closed.
Reproduce these entrypoints with `scripts/operator-release-entrypoint.mjs`.
This introduces a GitHub cold-start availability/rate-limit dependency. A conventional direct
Supabase CLI bundle deployment is preferable when deployment credentials are available. Do not
remove digest checks or substitute an unpinned branch URL. The first failed import release was
replaced, not reported as a successful runtime deployment.

The updated worker also returned HTTP 200 with `claimed: 0` in a targeted no-work probe
(request 690). This verifies startup/worker auth, not generation, and did not claim unrelated work.

## Actual live acceptance

Release ledger: `operator_acceptance_run`, run `b46b7b61-0dfd-4e27-b4fd-e6ea1418aa98`.
Temporary verifier source is in `supabase/functions/operator-acceptance/index.ts`; its deployed
endpoint was removed after testing. No credentials were returned or committed.

Passed using two real temporary Supabase auth identities and ordinary signed-in RPCs:

- Authentication → actual `register_profile` → correct profile identity.
- Owner memory persistence and cross-user isolation.
- Correction/deduplication and deletion.
- Member refusal for knowledge edits.
- Admin-only fixture knowledge creation, update, stale-version conflict and two revisions.
- Active versioned constitution loading.
- Ordinary DM → durable task → deployed worker context loading, with one saved preference.
- Fixture cleanup: no fixture auth users or fixture knowledge remained; existing members and
  their content were not removed.

The configured APINEX `gpt-6-luna` call failed with **`billing_error`**. No provider was switched,
no second credit pool was used and no generated answer was fabricated. The ledger's `finished`
state means the verifier finished, not that every product acceptance criterion passed.

Two earlier verifier runs failed because their fixture setup assumed profile creation on auth
insert. The verifier was corrected to the app's actual separate `register_profile` flow. Their
cleanup passed. These failed setup attempts remain visible in the ledger.

## Evaluation and automated tests

- Full `npm run check`: pass after migration 99 (static/type/regression gates).
- Intelligence suite: **24 reported tests**, including PostgreSQL parent and evaluation checks.
- Provider contract suite: **6 reported tests**; voice contract suite: **10 reported tests**.
  Transport doubles test contracts, not account availability.
- PostgreSQL/PGlite tests execute migrations 96–99 with a minimal existing-schema fixture and
  exercise isolation, lifecycle, relevance, conflicts, grants, atomic activation, targeted claims
  and research provenance. They are not the entire production schema or a concurrency load test.
- Runtime tests cover lower-trust evidence, recap relevance, explicit evidence retention,
  mandatory context failure, bound tool refusals, approval checks and distinct source dates.
- `evaluation.ts` defines bounded live cases for saved recall, sourced product facts, unsupported
  statistics and injection/refusal. The verifier can run these after a successful baseline DM;
  actual model cases remain billing-blocked. Lexical graders are regression signals, not proof
  that a model can never hallucinate.
- App TypeScript, Deno worker/voice/verifier, SQL/type contracts, lint and bundle generation pass.
  Lint retains one pre-existing moviebox unused-constant warning.

The opt-in deployed browser test is `scripts/ci/nari-browser-acceptance.mjs`, dispatched through
`deploy-web.yml` with `run_live_browser_test=true` on this branch. It tests 360×800 sign-in,
preference persistence/correction/deletion, member editor refusal and fixture-admin revision UI.
Live workflow run `44045085580` failed with the annotation **Invalid API key** while making
its configured Supabase admin request. The job uses the repository's
`SUPABASE_SERVICE_ROLE_KEY`; no successful browser sign-in or UI assertions are claimed.
The GitHub integration returned 403 for repository-secret administration earlier in this session;
no secret values were retrieved or logged to repair this configuration.

## Remaining acceptance gates / recovery

1. Account owner must resolve APINEX billing/credit rejection for the configured model. Then rerun
   the bounded ordinary-DM and factuality cases. Do not change provider/model as a workaround.
2. A repository administrator must replace the invalid/unusable `SUPABASE_SERVICE_ROLE_KEY`
   Actions secret for this same Supabase project, through GitHub's secure repository settings.
   Then dispatch `deploy-web.yml` on this branch with `deploy_public_site=false` and
   `run_live_browser_test=true`. Do not paste privileged keys into chat. The test follows actual
   UI sign-in/profile provisioning and cleans only its temporary fixture.
3. Physical Android recording/playback and full-duplex voice remain separate Stage 2 gaps.

Rollback preserves preference and revision rows. Revert to reviewed privacy-preserving artifacts
or disable controls; never restore broad unscoped private retrieval, drop user tables or reset
production to make a test pass.

## Provider switch and authentication verification — 2026-11-17

- Explicit production default: **Coarena / gpt-6-luna**. APINEX is nondefault
  after billing errors; no automatic cross-provider fallback was introduced.
  Two earlier real worker acceptance runs completed replies and recalled the
  fixture's saved genre. This is evidence of generation, not a reliability guarantee.
- Latest backend run `36cbe159-c651-4c35-9257-caa6ab09218b` finished with
  identity, memory lifecycle/cross-user isolation, knowledge revisions/conflicts,
  constitution and deployed-context checks passing, but live reasoning was blocked
  by `bad_response` (HTTP 200 with an invalid completion/tool response).
  Consequently the full reasoning acceptance suite is **not passed**.
- Worker v16 fixes reply deduplication against the real tool ledger column
  `outcome='succeeded'`. The temporary acceptance endpoint was removed after
  testing; fixture cleanup passed.
- Browser run `44047730941` successfully authenticated and cleaned up its fixture,
  but memory settings fetched before session restoration and did not retry.
  Commit `2f0c6d9` waits for signed-in auth, reloads on identity changes, and
  discards stale async results after identity change/unmount. Typecheck and lint
  passed (lint warnings only). Browser verification of this fix remains pending.
- The invalid GitHub service-role secret was **not rotated** (secret-management
  access was denied). The browser fixture no longer depends on that secret:
  it uses narrowly scoped, short-lived GitHub OIDC. Do not describe the obsolete
  stored key itself as repaired or usable by other workflows.
- Frontend deployment `dpl_CaYcKt5rdFzjGEZ1hNEtBmW67BWt` was requested for
  `2f0c6d9`; last observed state QUEUED, not verified/promoted.

Stage 3 remains incomplete pending full live reasoning and browser acceptance.
Stages 4–5 are not claimed complete.

### Final switch acceptance — 2026-11-17 (supersedes pending entries above)

- Frontend `dpl_CaYcKt5rdFzjGEZ1hNEtBmW67BWt` is **READY / PROMOTED**,
  serving `2f0c6d9` at https://hallyuapp.vercel.app.
- GitHub run **44050027798**, commit `ee4b331`: **Explicit Nari deployed UI
  acceptance PASS**, fixture cleanup PASS, full static/type/SQL/runtime gate PASS.
  Real 360×800 browser checked email sign-in, memory save/reload/correct/delete,
  member rejection from knowledge editing, admin save and revision rendering.
  The overall workflow failed later during Pages export; it is not a green deployment run.
- Backend run **c8a3ca17-6491-47bc-a3d8-7ae93ebd47b1**, pg_net response **712**:
  HTTP 200, actual Coarena/gpt-6-luna worker completed; saved preference reply
  was `thriller`. All four reasoning evaluations passed: saved preference,
  sourced features, unsupported statistics, retrieval injection. Identity,
  cross-user memory isolation, correction/deletion, knowledge access/revisions/
  conflict checks, active constitution, loaded context, fixture cleanup passed.
- Earlier two v16 malformed-response failures remain valid reliability findings;
  a later passing acceptance run does not establish an error-free upstream SLA.
  Provider validation remains fail-closed; no fallback or invented replies added.
- Temporary `operator-acceptance` endpoint removed after the successful run.
- Local `npm run check` passed; local Expo Pages-path export and HTML enhancement
  also passed. CI Pages export failure is not reproduced locally and is unresolved.

This closes the model-switch/browser-key-dependency acceptance work. It does not
claim full five-stage delivery: live voice/device acceptance, full-duplex voice,
and the remaining Stage 4–5 work are not completed by this change.
