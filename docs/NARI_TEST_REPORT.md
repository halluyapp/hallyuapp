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


Scheduler release follow-up:
- Real `authenticated` role boundary test: PASS for admin save/schedule/history,
  member RLS read denial, schedule denial and sweep execute denial. Rollback-only;
  fixture absence verified.
- Production overlapping schedule requests on backends `762871` and `762873`
  started `11:17:31.734843Z` / `11:17:33.484109Z` (first held its transaction three
  seconds). Results: `duplicate:false` / `duplicate:true`. Verified one occurrence,
  one campaign version increment and one approval audit. Deleted only fixture
  campaign `c6974c4c-1856-49a2-aa96-0206a7c09220` and fixture profile
  `7416b252-43d2-4ee0-9b02-a83b024085e1`; remaining fixture counts zero, no posts.
  This verifies concurrent schedule creation, not every sweep/cancel race.
- Cron run history: consecutive minute runs succeeded (11:16–11:18 UTC).
- Frontend `dpl_94dEmqg7km41ZLAth1h8PEq2bTZL`, commit `6119a37`:
  READY/PROMOTED at `hallyuapp.vercel.app`.
- Browser run `44072729921` failed because it loaded the old production bundle
  before deployment promotion (old planner text, missing schedule field); fixture
  cleanup PASS. Fresh run after confirmed promotion
  `44073107108`: targeted deployed UI acceptance **PASS**, cleanup **PASS**. Covers
  weekly two-occurrence exact-text review/approval, reload-persisted history and
  cancellation of both future occurrences, plus prior member/admin regressions.
  Backend ledger `b73438e5-c12f-486b-b208-976f53d841d6`: finished, cleanup pass;
  remaining fixture profiles/campaigns/actions **0**. No public posts were created
  by browser tests. The broader workflow was still running at this checkpoint;
  these targeted results do not assert its overall outcome. Do not count the
  first old-bundle browser attempt as a scheduler UI pass.


## Stage 4 integrated release evidence — 2026-11-17

- `npm run check`: PASS after final changes (`/tmp/stage4-final-check.log`);
  Stage4 suite **34 passed**, including all 27 schema/gateway tools, all 21
  disabled aliases, atomic approvals, ballot/scheduler SQL, specialist bounds and
  delivery claim revalidation. Transport is mocked in the 27-tool gateway suite;
  local PostgreSQL tests use PGlite with explicit schema fixtures.
- Existing Supabase project: migrations 104–108 successfully applied.
- `scripts/ci/stage4-transactional-acceptance.sql`: real-schema rollback PASS:
  monthly ballot identity/privacy/vote update/replay/closure/report; admin status;
  stale-target refusal and single-use exact approval; notification opt-out/block/
  cap/dedup/quiet hours. Fixtures rolled back and absence asserted.
- `scripts/ci/stage4-atomic-actions-acceptance.sql`: production rollback PASS for
  ten atomic approved action branches; final deleted post, suspended+banned
  fixture member and two scheduled occurrences verified, all rolled back.
- Worker 18 deployment ACTIVE, immutable 3e42676 bundle digest recorded in inventory.
  Real provider acceptance `dcd767cb-0369-4844-a9a5-cc364cb555d3`: completed operations
  specialist and orchestrator, Coarena/gpt-6-luna, two successful usage records
  (2500 + 4206 tokens), validated depth-one draft, zero tool calls. No fallback.
  Isolated task/profile deleted, audit/usage retained; ledger cleanup PASS.
- Atomic replay acceptance `b6f45cb3-81af-4dce-b9c3-8e08e84f1389`: pg_net 732/733,
  HTTP200, campaign.schedule completed with two future occurrences, consumed
  grant, zero provider calls; second wake claimed zero. Only fixtures deleted,
  ledger cleanup PASS. Explicit authenticated wake was used for deterministic
  acceptance; this alone is not proof of every automatic dispatch path.
