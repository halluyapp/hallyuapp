-- Hallyu backend — 33 moderation actions and audit trail.
--
-- Migration 15 records *requests* for help (reports). Nothing in the backend could act on them:
-- a moderator could resolve a report by hand-editing a row, which left no record of who did it, why,
-- or what happened to the content afterwards.
--
-- This migration adds the other half of the workflow. Every privileged action — suspending an
-- account, hiding a post, dismissing a report — goes through a function that:
--
--   * re-checks authority in the database (`public.is_moderator()`)
--   * writes an immutable row to `moderation_actions` *in the same transaction as the change*
--   * notifies the affected member
--   * links the action to the report it resolves, so a decision is explainable afterwards
--
-- The audit table has no update path: `moderation_actions` is append-only, readable only by
-- moderators, and every privileged state change in this schema is expected to leave a row in it.

-- ---------------------------------------------------------------------------------------------
-- The audit log
-- ---------------------------------------------------------------------------------------------

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create type public.moderation_action_kind as enum (
  'report_resolved', 'report_dismissed', 'report_escalated',
  'content_hidden', 'content_restored', 'content_removed',
  'user_suspended', 'user_unsuspended',
  'room_post_hidden', 'room_post_restored'
);

create type public.moderation_target as enum ('post', 'comment', 'user', 'collection', 'community', 'title', 'report');

