-- Migration 75: Hallyu AI scheduler claims, targeted execution and publishing repairs.
--
-- Fixes:
-- 1. `hallyu_ai_claim_due_schedules`: implements atomic SKIP LOCKED schedule claiming.
-- 2. `hallyu_ai_claim_schedule`: enables targeted "Run Now" execution with force override.
-- 3. `hallyu_ai_publish`: unifies the publishing RPC, matching the operator function signature,
--    attributing autonomous output to the official Hallyu AI author, and logging in the publication ledger.
-- 4. Preserves backward compatibility for callers using (p_task uuid, p_kind text, p_args jsonb).

set check_function_bodies = off;

-- ── 1. Atomic claim for due schedules ─────────────────────────────────────────────────────────

create or replace function public.hallyu_ai_claim_due_schedules(p_limit integer default 3)
returns setof public.hallyu_ai_schedule
language sql
security definer
set search_path = public, pg_temp
as $$
  with due as (
    select s.id
      from public.hallyu_ai_schedule s
     where s.enabled
       and coalesce(s.next_run_at, s.created_at) <= now()
     order by coalesce(s.next_run_at, s.created_at) asc
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 3), 10))
  )
  update public.hallyu_ai_schedule s
     set next_run_at = now() + (s.interval_minutes || ' minutes')::interval,
         last_run_at = now(),
         updated_at = now()
    from due
   where s.id = due.id
  returning s.*;
$$;

comment on function public.hallyu_ai_claim_due_schedules(integer) is
  'Claim due enabled AI schedules atomically (SKIP LOCKED), advancing next_run_at so duplicate execution is impossible.';

revoke all on function public.hallyu_ai_claim_due_schedules(integer) from public, anon;
grant execute on function public.hallyu_ai_claim_due_schedules(integer) to authenticated, service_role;

-- ── 2. Targeted schedule execution for "Run Now" ──────────────────────────────────────────────

create or replace function public.hallyu_ai_claim_schedule(p_schedule_id uuid, p_force boolean default false)
returns setof public.hallyu_ai_schedule
language sql
security definer
set search_path = public, pg_temp
as $$
  with target as (
    select s.id
      from public.hallyu_ai_schedule s
     where s.id = p_schedule_id
       and (p_force or s.enabled)
     for update
  )
  update public.hallyu_ai_schedule s
     set next_run_at = now() + (s.interval_minutes || ' minutes')::interval,
         last_run_at = now(),
         updated_at = now()
    from target
   where s.id = target.id
  returning s.*;
$$;

comment on function public.hallyu_ai_claim_schedule(uuid, boolean) is
  'Claim a specific schedule for immediate execution (Run Now). If p_force is false, disabled schedules are not claimed.';

revoke all on function public.hallyu_ai_claim_schedule(uuid, boolean) from public, anon;
grant execute on function public.hallyu_ai_claim_schedule(uuid, boolean) to authenticated, service_role;

-- ── 3. Unified publishing RPC ─────────────────────────────────────────────────────────────────