- Vercel `dpl_EZ6kv14espy1KApMTRobUjzuhpw5`: READY/PROMOTED 3e42676.
- GitHub browser run **44077058310** against production: targeted Nari deployed UI
  step PASS; fixture cleanup step PASS. Includes member denial of live status,
  monthly-ballot exact launch review (not publication), persisted aggregate report,
  cancellation and real admin status, plus prior approval/scheduler regressions.
  Overall broader workflow was still running when these targeted results were read.

### Remaining verification / unavailable scope

Not a blanket Stage4 completion certificate: real-backend end-to-end acceptance
for each of the 27 individual tools, physical-device external push delivery, and
all race/failure combinations are not established. The 21 retired aliases are
explicitly not implemented. Draft-only specialists do not independently execute
tools. Stage5 remains pending. No production public test announcement or push was
sent by the tests above; rollback tests do not establish external delivery.

## Stage 4 verification gap closure — 2026-11-17, follow-up

**All 27 enabled tools now have real-backend positive-path coverage**, at the
layers specified below. This supersedes the earlier statement that real-backend
coverage was outstanding for individual tools. It is still not a claim that all
27 were driven by a language model, or that destructive public actions were
committed merely to test them.

### Live gateway, no mocked transport (16/16 PASS)

Reserved ledger `44246f08-f673-4502-8ed2-19695161d685`, pg_net request **740**,
HTTP200 `ok:true`. Temporary verifier executed the actual shared `executeTool`
and `recordToolCall`, live registry/schema/limiter, PostgREST and RPC paths.
Each case checked malformed-JSON refusal, successful result and persisted audit;
writes were independently queried before cleanup. Wikipedia returned actual
HTTPS source results, not canned network content.

| Tools | Positive-path evidence |
|---|---|
| member.get, member.status | exact isolated profile ID returned |
| conversation.context | bound conversation RPC returned context |
| message.reply | persisted outbound message with exact test body |
| comment.reply | persisted exact-body reply on hidden fixture post |
| moderation.flag | persisted case targeting fixture post |
| moderation.queue, moderation.rules | actual backend RPC/policy data |
| analytics.platform | actual production analytics RPC result |
| research.search | actual catalog query result array |
| research.web | nonempty live Wikipedia results with HTTPS source URLs |
| research.save | persisted item read back as unverified |
| campaign.create | persisted draft campaign readback |
| ops.task_list | actual task query result array |
| ops.task_retry | failed fixture requeued, verified, then immediately cancelled |
| ops.health | actual providers/workers and observation timestamp |

All isolated profile/conversation/tasks/hidden post/comments/messages/research/
campaign/moderation fixtures removed. Absence asserted, ledger cleanup **PASS**.
No public fixture post was created and no notification went to a real member.
Verifier endpoint was **deleted successfully** after acceptance. Reproducible
fixture/cleanup procedure: `scripts/ci/stage4-live-tool-fixtures.sql`; verifier
source: `supabase/functions/operator-acceptance/stage4-tools.ts`. It requires a
short-lived reserved ledger and Vault worker authentication; never expose tokens.

### Real atomic approved writes (11/11 PASS, rolled back)

Updated `scripts/ci/stage4-atomic-actions-acceptance.sql` passed on production:
post.create, post.publish, post.edit, post.delete, poll.create,
moderation.remove_content, moderation.restore, moderation.suspend,
moderation.ban, notification.send, campaign.schedule. Each used an actual pending
proposal, authenticated admin decision, execution lease, atomic executor and
consumed-grant assertion. Verified mutation results and final state, then rolled
back **all** effects, including transactional wake requests.

The stronger publication test exercises **hidden → active**, not a no-op active
row. It exposed the need to clear hidden/deleted timestamps. Applied safe forward
migration **109**, then production acceptance PASS. The local regression asserts
the old implementation violates the state constraint without consuming approval,
the patched implementation publishes and clears timestamps, and replay refuses.
The eleven tools also have gateway/schema tests; destructive/public success is
verified transactionally, not committed public publication. Earlier worker18
campaign.schedule live gateway/replay acceptance still applies.

### Push: precise remaining external prerequisites

pg_net **741** called the deployed push-dispatch with service authentication,
`verify_fcm:true` and `reload_secrets:true`. HTTP200, claimed/sent/failed/invalid
all **0**; Web Push configured **true**; FCM configured **false** and OAuth verified
**false**. Database count of active registered devices: **0**. No fake token or
simulated receipt was used, and no test notification was sent.

