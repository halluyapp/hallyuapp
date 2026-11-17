# Nari operations — Stage 4

## Independent campaign planner

Settings → Campaign planner (admin/CEO) is independent of reasoning providers and
Nari's enabled state. `operator_campaign_save` is an authenticated RPC: it requires
an active administrator, applies server-side length/kind/date/timezone validation,
locks the current record and checks an expected version before updating it.

The planner currently supports **draft creation/editing and cancellation only**.
Descriptions, objectives, event/poll/vote planning categories, start/end instants
and an IANA display timezone are persisted. A category is not a created poll.
Dates entered with an explicit UTC offset are normalized to UTC; a timezone name
does not silently reinterpret a wall-clock input. Cancelled drafts are read-only.
The list shows at most the 100 most recently updated records.

Every successful create/update records the actor, campaign, status and version in
`operator_audit`. Stale edits fail with `40001`: refresh and explicitly select the
latest campaign before editing again. Missing records fail rather than re-create.

**No announcement, vote, reminder or public launch happens on save.** The UI does
not expose nonfunctional launch buttons. Existing launched campaigns are read-only
in this draft editor. Full scheduled/active/completed lifecycle execution remains
Stage 4 work; do not label planning dates as executed scheduled jobs.

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
