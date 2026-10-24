-- Hallyu backend — 19 social RPCs.
-- Everything here is SECURITY DEFINER with a pinned search_path, authenticates the caller, and
-- validates its arguments. There is no generic "run this SQL" endpoint anywhere in this schema.

-- ---------------------------------------------------------------------------------------------
-- Reactions: toggle / swap / clear in one round trip, returning fresh counts
-- ---------------------------------------------------------------------------------------------

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create or replace function public.toggle_reaction(
  p_target_type text,
  p_target_id uuid,
  p_kind public.reaction_kind
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  existing public.reactions%rowtype;
  active boolean := false;
  result_kind public.reaction_kind := null;
  counts jsonb;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_target_type not in ('post', 'comment') then
    raise exception 'target type must be post or comment' using errcode = 'invalid_parameter_value';
  end if;

  if p_target_type = 'post' then
    if not exists (select 1 from public.posts where id = p_target_id and state = 'active') then
      raise exception 'post % is not available', p_target_id using errcode = 'no_data_found';
    end if;
  else
    if not exists (select 1 from public.comments where id = p_target_id and state = 'active') then
      raise exception 'comment % is not available', p_target_id using errcode = 'no_data_found';
    end if;
  end if;

  if p_target_type = 'post' then
    select * into existing from public.reactions where user_id = actor and post_id = p_target_id;
  else
    select * into existing from public.reactions where user_id = actor and comment_id = p_target_id;
  end if;

  if found and existing.kind = p_kind then
    -- Same reaction again = take it back.
    delete from public.reactions where id = existing.id;
    active := false;
    result_kind := null;
  elsif found then
    update public.reactions set kind = p_kind, created_at = now() where id = existing.id;
    active := true;
    result_kind := p_kind;
  else
    if p_target_type = 'post' then
      insert into public.reactions (user_id, kind, post_id) values (actor, p_kind, p_target_id);
    else
      insert into public.reactions (user_id, kind, comment_id) values (actor, p_kind, p_target_id);
    end if;
    active := true;
    result_kind := p_kind;
  end if;

  if p_target_type = 'post' then
    select jsonb_build_object(
      'loved', loved_count, 'cried', cried_count, 'screamed', screamed_count,
      'swooned', swooned_count, 'laughed', laughed_count, 'furious', furious_count
    ) into counts
    from public.posts where id = p_target_id;
  else
    select jsonb_build_object(
      'loved', loved_count, 'cried', cried_count, 'screamed', screamed_count,
      'swooned', swooned_count, 'laughed', laughed_count, 'furious', furious_count
    ) into counts
    from public.comments where id = p_target_id;
  end if;

  return jsonb_build_object('active', active, 'kind', result_kind, 'counts', counts);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Saves
-- ---------------------------------------------------------------------------------------------

create or replace function public.toggle_save(p_post_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  removed integer;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  delete from public.saves where user_id = actor and post_id = p_post_id;
  get diagnostics removed = row_count;

  if removed > 0 then
    return false;
  end if;

  if not exists (select 1 from public.posts where id = p_post_id and state = 'active') then
    raise exception 'post % is not available', p_post_id using errcode = 'no_data_found';
  end if;

  insert into public.saves (user_id, post_id) values (actor, p_post_id);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Follow: one RPC, four edge tables
-- ---------------------------------------------------------------------------------------------

create or replace function public.set_follow(
  p_kind text,
  p_target_id uuid,
  p_on boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_kind not in ('user', 'title', 'person', 'collection') then
    raise exception 'unknown follow kind %', p_kind using errcode = 'invalid_parameter_value';
  end if;

  -- The target must exist. Doing it per branch keeps a real foreign key on every edge table.
  if p_kind = 'user' and not exists (select 1 from public.profiles where id = p_target_id and account_status = 'active') then
    raise exception 'profile % is not available', p_target_id using errcode = 'no_data_found';
  elsif p_kind = 'title' and not exists (select 1 from public.titles where id = p_target_id) then
    raise exception 'title % does not exist', p_target_id using errcode = 'no_data_found';
  elsif p_kind = 'person' and not exists (select 1 from public.people where id = p_target_id) then
    raise exception 'person % does not exist', p_target_id using errcode = 'no_data_found';
  elsif p_kind = 'collection' and not exists (select 1 from public.collections where id = p_target_id) then
    raise exception 'collection % does not exist', p_target_id using errcode = 'no_data_found';
  end if;

  if p_kind = 'user' and p_on and p_target_id = actor then
    raise exception 'you cannot follow yourself' using errcode = 'check_violation';
  end if;

  -- No follow may exist across a block in either direction.
  if p_on and exists (
    select 1 from public.blocks b
    where (b.blocker_id = actor and b.blocked_id = p_target_id)
       or (b.blocked_id = actor and b.blocker_id = p_target_id)
  ) then
    raise exception 'this member is blocked' using errcode = 'check_violation';
  end if;

  if p_on then
    if p_kind = 'user' then
      insert into public.follows (follower_id, target_id) values (actor, p_target_id) on conflict do nothing;
    elsif p_kind = 'title' then
      insert into public.title_follows (user_id, title_id) values (actor, p_target_id) on conflict do nothing;
    elsif p_kind = 'person' then
      insert into public.person_follows (user_id, person_id) values (actor, p_target_id) on conflict do nothing;
    else
      insert into public.collection_follows (user_id, collection_id) values (actor, p_target_id) on conflict do nothing;
    end if;
    return true;
  end if;

  if p_kind = 'user' then
    delete from public.follows where follower_id = actor and target_id = p_target_id;
  elsif p_kind = 'title' then
    delete from public.title_follows where user_id = actor and title_id = p_target_id;
  elsif p_kind = 'person' then
    delete from public.person_follows where user_id = actor and person_id = p_target_id;
  else
    delete from public.collection_follows where user_id = actor and collection_id = p_target_id;
  end if;

  return false;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Block / mute
-- ---------------------------------------------------------------------------------------------

create or replace function public.set_block(p_user_id uuid, p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_user_id = actor then
    raise exception 'you cannot block yourself' using errcode = 'check_violation';
  end if;

  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'profile % does not exist', p_user_id using errcode = 'no_data_found';
  end if;

  if p_on then
    insert into public.blocks (blocker_id, blocked_id) values (actor, p_user_id) on conflict do nothing;
    -- A block severs the relationship in both directions, in the same transaction.
    delete from public.follows
    where (follower_id = actor and target_id = p_user_id) or (follower_id = p_user_id and target_id = actor);
    return true;
  end if;

  delete from public.blocks where blocker_id = actor and blocked_id = p_user_id;
  return false;
end;
$$;

create or replace function public.set_mute(
  p_kind text,
  p_target_id uuid,
  p_on boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_kind = 'user' then
    if p_target_id = actor then
      raise exception 'you cannot mute yourself' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from public.profiles where id = p_target_id) then
      raise exception 'profile % does not exist', p_target_id using errcode = 'no_data_found';
    end if;
    if p_on then
      insert into public.mutes (user_id, muted_user_id) values (actor, p_target_id)
      on conflict (user_id, muted_user_id) where muted_user_id is not null do nothing;
    else
      delete from public.mutes where user_id = actor and muted_user_id = p_target_id;
    end if;
    return p_on;
  elsif p_kind = 'title' then
    if not exists (select 1 from public.titles where id = p_target_id) then
      raise exception 'title % does not exist', p_target_id using errcode = 'no_data_found';
    end if;
    if p_on then
      insert into public.mutes (user_id, muted_title_id) values (actor, p_target_id)
      on conflict (user_id, muted_title_id) where muted_title_id is not null do nothing;
    else
      delete from public.mutes where user_id = actor and muted_title_id = p_target_id;
    end if;
    return p_on;
  end if;

  raise exception 'unknown mute kind %', p_kind using errcode = 'invalid_parameter_value';
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Notification inbox
-- ---------------------------------------------------------------------------------------------

create or replace function public.mark_notifications_read(
  p_ids uuid[] default null,
  p_group public.notification_group default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  updated integer;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  update public.notifications
     set read_at = coalesce(read_at, now())
   where recipient_id = actor
     and read_at is null
     and (p_ids is null or id = any(p_ids))
     and (p_group is null or "group" = p_group);
  get diagnostics updated = row_count;

  return updated;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Push registration (the only path that may move a token between members)
-- ---------------------------------------------------------------------------------------------

create or replace function public.register_push_token(
  p_token text,
  p_platform public.push_platform,
  p_device_name text default null,
  p_app_version text default null,
  p_locale text default null
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
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  insert into public.push_tokens as t (user_id, token, platform, device_name, app_version, locale)
  values (actor, p_token, p_platform, p_device_name, p_app_version, p_locale)
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        device_name = excluded.device_name,
        app_version = excluded.app_version,
        locale = excluded.locale,
        last_seen_at = now(),
        disabled_at = null
  returning t.id into row_id;

  return row_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------------------------

create or replace function public.report_content(
  p_target_type text,
  p_target_id uuid,
  p_reason text,
  p_detail text default null
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
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_target_type not in ('post', 'comment', 'user', 'title', 'collection') then
    raise exception 'unknown report target type %', p_target_type using errcode = 'invalid_parameter_value';
  end if;

  -- The target has to exist in the table the caller named — a report cannot be filed against nothing.
  if p_target_type = 'post' and not exists (select 1 from public.posts where id = p_target_id) then
    raise exception 'post % does not exist', p_target_id using errcode = 'no_data_found';
  elsif p_target_type = 'comment' and not exists (select 1 from public.comments where id = p_target_id) then
    raise exception 'comment % does not exist', p_target_id using errcode = 'no_data_found';
  elsif p_target_type = 'user' and not exists (select 1 from public.profiles where id = p_target_id) then
    raise exception 'profile % does not exist', p_target_id using errcode = 'no_data_found';
  elsif p_target_type = 'title' and not exists (select 1 from public.titles where id = p_target_id) then
    raise exception 'title % does not exist', p_target_id using errcode = 'no_data_found';
  elsif p_target_type = 'collection' and not exists (select 1 from public.collections where id = p_target_id) then
    raise exception 'collection % does not exist', p_target_id using errcode = 'no_data_found';
  end if;

  -- One open report per reporter per target; adding detail later is an update, not a second report.
  select id into row_id
  from public.reports
  where reporter_id = actor and target_type = p_target_type and target_id = p_target_id and status = 'open'
  limit 1;

  if row_id is not null then
    update public.reports set detail = coalesce(p_detail, detail) where id = row_id;
    return row_id;
  end if;

  insert into public.reports (reporter_id, target_type, target_id, reason, detail)
  values (actor, p_target_type, p_target_id, left(btrim(p_reason), 60), left(p_detail, 1000))
  returning id into row_id;

  return row_id;
end;
$$;

-- Grants: authenticated callers only. `service_role` keeps its implicit full access.
grant execute on function public.toggle_reaction(text, uuid, public.reaction_kind) to authenticated;
grant execute on function public.toggle_save(uuid) to authenticated;
grant execute on function public.set_follow(text, uuid, boolean) to authenticated;
grant execute on function public.set_block(uuid, boolean) to authenticated;
grant execute on function public.set_mute(text, uuid, boolean) to authenticated;
grant execute on function public.mark_notifications_read(uuid[], public.notification_group) to authenticated;
grant execute on function public.register_push_token(text, public.push_platform, text, text, text) to authenticated;
grant execute on function public.report_content(text, uuid, text, text) to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
