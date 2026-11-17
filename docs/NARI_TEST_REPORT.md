# Nari verification report

## 2026-11-17 — explicit provider switch and browser authentication

**Complete and tested for this change**

- Coarena / `gpt-6-luna` is the explicit default; APINEX is nondefault.
- Real deployed worker: saved preference recalled; sourced feature answers,
  unsupported-statistics refusal and injection resistance all passed in backend
  acceptance `c8a3ca17-6491-47bc-a3d8-7ae93ebd47b1` (HTTP response 712).
- Scoped memory lifecycle/isolation, knowledge permissions/version conflicts,
  constitution loading and fixture cleanup passed in that run.
- Browser acceptance step in GitHub run `44050027798` passed against production:
  real sign-in, memory persistence/correction/deletion, admin-only knowledge UI,
  revision history, temporary fixture cleanup.
- Local `npm run check`, Expo web export using `/hallyuapp`, HTML enhancement,
  and whitespace validation passed.
- Frontend deployment `dpl_CaYcKt5rdFzjGEZ1hNEtBmW67BWt`: READY / PROMOTED.

**Limitations and unresolved findings**

- Two earlier real Coarena runs failed `bad_response`; strict validation remains
  enabled. Passing the final run is not proof of continuous provider reliability.
- GitHub workflow `44050027798` failed after its passing browser and full static
  gates, during Pages export. Overall workflow is not claimed successful.
- Invalid GitHub service-role secret was not rotated: secret-management access
  was denied. This browser test instead uses narrowly scoped GitHub OIDC and
  does not require that stored key. Other consumers are not claimed repaired.
- Voice live/device acceptance and full five-stage implementation remain outside
  the verified completion of this switch. Stages 4–5 are not complete.

Detailed chronology: [NARI_INTELLIGENCE.md](NARI_INTELLIGENCE.md).

## 2026-11-17 — Stage 4 campaign planner and no-link email signup

- Source deployed: `ba5ee10e1e657135b1fea082aa734815dba72297`.
- Frontend `dpl_GouRP1rcQ8D3HRJttEKAXuPRcm1c`: **READY / PROMOTED**
  at https://hallyuapp.vercel.app.
- Migration 100 applied on existing Supabase project. Rollback-only live SQL checks
  passed for active-admin authorization, member/suspended denial, optimistic edit
  conflicts, timezone/offset preservation, invalid/reversed dates, cancellation
  immutability, launch rejection and audit records. Anonymous EXECUTE denied.
- Local `npm run check` and Expo web export passed. Campaign client tests cover
  explicit offsets, RPC version/field contracts, server error propagation and
  refusal to claim a save without a returned persisted record. Static auth
  regressions verify removal of the link-request/waiting-room signup branch.
- GitHub **44054068762**, **Explicit Nari deployed UI acceptance: PASS**;
  **Clean temporary Nari UI fixture: PASS**. This was an ordinary `/auth/v1/signup`
  with no admin `email_confirm` shortcut: immediate access token and confirmed
  user required. Browser checked real password sign-in, memory lifecycle,
  member knowledge/campaign denial, admin knowledge revisions, campaign draft
  create/reload/edit/cancel. Full workflow was still running when these results
  were recorded; do not infer an overall workflow pass from its browser step.
- Backend cleanup check: UI fixture state finished/cleanup pass, zero remaining
  `nari-ui-%` campaign records and zero transactional `cmp_%` fixture profiles.
- Fixture v3 uses scoped OIDC and cleans campaigns only when the creation audit
  identifies its own fixture actor and the record has the generated run name.

Email confirmation is disabled in production (`mailer_autoconfirm=true`), matching
the requested behavior. Password reset links remain intentionally supported.
Campaign launches/automation/delegation are not claimed implemented by this tranche.
See [NARI_OPERATIONS.md](NARI_OPERATIONS.md) for remaining Stage 4 gates.

## 2026-11-17 — Stage 4 exact-action approvals

