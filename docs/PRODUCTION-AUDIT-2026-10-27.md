# Hallyu production audit — 2026-10-27

## Executive status

**Do not treat this audit as a production sign-off.** The repository has substantial automated coverage and its offline gates pass, but the latest live backend verification on GitHub is **red**, and the Supabase account connected to this audit does not expose the documented production project. I therefore could not independently confirm the production database, Auth, Storage, Edge Functions, scheduled jobs, current customer data, or live app behavior. No production project was modified and no migration was run.

The immediate task is to restore verified access to the exact production project and investigate the failing connected workflow before calling the backend healthy. Do not point migrations at one of the other visible projects just because it is accessible.

## Scope and evidence

- Repository snapshot audited: `6b5fd9a2280bc10140b9f9dd9e09bf8d462eac0c` (the branch started at this commit).
- GitHub repository: `halluyapp/hallyuapp`; default branch `main`.
- GitHub workflow state was inspected on 2026-10-27. Run IDs and conclusions below are observations at audit time, not a promise that a still-running job has completed.
- Supabase project inventory was read through the connected Supabase account. No production query, write, migration, deployment, key retrieval, or secret change was performed.
- Local dependency install was kept out of Git. `node_modules` and the web export are ignored build outputs.

## What is in place

- Expo / React Native + TypeScript application with web/PWA and Android build/release workflows.
- A Supabase client and auth integration, local-mode fallback, backend connection gate, server catalog paths, client API modules, and an extensive typed database contract.
- **57 ordered SQL migrations** (`00`–`56`), seed data, and **8 Edge Function entry points** (plus shared function modules).
- Repository checks for SQL parsing/security invariants, typed DB surface, migrations applied to real PostgreSQL in CI, function-body validation, behavior checks, product regression tests, secret scanning, and platform build checks.
- GitHub Pages deployment run **40475673778** completed successfully for the audited `main` SHA. This proves the workflow completed; it does not independently prove every end-user route or the remote backend is healthy.

## Findings — ordered by risk

### P1 — Live backend verification is failing on the current `main` build

GitHub Actions run **40475673507** (2026-10-27, SHA `6b5fd9a`) reports:

- Offline validation: **success**.
- Rork Auth job: **success**, with the actual Rork suite skipped because its optional credentials were not configured for that run.
- Migration/sync job: **success**, but its “Mask the database URL” step was skipped. Therefore the run did **not** establish that a privileged database connection actually applied migrations; the workflow can use its schema-sync fallback when `SUPABASE_DB_URL` is absent.
- Connected backend job: **failure** at “Run the live backend suite”. Its pre-release verification step was skipped.

The preceding run **40387943774** on 2026-10-26 completed successfully, including its connected and pre-release steps. The current failure is a regression in the observed CI result, but the exact failing assertions are **not established here**: the hosted log download returned an EOF in this environment. Retrieve the failing job log/summary in GitHub Actions before changing production or attributing a cause.

### P1 — Current Android build did not publish a replacement release

APK workflow **40475673413** completed with **failure** at 09:00 UTC. All build, signing, emulator, device-to-backend, account-cleanup, and artifact-upload steps passed. GitHub Release publication failed, and the subsequent Supabase CDN/manifest publish step was skipped. The release-step error itself was unavailable in this audit environment, so its cause is unknown. The prior published APK has not been shown to be affected, but the current run did not verify/publish a replacement. Inspect the failed release step and retry publication only after confirming the already-uploaded artifacts and release target.


### P1 — Production Supabase project is not visible to the connected Supabase account

Repository documentation identifies production as ref `kzxlbscfkixnswurpkzb`. The connected Supabase project inventory returned three different refs — `jhgpehhmtvuedcycfxtv`, `fuxhgqttqezfkfoqgjid`, and `mmhvwnorstyiwypvxrha` — and each was marked `INACTIVE`. None matches the documented production ref.

This means this audit cannot verify production health, schema drift, RLS behavior, Edge Function deployments, Storage policies, Auth settings, cron activity, or the safety of account deletion/media cleanup. It does **not**, by itself, prove the production project is down: the account may simply lack access or the recorded ref may be stale. Confirm the exact live project through the service owner before any privileged operation.

### P1 — Rights / platform-policy review is required for full-length playback and downloads

The app exposes playback and download flows through `app/watch/*` and the `moviebox` Edge Function.
That function proxies full-length MP4 media from third-party hosts, and a test fixture described as a
live provider response names the source `Web CDN (https://123moviesfree.club)` (`scripts/test-watch.mjs`).
The repository does not contain evidence of content licences, provider authorization, a takedown
process, or a legal/platform-policy review. This audit cannot determine the rights status of any
specific title, but this is a material launch/distribution risk: obtain documented rights and provider
terms before offering the feature broadly; if rights cannot be demonstrated, disable playback and
download endpoints until they can.

