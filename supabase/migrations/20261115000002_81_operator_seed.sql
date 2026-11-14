-- 81: Hallyu AI Operator — seed of staff identity, providers, policy, tool registry and schedules.
--
-- Idempotent: every insert is `on conflict do update/do nothing`, so re-applying is safe.

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Official staff identity
-- ─────────────────────────────────────────────────────────────────────────────
-- The member-facing AI account already exists (`hallyu.ai`). It is reused as the public identity so
-- existing member DM threads are not orphaned; the staff authorisation record is new and explicit.
do $$
declare
  v_profile uuid;
begin
  select id into v_profile from public.profiles where handle = 'hallyu.ai' limit 1;

  if v_profile is null then
    insert into public.profiles (handle, display_name, bio, role, account_status, is_ai, worlds, favorite_genres)
    values (
      'hallyu.ai', 'Hallyu AI', 'Official Hallyu AI staff account. AI-operated.',
      'member', 'active', true, '{}'::text[], '{}'::text[]
    )
    returning id into v_profile;
  else
    update public.profiles
       set is_ai = true,
           display_name = 'Hallyu AI',
           bio = 'Official Hallyu AI staff account. AI-operated.'
     where id = v_profile;
  end if;

  insert into public.operator_staff (profile_id, staff_code, display_name, is_ai, active, capabilities)
  values (
    v_profile, 'hallyu.ai', 'Hallyu AI', true, true,
    array[
      'community.reply', 'community.moderate', 'content.publish', 'content.draft',
      'notify.mass', 'notify.individual', 'research.entertainment', 'analytics.read',
      'campaign.manage', 'ops.inspect'
    ]::text[]
  )
  on conflict (staff_code) do update
    set profile_id = excluded.profile_id,
        active = true,
        capabilities = excluded.capabilities,
        updated_at = now();
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Providers — two independent rows, never merged
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.operator_provider (provider, label, model_id, base_url, enabled, is_default, rpm_limit, notes)
values
  ('apinex', 'APINEX AI', 'free/gpt-6-luna', 'https://api.apinex.bond/v1', true, true, 15,
   'GPT-6 Luna. Default day-to-day operating model. Free tier requires a daily check-in; a 402 is surfaced as billing_error and never triggers failover.'),
  ('coarena', 'Coarena', 'claude-fable-5-2', 'https://coarena.ai/api/v1', true, false, 60,
   'Claude Fable 5.2. Specialist model for complex reasoning and research. Separate credentials and separate usage pool.')
on conflict (provider) do update
  set label = excluded.label,
      base_url = excluded.base_url,
      notes = excluded.notes,
      updated_at = now();

