# Nari tool inventory

Source: `supabase/functions/_shared/operator/tools.ts`, handlers registry.

**27 implemented handlers** (not a claim of end-to-end verification).

- `member.get`
- `member.status`
- `conversation.context`
- `message.reply`
- `post.edit`
- `campaign.schedule`
- `moderation.flag`
- `post.create`
- `post.publish`
- `post.delete`
- `comment.reply`
- `poll.create`
- `notification.send`
- `moderation.queue`
- `moderation.rules`
- `moderation.remove_content`
- `moderation.suspend`
- `moderation.ban`
- `moderation.restore`
- `analytics.platform`
- `research.search`
- `research.web`
- `research.save`
- `campaign.create`
- `ops.task_list`
- `ops.task_retry`
- `ops.health`

The gateway applies schema, permission, rate-limit and approval checks. All 27 handlers have exact-registry/schema gateway acceptance with mocked transport; this is not real-backend proof for every handler. See the evidence below.

Stage 3/4 gateway hardening (deployed worker version 18): member/public tasks are restricted to conversational context/replies and research reads; member profile reads are bound to their own conversation participant. Private operations, analytics, moderation, publication and campaigns require the admin channel. Conversation reads/replies reject model-supplied foreign conversation IDs. Configured publication approvals are enforced. `research.save` requires an HTTPS source and stores unverified evidence rather than claiming a fact was verified.


## Stage 4 audited release — 2026-11-17

Migrations 104–108 applied to existing project. Worker 18 loads immutable commit
`3e4267693a74d555844977e402bb76f87d765ce8`, SHA256
`9cf05f66516a2fb6fc800fbc82bb8ccd89bef8acb42dc12cb98346d2bffa0a2a`.
The deployed registry has 27 enabled tools; eleven high-impact actions require
exact, expiring, one-use approval. Atomic SQL executes and consumes the grant in
one transaction; target snapshots and active admin permissions are revalidated.
The internal consume function is revoked; high-impact consumption also requires
the transaction-local executor guard. Limiter/audit failure refuses execution.
RPCs have bounded timeouts; a lost response is an unknown outcome, not proof of rollback.

Real-schema rollback acceptance passed for all ten non-notification atomic
branches: post.create/publish/edit/delete, poll.create, moderation.remove_content/
restore/suspend/ban, campaign.schedule. Notification SQL independently passed
recipient preference, block, cap, quiet-hour and duplicate tests. Worker 18
campaign.schedule passed with two future occurrences, zero provider calls and
zero claims on replay; all fixtures removed. These are not blanket real-provider
end-to-end tests of every read/research/reply/operations tool.

### Explicitly unavailable, disabled aliases (21)

post.draft, post.search, post.inspect, comment.list, world.balance,
moderation.hide, moderation.recommend, research.read_page, research.images,
memory.save, memory.search, memory.update, memory.delete, campaign.list,
campaign.update, campaign.publish, campaign.close, schedule.list,
schedule.create, schedule.update, ops.cancel_task.

These were previously advertised without matching handlers. Migration 107
disables them without deleting history; gateway tests assert every alias fails
closed. They are **not implemented**, not successful no-ops. Independent staff
campaign management uses authenticated RPCs, not these nonexistent tool aliases.

## Follow-up: all enabled tools now have real-backend coverage

See NARI_TEST_REPORT.md “Stage 4 verification gap closure” for the per-tool matrix.
Sixteen non-approval tools passed the real shared gateway with live registry,
PostgREST/RPC/external Wikipedia, result checks and persisted audits (ledger
44246f08-f673-4502-8ed2-19695161d685, request740); fixtures cleaned. All eleven
high-impact tools, now including notification.send, passed the real atomic
approval/execute/consume path in a rollback-only production transaction. Migration
109 corrects timestamp consistency when publishing hidden posts. This supersedes
the earlier individual-tool backend coverage gap; it does not relabel rolled-back
public actions as committed publication or prove physical push receipt.

## Stage5 coverage boundary

Integration release does not expand the prior16 real gateway +11 transactional
atomic tests into27 full gateway E2Es. Public/destructive rollback verification
remains distinct from committed public changes. Admin controls and the independent
campaign planner are mapped in NARI_ARCHITECTURE.md. Delivery checks and visible
approval notices are documented in NARI_OPERATIONS.md.
