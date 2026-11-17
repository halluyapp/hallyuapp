# Nari operations — Stage 4

## Independent campaign planner

Settings → Campaign planner (admin/CEO) is independent of reasoning providers and
Nari's enabled state. `operator_campaign_save` is an authenticated RPC: it requires
an active administrator, applies server-side length/kind/date/timezone validation,
locks the current record and checks an expected version before updating it.

The draft editor supports creation/editing; separate reviewed actions support exact-text recurring announcements, public ballots, completion and cancellation.
Descriptions, objectives, event/poll/vote planning categories, start/end instants
and an IANA display timezone are persisted. A category is not a created poll.
Dates entered with an explicit UTC offset are normalized to UTC; a timezone name
does not silently reinterpret a wall-clock input. Cancelled drafts are read-only.
The list shows at most the 100 most recently updated records.

Every successful create/update records the actor, campaign, status and version in
`operator_audit`. Stale edits fail with `40001`: refresh and explicitly select the
latest campaign before editing again. Missing records fail rather than re-create.

**No announcement, vote, reminder or public launch happens on save.** Existing launched campaigns are read-only in the draft editor. Use the separately reviewed launch/schedule/lifecycle controls; planning dates alone do not schedule jobs.

### Database verification

Migration `20261125000000_100_campaign_editor.sql` applied to the existing project.
`scripts/localdb/campaign-editor.sql` is a rollback-only behavioral test. Equivalent
live transactional checks passed: member denied, admin create/edit/cancel,
UTC offset preservation and IANA validation, stale version rejected, reversed dates
rejected, active/launch transition rejected, cancelled draft immutable, three
expected audit records, suspended admin denied. Test rows were rolled back.

## Email sign-up

The production auth setting `mailer_autoconfirm=true` was read and confirmed on
2026-11-17. No auth settings or email templates were overwritten. The app no longer
requests a signup email redirect or routes a new account to a verification waiting
room. It provisions the application profile and continues only after the backend
returns a real session. A missing session is an error, not simulated success.
Old `/verify` bookmarks redirect to sign-in (or home for a signed-in member).
Password-reset callbacks are preserved. Older unconfirmed accounts are not bulk
confirmed; their owners can contact support.

## Stage 4 audit and next implementation boundaries

This is a first delivery within Stage 4, not completion of the stage.

- Existing gateway has 24 handler implementations; every handler still needs a
  passing full-path implementation test and verified application-state readback.
- Approval execution now replays a stored exact tool/arguments invocation using an
  expiring, single-use grant (migrations 101–102; details below), without replanning.
  Active approver role, task lease/state, current tool enablement, gateway schema,
  channel, policy and rate limits are rechecked. Target-specific content-version
  snapshots and atomic mutation guards still need coverage before claiming all
  high-impact tool workflows complete; approving a target ID is not proof its
  content has remained unchanged.
- Existing schedules must gain timezone-aware recurrence, cancellation,
  missed-run recovery and execution history tests before claiming Stage 4 complete.
- Campaign public launches, scheduled posts, live polls/monthly voting, reminders
  and performance reports are not implemented by the independent draft editor.
- Bounded specialist delegation and its disagreement/cycle/budget tests remain.
- Existing admin state endpoints need completion and live dashboard acceptance.

Never enable broad autonomy or bypass approvals to compensate for these gaps.

### Deployed UI acceptance

Source `ba5ee10` is READY/PROMOTED in Vercel deployment
`dpl_GouRP1rcQ8D3HRJttEKAXuPRcm1c`. GitHub run `44054068762` passed its
explicit deployed browser acceptance and fixture cleanup steps. Ordinary signup
returned an immediate confirmed session without an admin confirmation override;
the browser passed member campaign denial and admin draft create/reload/edit/cancel.
Post-test database checks confirmed fixture cleanup and anonymous RPC denial.
Full local checks and Expo export passed; the broader GitHub workflow was still
running when this acceptance was recorded.