There is also a concrete link-security concern in `supabase/functions/moviebox/index.ts`: a signed-in
user can receive a reusable encrypted bearer URL with a **four-hour** expiry; the GET proxy accepts
that token without a user session, and this code shows no per-user binding or rate limit. Anyone who
obtains the URL can use it until it expires, including for download. Review whether that lifetime is
necessary, shorten it, bind token claims to a user where the player permits, and add abuse/bandwidth
controls. These are code-level observations, not proof of a known exploit or upstream rights status.

### P2 — Operational documentation contains stale, conflicting state

Fixed in this audit branch:

- `docs/BACKEND.md` said the backend was “not connected,” listed 40 migrations, and omitted newer function entry points. It now states the configured backend/local fallback model, records the current migration/function counts, and links to this dated audit.
- `RORK-CREDENTIALS.md` pointed to the obsolete repository `macaulay-spec/grok-hallyu`. It now names `halluyapp/hallyuapp` and cautions that an inventory is not proof of live credentials.
- `docs/HALLYU.md` described the backend as unattached and exclusively device-local; that architecture note now reflects the backend-configured path and local fallback.

The older `docs/RORK-CLOUD-CONNECTION-REPORT.md` is a historical implementation report, not a current health check. Its claims about schema, migrations, cron, credentials, and prior live verification must be revalidated against the actual production project; do not use its historical counts or check results as present-day evidence.

## Verification run during this audit

| Check | Result | What it proves / does not prove |
| --- | --- | --- |
| `npm run check` | **PASS** (exit 0) | TypeScript, lint, and the configured offline regression/security/contract test sequence passed. One catalog/live-Supabase test explicitly skipped because `SUPABASE_URL` / `SUPABASE_ANON_KEY` were not in the local environment. |
| `npm run build` | **PASS** (exit 0) | A local Expo web production export completed. This is not a deployment or runtime test against production. |
| Current GitHub offline validation | **PASS** | CI’s PostgreSQL migration replay, behavior checks, function-body checks, and repository gates completed for the audited SHA. |
| Current GitHub connected verification | **FAIL** | A live suite ran and failed; detailed assertions/logs were not available here. |
| Current GitHub web deploy | **PASS** | Deployment workflow completed successfully for the audited SHA. |
| Current GitHub APK release | **FAIL** (run `40475673413`) | Build, emulator/backend verification, and artifact uploads passed; GitHub Release publication failed and the CDN/manifest publish step was skipped. |
| Supabase production health/schema | **NOT VERIFIED** | The connected account did not list the documented project. |

The local command `npm run check` is not a substitute for `npm run test:db-exec` or the credentialed CI live suite. The hosted offline job separately ran the PostgreSQL-backed checks and passed.

## Safe next steps

1. **Confirm project identity/access.** Have the production owner verify whether `kzxlbscfkixnswurpkzb` is still the production Supabase project, whether it is active, and grant the authorized audit/operations account read access. Do not substitute one of the three unrelated visible refs.
2. **Inspect the exact failing CI step.** Download the log for run `40475673507`; record each failure and whether it is caused by project drift, fixture/data assumptions, permissions, or a transient service issue. The fact that the previous run passed makes this comparison especially important.
3. **Establish a protected migration path.** Verify the `SUPABASE_DB_URL` secret is present and targets the confirmed production ref. Review the migration diff, backup/restore readiness, and expected lock/impact before running any migration. Do not “fix” this by running all migrations manually against an unconfirmed project.
4. **Rerun the connected suite after the cause is corrected.** Require both the live backend suite and pre-release/privacy suite to pass; explicitly verify Auth, RLS/isolation, media permissions, notifications, account deletion, and scheduled jobs in the intended production project.
5. **Resolve the APK publication failure.** Inspect the failed GitHub Release step in run `40475673413`; confirm the uploaded APK artifacts and intended release/tag before retrying. Re-run or complete the CDN/manifest verification, and do not claim a new Android release until publication succeeds.
6. **Reconcile operational documents and owner handoff.** Once project access and live evidence are available, update the historical connection report, credential inventory, and runbook with verified dates/statuses—not inferred secret values.

## Safety boundary

This pass changed documentation only. It did not edit application logic, migrations, secrets, GitHub settings, production data, or any Supabase project. That is intentional: with the live project identity unresolved and a failing backend gate, an unverified production change would carry unacceptable risk for an app already in distribution.
