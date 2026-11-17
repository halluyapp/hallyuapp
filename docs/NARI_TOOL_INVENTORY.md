# Nari tool inventory

Source: `supabase/functions/_shared/operator/tools.ts`, handlers registry.

**24 implemented handlers** (not a claim of end-to-end verification).

- `member.get`
- `member.status`
- `conversation.context`
- `message.reply`
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

The gateway applies schema, permission, rate-limit and approval checks. Runtime backend tests for every handler remain outstanding.

Stage 3 gateway hardening (tracked worker source, not yet deployed): member/public tasks are restricted to conversational context/replies and research reads; member profile reads are bound to their own conversation participant. Private operations, analytics, moderation, publication and campaigns require the admin channel. Conversation reads/replies reject model-supplied foreign conversation IDs. Configured publication approvals are enforced. `research.save` requires an HTTPS source and stores unverified evidence rather than claiming a fact was verified.
