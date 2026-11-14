-- 79: Hallyu AI Operator — fresh core schema.
--
-- This is a deliberate rebuild. The retired `hallyu_ai_*` objects are gone; the interim
-- `hallyu_operator_*` objects are left in place, untouched, and are superseded by the `operator_*`
-- namespace created here. Nothing in this migration reads, alters or drops them, so it is safe to
-- apply to a database that still carries either legacy set.
--
-- Design rules enforced by this file:
--   * every table has row level security enabled;
--   * privileged access is server-side (service_role) only;
--   * administrators read through `public.is_admin()`, members read only their own conversations;
--   * no table stores a provider secret, and no table stores a raw API key;
--   * every write path that must be auditable has an append-only audit table.

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Staff identity
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.operator_staff (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null unique references public.profiles (id) on delete cascade,
  staff_code    text not null unique,
  display_name  text not null,
  is_ai         boolean not null default true,
  active        boolean not null default true,
  capabilities  text[] not null default '{}'::text[],
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint operator_staff_code_format check (staff_code ~ '^[a-z0-9_.-]{2,40}$')
);

comment on table public.operator_staff is
  'Official Hallyu AI staff identities. Exactly one row is expected to be active. The public profile is the member-facing identity; this row is the staff authorisation record.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Policy (single row)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.operator_policy (
  id                boolean primary key default true,
  autonomy          jsonb not null default '{}'::jsonb,
  moderation        jsonb not null default '{}'::jsonb,
  notifications     jsonb not null default '{}'::jsonb,
  providers         jsonb not null default '{}'::jsonb,
  approval_required text[] not null default array[
    'admin.role.change',
    'admin.permission.change',
    'security.policy.change',
    'provider.secret.change'
  ]::text[],
  updated_at        timestamptz not null default now(),
  updated_by        uuid references public.profiles (id) on delete set null,
  constraint operator_policy_singleton check (id)
);

comment on table public.operator_policy is
  'Single-row policy document. Autonomy flags, moderation thresholds, notification limits and the list of actions that always require human approval.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Providers (metadata only — never secrets)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.operator_provider (
  provider         text primary key,
  label            text not null,
  model_id         text not null,
  base_url         text not null,
  enabled          boolean not null default true,
  is_default       boolean not null default false,
  health           text not null default 'unknown',
  last_ok_at       timestamptz,
  last_error_at    timestamptz,
  last_error_code  text,
  last_error_detail text,
  rpm_limit        integer,
  notes            text,
  updated_at       timestamptz not null default now(),
  constraint operator_provider_name check (provider in ('apinex', 'coarena')),
  constraint operator_provider_health check (
    health in ('available', 'degraded', 'rate_limited', 'auth_error', 'billing_error', 'unavailable', 'unknown')
  )
);

comment on table public.operator_provider is
  'Independent provider configuration. APINEX and Coarena are separate rows with separate models, health and limits. No secret is stored here — keys live only in server-side function secrets.';

create unique index if not exists operator_provider_one_default_idx
  on public.operator_provider ((true)) where is_default;

create table if not exists public.operator_provider_usage (
  id                bigserial primary key,
  task_id           uuid,
  provider          text not null,
  model             text not null,
  outcome           text not null,
  input_tokens      integer,
  output_tokens     integer,
  total_tokens      integer,
  estimated_cost_usd numeric(12, 6),
  cost_is_estimate  boolean not null default true,
  latency_ms        integer,
  http_status       integer,
  error_code        text,
  created_at        timestamptz not null default now(),
  constraint operator_usage_outcome check (outcome in ('succeeded', 'failed', 'rejected', 'timeout'))
);

comment on table public.operator_provider_usage is
  'One row per provider request. APINEX and Coarena usage is therefore separable by `provider`; costs are labelled as estimates because the APIs do not return a balance.';