## Approval execution — 2026-11-17

Settings → Nari approvals (active admin/CEO only) lists up to 100 real records,
with proposed tool arguments/targets/content, reason, task, expiry, decision and
consumption state. Proposals are rendered as untrusted text. A review step precedes
approve/reject. The client never acquires a service-role key.

`operator_decide_approval` binds an approved task to `_approved_action_id`; only
pending, unexpired proposals attached to an awaiting task can be approved. Rejection
cancels that task. Expired decisions persist `expired` and cancel an awaiting task.
Approval resets retry attempts for the new exact invocation but grants no new tool
permission. Decision and consumption are audited.

The worker executes the stored tool/arguments directly, not a new model plan. The
gateway reruns schema, channel, policy and rate checks; then a service-only RPC
atomically checks task/action/JSON argument equality, active deciding admin, current
tool enablement, unexpired deadline, active running/executing lease, and unused
consumption marker. Only then can the handler run. Public posting/publishing,
polls, deletion, notifications and sensitive moderation always require approval,
even if the registry flag is omitted. Existing autonomy flags still restrict them.

Consumption is deliberately **at-most-once attempt**, not an exactly-once claim
across multiple network writes. A crash, timeout or partial handler failure after
consumption requires audit inspection and a fresh human-reviewed proposal. Do not
retry the old approval. Consumption does not itself mean the action completed;
inspect the tool ledger and task result. Every individual handler's target-state
readback/transactional preconditions remain part of the wider Stage 4 tool audit.

Deployed worker v17, source `f0a43fb`, digest
`45bc99076750ecc67f725ec249e48d2a4da75a04a8e8ce8d2309029e7492f36a`.
Migrations 101 and 102 applied. Migration 102 corrects the live worker's
running→executing transition and requires an unexpired lease. The initial v17
probe failed closed at consumption; after 102 the same unconsumed fixture proposal
completed and created one draft. No real post, notification or moderation action
was used for acceptance.

Live acceptance ledger `9af7cfa3-8068-4c9b-9648-1f33c33f403d` records completed exact
campaign draft, consumed grant, zero provider calls and zero claims on repeat worker
delivery. The isolated draft, task/approval and fixture profile were removed;
audit evidence and the test ledger remain. See NARI_TEST_REPORT.md for test scope.

Browser run `44070130069` passed targeted deployed UI acceptance and fixture cleanup:
member approval-queue denial and admin queue rendering, alongside the existing
memory/knowledge/campaign regressions. No real approval proposal was decided by
that browser test. Final backend checks found no remaining probe profile, task or
campaign; authenticated users cannot execute grant consumption directly.

### Stage 4 independent announcement scheduler — deployed and targeted acceptance passed

Migration `20261125000003_103_campaign_announcements.sql` adds admin-approved,
immutable per-occurrence public posts. The campaign planner now has a separate
review/approval step, once/daily/weekly recurrence, history and per-occurrence
cancellation. Publication is under the approving admin, not Nari; neither a model
nor the operator enabled switch is involved. Campaign poll/vote kinds remain
planning metadata: this does not implement ballot collection or mass reminders.

Contract: explicit-offset first instant plus named timezone; 1–31 occurrences;
90-day horizon; at most 100 pending occurrences per campaign / 500 per approver.
Recurrences preserve local calendar time (PostgreSQL standard-time preference in
DST gaps/overlaps). The minute cron catches up within 24 hours; older work is
marked missed. Series UUID retries return the existing schedule only for identical
content/approver/times; changing a proposal requires a new reviewed UUID. After an
ambiguous network result, retry the same proposal or inspect history first.

The sweep serializes itself with a transaction advisory lock and locks campaign
before occurrence, then rechecks campaign status and approver role/account status.
Post, transactional notification-trigger writes, readback, occurrence completion
and publication audit share a subtransaction. Failure rolls these back and marks
the occurrence failed; there is no automatic retry of failed occurrences. Published
posts are not deleted by cancellation. External delivery is not an exactly-once
guarantee. The existing follower notification pipeline remains in effect; full
preference/quiet-hour/cap acceptance is still a separate Stage 4 gate.

