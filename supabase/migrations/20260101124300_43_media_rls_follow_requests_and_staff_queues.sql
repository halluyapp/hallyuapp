-- Hallyu — 43: Media Storage Public-Read Parity, Post Media Realtime, Private Follow Requests,
-- Video Creator Status & Staff Moderation Studio, and Community Room Creation.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------------------------
-- 1. Storage RLS parity: allow anon + authenticated to sign/read active post media & active avatars
-- ---------------------------------------------------------------------------------------------

drop policy if exists media_read_attached_or_avatar_public on storage.objects;
create policy media_read_attached_or_avatar_public on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'media'
    and (
      exists (
        select 1
        from public.post_media m
        join public.posts p on p.id = m.post_id
        where (m.storage_path = name or m.poster_path = name)
          and p.state = 'active'
      )
      or exists (
        select 1
        from public.profiles p
        where p.avatar_path = name
          and p.account_status <> 'deleted'
      )
    )
  );

grant usage on schema storage to anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Private Profile Follow Requests
-- ---------------------------------------------------------------------------------------------

create table if not exists public.follow_requests (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  target_id    uuid not null references public.profiles (id) on delete cascade,
  status       text not null default 'pending',
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  constraint follow_requests_no_self check (requester_id <> target_id),
  constraint follow_requests_status_check check (status in ('pending', 'accepted', 'declined')),
  constraint follow_requests_unique_pair unique (requester_id, target_id)
);

create index if not exists follow_requests_target_pending_idx
  on public.follow_requests (target_id, created_at desc)
  where status = 'pending';

create index if not exists follow_requests_requester_pending_idx
  on public.follow_requests (requester_id)
  where status = 'pending';

alter table public.follow_requests enable row level security;

drop policy if exists follow_requests_participants_select on public.follow_requests;
create policy follow_requests_participants_select on public.follow_requests
  for select to authenticated
  using (requester_id = auth.uid() or target_id = auth.uid());

drop policy if exists follow_requests_requester_insert on public.follow_requests;
create policy follow_requests_requester_insert on public.follow_requests
  for insert to authenticated
  with check (requester_id = auth.uid() and requester_id <> target_id);

drop policy if exists follow_requests_participants_update on public.follow_requests;
create policy follow_requests_participants_update on public.follow_requests
  for update to authenticated
  using (requester_id = auth.uid() or target_id = auth.uid())
  with check (requester_id = auth.uid() or target_id = auth.uid());

drop policy if exists follow_requests_participants_delete on public.follow_requests;
create policy follow_requests_participants_delete on public.follow_requests
  for delete to authenticated
  using (requester_id = auth.uid() or target_id = auth.uid());