create or replace function public.hallyu_ai_publish(
  p_task_id uuid,
  p_action text,
  p_title text,
  p_body text,
  p_payload jsonb default '{}'::jsonb,
  p_sources jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ai_profile uuid;
  v_target_id uuid;
  v_pub_id uuid;
  v_post_id uuid;
  v_parent_id uuid;
  v_world text;
  v_options text[];
  v_question text;
  v_body text := btrim(p_body);
  v_title text := nullif(btrim(p_title), '');
begin
  if p_action not in ('publish_post', 'reply_comment', 'create_poll') then
    raise exception 'invalid publication action: %', p_action using errcode = 'invalid_parameter_value';
  end if;

  -- The official AI author identity
  v_ai_profile := public.hallyu_ai_profile_id();
  if v_ai_profile is null then
    select id into v_ai_profile from public.profiles where role = 'ceo' and account_status = 'active' limit 1;
  end if;
  if v_ai_profile is null then
    raise exception 'no valid author profile available for publication' using errcode = '42501';
  end if;

  if p_action = 'publish_post' then
    if v_body is null or char_length(v_body) < 1 or char_length(v_body) > 5000 then
      raise exception 'post body must be between 1 and 5000 characters' using errcode = 'invalid_parameter_value';
    end if;
    v_world := nullif(btrim(p_payload->>'world'), '');

    insert into public.posts (
      author_id,
      title,
      body,
      world,
      visibility,
      state
    ) values (
      v_ai_profile,
      left(v_title, 90),
      v_body,
      v_world,
      'public',
      'active'
    ) returning id into v_target_id;

  elsif p_action = 'reply_comment' then
    v_post_id := (p_payload->>'post_id')::uuid;
    if p_payload->>'parent_id' is not null and (p_payload->>'parent_id') ~* '^[0-9a-f-]{36}$' then
      v_parent_id := (p_payload->>'parent_id')::uuid;
    end if;

    if v_post_id is null or v_body is null or char_length(v_body) < 1 or char_length(v_body) > 2000 then
      raise exception 'reply requires post_id and body (1-2000 chars)' using errcode = 'invalid_parameter_value';
    end if;

    insert into public.comments (
      post_id,
      parent_id,
      author_id,
      body,
      state
    ) values (
      v_post_id,
      v_parent_id,
      v_ai_profile,
      v_body,
      'active'
    ) returning id into v_target_id;

  elsif p_action = 'create_poll' then
    v_question := coalesce(v_title, 'Hallyu community poll');
    select array_agg(opt) into v_options
      from jsonb_array_elements_text(coalesce(p_payload->'options', '[]'::jsonb)) as opt;

    if array_length(v_options, 1) is null or array_length(v_options, 1) < 2 then
      raise exception 'poll requires at least 2 options' using errcode = 'invalid_parameter_value';
    end if;

    insert into public.posts (
      author_id,
      title,
      body,
      visibility,
      state
    ) values (
      v_ai_profile,
      left(v_question, 90),
      v_body,
      'public',
      'active'
    ) returning id into v_target_id;

    perform public.create_post_poll(v_target_id, v_question, v_options, coalesce((p_payload->>'hours')::integer, 168));
  end if;

  -- Record in the publication ledger (task_id, action is unique so retried task cannot duplicate)
  insert into public.hallyu_ai_publication (
    task_id,
    action,
    title,
    body,
    payload,
    sources,
    status,
    target_id,
    published_at
  ) values (
    p_task_id,
    p_action,
    v_title,
    v_body,
    p_payload,
    p_sources,
    'published',
    v_target_id,
    now()
  )
  on conflict (task_id, action) do update
    set status = 'published',
        target_id = excluded.target_id,
        published_at = now(),
        error = null
  returning id into v_pub_id;

  return jsonb_build_object(
    'success', true,
    'publication_id', v_pub_id,
    'target_id', v_target_id,
    'action', p_action
  );
end;
$$;

comment on function public.hallyu_ai_publish(uuid, text, text, text, jsonb, jsonb) is
  'Execute and verify an AI publication (post, comment reply, poll) attributed to the official Hallyu AI profile.';

revoke all on function public.hallyu_ai_publish(uuid, text, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.hallyu_ai_publish(uuid, text, text, text, jsonb, jsonb) to service_role;

-- ── 4. Backward-compatible wrapper ───────────────────────────────────────────────────────────

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
begin
  return public.hallyu_ai_publish(
    p_task,
    p_kind,
    p_args->>'title',
    coalesce(p_args->>'body', p_args->>'question', ''),
    p_args,
    coalesce(p_args->'sources', '[]'::jsonb)
  );
end;
$$;

revoke all on function public.hallyu_ai_publish(uuid, text, jsonb) from public, anon;
grant execute on function public.hallyu_ai_publish(uuid, text, jsonb) to service_role;