create table if not exists public.moderation_actions (
  id            uuid primary key default gen_random_uuid(),
  action        public.moderation_action_kind not null,
  target_type   public.moderation_target      not null,
  target_id     uuid        not null,
  actor_id      uuid        not null references public.profiles (id) on delete restrict,
  report_id     uuid        references public.reports (id) on delete set null,
  reason        text,
  detail        jsonb       not null default '{}'::jsonb,
  -- A reversal points at the action it undoes, so the history reads as a chain rather than a pile.
  reverses_id   uuid        references public.moderation_actions (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint moderation_actions_reason_length check (reason is null or char_length(reason) <= 500),
  constraint moderation_actions_detail_is_object check (jsonb_typeof(detail) = 'object'),
  -- A reversal may not reverse itself.
  constraint moderation_actions_no_self_reverse check (reverses_id is null or reverses_id <> id)
);

comment on table public.moderation_actions is 'Append-only log of every privileged action. Written in the same transaction as the change it describes.';
comment on column public.moderation_actions.detail is 'Before/after facts worth keeping: previous status, the report queue the action came from, the affected counters.';

create index if not exists moderation_actions_target_idx on public.moderation_actions (target_type, target_id, created_at desc);
create index if not exists moderation_actions_actor_idx on public.moderation_actions (actor_id, created_at desc);
create index if not exists moderation_actions_action_idx on public.moderation_actions (action, created_at desc);
create index if not exists moderation_actions_report_idx on public.moderation_actions (report_id) where report_id is not null;

alter table public.moderation_actions enable row level security;

-- Moderators read the whole log. Nobody — not even a moderator — may edit or delete a row.
create policy moderation_actions_moderator_select on public.moderation_actions
  for select to authenticated using (public.is_moderator());

create policy moderation_actions_service_only on public.moderation_actions
  for all to service_role using (true) with check (true);

grant select on public.moderation_actions to authenticated;

-- The only write path is public.record_moderation_action(), called from inside the privileged RPCs.
create or replace function public.record_moderation_action(
  p_action public.moderation_action_kind,
  p_target_type public.moderation_target,
  p_target_id uuid,
  p_reason text default null,
  p_report_id uuid default null,
  p_detail jsonb default '{}'::jsonb,
  p_reverses_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  row_id uuid;
begin
  -- Both paths are legitimate: a moderator acting in the app, and the service role acting from an
  -- Edge Function. Anyone else is refused — there is no third writer.
  if actor is null and auth.role() <> 'service_role' then
    raise exception 'moderation actions may only be recorded by a moderator' using errcode = 'insufficient_privilege';
  end if;

  if actor is not null and not public.is_moderator() then
    raise exception 'moderator role required' using errcode = 'insufficient_privilege';
  end if;

  insert into public.moderation_actions (action, target_type, target_id, actor_id, report_id, reason, detail, reverses_id)
  values (p_action, p_target_type, p_target_id, actor, p_report_id, left(p_reason, 500), coalesce(p_detail, '{}'::jsonb), p_reverses_id)
  returning id into row_id;

  return row_id;
end;
$$;

revoke all on function public.record_moderation_action(public.moderation_action_kind, public.moderation_target, uuid, text, uuid, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.record_moderation_action(public.moderation_action_kind, public.moderation_target, uuid, text, uuid, jsonb, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Authority
-- ---------------------------------------------------------------------------------------------

-- Global moderator (role = 'moderator' or 'admin') or the acting member. Community-scoped
-- moderation lives in migration 32 and is a separate, narrower check.

-- `is_moderator()` (migration 00) treats admin as a moderator. Some actions — suspending an account,
-- suspending another moderator — are admin-only, so the higher role needs its own predicate rather
-- than a client-side check.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
      and p.account_status = 'active'
  )
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

create or replace function public.require_moderator(p_action text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'moderator role required' using errcode = 'insufficient_privilege';
  end if;

  if not public.is_moderator() then
    raise exception 'moderator role required to %s', coalesce(p_action, 'moderate')
      using errcode = 'insufficient_privilege';
  end if;

  -- A suspended moderator moderates nothing.
  if exists (select 1 from public.profiles p where p.id = actor and p.account_status <> 'active') then
    raise exception 'your account is not active' using errcode = 'insufficient_privilege';
  end if;

  return actor;
end;
$$;

revoke all on function public.require_moderator(text) from public, anon, authenticated;
grant execute on function public.require_moderator(text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Account actions
-- ---------------------------------------------------------------------------------------------

-- Suspends an account. Content stays, the account cannot post, comment, react, save or be followed,
-- and every suspension is logged with its duration and reason. A moderator cannot suspend another
-- moderator; that needs a global admin, so a compromised moderator cannot lock out the team.
create or replace function public.suspend_user(
  p_user_id uuid,
  p_reason text,
  p_days integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid;
  target public.profiles%rowtype;
  until_at timestamptz;
begin
  actor := public.require_moderator('suspend a member');

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'a suspension needs a reason' using errcode = 'invalid_parameter_value';
  end if;

  if p_days < 0 or p_days > 3650 then
    raise exception 'suspension length is out of range' using errcode = 'invalid_parameter_value';
  end if;

  select * into target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'member % does not exist', p_user_id using errcode = 'no_data_found';
  end if;

  if target.role <> 'member' then
    raise exception 'only a global admin may suspend another moderator'
      using errcode = 'insufficient_privilege';
  end if;

  if not public.is_admin() then
    raise exception 'only a global admin may suspend a member'
      using errcode = 'insufficient_privilege';
  end if;

  until_at := case when p_days > 0 then now() + make_interval(days => p_days) else null end;

  update public.profiles
     set account_status = 'suspended',
         deleted_at = null
   where id = p_user_id;

  perform public.record_moderation_action(
    'user_suspended', 'user', p_user_id, p_reason, null,
    jsonb_build_object('previous_status', target.account_status, 'until', until_at, 'days', p_days)
  );

  perform public.notify_recipient(
    p_user_id, 'system', 'system', '{}'::uuid[],
    null, null, null, null, null, null,
    'Your account has been suspended',
    left(p_reason, 300)
  );

  return jsonb_build_object(
    'user_id', p_user_id,
    'status', 'suspended',
    'until', until_at,
    'clears_activity', (select count(*) from public.push_tokens where user_id = p_user_id and disabled_at is null)
  );
end;
$$;

revoke all on function public.suspend_user(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.suspend_user(uuid, text, integer) to authenticated;

create or replace function public.unsuspend_user(
  p_user_id uuid,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid;
  target public.profiles%rowtype;
begin
  actor := public.require_moderator('reinstate a member');

  select * into target from public.profiles where id = p_user_id;
  if not found then
    raise exception 'member % does not exist', p_user_id using errcode = 'no_data_found';
  end if;

  if target.account_status = 'deleted' then
    raise exception 'this account was deleted, not suspended' using errcode = 'check_violation';
  end if;

  update public.profiles set account_status = 'active' where id = p_user_id;

  perform public.record_moderation_action(
    'user_unsuspended', 'user', p_user_id, p_reason, null,
    jsonb_build_object('previous_status', target.account_status)
  );

  perform public.notify_recipient(
    p_user_id, 'system', 'system', '{}'::uuid[],
    null, null, null, null, null, null,
    'Your account is active again', left(p_reason, 300)
  );

  return true;
end;
$$;

revoke all on function public.unsuspend_user(uuid, text) from public, anon, authenticated;
grant execute on function public.unsuspend_user(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Content actions
-- ---------------------------------------------------------------------------------------------

-- Hides or restores a post or comment. 'removed' is a permanent state change (state = 'deleted')
-- and is irreversible by this function; hiding is reversible and is what a moderator normally does.
create or replace function public.moderate_content(
  p_target_type text,
  p_target_id uuid,
  p_action text,
  p_reason text default null,
  p_report_id uuid default null
)
returns public.content_state
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid;
  previous public.content_state;
  next_state public.content_state;
begin
  actor := public.require_moderator('moderate content');

  if p_target_type not in ('post', 'comment') then
    raise exception 'target type must be post or comment' using errcode = 'invalid_parameter_value';
  end if;

  case p_action
    when 'hide' then next_state := 'hidden';
    when 'restore' then next_state := 'active';
    when 'remove' then next_state := 'deleted';
    else raise exception 'action must be hide, restore or remove' using errcode = 'invalid_parameter_value';
  end case;

  if p_action = 'restore' then
    if p_target_type = 'post' then
      select p.state into previous from public.posts p where p.id = p_target_id;
    else
      select c.state into previous from public.comments c where c.id = p_target_id;
    end if;

    if not found then
      raise exception '%s % does not exist', p_target_type, p_target_id using errcode = 'no_data_found';
    end if;

    -- Restoring is only meaningful for hidden content, and only for a member who still exists.
    if previous = 'deleted' then
      raise exception 'removed content cannot be restored here' using errcode = 'check_violation';
    end if;
  end if;

  if p_target_type = 'post' then
    select p.state into previous from public.posts p where p.id = p_target_id for update;
    if not found then
      raise exception 'post % does not exist', p_target_id using errcode = 'no_data_found';
    end if;

    update public.posts
       set state = next_state,
           deleted_at = case when next_state = 'deleted' then coalesce(p.deleted_at, now()) else null end,
           hidden_at = case when next_state = 'hidden' then coalesce(p.hidden_at, now()) else null end
     where id = p_target_id
    returning state into next_state;

    perform public.record_moderation_action(
      case when p_action = 'remove' then 'content_removed'::public.moderation_action_kind
           when p_action = 'restore' then 'content_restored'::public.moderation_action_kind
           else 'content_hidden'::public.moderation_action_kind end,
      'post', p_target_id, p_reason, p_report_id,
      jsonb_build_object('previous_state', previous, 'new_state', next_state)
    );

    -- The author hears about it, in the system group.
    perform public.notify_recipient(
      (select author_id from public.posts where id = p_target_id),
      'system', 'system', '{}'::uuid[],
      p_target_id, null, null, null, null, null,
      case when p_action = 'remove' then 'A moderator removed your post'
           when p_action = 'restore' then 'Your post is visible again'
           else 'A moderator hid your post' end,
      left(p_reason, 300)
    );
  else
    select c.state into previous from public.comments c where c.id = p_target_id for update;
    if not found then
      raise exception 'comment % does not exist', p_target_id using errcode = 'no_data_found';
    end if;

    update public.comments
       set state = next_state,
           deleted_at = case when next_state = 'deleted' then coalesce(c.deleted_at, now()) else null end,
           hidden_at = case when next_state = 'hidden' then coalesce(c.hidden_at, now()) else null end
     where id = p_target_id;

    perform public.record_moderation_action(
      case when p_action = 'remove' then 'content_removed'::public.moderation_action_kind
           when p_action = 'restore' then 'content_restored'::public.moderation_action_kind
           else 'content_hidden'::public.moderation_action_kind end,
      'comment', p_target_id, p_reason, p_report_id,
      jsonb_build_object('previous_state', previous, 'new_state', next_state)
    );
  end if;

  return next_state;
end;
$$;

revoke all on function public.moderate_content(text, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.moderate_content(text, uuid, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Report decisions
-- ---------------------------------------------------------------------------------------------

-- Resolving or dismissing a report. Every open report for the same target is closed together, so a
-- post reported nine times is one decision with nine records linked to it.
create or replace function public.resolve_report(
  p_report_id uuid,
  p_outcome text,
  p_resolution text,
  p_content_action text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid;
  report_row public.reports%rowtype;
  sibling_ids uuid[];
  new_status public.report_status;
begin
  actor := public.require_moderator('resolve a report');

  if p_outcome not in ('resolved', 'dismissed') then
    raise exception 'outcome must be resolved or dismissed' using errcode = 'invalid_parameter_value';
  end if;

  select * into report_row from public.reports where id = p_report_id for update;
  if not found then
    raise exception 'report % does not exist', p_report_id using errcode = 'no_data_found';
  end if;

  if report_row.status in ('resolved', 'dismissed') then
    raise exception 'report % is already closed', p_report_id using errcode = 'check_violation';
  end if;

  -- An optional content action taken as part of the decision, logged as its own audit row.
  if p_content_action is not null then
    perform public.moderate_content(
      report_row.target_type,
      report_row.target_id,
      p_content_action,
      p_resolution,
      p_report_id
    );
  end if;

  new_status := p_outcome::public.report_status;

  update public.reports
     set status = new_status,
         resolution = left(p_resolution, 1000),
         resolved_by = actor,
         resolved_at = now()
   where id = p_report_id;

  -- Every other report on the same target closes with the same decision.
  update public.reports
     set status = new_status,
         resolution = left(p_resolution, 1000),
         resolved_by = actor,
         resolved_at = now()
   where target_type = report_row.target_type
     and target_id = report_row.target_id
     and status in ('open', 'reviewing')
     and id <> p_report_id;

  select coalesce(array_agg(r.id), '{}') into sibling_ids
  from public.reports r
  where r.target_type = report_row.target_type
    and r.target_id = report_row.target_id
    and r.resolved_by = actor;

  perform public.record_moderation_action(
    case when new_status = 'resolved' then 'report_resolved'::public.moderation_action_kind
         else 'report_dismissed'::public.moderation_action_kind end,
    'report', p_report_id, p_resolution, p_report_id,
    jsonb_build_object(
      'target_type', report_row.target_type,
      'target_id', report_row.target_id,
      'reason', report_row.reason,
      'closed_reports', cardinality(sibling_ids),
      'content_action', p_content_action
    )
  );

  return jsonb_build_object(
    'report_id', p_report_id,
    'status', new_status,
    'closed_reports', cardinality(sibling_ids),
    'content_action', p_content_action
  );
end;
$$;

revoke all on function public.resolve_report(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.resolve_report(uuid, text, text, text) to authenticated;

-- Escalation: hands a report up without closing it. Recorded so the queue shows who escalated it and
-- to whom, and the report stays visible in the moderator inbox.
create or replace function public.escalate_report(
  p_report_id uuid,
  p_note text,
  p_to_role text default 'admin'
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  report_row public.reports%rowtype;
begin
  perform public.require_moderator('escalate a report');

  if p_note is null or length(btrim(p_note)) < 3 then
    raise exception 'an escalation needs a note' using errcode = 'invalid_parameter_value';
  end if;

  if p_to_role not in ('admin', 'legal', 'catalog') then
    raise exception 'unknown escalation target %', p_to_role using errcode = 'invalid_parameter_value';
  end if;

  select * into report_row from public.reports where id = p_report_id;
  if not found then
    raise exception 'report % does not exist', p_report_id using errcode = 'no_data_found';
  end if;

  if report_row.status in ('resolved', 'dismissed') then
    raise exception 'report % is already closed', p_report_id using errcode = 'check_violation';
  end if;

  update public.reports set status = 'reviewing' where id = p_report_id;

  perform public.record_moderation_action(
    'report_escalated', 'report', p_report_id, p_note, p_report_id,
    jsonb_build_object('to_role', p_to_role, 'target_type', report_row.target_type, 'target_id', report_row.target_id)
  );

  return true;
end;
$$;

revoke all on function public.escalate_report(uuid, text, text) from public, anon, authenticated;
grant execute on function public.escalate_report(uuid, text, text) to authenticated;

-- The moderation inbox, in the database rather than only in the Edge Function digest. Deterministic
-- ordering and pagination so a queue page is stable.
create or replace function public.moderation_queue(
  p_status public.report_status default 'open',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  per_page integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  skip_rows integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform public.require_moderator('read the moderation queue');

  return jsonb_build_object(
    'status', p_status,
    'total', (select count(*) from public.reports r where r.status = p_status),
    'reports', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at asc, r.id asc)
      from (
        select r.id, r.target_type, r.target_id, r.reason, r.detail, r.status, r.created_at,
               (select count(*)::integer from public.reports r2
                 where r2.target_type = r.target_type and r2.target_id = r.target_id) as target_report_count,
               (select count(*)::integer from public.reports r2
                 where r2.target_type = r.target_type and r2.target_id = r.target_id
                   and r2.reporter_id is distinct from r.reporter_id) as distinct_reporters
        from public.reports r
        where r.status = p_status
        order by r.created_at asc, r.id asc
        limit per_page offset skip_rows
      ) r
    ), '[]'::jsonb),
    'recent_actions', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.created_at desc)
      from (
        select a.id, a.action, a.target_type, a.target_id, a.reason, a.created_at,
               pr.handle as actor_handle, pr.display_name as actor_name
        from public.moderation_actions a
        join public.profiles pr on pr.id = a.actor_id
        order by a.created_at desc, a.id desc
        limit 25
      ) a
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.moderation_queue(public.report_status, integer, integer) from public, anon, authenticated;
grant execute on function public.moderation_queue(public.report_status, integer, integer) to authenticated;

-- The audit trail for one target, newest first. Moderators only.
create or replace function public.moderation_history(
  p_target_type public.moderation_target,
  p_target_id uuid,
  p_limit integer default 50
)
returns setof public.moderation_actions
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.*
  from public.moderation_actions a
  where a.target_type = p_target_type and a.target_id = p_target_id
    and public.is_moderator()
  order by a.created_at desc, a.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

revoke all on function public.moderation_history(public.moderation_target, uuid, integer) from public, anon, authenticated;
grant execute on function public.moderation_history(public.moderation_target, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Scheduled maintenance
-- ---------------------------------------------------------------------------------------------

-- Expires timed suspensions and closes reports whose target no longer exists. A report outliving
-- its target is normal (migration 15 says so deliberately), but an orphaned *open* report is queue
-- noise, so it is dismissed with a recorded reason rather than left in the inbox forever.
create or replace function public.job_reconcile_moderation()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  reinstated integer := 0;
  dismissed integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'scheduled jobs are a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  -- A timed suspension is recorded in its action row; when the window has passed the member returns
  -- unless a later suspension is still running.
  update public.profiles p
     set account_status = 'active'
   where p.account_status = 'suspended'
     and exists (
       select 1 from public.moderation_actions a
       where a.action = 'user_suspended'
         and a.target_id = p.id
         and (a.detail ->> 'until') is not null
         and (a.detail ->> 'until')::timestamptz < now()
     )
     and not exists (
       select 1 from public.moderation_actions a
       where a.action = 'user_suspended'
         and a.target_id = p.id
         and (a.detail ->> 'until')::timestamptz >= now()
     );

  get diagnostics reinstated = row_count;

  -- Close reports whose target row is gone, so the queue reflects reality.
  update public.reports r
     set status = 'dismissed',
         resolution = 'closed automatically: the reported content no longer exists',
         resolved_at = now()
   where r.status in ('open', 'reviewing')
     and not (
       (r.target_type = 'post' and exists (select 1 from public.posts p where p.id = r.target_id))
       or (r.target_type = 'comment' and exists (select 1 from public.comments c where c.id = r.target_id))
       or (r.target_type = 'user' and exists (select 1 from public.profiles p where p.id = r.target_id))
       or (r.target_type = 'collection' and exists (select 1 from public.collections c where c.id = r.target_id))
       or (r.target_type = 'title' and exists (select 1 from public.titles t where t.id = r.target_id))
     );

  get diagnostics dismissed = row_count;

  return jsonb_build_object(
    'accounts_reinstated', reinstated,
    'orphan_reports_dismissed', dismissed
  );
end;
$$;

revoke all on function public.job_reconcile_moderation() from public, anon, authenticated;
grant execute on function public.job_reconcile_moderation() to service_role;

-- The dispatcher, now with a real moderation job.
create or replace function public.run_scheduled_jobs(p_jobs text[] default null)
returns table (job text, status text, run_id uuid, items integer, error text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  entry text;
  run_key_value text;
  claim_row record;
  retention_row record;
  media_result jsonb;
  moderation_result jsonb;
  handled integer := 0;
  job_error text;
  outcome text;
begin
  if auth.uid() is not null then
    raise exception 'scheduled jobs are a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  perform public.job_release_stale();

  foreach entry in array coalesce(
    p_jobs,
    array[
      'catalog.status',
      'catalog.episode_schedule',
      'catalog.prune',
      'catalog.aggregates',
      'catalog.trending',
      'alerts.upcoming_episodes',
      'alerts.new_episodes',
      'alerts.title_updates',
      'notifications.fanout',
      'notifications.retention',
      'media.reconcile',
      'moderation.audit'
    ]
  ) loop
    run_key_value := to_char(date_trunc('hour', now()), 'YYYY-MM-DD') || 'T' || to_char(date_trunc('hour', now()), 'HH24');

    job_error := null;
    outcome := 'skipped';

    for claim_row in select * from public.job_claim(entry, run_key_value) loop
      if claim_row.did_claim then
        begin
          case entry
            when 'catalog.status' then
              handled := public.job_reconcile_catalog_status();
            when 'catalog.episode_schedule' then
              handled := public.job_reconcile_episode_schedule();
            when 'catalog.prune' then
              handled := (select coalesce(titles_parked, 0) + coalesce(titles_available, 0) from public.job_prune_stale_catalog());
            when 'catalog.aggregates' then
              handled := public.job_recompute_community_post_counts();
            when 'catalog.trending' then
              handled := public.refresh_trending(null);
            when 'alerts.upcoming_episodes' then
              handled := public.job_queue_upcoming_episodes();
            when 'alerts.new_episodes' then
              handled := public.job_queue_new_episodes();
            when 'alerts.title_updates' then
              handled := public.job_queue_title_updates();
            when 'notifications.fanout' then
              handled := public.fanout_due_notifications();
            when 'notifications.retention' then
              select * into retention_row from public.job_expire_notifications();
              handled := coalesce(retention_row.notifications_removed, 0)
                       + coalesce(retention_row.deliveries_removed, 0)
                       + coalesce(retention_row.read_removed, 0);
            when 'media.reconcile' then
              media_result := public.job_reconcile_media();
              handled := coalesce((media_result ->> 'orphan_objects_removed')::integer, 0)
                       + coalesce((media_result ->> 'broken_rows_removed')::integer, 0)
                       + coalesce((media_result ->> 'upload_rows_purged')::integer, 0);
            when 'moderation.audit' then
              moderation_result := public.job_reconcile_moderation();
              handled := coalesce((moderation_result ->> 'accounts_reinstated')::integer, 0)
                       + coalesce((moderation_result ->> 'orphan_reports_dismissed')::integer, 0);
            else
              raise exception 'unknown job %', entry using errcode = 'invalid_parameter_value';
          end case;
          outcome := 'succeeded';
        exception when others then
          job_error := left(sqlerrm, 500);
          outcome := 'failed';
        end;

        perform public.job_complete(claim_row.id, outcome, handled, job_error);

        return query select entry, outcome, claim_row.id, handled, job_error;
        return;
      end if;
    end loop;
  end loop;

  return;
end;
$$;

revoke all on function public.run_scheduled_jobs(text[]) from public, anon, authenticated;
grant execute on function public.run_scheduled_jobs(text[]) to service_role;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