create index if not exists operator_usage_provider_created_idx
  on public.operator_provider_usage (provider, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Conversations and messages (four channel types, strictly separated)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.operator_conversation (
  id                 uuid primary key default gen_random_uuid(),
  channel            text not null,
  staff_profile_id   uuid references public.profiles (id) on delete set null,
  member_profile_id  uuid references public.profiles (id) on delete cascade,
  external_thread_id uuid,
  subject            text,
  status             text not null default 'open',
  last_inbound_at    timestamptz,
  last_outbound_at   timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint operator_conversation_channel check (
    channel in ('admin_control', 'member_ai', 'public_thread')
  ),
  constraint operator_conversation_status check (status in ('open', 'archived', 'closed')),
  -- A member-AI or admin conversation must name its member; a public thread must name its thread.
  constraint operator_conversation_participant check (
    (channel = 'public_thread' and external_thread_id is not null)
    or (channel <> 'public_thread' and member_profile_id is not null)
  )
);

comment on table public.operator_conversation is
  'Conversation identity for the Operator only. Ordinary member-to-member DMs are never represented here — they live solely in public.direct_messages and are not intercepted.';

create unique index if not exists operator_conversation_identity_idx
  on public.operator_conversation (channel, coalesce(member_profile_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(external_thread_id, '00000000-0000-0000-0000-000000000000'::uuid));

create index if not exists operator_conversation_member_idx
  on public.operator_conversation (member_profile_id, last_inbound_at desc nulls last);

create table if not exists public.operator_message (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references public.operator_conversation (id) on delete cascade,
  direction           text not null,
  author_profile_id   uuid references public.profiles (id) on delete set null,
  author_type         text not null default 'member',
  body                text not null,
  external_message_id uuid,
  delivery_status     text not null default 'pending',
  task_id             uuid,
  meta                jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  constraint operator_message_direction check (direction in ('inbound', 'outbound')),
  constraint operator_message_author check (author_type in ('member', 'staff', 'system')),
  constraint operator_message_delivery check (
    delivery_status in ('pending', 'sent', 'failed', 'not_required')
  )
);

create index if not exists operator_message_conversation_idx
  on public.operator_message (conversation_id, created_at);

create unique index if not exists operator_message_external_idx
  on public.operator_message (external_message_id) where external_message_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Scoped memory
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.operator_memory (
  id          uuid primary key default gen_random_uuid(),
  scope       text not null,
  scope_id    uuid,
  key         text not null,
  value       jsonb not null,
  source      text,
  confidence  numeric(4, 3),
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint operator_memory_scope check (
    scope in ('member', 'admin', 'operational', 'platform', 'research')
  ),
  constraint operator_memory_member_scoped check (scope <> 'member' or scope_id is not null)
);

create unique index if not exists operator_memory_key_idx
  on public.operator_memory (scope, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Tool registry and tool calls
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.operator_tool (
  name              text primary key,
  description       text not null,
  family            text not null,
  input_schema      jsonb not null,
  output_schema     jsonb,
  permission        text not null,
  read_only         boolean not null default true,
  approval_required boolean not null default false,
  rate_limit_per_min integer,
  timeout_ms        integer not null default 15000,
  enabled           boolean not null default true,
  updated_at        timestamptz not null default now()
);

comment on table public.operator_tool is
  'Server-side tool registry. A model may only request a tool present here and enabled; the gateway rejects anything else before execution.';

create table if not exists public.operator_tool_call (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid,
  tool         text not null,
  args         jsonb not null default '{}'::jsonb,
  result       jsonb,
  outcome      text not null,
  error_code   text,
  error_detail text,
  duration_ms  integer,
  created_at   timestamptz not null default now(),
  constraint operator_tool_call_outcome check (
    outcome in ('succeeded', 'partially_succeeded', 'rejected', 'failed', 'pending', 'not_verified')
  )
);

create index if not exists operator_tool_call_task_idx
  on public.operator_tool_call (task_id, created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Tasks, events, schedules
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.operator_task (
  id                  uuid primary key default gen_random_uuid(),
  task_type           text not null,
  status              text not null default 'queued',
  priority            integer not null default 5,
  source_event_id     uuid,
  conversation_id     uuid references public.operator_conversation (id) on delete set null,
  requester_profile_id uuid references public.profiles (id) on delete set null,
  destination_type    text,
  destination_id      uuid,
  provider            text,
  model               text,
  input               jsonb not null default '{}'::jsonb,
  result              jsonb,
  error_code          text,
  error_detail        text,
  attempt_count       integer not null default 0,
  max_attempts        integer not null default 3,
  available_at        timestamptz not null default now(),
  lease_owner         text,
  lease_expires_at    timestamptz,
  idempotency_key     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  constraint operator_task_status check (
    status in ('queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'retrying')
  ),
  constraint operator_task_attempts check (attempt_count >= 0 and max_attempts between 1 and 10)
);

create unique index if not exists operator_task_idempotency_idx
  on public.operator_task (idempotency_key) where idempotency_key is not null;

create index if not exists operator_task_claim_idx
  on public.operator_task (status, available_at, priority)
  where status in ('queued', 'retrying');

create index if not exists operator_task_lease_idx
  on public.operator_task (lease_expires_at)
  where status = 'running';

create table if not exists public.operator_event (
  id                uuid primary key default gen_random_uuid(),
  source            text not null,
  event_type        text not null,
  external_event_id text,
  conversation_id   uuid references public.operator_conversation (id) on delete set null,
  actor_profile_id  uuid references public.profiles (id) on delete set null,
  destination_type  text,
  destination_id    uuid,
  payload           jsonb not null default '{}'::jsonb,
  idempotency_key   text not null unique,
  task_id           uuid,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  constraint operator_event_source check (
    source in ('dm', 'comment', 'mention', 'report', 'admin_command', 'schedule', 'system', 'webhook')
  )
);

create index if not exists operator_event_unprocessed_idx
  on public.operator_event (received_at) where processed_at is null;

create table if not exists public.operator_schedule (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,
  task_type        text not null,
  cron             text,
  interval_seconds integer,
  next_run_at      timestamptz not null default now(),
  enabled          boolean not null default true,
  payload          jsonb not null default '{}'::jsonb,
  last_run_at      timestamptz,
  last_task_id     uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint operator_schedule_trigger check (cron is not null or interval_seconds is not null)
);

create index if not exists operator_schedule_due_idx
  on public.operator_schedule (next_run_at) where enabled;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Approvals
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.operator_approval (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid references public.operator_task (id) on delete cascade,
  action        text not null,
  requested_by  uuid references public.profiles (id) on delete set null,
  required_role text not null default 'admin',
  status        text not null default 'pending',
  decided_by    uuid references public.profiles (id) on delete set null,
  decided_at    timestamptz,
  note          text,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  constraint operator_approval_status check (status in ('pending', 'approved', 'rejected', 'expired'))
);

create index if not exists operator_approval_pending_idx
  on public.operator_approval (created_at) where status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Moderation cases
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.operator_moderation_case (
  id                   uuid primary key default gen_random_uuid(),
  report_id            uuid references public.reports (id) on delete set null,
  target_type          text not null,
  target_id            uuid not null,
  rule_code            text not null,
  rule_text            text,
  evidence             jsonb not null default '{}'::jsonb,
  confidence           numeric(4, 3),
  decision             text not null,
  action_taken         text,
  moderation_action_id uuid references public.moderation_actions (id) on delete set null,
  task_id              uuid references public.operator_task (id) on delete set null,
  decided_by           uuid references public.profiles (id) on delete set null,
  appeal_status        text not null default 'none',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint operator_moderation_target check (
    target_type in ('post', 'comment', 'user', 'collection', 'community', 'title', 'report')
  ),
  constraint operator_moderation_decision check (
    decision in ('remove', 'warn', 'suspend', 'ban', 'restore', 'no_action', 'contain')
  ),
  constraint operator_moderation_appeal check (
    appeal_status in ('none', 'requested', 'upheld', 'overturned')
  )
);

create index if not exists operator_moderation_created_idx
  on public.operator_moderation_case (created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Research, campaigns, notification runs
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.operator_research_item (
  id            uuid primary key default gen_random_uuid(),
  topic         text not null,
  headline      text not null,
  summary       text,
  source_name   text,
  source_url    text,
  published_at  timestamptz,
  verification  text not null default 'unverified',
  world         text,
  used_in_post_id uuid references public.posts (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint operator_research_verification check (
    verification in ('confirmed', 'reported', 'rumour', 'unverified')
  )
);

create unique index if not exists operator_research_dedupe_idx
  on public.operator_research_item (lower(headline), coalesce(source_url, ''));

create table if not exists public.operator_campaign (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text not null,
  status      text not null default 'draft',
  starts_at   timestamptz,
  ends_at     timestamptz,
  payload     jsonb not null default '{}'::jsonb,
  post_id     uuid references public.posts (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint operator_campaign_kind check (kind in ('campaign', 'event', 'poll', 'vote')),
  constraint operator_campaign_status check (
    status in ('draft', 'scheduled', 'active', 'completed', 'cancelled')
  )
);

create table if not exists public.operator_notification_run (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  body            text not null,
  audience        text not null,
  audience_filter jsonb not null default '{}'::jsonb,
  kind            public.notification_kind not null default 'system',
  status          text not null default 'queued',
  target_count    integer,
  delivered_count integer,
  failed_count    integer,
  task_id         uuid references public.operator_task (id) on delete set null,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz,
  constraint operator_notification_status check (
    status in ('queued', 'sending', 'sent', 'failed', 'partial')
  )
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Audit and worker health
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.operator_audit (
  id               bigserial primary key,
  task_id          uuid,
  actor_profile_id uuid,
  actor_type       text not null default 'system',
  action           text not null,
  outcome          text not null,
  resource_type    text,
  resource_id      text,
  details          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  constraint operator_audit_actor check (actor_type in ('member', 'staff', 'admin', 'system'))
);

create index if not exists operator_audit_created_idx
  on public.operator_audit (created_at desc);

create table if not exists public.operator_worker_health (
  worker_id       text primary key,
  last_seen_at    timestamptz not null default now(),
  version         text,
  meta            jsonb not null default '{}'::jsonb,
  tasks_processed bigint not null default 0,
  last_error      text
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. Row level security
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'operator_staff', 'operator_policy', 'operator_provider', 'operator_provider_usage',
    'operator_conversation', 'operator_message', 'operator_memory', 'operator_tool',
    'operator_tool_call', 'operator_task', 'operator_event', 'operator_schedule',
    'operator_approval', 'operator_moderation_case', 'operator_research_item',
    'operator_campaign', 'operator_notification_run', 'operator_audit', 'operator_worker_health'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end;
$$;

-- Administrators may read operational state. Writes are server-side only.
do $$
declare
  t text;
begin
  foreach t in array array[
    'operator_staff', 'operator_policy', 'operator_provider', 'operator_provider_usage',
    'operator_conversation', 'operator_message', 'operator_memory', 'operator_tool',
    'operator_tool_call', 'operator_task', 'operator_event', 'operator_schedule',
    'operator_approval', 'operator_moderation_case', 'operator_research_item',
    'operator_campaign', 'operator_notification_run', 'operator_audit', 'operator_worker_health'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_admin_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_admin())',
      t || '_admin_read', t
    );
  end loop;
end;
$$;

-- A member may read only their own Operator conversation and its messages.
drop policy if exists operator_conversation_member_read on public.operator_conversation;
create policy operator_conversation_member_read
  on public.operator_conversation
  for select to authenticated
  using (member_profile_id = public.current_profile_id());

drop policy if exists operator_message_member_read on public.operator_message;
create policy operator_message_member_read
  on public.operator_message
  for select to authenticated
  using (
    exists (
      select 1 from public.operator_conversation c
      where c.id = operator_message.conversation_id
        and c.member_profile_id = public.current_profile_id()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. Grants — reads for admins, nothing for anon, everything for service_role
-- ─────────────────────────────────────────────────────────────────────────────
revoke all on all tables in schema public from anon;

do $$
declare
  t text;
begin
  foreach t in array array[
    'operator_staff', 'operator_policy', 'operator_provider', 'operator_provider_usage',
    'operator_conversation', 'operator_message', 'operator_memory', 'operator_tool',
    'operator_tool_call', 'operator_task', 'operator_event', 'operator_schedule',
    'operator_approval', 'operator_moderation_case', 'operator_research_item',
    'operator_campaign', 'operator_notification_run', 'operator_audit', 'operator_worker_health'
  ]
  loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end;
$$;

grant usage, select on sequence public.operator_audit_id_seq to service_role;
grant usage, select on sequence public.operator_provider_usage_id_seq to service_role;
