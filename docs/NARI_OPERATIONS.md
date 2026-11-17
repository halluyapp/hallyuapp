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
- Existing approval decision queues the original task, but the worker currently
  regenerates its plan and the gateway does not consume a single-use exact-action
  grant. This fails closed (approval-gated actions are requested again), not a
  completed approval execution flow. Bind action/arguments/target, add expiry,
  consume once, and revalidate current policy/state before enabling launches.
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
