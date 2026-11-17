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