-- Upgrade set_follow(p_kind, p_target_id, p_on) with exact preserved signature so following a private
-- account cleanly creates/cancels a pending follow request instead of bypassing privacy.
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
  target_private boolean := false;
  actor_handle text;
  actor_name text;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_kind not in ('user', 'title', 'person', 'collection') then
    raise exception 'unknown follow kind %', p_kind using errcode = 'invalid_parameter_value';
  end if;

  if p_kind = 'user' then
    select p.is_private into target_private
    from public.profiles p
    where p.id = p_target_id and p.account_status = 'active';
    if not found then
      raise exception 'profile % is not available', p_target_id using errcode = 'no_data_found';
    end if;
    if p_on and p_target_id = actor then
      raise exception 'you cannot follow yourself' using errcode = 'check_violation';
    end if;
    if p_on and exists (
      select 1 from public.blocks b
      where (b.blocker_id = actor and b.blocked_id = p_target_id)
         or (b.blocker_id = p_target_id and b.blocked_id = actor)
    ) then
      raise exception 'this member is blocked' using errcode = 'check_violation';
    end if;
  elsif p_kind = 'title' and not exists (select 1 from public.titles where id = p_target_id) then
    raise exception 'title % does not exist', p_target_id using errcode = 'no_data_found';
  elsif p_kind = 'person' and not exists (select 1 from public.people where id = p_target_id) then
    raise exception 'person % does not exist', p_target_id using errcode = 'no_data_found';
  elsif p_kind = 'collection' and not exists (select 1 from public.collections where id = p_target_id) then
    raise exception 'collection % does not exist', p_target_id using errcode = 'no_data_found';
  end if;

  if p_kind = 'user' then
    if p_on then
      if exists (select 1 from public.follows where follower_id = actor and target_id = p_target_id) then
        return true;
      end if;
      if coalesce(target_private, false) then
        insert into public.follow_requests (requester_id, target_id, status, created_at, decided_at)
        values (actor, p_target_id, 'pending', now(), null)
        on conflict (requester_id, target_id) do update
          set status = 'pending',
              created_at = now(),
              decided_at = null;

        select handle, display_name into actor_handle, actor_name from public.profiles where id = actor;
        insert into public.notifications (recipient_id, actor_ids, kind, "group", title, body, deep_link)
        values (
          p_target_id,
          array[actor],
          'follow',
          'social',
          coalesce(actor_name, '@' || actor_handle) || ' requested to follow you',
          'Tap Activity to approve or decline',
          '/notifications'
        );
        return false;
      end if;
      insert into public.follows (follower_id, target_id)
      values (actor, p_target_id)
      on conflict do nothing;
      delete from public.follow_requests where requester_id = actor and target_id = p_target_id;
    else
      delete from public.follows where follower_id = actor and target_id = p_target_id;
      delete from public.follow_requests where requester_id = actor and target_id = p_target_id;
    end if;
  elsif p_kind = 'title' then
    if p_on then
      insert into public.title_follows (user_id, title_id) values (actor, p_target_id) on conflict do nothing;
    else
      delete from public.title_follows where user_id = actor and title_id = p_target_id;
    end if;
  elsif p_kind = 'person' then
    if p_on then
      insert into public.person_follows (user_id, person_id) values (actor, p_target_id) on conflict do nothing;
    else
      delete from public.person_follows where user_id = actor and person_id = p_target_id;
    end if;
  elsif p_kind = 'collection' then
    if p_on then
      insert into public.collection_follows (user_id, collection_id) values (actor, p_target_id) on conflict do nothing;
    else
      delete from public.collection_follows where user_id = actor and collection_id = p_target_id;
    end if;
  end if;

  return p_on;
end;
$$;

create or replace function public.list_follow_requests()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'incoming', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', fr.id,
          'requester_id', fr.requester_id,
          'handle', p.handle,
          'display_name', p.display_name,
          'avatar_path', p.avatar_path,
          'verified', p.verified,
          'bio', p.bio,
          'created_at', fr.created_at
        )
        order by fr.created_at desc
      )
      from public.follow_requests fr
      join public.profiles p on p.id = fr.requester_id
      where fr.target_id = auth.uid()
        and fr.status = 'pending'
        and p.account_status = 'active'
    ), '[]'::jsonb),
    'outgoing_ids', coalesce((
      select jsonb_agg(fr.target_id)
      from public.follow_requests fr
      where fr.requester_id = auth.uid()
        and fr.status = 'pending'
    ), '[]'::jsonb)
  );
$$;