-- Only one default may exist. If the seed above left none, promote APINEX.
update public.operator_provider set is_default = true where provider = 'apinex' and not exists (select 1 from public.operator_provider where is_default);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Policy
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.operator_policy (id, autonomy, moderation, notifications, providers)
values (
  true,
  jsonb_build_object(
    'reply_member_dm', true,
    'reply_public_mention', true,
    'research', true,
    'publish_content', true,
    'send_notifications', true,
    'moderate_explicit_sexual', true,
    'moderate_other_violations', true,
    'suspend_or_ban', true,
    'may_switch_model', false,
    'require_approval_for_publish', false
  ),
  jsonb_build_object(
    'explicit_removal_confidence', 0.85,
    'other_violation_confidence', 0.70,
    'contain_below_confidence', 0.55,
    'repeat_offence_window_days', 90,
    'suspension_days_first', 3,
    'suspension_days_second', 14,
    'ban_after_offences', 3,
    'rules_version', '2026.11'
  ),
  jsonb_build_object(
    'max_per_hour', 4,
    'max_per_day', 12,
    'quiet_hours', jsonb_build_object('start', '00:00', 'end', '07:00'),
    'dedupe_window_hours', 72
  ),
  jsonb_build_object(
    'no_cross_provider_fallback', true,
    'max_retries', 3,
    'timeout_ms', 45000,
    'daily_request_budget_apinex', 500,
    'daily_request_budget_coarena', 200
  )
)
on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Tool registry
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.operator_tool (name, description, family, input_schema, permission, read_only, approval_required, rate_limit_per_min, timeout_ms)
values
  ('member.get', 'Read a member profile and permitted public account information.',
   'member', '{"type":"object","properties":{"profile_id":{"type":"string","format":"uuid"}},"required":["profile_id"],"additionalProperties":false}',
   'member.read', true, false, 60, 5000),
  ('member.status', 'Read account status and moderation history within authorised scope.',
   'member', '{"type":"object","properties":{"profile_id":{"type":"string","format":"uuid"}},"required":["profile_id"],"additionalProperties":false}',
   'member.read', true, false, 30, 5000),
  ('conversation.context', 'Read the authorised message context for one Operator conversation.',
   'messaging', '{"type":"object","properties":{"conversation_id":{"type":"string","format":"uuid"},"limit":{"type":"integer","minimum":1,"maximum":60}},"required":["conversation_id"],"additionalProperties":false}',
   'conversation.read', true, false, 60, 5000),
  ('message.reply', 'Send a reply into the exact conversation the task belongs to.',
   'messaging', '{"type":"object","properties":{"conversation_id":{"type":"string","format":"uuid"},"body":{"type":"string","minLength":1,"maxLength":2000}},"required":["conversation_id","body"],"additionalProperties":false}',
   'message.send', false, false, 30, 10000),
  ('post.create', 'Create a community post as the Hallyu AI staff identity.',
   'content', '{"type":"object","properties":{"body":{"type":"string","minLength":1,"maxLength":4000},"title":{"type":"string","maxLength":120},"world":{"type":"string"},"type":{"type":"string","enum":["post","discussion","review","recommendation"]}},"required":["body"],"additionalProperties":false}',
   'content.write', false, false, 10, 10000),
  ('post.publish', 'Publish a draft post.',
   'content', '{"type":"object","properties":{"post_id":{"type":"string","format":"uuid"}},"required":["post_id"],"additionalProperties":false}',
   'content.write', false, false, 10, 10000),
  ('post.delete', 'Delete a post authored by the Operator.',
   'content', '{"type":"object","properties":{"post_id":{"type":"string","format":"uuid"},"reason":{"type":"string","maxLength":300}},"required":["post_id"],"additionalProperties":false}',
   'content.write', false, false, 10, 10000),
  ('comment.reply', 'Reply to a comment in its exact thread.',
   'content', '{"type":"object","properties":{"comment_id":{"type":"string","format":"uuid"},"body":{"type":"string","minLength":1,"maxLength":2000}},"required":["comment_id","body"],"additionalProperties":false}',
   'content.write', false, false, 30, 10000),
  ('poll.create', 'Create a poll attached to a post.',
   'content', '{"type":"object","properties":{"post_id":{"type":"string","format":"uuid"},"options":{"type":"array","items":{"type":"string"},"minItems":2,"maxItems":6}},"required":["post_id","options"],"additionalProperties":false}',
   'content.write', false, false, 5, 10000),
  ('notification.send', 'Send an individual or mass notification to a resolved audience.',
   'notification', '{"type":"object","properties":{"title":{"type":"string","maxLength":120},"body":{"type":"string","maxLength":500},"audience":{"type":"string","enum":["all","world","followers","members"]},"world":{"type":"string"}},"required":["title","body","audience"],"additionalProperties":false}',
   'notification.send', false, false, 4, 30000),
  ('moderation.queue', 'List open reports and flagged content.',
   'moderation', '{"type":"object","properties":{"status":{"type":"string","enum":["open","reviewing"]},"limit":{"type":"integer","minimum":1,"maximum":100}},"additionalProperties":false}',
   'moderation.read', true, false, 30, 5000),
  ('moderation.rules', 'Read the published Hallyu community rules applied to a decision.',
   'moderation', '{"type":"object","properties":{"rule_code":{"type":"string"}},"additionalProperties":false}',
   'moderation.read', true, false, 30, 5000),
  ('moderation.remove_content', 'Remove content that violates Hallyu rules.',
   'moderation', '{"type":"object","properties":{"target_type":{"type":"string","enum":["post","comment"]},"target_id":{"type":"string","format":"uuid"},"rule_code":{"type":"string"},"reason":{"type":"string","maxLength":500},"confidence":{"type":"number","minimum":0,"maximum":1}},"required":["target_type","target_id","rule_code","reason","confidence"],"additionalProperties":false}',
   'moderation.enforce', false, false, 20, 10000),
  ('moderation.suspend', 'Suspend a member for a confirmed violation.',
   'moderation', '{"type":"object","properties":{"profile_id":{"type":"string","format":"uuid"},"rule_code":{"type":"string"},"reason":{"type":"string","maxLength":500},"days":{"type":"integer","minimum":1,"maximum":365},"confidence":{"type":"number","minimum":0,"maximum":1}},"required":["profile_id","rule_code","reason","days","confidence"],"additionalProperties":false}',
   'moderation.enforce', false, false, 10, 10000),
  ('moderation.ban', 'Permanently ban a member for a confirmed, severe or repeated violation.',
   'moderation', '{"type":"object","properties":{"profile_id":{"type":"string","format":"uuid"},"rule_code":{"type":"string"},"reason":{"type":"string","maxLength":500},"confidence":{"type":"number","minimum":0,"maximum":1}},"required":["profile_id","rule_code","reason","confidence"],"additionalProperties":false}',
   'moderation.enforce', false, false, 5, 10000),
  ('moderation.restore', 'Reverse an enforcement action.',
   'moderation', '{"type":"object","properties":{"moderation_action_id":{"type":"string","format":"uuid"},"reason":{"type":"string","maxLength":500}},"required":["moderation_action_id","reason"],"additionalProperties":false}',
   'moderation.reverse', false, true, 5, 10000),
  ('analytics.platform', 'Read real platform counts and trends with definitions and date ranges.',
   'analytics', '{"type":"object","properties":{"days":{"type":"integer","minimum":1,"maximum":365}},"additionalProperties":false}',
   'analytics.read', true, false, 20, 10000),
  ('research.search', 'Search approved sources for entertainment news.',
   'research', '{"type":"object","properties":{"query":{"type":"string","minLength":2,"maxLength":200},"world":{"type":"string","enum":["kdrama","cdrama","anime","hollywood"]}},"required":["query"],"additionalProperties":false}',
   'research.read', true, false, 20, 20000),
  ('research.save', 'Store a research item with source and verification status.',
   'research', '{"type":"object","properties":{"topic":{"type":"string"},"headline":{"type":"string"},"summary":{"type":"string"},"source_name":{"type":"string"},"source_url":{"type":"string"},"verification":{"type":"string","enum":["confirmed","reported","rumour","unverified"]},"world":{"type":"string"}},"required":["topic","headline","verification"],"additionalProperties":false}',
   'research.write', false, false, 20, 10000),
  ('campaign.create', 'Create a campaign, event, poll or voting record.',
   'campaign', '{"type":"object","properties":{"name":{"type":"string"},"kind":{"type":"string","enum":["campaign","event","poll","vote"]},"starts_at":{"type":"string"},"ends_at":{"type":"string"},"payload":{"type":"object"}},"required":["name","kind"],"additionalProperties":false}',
   'campaign.write', false, false, 10, 10000),
  ('ops.task_list', 'Inspect task queue state.',
   'operations', '{"type":"object","properties":{"status":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100}},"additionalProperties":false}',
   'ops.read', true, false, 30, 5000),
  ('ops.task_retry', 'Retry a safe failed task.',
   'operations', '{"type":"object","properties":{"task_id":{"type":"string","format":"uuid"}},"required":["task_id"],"additionalProperties":false}',
   'ops.write', false, false, 10, 5000),
  ('ops.health', 'Read worker, queue and provider health.',
   'operations', '{"type":"object","properties":{},"additionalProperties":false}',
   'ops.read', true, false, 30, 5000)
