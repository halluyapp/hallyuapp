-- Hallyu AI Operator: platform overview, publication system, and admin management RPCs.
set check_function_bodies = off;

-- ── Publications Table ─────────────────────────────────────────────────────────────────────────

create table if not exists public.hallyu_ai_publication (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.hallyu_ai_task (id) on delete set null,
  kind text not null check (kind in ('publish_post', 'reply_comment', 'create_poll')),
  target_id uuid,
  parent_id uuid,
  content jsonb not null default '{}'::jsonb,
  published_by text not null default 'hallyu-ai-operator',
  approved_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.hallyu_ai_publication enable row level security;
revoke all on public.hallyu_ai_publication from anon, authenticated;

create policy hallyu_ai_publication_deny_clients on public.hallyu_ai_publication
  for all using (false) with check (false);

-- ── Platform Overview Function ─────────────────────────────────────────────────────────────────

create or replace function public.hallyu_ai_platform_overview()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total_members bigint;
  v_active_members bigint;
  v_new_registrations_24h bigint;
  v_public_posts_total bigint;
  v_public_posts_24h bigint;
  v_comments_total bigint;
  v_comments_24h bigint;
  v_open_reports bigint;
  v_failed_catalog_jobs_24h bigint;
begin
  if current_user <> 'service_role' and not public.hallyu_ai_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select count(*) into v_total_members from public.profiles;
  select count(*) into v_active_members from public.profiles where account_status = 'active';
  select count(*) into v_new_registrations_24h from public.profiles where created_at >= now() - interval '24 hours';

  select count(*) into v_public_posts_total from public.posts where state = 'active' and visibility = 'public';
  select count(*) into v_public_posts_24h from public.posts where state = 'active' and visibility = 'public' and created_at >= now() - interval '24 hours';

  select count(*) into v_comments_total from public.comments where state = 'active';
  select count(*) into v_comments_24h from public.comments where state = 'active' and created_at >= now() - interval '24 hours';

  select count(*) into v_open_reports from public.reports where status = 'open';

  select count(*) into v_failed_catalog_jobs_24h from public.catalog_sync_runs where status = 'failed' and started_at >= now() - interval '24 hours';

  return jsonb_build_object(
    'total_members', v_total_members,
    'active_members', v_active_members,
    'new_registrations_24h', v_new_registrations_24h,
    'public_posts_total', v_public_posts_total,
    'public_posts_24h', v_public_posts_24h,
    'comments_total', v_comments_total,
    'comments_24h', v_comments_24h,
    'open_reports', v_open_reports,
    'failed_catalog_jobs_24h', v_failed_catalog_jobs_24h,
    'last_updated', now()
  );
end;
$$;

revoke all on function public.hallyu_ai_platform_overview() from public, anon;
grant execute on function public.hallyu_ai_platform_overview() to authenticated, service_role;

-- ── Publishing Execution Function (fail-closed, requires exact approval) ─────────────────────────

create or replace function public.hallyu_ai_publish(
  p_task uuid,
  p_kind text,
  p_args jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_approval record;
  v_approver uuid;
  v_target_id uuid;
  v_title text;
  v_body text;
  v_post_id uuid;
  v_question text;
  v_options text[];
  v_pub_id uuid;
begin
  if p_kind not in ('publish_post', 'reply_comment', 'create_poll') then
    raise exception 'invalid publication kind' using errcode = 'invalid_parameter_value';
  end if;

  select id, decided_by into v_approval
    from public.hallyu_ai_approval
   where task_id = p_task
     and tool = p_kind
     and args = p_args
     and status = 'approved'
     and requested_at > now() - interval '24 hours'
   order by requested_at desc
   limit 1;

  if v_approval.id is null then
    raise exception 'publication requires verified prior approval' using errcode = '42501';
  end if;

  v_approver := v_approval.decided_by;
  if v_approver is null then
    select id into v_approver from public.profiles where role = 'ceo' and account_status = 'active' limit 1;
  end if;

  if p_kind = 'publish_post' then
    v_title := nullif(btrim(p_args->>'title'), '');
    v_body := btrim(p_args->>'body');
    if v_body is null or char_length(v_body) < 1 or char_length(v_body) > 5000 then
      raise exception 'post body must be between 1 and 5000 characters' using errcode = 'invalid_parameter_value';
    end if;

    insert into public.posts (
      author_id,
      title,
      body,
      visibility,
      state
    ) values (
      v_approver,
      left(v_title, 90),
      v_body,
      'public',
      'active'
    ) returning id into v_target_id;

  elsif p_kind = 'reply_comment' then
    v_post_id := (p_args->>'post_id')::uuid;
    v_body := btrim(p_args->>'body');
    if v_post_id is null or v_body is null or char_length(v_body) < 1 or char_length(v_body) > 1000 then
      raise exception 'reply requires post_id and body (1-1000 chars)' using errcode = 'invalid_parameter_value';
    end if;

    insert into public.comments (
      post_id,
      author_id,
      body,
      state
    ) values (
      v_post_id,
      v_approver,
      v_body,
      'active'
    ) returning id into v_target_id;

  elsif p_kind = 'create_poll' then
    v_body := coalesce(nullif(btrim(p_args->>'body'), ''), 'Community Poll');
    v_question := coalesce(nullif(btrim(p_args->>'question'), ''), 'Vote below');
    select array_agg(opt) into v_options
      from jsonb_array_elements_text(coalesce(p_args->'options', '[]'::jsonb)) as opt;

    if array_length(v_options, 1) is null or array_length(v_options, 1) < 2 then
      raise exception 'poll requires at least 2 options' using errcode = 'invalid_parameter_value';
    end if;

    insert into public.posts (
      author_id,
      body,
      visibility,
      state
    ) values (
      v_approver,
      v_body,
      'public',
      'active'
    ) returning id into v_target_id;

    perform public.create_post_poll(v_target_id, v_question, v_options, 168);
  end if;

  insert into public.hallyu_ai_publication (
    task_id,
    kind,
    target_id,
    parent_id,
    content,
    published_by,
    approved_by
  ) values (
    p_task,
    p_kind,
    v_target_id,
    v_post_id,
    p_args,
    'hallyu-ai-operator',
    v_approver
  ) returning id into v_pub_id;

  return jsonb_build_object(
    'success', true,
    'publication_id', v_pub_id,
    'target_id', v_target_id,
    'kind', p_kind
  );
end;
$$;

revoke all on function public.hallyu_ai_publish(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.hallyu_ai_publish(uuid, text, jsonb) to service_role;

-- ── Admin RPCs for Operator UI Console ─────────────────────────────────────────────────────────

create or replace function public.hallyu_ai_admin_schedules()
returns table (
  id uuid,
  name text,
  kind text,
  interval_minutes int,
  enabled boolean,
  config jsonb,
  last_run_at timestamptz,
  last_status text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_user <> 'service_role' and not public.hallyu_ai_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
    select s.id, s.name, s.kind, s.interval_minutes, s.enabled, s.config, s.last_run_at, s.last_status, s.created_at
      from public.hallyu_ai_schedule s
     order by s.name asc;
end;
$$;

revoke all on function public.hallyu_ai_admin_schedules() from public, anon;
grant execute on function public.hallyu_ai_admin_schedules() to authenticated, service_role;

create or replace function public.hallyu_ai_admin_toggle_schedule(
  p_id uuid,
  p_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_user <> 'service_role' and not public.hallyu_ai_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.hallyu_ai_schedule
     set enabled = p_enabled
   where id = p_id;

  return found;
end;
$$;

revoke all on function public.hallyu_ai_admin_toggle_schedule(uuid, boolean) from public, anon;
grant execute on function public.hallyu_ai_admin_toggle_schedule(uuid, boolean) to authenticated, service_role;

create or replace function public.hallyu_ai_admin_memories(
  p_limit int default 50
)
returns table (
  kind text,
  key text,
  value jsonb,
  task_id uuid,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_user <> 'service_role' and not public.hallyu_ai_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
    select m.kind, m.key, m.value, m.task_id, m.created_at
      from public.hallyu_ai_memory m
     order by m.created_at desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

revoke all on function public.hallyu_ai_admin_memories(int) from public, anon;
grant execute on function public.hallyu_ai_admin_memories(int) to authenticated, service_role;

create or replace function public.hallyu_ai_admin_publications(
  p_limit int default 50
)
returns table (
  id uuid,
  task_id uuid,
  kind text,
  target_id uuid,
  parent_id uuid,
  content jsonb,
  published_by text,
  approved_by uuid,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_user <> 'service_role' and not public.hallyu_ai_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
    select p.id, p.task_id, p.kind, p.target_id, p.parent_id, p.content, p.published_by, p.approved_by, p.created_at
      from public.hallyu_ai_publication p
     order by p.created_at desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

revoke all on function public.hallyu_ai_admin_publications(int) from public, anon;
grant execute on function public.hallyu_ai_admin_publications(int) to authenticated, service_role;

-- ── Seed Reference Schedules ───────────────────────────────────────────────────────────────────

insert into public.hallyu_ai_schedule (name, kind, interval_minutes, enabled, config)
values
  ('Daily Platform Intelligence', 'daily_intelligence', 1440, false, '{"scope":"full"}'::jsonb),
  ('Community Pulse Watch', 'community_pulse', 720, false, '{"table":"posts","limit":20}'::jsonb),
  ('Entertainment Intelligence', 'entertainment_intelligence', 1440, false, '{"category":"k-drama"}'::jsonb)
on conflict (name) do nothing;