create or replace function public.respond_follow_request(
  p_requester_id uuid,
  p_accept boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  my_name text;
  my_handle text;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  update public.follow_requests
     set status = case when p_accept then 'accepted' else 'declined' end,
         decided_at = now()
   where requester_id = p_requester_id
     and target_id = actor
     and status = 'pending';

  if p_accept then
    insert into public.follows (follower_id, target_id)
    values (p_requester_id, actor)
    on conflict do nothing;

    select display_name, handle into my_name, my_handle from public.profiles where id = actor;
    insert into public.notifications (recipient_id, actor_ids, kind, "group", title, body, deep_link)
    values (
      p_requester_id,
      array[actor],
      'follow',
      'social',
      coalesce(my_name, '@' || my_handle) || ' accepted your follow request',
      'You can now see their posts and watchlists',
      '/user/' || my_handle
    );
  end if;

  return jsonb_build_object('accepted', p_accept, 'requester_id', p_requester_id);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Video Creator Access Status + Staff Moderation & Community Studio RPCs
-- ---------------------------------------------------------------------------------------------

create or replace function public.my_video_access_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  my_role text := 'member';
  allowed boolean := false;
  vc_row public.video_creators%rowtype;
  req_row public.video_access_requests%rowtype;
  used_bytes bigint := 0;
begin
  if actor is null then
    return jsonb_build_object(
      'allowed', false,
      'role', 'guest',
      'status', 'signed_out',
      'monthly_budget', 0,
      'used_this_month', 0
    );
  end if;

  select role::text into my_role from public.profiles where id = actor;
  allowed := public.video_access(actor);
  select * into vc_row from public.video_creators where user_id = actor;
  select * into req_row
    from public.video_access_requests
   where user_id = actor
   order by created_at desc
   limit 1;

  if allowed then
    used_bytes := public.video_bytes_used_this_month(actor);
  end if;

  return jsonb_build_object(
    'allowed', allowed,
    'role', coalesce(my_role, 'member'),
    'status', case
      when allowed then 'approved'
      when req_row.id is not null then req_row.status
      else 'none'
    end,
    'request_id', req_row.id,
    'request_note', req_row.note,
    'decision_note', req_row.decision_note,
    'monthly_budget', coalesce(vc_row.monthly_byte_budget, case when allowed then 10737418240::bigint else 0::bigint end),
    'used_this_month', coalesce(used_bytes, 0)
  );
end;
$$;

create or replace function public.get_staff_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_moderator() then
    raise exception 'moderator role required' using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'video_requests', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'user_id', r.user_id,
          'handle', p.handle,
          'display_name', p.display_name,
          'avatar_path', p.avatar_path,
          'status', r.status,
          'note', r.note,
          'decision_note', r.decision_note,
          'created_at', r.created_at,
          'decided_at', r.decided_at
        )
        order by (r.status = 'pending') desc, r.created_at desc
      )
      from (select * from public.video_access_requests order by (status = 'pending') desc, created_at desc limit 50) r
      join public.profiles p on p.id = r.user_id
    ), '[]'::jsonb),
    'creators', public.video_creator_roster(50),
    'reports', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', rep.id,
          'target_type', rep.target_type,
          'target_id', rep.target_id,
          'reason', rep.reason,
          'detail', rep.detail,
          'status', rep.status,
          'created_at', rep.created_at,
          'reporter_handle', rp.handle,
          'post_body', (select left(po.body, 140) from public.posts po where po.id = rep.target_id)
        )
        order by rep.created_at desc
      )
      from (select * from public.reports where status = 'open' order by created_at desc limit 40) rep
      left join public.profiles rp on rp.id = rep.reporter_id
    ), '[]'::jsonb),
    'communities', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'name', c.name,
          'fandom', c.fandom,
          'description', c.description,
          'member_count', c.member_count,
          'post_count', c.post_count,
          'join_policy', c.join_policy,
          'is_locked', c.is_locked
        )
        order by c.member_count desc, c.created_at asc
      )
      from public.communities c
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.staff_grant_video_by_handle(
  p_handle text,
  p_budget_mb integer default 1024,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_uid uuid;
  clean_handle text := lower(regexp_replace(btrim(coalesce(p_handle, '')), '^@', ''));
  bytes bigint := greatest(10, least(coalesce(p_budget_mb, 1024), 102400))::bigint * 1048576::bigint;
  granted public.video_creators%rowtype;
begin
  if not public.is_moderator() then
    raise exception 'moderator role required' using errcode = 'insufficient_privilege';
  end if;

  select id into target_uid
  from public.profiles
  where lower(handle) = clean_handle
  limit 1;

  if target_uid is null then
    raise exception 'member @% was not found', clean_handle using errcode = 'no_data_found';
  end if;

  granted := public.grant_video_access(target_uid, bytes, coalesce(p_note, 'Granted via Staff Studio'));
  return jsonb_build_object('user_id', granted.user_id, 'handle', clean_handle, 'budget', granted.monthly_byte_budget);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Community Room Creation & Detail RPCs
-- ---------------------------------------------------------------------------------------------

create or replace function public.create_community_room(
  p_name text,
  p_fandom text,
  p_description text default '',
  p_cover_tone text default '#E11D48'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  clean_name text := left(btrim(coalesce(p_name, '')), 60);
  clean_fandom text := lower(btrim(coalesce(p_fandom, 'kdrama')));
  new_id uuid;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if length(clean_name) < 3 then
    raise exception 'community name must be at least 3 characters' using errcode = 'check_violation';
  end if;
  if clean_fandom not in ('kdrama', 'cdrama', 'anime', 'hollywood') then
    clean_fandom := 'kdrama';
  end if;

  insert into public.communities (
    name,
    fandom,
    description,
    cover_tone,
    owner_id,
    join_policy,
    is_locked,
    member_count
  )
  values (
    clean_name,
    clean_fandom,
    left(btrim(coalesce(p_description, '')), 300),
    coalesce(nullif(btrim(p_cover_tone), ''), '#E11D48'),
    actor,
    'open',
    false,
    1
  )
  returning id into new_id;

  insert into public.community_members (community_id, user_id, role, status)
  values (new_id, actor, 'moderator', 'active')
  on conflict (community_id, user_id) do update
    set role = 'moderator', status = 'active';

  return jsonb_build_object(
    'id', new_id,
    'name', clean_name,
    'fandom', clean_fandom,
    'description', left(btrim(coalesce(p_description, '')), 300),
    'cover_tone', coalesce(nullif(btrim(p_cover_tone), ''), '#E11D48'),
    'member_count', 1,
    'post_count', 0,
    'is_member', true
  );
end;
$$;

create or replace function public.get_community_detail(p_community_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'community', jsonb_build_object(
      'id', c.id,
      'name', c.name,
      'fandom', c.fandom,
      'description', c.description,
      'cover_tone', c.cover_tone,
      'cover_url', c.cover_url,
      'drama_id', c.drama_id,
      'member_count', c.member_count,
      'post_count', c.post_count,
      'join_policy', c.join_policy,
      'is_locked', c.is_locked,
      'owner_id', c.owner_id,
      'created_at', c.created_at
    ),
    'is_member', exists (
      select 1
      from public.community_members cm
      where cm.community_id = c.id
        and cm.user_id = auth.uid()
        and cm.status = 'active'
    ),
    'my_role', (
      select cm.role::text
      from public.community_members cm
      where cm.community_id = c.id
        and cm.user_id = auth.uid()
        and cm.status = 'active'
      limit 1
    )
  )
  from public.communities c
  where c.id = p_community_id
  limit 1;
$$;

grant execute on function public.list_follow_requests() to authenticated;
grant execute on function public.respond_follow_request(uuid, boolean) to authenticated;
grant execute on function public.my_video_access_status() to anon, authenticated;
grant execute on function public.get_staff_overview() to authenticated;
grant execute on function public.staff_grant_video_by_handle(text, integer, text) to authenticated;
grant execute on function public.create_community_room(text, text, text, text) to authenticated;
grant execute on function public.get_community_detail(uuid) to anon, authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.post_media;
    exception when duplicate_object then
      null;
    end;
    begin
      alter publication supabase_realtime add table public.follow_requests;
    exception when duplicate_object then
      null;
    end;
  end if;
end;
$$;

reset check_function_bodies;
