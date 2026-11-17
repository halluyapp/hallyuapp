# Stage 3 — Intelligence implementation evidence

## Status

**Core implementation tested locally; database safeguards deployed; worker/client not deployed.** This is not a claim that Stage 3 live acceptance or the whole IDEAL project is complete.

## Audit findings and repairs

1. Existing `operator_conversation_context` included member memories regardless of channel, unscoped admin memories from all executives, and global/operational memory. Expiry was not applied uniformly. Replaced with owner-bound explicitly saved preference retrieval, including expiry checks. Public threads receive no private memory. Unreviewed legacy memories are preserved in storage but never automatically injected.
2. The worker placed memory and knowledge in system-role instructions, and said database constitution could override everything below. Immutable identity/privacy/approval rules now take precedence; retrieved evidence is a separate user-role data block. Prompt text is not a security boundary: gateway checks enforce member/public tool restrictions and conversation/profile ownership independently.
3. Whole-question ILIKE usually returned unrelated score-zero knowledge. Task-bound lexical retrieval now matches individual literal terms, excludes score-zero results and derives staff/public visibility from durable task/channel/current-role data. Existing knowledge is staff-only by default; only `platform-overview` and `tone-guide` were explicitly marked public. No existing knowledge bodies or constitution were overwritten.
4. Model-supplied conversation IDs could redirect `message.reply`; profile/context fallback could use an unbound input identity. Reads and replies now require the task's bound conversation, member profile reads are owner-bound, and worker context mismatches fail closed. Executive requests also recheck current admin/CEO role and active account state.
5. `research.save` accepted a model's verification claim and returned `verified:true` simply because insertion succeeded. It now requires an HTTPS source, stores `unverified`, and reports storage success separately from factual verification. Wikipedia search returns source URLs, retrieval time, unknown publication/event dates and an explicit snippet limitation. It is not a comprehensive news crawler and does not verify that an event occurred.
6. Provider input accumulated without a whole-request limit and tool-result JSON was sliced mid-document. Added conservative UTF-8 byte-budget accounting including schemas/overhead, lossless JSON serialization, explicit omission notices and permanent context-limit failures rather than repeated credit-consuming retries. Model-provided tool-call lists are matched to the bounded executed subset.
7. Publication now obeys both registry approval flags, configured tool/permission approval lists, and `require_approval_for_publish`, rather than merely describing them in a prompt.

## Memory lifecycle and UI

Settings → **Nari memory** (`app/settings/nari-memory.tsx`).

- Explicit opt-in only; no automatic private fact extraction.
- Allowed preference keys/values: reply language (`en`, `ko`, `zh`, `ja`); favorite genre (enumerated choices); spoiler preference (`avoid`, `allow`). Free-text secrets, addresses, health facts or arbitrary personal details cannot be stored through this API.
- Owner derived by `current_profile_id`, not a submitted profile ID. Requires an active account.
- One record per owner/key using the existing unique index. Saving corrects the value atomically and renews the 90-day expiry.
- UI displays current values and expiry, supports correction and individual deletion, and distinguishes no saved preference from retrieval failure.
- Daily `operator-memory-retention`, schedule `17 3 * * *`, deletes expired explicitly saved preferences. Retrieval excludes expired records immediately even before cleanup.
- Memory mutation audits contain the key and actor, not the private value.
- Deleting a preference does **not** delete conversation history. Conversation history has separate existing storage/retention behavior.
- General free-text semantic memory and persisted long-conversation summaries are **not implemented**. This bounded preference memory is an intentional safe subset, not a claim of arbitrary long-term recall.

## Organizational knowledge and constitution

Settings → **Nari knowledge & constitution** (`app/settings/nari-knowledge.tsx`), shown to admin/CEO only. Server RPCs independently require `is_admin() IS TRUE`; hidden controls are not authorization.

- Create/edit/deactivate knowledge with title, body, search tags, HTTPS source, and public/staff visibility.
- Optimistic expected-version check prevents lost updates. Full snapshots in `operator_knowledge_revision` preserve versions, sources and editors; baseline existing entries were snapshotted. Revision history is in the database; a dedicated revision-history browsing UI is not implemented.
- Current constitution can be loaded for editing, then activated under a new unique version. A transaction advisory lock and unique active index ensure one active version. Duplicate version activation rolls back, preserving the previous active version.
- Worker reads the active constitution at task time; the RPC includes the active version in returned prompt text. No build required to edit content. Missing/oversized constitution or knowledge retrieval failure stops work rather than silently dropping policy.
- `context.loaded` audit records knowledge slugs/versions, channel and preference count, not private values or raw prompts.
- Publication/permission rules cannot be granted by knowledge or constitution text.
- Existing production fact bodies were preserved, not re-certified as current. Admin review of feature/operations entries remains necessary; no invented capabilities were seeded.