- Migrations **101–102 applied**. Worker **v17 deployed** from `f0a43fb`.
- Frontend deployment **dpl_9zEWpapXYh1P9FhfY1VAe8NCdRzw** READY/PROMOTED.
- Full local `npm run check` passed, including four new approval test cases.
  `test-approvals-db.mjs` executes the actual forward migrations in an isolated
  PostgreSQL/PGlite dependency harness: active-admin decision, member/service-only
  denial, expired/rejected proposals, cross-task/action/argument mismatch,
  revoked approver, disabled tool, missing/stale lease, and racing consumption
  calls (only one succeeds). This is not a production-availability test.
- Gateway runtime tests use explicit HTTP/RPC doubles for permission/schema checks,
  consume-before-write, failed/throwing consumption refusal and mandatory approval
  for high-impact tools. Worker regression checks exact replay without a model call.
- Real deployed probe **9af7cfa3-8068-4c9b-9648-1f33c33f403d**:
  approval decision → worker replay → **one real draft** → completed tool/task.
  The grant was consumed; provider usage count for this task was **0**.
  Repeat delivery (pg_net **727**) claimed **0**, so no second draft was created.
  pg_net **726** contains the successful worker result. Probe **725** previously
  failed closed because live task state was executing, repaired by migration 102.
- Probe cleanup removed the isolated campaign, task/approval and fixture profile.
  No existing account was elevated, no public content posted, no notification sent.
- GitHub run **44070130069**: **Explicit Nari deployed UI acceptance PASS**,
  fixture cleanup PASS. New checks cover member denial/admin approval-queue rendering,
  not approve/reject clicks against real proposals. Backend cleanup verified zero
  remaining probe profiles/tasks/campaigns and no authenticated execute privilege on
  grant consumption. The broader workflow was still running when recorded; do not
  infer an overall workflow pass from its targeted browser steps.

Exact-argument/lease enforcement is complete for the tested draft workflow.
Do not extrapolate to every high-impact handler's target-content/version safety,
transactional side effects or all campaign/scheduling/delegation acceptance gates.

### Independent campaign announcements — local checkpoint

- `npm run check`: PASS after scheduler implementation and database type updates;
  two pre-existing lint warnings remain (memory hook dependency, moviebox constant).
- `node --test scripts/test-campaign-schedule-db.mjs`: PASS, exact migration 103
  functions executed in isolated PGlite PostgreSQL with narrow dependency fixtures.
  Covers admin denial, member RLS read denial, malformed timezone, stale campaign
  version, immutable idempotent replay/content mismatch, cancellation permission
  and repeat cancellation, one persisted exact-body post, repeat sweep no-op,
  role/campaign revocation, >24h missed run, publication-audit failure rollback,
  and direct client insert/sweep privilege denial. A PostgreSQL calendar-expression
  test verifies the DST offset change, not full production DST scheduling.
- `npm run typecheck`: PASS; new scheduler component integrated into campaign editor.
- Not claimed: production migration/deployment, browser acceptance of the new
  controls, multi-connection locking proof, full real post-trigger integration,
  notification preference/quiet-hour/cap acceptance, or complete Stage 4.


### Scheduler production migration / transactional acceptance

- Applied `campaign_announcements_103` to existing project `ltyymanoidagwsapgiql`;
  verified table exists and `hallyu-campaign-announcements` cron is active alongside
  unchanged operator/memory jobs.
- Real-schema rollback-only acceptance: **PASS** for profile identity, exact
  schedule/replay, idempotent cancellation, actual post triggers/readback, no second
  post on repeat sweep, completed lifecycle and client insert/sweep ACL denial.
  An explicit exception rolls back the entire fixture subtransaction; post/profile/
  campaign/occurrence absence asserted afterward. Final occurrence count: **0**.
- The rollback test is not committed public publication or proof of external push
  delivery. No member announcements were published. UI/browser release evidence
  and two-connection concurrency acceptance are not yet recorded here.