Therefore server-side dispatch/no-work path is tested; **physical-device receipt
is blocked**, not passed. To finish that check, a user must sign in on a real
device, open Settings → Notifications and enable/register notifications. Web Push
can use the already configured VAPID path (iPhone: add to Home Screen first).
Native FCM additionally requires a valid Firebase service-account JSON configured
server-side as `FCM_SERVICE_ACCOUNT_JSON` (or existing protected build-vault key
`fcm_service_account_json`); do not paste it into chat or commit it. No credentials
were invented or rotated. A targeted notification to that consenting test user
must then be checked on the physical device; provider acceptance alone is not
receipt proof.

Final local validation: `npm run check` **PASS**, Stage4 **34/34 PASS**, including
new hidden-publication regression (`/tmp/s4-gap-full-check.log`). Existing lint
warnings remain warnings, not errors. No frontend/worker redeployment is needed
for the verifier-only code; migration109 is already applied in production.

## Stage5 integration release evidence (2026-11-17)

**Final acceptance is not complete.** This matrix separates verified behavior
from outstanding acceptance instead of treating deployment as feature proof.

| Area | Status | Evidence / boundary |
|---|---|---|
| Legacy/new DM history, visible persisted staff text | Complete and tested | Authenticated production smoke: legacy2arg and paginated3arg calls PASS; migration110 applied |
| Campaign authorization | Complete and tested | Real member denied403, same fixture promoted server-side receives campaigns; custom CEO account not tested |
| Avatar/profile installation | Complete and tested | Source hash verified, Storage installed, profile named Nari; bundled fallback and authoritative verification fetch added |
| Refreshed inbox/thread appearance | Implemented but not production-verified | Typecheck passes; latest inbox profile-fetch refinement awaits pipeline deployment |
| Worker delivery/recovery and approval notices | Implemented but not production-verified | Local gates pass; completion now requires sent outbound message; new real browser scenario must pass |
| Tool backend operations | Complete and tested | 16 live gateway tools plus11 atomic transactional rollback mutations; not27 live gateway E2Es |
| Specialist delegation | Complete and tested | Prior real ledger dcd767cb-0369-4844-a9a5-cc364cb555d3 and replay b6f45cb3-81af-4dce-b9c3-8e08e84f1389 |
| Dedicated Gemini TTS generation | Complete and tested | Repeated real WAV results; not proof of physical speaker playback |
| STT / full voice workflow | Implemented but not production-verified | Model returned empty text; endpoint422 no_speech_detected; ledger0644c866-4577-46a2-ad60-9feb0540fd0a |
| Live full-duplex voice | Not implemented | UI/status do not claim availability |
| APINEX success/recovery with funded account | Blocked by external credentials/access | Real billing_error; no silent fallback |
| Physical FCM notification receipt | Blocked by external credentials/access | No Firebase service account/registered device; prior dispatch741 devices0/sent0 |
| Custom CEO login / physical Android / microphone performance | Implemented but not production-verified | Standard auth/admin fixtures do not establish these workflows |
| Production web release8752e59 | Complete and tested | Vercel dpl_GRcPM4anjmH3Q1ce14C3YRiWJiFS READY, production alias assigned; build result only |

Smoke request753's fixture was cleaned successfully. Temporary production
`operator-acceptance` function deleted after collecting results. No real member
messages were used for these isolated probes. Admin roles were not weakened.

Final full local `npm run check` PASS (`/tmp/nari-final-check.log`), including11
voice contracts. Latest inbox-only refinement `npm run typecheck` PASS. Existing
lint warnings are not represented as new failures. Real browser workflow
44089156043 and APK workflow44089035941 were still running when this section was
written; record their actual outcomes before accepting release.

Unverified registration concurrency, Google/custom OAuth, recovery emails,
physical receipt and full voice acceptance must not be inferred from local
contracts or a promoted standard-auth fixture. The original first-admin
server-controlled protections were preserved, not reset to create a demo admin.
