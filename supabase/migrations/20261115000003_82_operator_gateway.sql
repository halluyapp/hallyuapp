-- 82_operator_gateway.sql
--
-- Service-role-only action gateway for the Hallyu AI Operator.
--
-- The member-facing moderation RPCs (moderate_content, suspend_user, ...) call require_moderator(),
-- which resolves a human JWT. The operator is an Edge Function running as the service role, so it
-- cannot use them. These wrappers perform the exact same state transitions, but they:
--   * refuse anything that is not the service role,
--   * attribute the action to the official AI staff profile in moderation_actions,
--   * write an operator_moderation_case row so the Control Centre can show the reasoning,
--   * write an operator_audit row.
-- They are the only path the model has to moderation. Nothing here is granted to anon/authenticated.

-- ─────────────────────────────────────────────────────────────────────────────
-- Guard
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_require_service()
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'operator gateway is service-role only' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

revoke all on function public.operator_require_service() from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Content moderation: hide / remove / restore a post or comment
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_moderate_content(
  p_target_type text,
  p_target_id uuid,
  p_action text,
  p_reason text default null,
  p_case_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_staff uuid := public.operator_staff_profile_id();
  v_state public.content_state;
  v_previous public.content_state;
  v_action_kind public.moderation_action_kind;
  v_action_id uuid;
begin
  perform public.operator_require_service();

  if p_target_type not in ('post', 'comment') then
    raise exception 'target type must be post or comment' using errcode = 'invalid_parameter_value';
  end if;
  if p_action not in ('hide', 'remove', 'restore') then
    raise exception 'action must be hide, remove or restore' using errcode = 'invalid_parameter_value';
  end if;

  if p_target_type = 'post' then
    select state into v_previous from public.posts where id = p_target_id for update;
  else
    select state into v_previous from public.comments where id = p_target_id for update;
  end if;
  if not found then
    raise exception '% % does not exist', p_target_type, p_target_id using errcode = 'no_data_found';
  end if;

  v_state := case p_action when 'hide' then 'hidden' when 'remove' then 'deleted' else 'active' end::public.content_state;

  if p_target_type = 'post' then
    update public.posts
       set state = v_state,
           deleted_at = case when v_state = 'deleted' then coalesce(deleted_at, now()) else null end,
           hidden_at = case when v_state = 'hidden' then coalesce(hidden_at, now()) else null end
     where id = p_target_id;
  else
    update public.comments
       set state = v_state,
           deleted_at = case when v_state = 'deleted' then coalesce(deleted_at, now()) else null end,
           hidden_at = case when v_state = 'hidden' then coalesce(hidden_at, now()) else null end
     where id = p_target_id;
  end if;

  v_action_kind := case p_action
    when 'hide' then 'content_hidden'
    when 'remove' then 'content_removed'
    else 'content_restored'
  end::public.moderation_action_kind;

  insert into public.moderation_actions (action, target_type, target_id, actor_id, actor_handle, reason, detail)
  values (
    v_action_kind,
    case when p_target_type = 'post' then 'post' else 'comment' end::public.moderation_target,
    p_target_id,
    v_staff,
    (select handle::text from public.profiles where id = v_staff),
    left(coalesce(p_reason, 'operator action'), 500),
    jsonb_build_object('source', 'hallyu_ai_operator', 'previous_state', v_previous, 'next_state', v_state)
  )
  returning id into v_action_id;

  if p_case_id is not null then
    update public.operator_moderation_case
       set action_taken = p_action,
           moderation_action_id = v_action_id,
           updated_at = now()
     where id = p_case_id;
  end if;

  perform public.operator_audit_write(
    'moderation.' || p_action, 'succeeded', null, v_staff, 'staff',
    p_target_type, p_target_id::text,
    jsonb_build_object('reason', p_reason, 'previous_state', v_previous, 'next_state', v_state, 'moderation_action_id', v_action_id)
  );

  return jsonb_build_object(
    'target_type', p_target_type,
    'target_id', p_target_id,
    'previous_state', v_previous,
    'state', v_state,
    'moderation_action_id', v_action_id,
    'verified', true
  );
end;
$$;

revoke all on function public.operator_moderate_content(text, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.operator_moderate_content(text, uuid, text, text, uuid) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Member enforcement: suspend / ban / restore
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_suspend_member(
  p_profile_id uuid,
  p_reason text,
  p_days integer default 7
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_staff uuid := public.operator_staff_profile_id();
  v_target public.profiles%rowtype;
  v_action_id uuid;
begin
  perform public.operator_require_service();

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'a suspension needs a reason' using errcode = 'invalid_parameter_value';
  end if;
  if p_days < 0 or p_days > 3650 then
    raise exception 'suspension length is out of range' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_target from public.profiles where id = p_profile_id for update;
  if not found then
    raise exception 'member % does not exist', p_profile_id using errcode = 'no_data_found';
  end if;
  if v_target.role <> 'member' then
    raise exception 'the operator may only suspend ordinary members' using errcode = 'insufficient_privilege';
  end if;
  if v_target.is_ai then
    raise exception 'the operator may not suspend AI staff' using errcode = 'insufficient_privilege';
  end if;

  update public.profiles set account_status = 'suspended' where id = p_profile_id;

  insert into public.moderation_actions (action, target_type, target_id, actor_id, actor_handle, reason, detail)
  values (
    'user_suspended', 'user', p_profile_id, v_staff,
    (select handle::text from public.profiles where id = v_staff),
    left(p_reason, 500),
    jsonb_build_object('source', 'hallyu_ai_operator', 'days', p_days)
  )
  returning id into v_action_id;

  perform public.operator_audit_write(
    'moderation.suspend', 'succeeded', null, v_staff, 'staff',
    'member', p_profile_id::text,
    jsonb_build_object('reason', p_reason, 'days', p_days, 'moderation_action_id', v_action_id)
  );

  return jsonb_build_object(
    'profile_id', p_profile_id,
    'account_status', 'suspended',
    'days', p_days,
    'moderation_action_id', v_action_id,
    'verified', true
  );
end;
$$;

revoke all on function public.operator_suspend_member(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.operator_suspend_member(uuid, text, integer) to service_role;

create or replace function public.operator_ban_member(
  p_profile_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_staff uuid := public.operator_staff_profile_id();
  v_target public.profiles%rowtype;
  v_action_id uuid;
begin
  perform public.operator_require_service();

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'a ban needs a reason' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_target from public.profiles where id = p_profile_id for update;
  if not found then
    raise exception 'member % does not exist', p_profile_id using errcode = 'no_data_found';
  end if;
  if v_target.role <> 'member' then
    raise exception 'the operator may only ban ordinary members' using errcode = 'insufficient_privilege';
  end if;
  if v_target.is_ai then
    raise exception 'the operator may not ban AI staff' using errcode = 'insufficient_privilege';
  end if;

  update public.profiles set account_status = 'suspended' where id = p_profile_id;

  insert into public.moderation_actions (action, target_type, target_id, actor_id, actor_handle, reason, detail)
  values (
    'user_suspended', 'user', p_profile_id, v_staff,
    (select handle::text from public.profiles where id = v_staff),
    left(p_reason, 500),
    jsonb_build_object('source', 'hallyu_ai_operator', 'permanent', true)
  )
  returning id into v_action_id;

  perform public.operator_audit_write(
    'moderation.ban', 'succeeded', null, v_staff, 'staff',
    'member', p_profile_id::text,
    jsonb_build_object('reason', p_reason, 'moderation_action_id', v_action_id)
  );

  return jsonb_build_object(
    'profile_id', p_profile_id,
    'account_status', 'suspended',
    'permanent', true,
    'moderation_action_id', v_action_id,
    'verified', true
  );
end;
$$;

revoke all on function public.operator_ban_member(uuid, text) from public, anon, authenticated;
grant execute on function public.operator_ban_member(uuid, text) to service_role;

create or replace function public.operator_restore_member(
  p_profile_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_staff uuid := public.operator_staff_profile_id();
  v_action_id uuid;
begin
  perform public.operator_require_service();

  update public.profiles set account_status = 'active' where id = p_profile_id;
  if not found then
    raise exception 'member % does not exist', p_profile_id using errcode = 'no_data_found';
  end if;

  insert into public.moderation_actions (action, target_type, target_id, actor_id, actor_handle, reason, detail)
  values (
    'user_unsuspended', 'user', p_profile_id, v_staff,
    (select handle::text from public.profiles where id = v_staff),
    left(coalesce(p_reason, 'operator restore'), 500),
    jsonb_build_object('source', 'hallyu_ai_operator')
  )
  returning id into v_action_id;

  perform public.operator_audit_write(
    'moderation.restore', 'succeeded', null, v_staff, 'staff',
    'member', p_profile_id::text,
    jsonb_build_object('reason', p_reason, 'moderation_action_id', v_action_id)
  );

  return jsonb_build_object('profile_id', p_profile_id, 'account_status', 'active', 'verified', true);
end;
$$;

revoke all on function public.operator_restore_member(uuid, text) from public, anon, authenticated;
grant execute on function public.operator_restore_member(uuid, text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Content creation: create + publish a post as the official staff account
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_create_post(
  p_title text,
  p_body text,
  p_type text default 'post',
  p_world text default null,
  p_kind text default null,
  p_spoiler text default 'none',
  p_visibility text default 'public',
  p_hashtags text[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_staff uuid := public.operator_staff_profile_id();
  v_id uuid;
begin
  perform public.operator_require_service();

  if v_staff is null then
    raise exception 'no active operator staff profile' using errcode = 'no_data_found';
  end if;
  if p_body is null or length(btrim(p_body)) < 1 then
    raise exception 'a post needs a body' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.posts (author_id, type, title, body, world, kind, spoiler, visibility, state, hashtags)
  values (
    v_staff,
    coalesce(p_type, 'post')::public.post_type,
    nullif(btrim(coalesce(p_title, '')), ''),
    left(p_body, 8000),
    p_world,
    case when p_kind is null then null else p_kind::public.discussion_kind end,
    coalesce(p_spoiler, 'none')::public.spoiler_level,
    coalesce(p_visibility, 'public')::public.visibility,
    'active'::public.content_state,
    coalesce(p_hashtags, '{}')
  )
  returning id into v_id;

  perform public.operator_audit_write(
    'content.post.create', 'succeeded', null, v_staff, 'staff',
    'post', v_id::text, jsonb_build_object('world', p_world, 'type', p_type)
  );

  return jsonb_build_object('post_id', v_id, 'state', 'active', 'verified', true);
end;
$$;

revoke all on function public.operator_create_post(text, text, text, text, text, text, text, text[]) from public, anon, authenticated;
grant execute on function public.operator_create_post(text, text, text, text, text, text, text, text[]) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Platform analytics snapshot (single round trip, real numbers)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_platform_analytics()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v jsonb;
begin
  perform public.operator_require_service();

  select jsonb_build_object(
    'generated_at', now(),
    'members_total', (select count(*) from public.profiles where deleted_at is null),
    'members_active', (select count(*) from public.profiles where account_status = 'active' and deleted_at is null),
    'members_new_7d', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'posts_total', (select count(*) from public.posts where state = 'active'),
    'posts_7d', (select count(*) from public.posts where state = 'active' and created_at > now() - interval '7 days'),
    'comments_total', (select count(*) from public.comments where state = 'active'),
    'comments_7d', (select count(*) from public.comments where state = 'active' and created_at > now() - interval '7 days'),
    'dms_total', (select count(*) from public.direct_messages),
    'reports_open', (select count(*) from public.reports where status = 'open'),
    'notifications_7d', (select count(*) from public.notifications where created_at > now() - interval '7 days'),
    'worlds', coalesce((
      select jsonb_object_agg(world, n)
      from (
        select coalesce(world, 'unspecified') as world, count(*) as n
        from public.posts where state = 'active' group by 1
      ) s
    ), '{}'::jsonb),
    'top_posts_7d', coalesce((
      select jsonb_agg(row_to_json(t))
      from (
        select p.id, left(coalesce(p.title, p.body), 80) as excerpt,
               (p.loved_count + p.cried_count + p.screamed_count + p.swooned_count + p.laughed_count + p.furious_count) as reactions,
               p.comment_count
        from public.posts p
        where p.state = 'active' and p.created_at > now() - interval '7 days'
        order by (p.loved_count + p.cried_count + p.screamed_count + p.swooned_count + p.laughed_count + p.furious_count) desc
        limit 5
      ) t
    ), '[]'::jsonb)
  ) into v;

  return v;
end;
$$;

revoke all on function public.operator_platform_analytics() from public, anon, authenticated;
grant execute on function public.operator_platform_analytics() to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Moderation queue snapshot: open reports joined to their target
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_moderation_queue(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v jsonb;
begin
  perform public.operator_require_service();

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v
  from (
    select r.id, r.target_type::text as target_type, r.target_id, r.reason,
           left(coalesce(r.detail, ''), 300) as detail, r.status::text as status,
           r.created_at,
           case r.target_type
             when 'post' then (select left(coalesce(p.body, ''), 400) from public.posts p where p.id = r.target_id)
             when 'comment' then (select left(coalesce(c.body, ''), 400) from public.comments c where c.id = r.target_id)
             else null
           end as target_excerpt,
           case r.target_type
             when 'post' then (select p.author_id from public.posts p where p.id = r.target_id)
             when 'comment' then (select c.author_id from public.comments c where c.id = r.target_id)
             else null
           end as target_author_id
    from public.reports r
    where r.status = 'open'
    order by r.created_at asc
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  ) t;

  return v;
end;
$$;

revoke all on function public.operator_moderation_queue(integer) from public, anon, authenticated;
grant execute on function public.operator_moderation_queue(integer) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Approval creation (used when an action needs a human)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_request_approval(
  p_task uuid,
  p_action text,
  p_required_role text default 'admin',
  p_detail jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_id uuid;
begin
  perform public.operator_require_service();

  insert into public.operator_approval (task_id, action, required_role, status, payload)
  values (p_task, p_action, coalesce(p_required_role, 'admin'), 'pending', coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;

  if p_task is not null then
    update public.operator_task set status = 'awaiting_approval', updated_at = now() where id = p_task;
  end if;

  perform public.operator_audit_write(
    'approval.requested', 'succeeded', p_task, public.operator_staff_profile_id(), 'staff',
    'approval', v_id::text, jsonb_build_object('action', p_action, 'required_role', p_required_role)
  );

  return v_id;
end;
$$;

revoke all on function public.operator_request_approval(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.operator_request_approval(uuid, text, text, jsonb) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Approval decision (admin, in-app)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_decide_approval(
  p_approval uuid,
  p_decision text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := public.current_profile_id();
  v_row public.operator_approval;
begin
  if v_actor is null or not public.is_admin() then
    raise exception 'admin role required' using errcode = 'insufficient_privilege';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_row from public.operator_approval where id = p_approval for update;
  if v_row.id is null then
    raise exception 'approval % not found', p_approval using errcode = 'no_data_found';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'approval already %', v_row.status using errcode = 'check_violation';
  end if;

  update public.operator_approval
     set status = p_decision, decided_by = v_actor, decided_at = now(), note = p_note
   where id = p_approval;

  if v_row.task_id is not null then
    update public.operator_task
       set status = case when p_decision = 'approved' then 'queued' else 'cancelled' end,
           available_at = now(),
           updated_at = now()
     where id = v_row.task_id;
  end if;

  perform public.operator_audit_write(
    'approval.' || p_decision, 'succeeded', v_row.task_id, v_actor, 'admin',
    'approval', p_approval::text, jsonb_build_object('note', p_note)
  );

  return jsonb_build_object('approval_id', p_approval, 'status', p_decision, 'verified', true);
end;
$$;

revoke all on function public.operator_decide_approval(uuid, text, text) from public, anon;
grant execute on function public.operator_decide_approval(uuid, text, text) to authenticated, service_role;