Migration 103 (`campaign_announcements_103`) is applied to the existing production
project. The independent minute cron is active. Real-schema acceptance passed in
a rollback-only transaction: authenticated-profile identity, schedule and exact
replay, repeat cancellation, real post insert/triggers/readback, repeated sweep,
completed lifecycle and client ACL. All fixture rows/posts/audits from that
transaction were rolled back; final occurrence count was zero. No test announcement
became visible to members. Production frontend `dpl_94dEmqg7km41ZLAth1h8PEq2bTZL` is READY/PROMOTED
at `https://hallyuapp.vercel.app`, commit `6119a37`. Two genuinely overlapping
schedule requests on distinct PostgreSQL backends returned new/duplicate and
persisted one occurrence, one version increment and one approval audit. The future
fixture campaign/profile/occurrence were removed without publication. Browser
run `44073107108` passed weekly exact-text approval, history persistence and
cancellation of both future occurrences, plus existing member/admin regressions.
Fixture cleanup passed and was independently checked in the backend: no fixture
profiles/campaigns/actions remain. Broader notification-policy integration,
concurrent sweep/cancel testing, polls/voting and remaining Stage 4 gates are not
completed by this release.


## Stage 4 deployed controls (104–108)

- Campaign ballots: 2–4 distinct choices, close instant, optional unique month;
  exact public-launch review, active/completed/cancelled lifecycle, real aggregate
  performance. Individual votes remain private. Existing poll/vote UI is reused.
- Notifications: explicit all/world/followers audiences, member preference and
  block checks, recipient caps, deduplication and quiet-hour deferral. Delivery
  claims recheck active account, preferences, blocks and token ownership. External
  push delivery on a physical device has not been verified by these tests.
- Settings → Nari live status: authenticated active admins only; current provider
  observations, worker timestamps, queue, approval/action counts, usage, campaigns,
  specialist activity and errors. This displays stored observations, not invented
  live-provider health probes. Refresh after an uncertain action outcome.
- Specialists: admin instruction prefix `[specialist:operations]` (or research,
  community, campaign, moderation); one draft-only pass, depth one, no tools or
  child delegation, same constitution/provider/budget/audit. Strict JSON and source
  validation; the orchestrator separately reasons over the untrusted proposal.
- Worker stops spending when budget reads or usage accounting fail; bounded
  provider timeout and task clock. Generic engine failures are nonretryable to
  avoid automatic duplicate side effects. Inspect history before manual retry.

Production release: worker 18; frontend `dpl_EZ6kv14espy1KApMTRobUjzuhpw5`
READY/PROMOTED at https://hallyuapp.vercel.app (commit 3e42676).
Unsupported aliases and evidence limits are enumerated in NARI_TOOL_INVENTORY.md.

## Verified push prerequisites and publication fix (follow-up)

Migration109 is applied: approved publication clears hidden/deleted timestamps to
preserve the post state constraint. All eleven atomic branches, including hidden
publication and notification.send, passed rollback-only production acceptance.

Deployed dispatcher probe returned HTTP200, Web Push configured, **FCM not
configured**, no queued deliveries and **zero active registered devices**. Physical
receipt remains blocked on a consenting real-device registration. Sign in on the
device and enable Settings → Notifications (iPhone Web Push requires Home Screen
installation). Native Android FCM additionally needs valid server-side
`FCM_SERVICE_ACCOUNT_JSON`, and Firebase configuration in the installed build.
Never share the private JSON in chat or source control. Send a targeted test only
to that consenting user's registered device and confirm lock-screen receipt;
HTTP200/no pending work is not delivery proof.

Temporary operator-acceptance endpoint used for the 16 live-tool checks and push
probe was deleted after fixture cleanup; it is not a permanent privileged API.