on conflict (name) do update
  set description = excluded.description,
      family = excluded.family,
      input_schema = excluded.input_schema,
      permission = excluded.permission,
      read_only = excluded.read_only,
      approval_required = excluded.approval_required,
      rate_limit_per_min = excluded.rate_limit_per_min,
      timeout_ms = excluded.timeout_ms,
      updated_at = now();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Schedules
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.operator_schedule (name, task_type, interval_seconds, payload, enabled)
values
  ('queue_sweep', 'queue_sweep', 60, '{}'::jsonb, true),
  ('engagement_report', 'analytics_report', 86400, '{"days":1}'::jsonb, true),
  ('entertainment_digest', 'research_digest', 43200, '{"worlds":["kdrama","cdrama","anime","hollywood"]}'::jsonb, true),
  ('moderation_sweep', 'moderation_sweep', 900, '{}'::jsonb, true)
on conflict (name) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Baseline audit entry
-- ─────────────────────────────────────────────────────────────────────────────
insert into public.operator_audit (actor_type, action, outcome, resource_type, details)
select 'system', 'operator.install', 'succeeded', 'schema',
       jsonb_build_object('migration', '79-81', 'providers', jsonb_build_array('apinex', 'coarena'))
where not exists (
  select 1 from public.operator_audit where action = 'operator.install'
);