### Context limits

`APINEX_CONTEXT_BYTE_LIMIT` and `COARENA_CONTEXT_BYTE_LIMIT` are optional server-only byte ceilings, default 32000. These are conservative byte limits, **not provider-tokenizer measurements or verified model context-window sizes**. Provider context errors are separately classified as permanent `context_limit_exceeded` failures.

Latest 14 messages are considered; each excerpt is bounded and explicitly marked if cut. Whole-request limiting preserves immutable system instructions and the current task, discards older evidence/history when necessary, and never cuts a tool exchange or JSON document in half. No generated summary is invented. If mandatory content/tool state cannot fit, the task fails honestly. Knowledge evidence includes source/version/update time and an excerpt-truncated indicator.

## Deployment evidence

Project: existing `ltyymanoidagwsapgiql`. Connector migration calls succeeded:

- `operator_intelligence` → repository migration **96**.
- `operator_knowledge_legacy_isolation` → repository migration **97**.

The connector returned null migration versions, so none are invented here. Local timestamp filenames and connector history must be reconciled before a bulk CLI migration push. Do not blindly reapply CREATE TABLE statements.

Production read checks confirmed:
- anonymous memory RPC EXECUTE: false;
- authenticated self-memory RPC EXECUTE: true;
- authenticated conversation-context and task-knowledge EXECUTE: false;
- revision-table RLS: true, 7 baseline snapshots;
- one active retention cron job;
- legacy retrieval joins yielded **zero staff-only entries**, and nonsense queries yielded zero matches;
- existing active constitution **2026.11.3** preserved; version label returned by actual backend RPC;
- memory table initially contained zero records and remained empty (no production user preferences fabricated for testing).

Migration 97 protects the **currently deployed worker** too: the old unscoped knowledge search can return only public relevant entries until the new task-bound worker is released. New worker/gateway/prompt protections remain in tracked source and generated bundle; they are not claimed as deployed. No function or client was released in this pass. No Vercel changes.

## Verification results

- `npm run test:intelligence`: **PASS**, 17 substantive checks / 18 including the PostgreSQL suite parent.
  - Real PostgreSQL engine via pinned PGlite 0.5.16: migration execution, cross-user/public/executive isolation, invalid-memory rejection, correction/deduplication, expiry/deletion, legacy-memory exclusion, admin authorization, version conflicts, relevant/visibility-filtered retrieval, atomic constitution publication, grants.
  - Runtime tests: constitution loading/order, lower-trust injection placement, public defense-in-depth, long-context omission, mandatory-context failure, tool/profile/conversation refusal, publication-policy enforcement, research storage vs verification.
- Combined provider + voice + intelligence run: **34 tests passed** (including suite parents), no failures.
- `npm run typecheck`: **PASS**.
- `npx deno check` for worker and voice: **PASS**.
- `npm run test:sql`: **PASS**, 90 migrations parsed (not a full deployment of all historical migrations).
- `npm run test:db-types`: **PASS** after updating new table/column contracts (including Stage 2 voice ledger drift).
- `npm run test:backend-surface`, `npm run test:signatures`, `npm run test:operator`, `npm run test:secrets`: **PASS**.
- `npm run lint`: **PASS**, zero errors; one existing unused-constant warning in `lib/api/moviebox.ts`.
- `npm run build`: **PASS**, Expo web export.
- `git diff --check`: **PASS**.

PGlite tests use a minimal existing-schema fixture and a test identity resolver, not production JWTs, the entire historical schema or simultaneous production workers. Injection tests verify assembly and actual permission refusals; they do not prove that an LLM never hallucinates or follows a malicious instruction. Real provider conversations, model-based factuality evaluations, full-role UI testing, physical Android and production task execution remain unverified.

## Files changed in Stage 3

- `supabase/migrations/20261124000000_96_operator_intelligence.sql`
- `supabase/migrations/20261124000001_97_operator_knowledge_legacy_isolation.sql`
- `supabase/functions/_shared/operator/context.ts`
- `supabase/functions/_shared/operator/prompt.ts`
- `supabase/functions/_shared/operator/providers.ts` (context-error classification)
- `supabase/functions/_shared/operator/tools.ts`
- `supabase/functions/operator-worker/index.ts`
- `supabase/functions/_bundles/operator-worker.js` (regenerated)
- `supabase/types/database.ts`
- `lib/api/intelligence.ts`
- `app/settings/nari-memory.tsx`
- `app/settings/nari-knowledge.tsx`
- `app/settings/index.tsx`
- `scripts/test-intelligence-db.mjs`
- `scripts/test-intelligence-runtime.mjs`
- `scripts/test-provider-runtime.mjs`
- `package.json`, `bun.lock` (pinned test dependency, regression commands)
- `docs/NARI_INTELLIGENCE.md`, `docs/IDEAL_PROJECT.md`, `docs/NARI_TOOL_INVENTORY.md`

## Completion matrix and remaining release gates

| Capability | Status |
|---|---|
| Preference lifecycle, isolation, revision/constitution transactions | Complete and tested locally; production schema/grants verified |
| New worker prompt/context pipeline and gateway restrictions | Implemented but not production-verified/deployed |
| Member memory and admin knowledge/settings UI | Implemented and web-build tested; not deployed or interaction-tested |
| Research source preservation and honest verification status | Implemented and runtime-tested; external Wikipedia/provider path unverified |
| Live reasoning uses new memory/knowledge correctly | Not production-verified |
| General free-text semantic memory, generated historical summaries, model factuality evaluation suite | Not implemented |

No missing Supabase permission prevented this stage. Remaining worker/client release and live verification are unfinished release work, not fabricated external blockers. Prior provider billing/account verification and voice-model configuration remain unresolved from earlier stages.

Release prerequisites: reconcile applied migration history; review/deploy the generated worker and matching settings client through the existing pipeline; verify a permitted saved preference in a real conversation, a separate user's isolation, public-thread exclusion, updated knowledge/constitution selection and context-failure behavior. Do not silently switch reasoning providers to make tests pass. Stage 4 must retain these scope/approval gates while auditing tools, queues, scheduling and campaigns.

Rollback: preserve user memory and knowledge revision rows. Roll back reviewed worker/client artifacts only if they retain the privacy guards; do not restore broad unscoped context queries. Disable the new UI if needed instead of dropping tables, resetting production or deleting user data.

## Stage 3 closure work — continuation (not a production sign-off)

The following supersedes the earlier local implementation gaps, but **does not** change the
production deployment status above:

- Admin knowledge settings now expose the latest 20 immutable revisions, including source URL,
  visibility, timestamp and body. Reads use the existing admin-only revision RLS.
- Context loading requests at most 60 messages from the authorized conversation. The latest 14
  remain individual excerpts. Up to five relevant older quotations form a deterministic,
  chronological **extractive recap**, labelled incomplete/untrusted and never persisted. It does
  not claim semantic summarization or recall beyond that bounded window. Corrections remain
  quotations rather than being turned into inferred permanent preferences.
- Context pruning retains the explicitly saved preference/knowledge evidence block and drops
  expendable older history first. Oversized mandatory evidence still fails closed.
- Member/public tasks receive only tool schemas permitted for their channel; execution checks
  remain in place. Admin tasks retain approval-required schemas so approval requests still work.
- Worker wake requests can target one queued task atomically instead of accidentally claiming
  unrelated work. This depends on **migration 98, not yet applied**. Deploying that worker before
  applying the migration is unsafe.
- Voice status adds `contract_version: 2`; the matching client only enables the new controls for
  that contract, avoiding requests against an older deployed voice endpoint.
- A temporary `operator-acceptance` release-verifier source and service-only run ledger were
  prepared. **Neither is deployed or executed.** The verifier creates isolated test users, tests
  ordinary member RPCs, and attempts a real configured-provider DM. It must receive further live
  schema/cleanup review before deployment. It does not constitute evidence of provider success.
  The verifier promotes only a newly created fixture user, restores that fixture role, and
  attempts fixture-only cleanup in `finally`; it must never be pointed at existing member IDs.

Verification after these changes:

- TypeScript app check and Deno worker/verifier checks: pass.
- Intelligence suite: **20 passing** (including relevant recap quotations and evidence retention).
- Provider contract suite: **6 passing**, voice contract suite: **10 passing**, using HTTP doubles.
- SQL static checks: **91 migrations / 431 functions**, pass.
- Database type contracts: **83 tables**, pass. Backend surface check: pass.
- Lint: zero errors; existing moviebox unused-variable warning remains. Bundles regenerated;
  `git diff --check` passes.

Still open: deploy reviewed worker/client safely, apply/test migration 98, exercise the actual
signed-in UI and real model, and resolve the broader free-text-memory/factuality-evaluation
requirements. Stage 4 has **not** started. Local tests are not production acceptance evidence.
