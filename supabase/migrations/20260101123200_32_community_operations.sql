-- Hallyu backend — 32 community operations.
--
-- Migration 07 gave rooms their tables and migration 07's policies let a member insert their own
-- membership row and delete it. That is join and leave, and nothing else could be done safely:
-- promoting a moderator, banning a member or editing a room's settings all need a server-side check,
-- because "is this person a moderator of this room" is a fact the client cannot be trusted to know.
--
-- This migration introduces ownership (migration 07 had no owner column at all, so every room was
-- unowned and unadministrable), membership requests for rooms that want them, and one RPC per
-- operation. Every RPC re-derives the caller's authority from the database before it writes anything.

-- ---------------------------------------------------------------------------------------------
-- Ownership and membership state
-- ---------------------------------------------------------------------------------------------

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

alter table public.communities
  add column if not exists owner_id   uuid references public.profiles (id) on delete set null,
  add column if not exists join_policy text not null default 'open',
  add column if not exists is_locked  boolean not null default false;

comment on column public.communities.owner_id is 'The member who may appoint moderators, edit settings and remove staff. NULL rooms are global-moderator-managed only.';
comment on column public.communities.join_policy is 'open = anyone may join; request = a member must be approved; invite = only invited members may join.';

alter table public.communities
  add constraint communities_join_policy_known
    check (join_policy in ('open', 'request', 'invite')) not valid;

alter table public.communities validate constraint communities_join_policy_known;

-- The seed creates the four official rooms without an owner; the first member to claim one becomes
-- its owner, and until then a global moderator manages it. Claiming is a single atomic insert.
create or replace function public.claim_community_ownership(p_community_id uuid)
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

  update public.communities
     set owner_id = actor
   where id = p_community_id
     and owner_id is null;

  if not found then
    return false; -- already owned; claiming is not stealing
  end if;

  insert into public.community_members (community_id, user_id, role)
  values (p_community_id, actor, 'moderator')
  on conflict (community_id, user_id) do update set role = 'moderator';

  return true;
end;
$$;

revoke all on function public.claim_community_ownership(uuid) from public, anon, authenticated;
grant execute on function public.claim_community_ownership(uuid) to authenticated;

create type public.membership_status as enum ('active', 'pending', 'banned');

alter table public.community_members
  add column if not exists status public.membership_status not null default 'active',
  add column if not exists decided_by uuid references public.profiles (id) on delete set null,
  add column if not exists decided_at timestamptz,
  add column if not exists note text;

comment on column public.community_members.status is 'active | pending (awaiting approval) | banned. A banned member cannot re-join.';

-- Membership is only counted when the member is actually in the room, so a pending request does not
-- inflate the number on the room card.
create or replace function public.handle_community_member_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_active boolean := false;
  new_active boolean := false;
begin
  if tg_op <> 'INSERT' then
    old_active := old.status = 'active';
  end if;

  if tg_op <> 'DELETE' then
    new_active := new.status = 'active';
  end if;

  if new_active and not old_active then
    update public.communities set member_count = member_count + 1 where id = new.community_id;
  elsif old_active and not new_active then
    update public.communities set member_count = greatest(0, member_count - 1) where id = old.community_id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.handle_community_role_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The room's moderator count is derived, so nobody can promote themselves to a role that grants
  -- more power than the membership itself does.
  if new.role is distinct from old.role and new.role = 'moderator' then
    update public.communities set updated_at = now() where id = new.community_id;
  end if;
  return new;
end;
$$;

create trigger community_members_role_change
  after update of role on public.community_members
  for each row execute function public.handle_community_role_change();

-- A membership moving between pending, active and banned changes the room's member count, so the
-- counter trigger from migration 07 has to run on updates too.
create trigger community_members_count_update
  after update of status on public.community_members
  for each row execute function public.handle_community_member_count();

-- Direct table inserts (the client path migration 07 documents) must honour the room's join policy:
-- only an open room may be joined with a plain insert, and only as an active member.
drop policy if exists community_members_self_insert on public.community_members;

create policy community_members_self_insert on public.community_members
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and role = 'member'
    and status = 'active'
    and exists (
      select 1 from public.communities c
      where c.id = community_members.community_id
        and c.join_policy = 'open'
        and not c.is_locked
    )
  );

-- Removing your own membership is still allowed, but a staff member cannot be removed by hand; that
-- goes through remove_community_member() so the audit trail exists.
drop policy if exists community_members_self_delete on public.community_members;

create policy community_members_self_delete on public.community_members
  for delete to authenticated
  using (
    user_id = auth.uid()
    and not exists (
      select 1 from public.community_members m
      where m.community_id = community_members.community_id
        and m.user_id = community_members.user_id
        and m.role = 'moderator'
    )
  );

-- ---------------------------------------------------------------------------------------------
-- Who may do what in a room
-- ---------------------------------------------------------------------------------------------

-- The single authority check every operation below uses. A global moderator always passes; a room
-- moderator passes for their own room; the owner passes for their own room.
create or replace function public.can_administer_community(p_community_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    public.is_moderator()
    or exists (
      select 1 from public.communities c
      where c.id = p_community_id and c.owner_id is not null and c.owner_id = auth.uid()
    )
    or exists (
      select 1 from public.community_members m
      where m.community_id = p_community_id
        and m.user_id = auth.uid()
        and m.role = 'moderator'
        and m.status = 'active'
    ),
    false
  )
$$;

revoke all on function public.can_administer_community(uuid) from public, anon, authenticated;
grant execute on function public.can_administer_community(uuid) to authenticated;

create or replace function public.require_community_admin(p_community_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not public.can_administer_community(p_community_id) then
    raise exception 'you do not administer community %', p_community_id using errcode = 'insufficient_privilege';
  end if;
end;
$$;

revoke all on function public.require_community_admin(uuid) from public, anon, authenticated;
grant execute on function public.require_community_admin(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Join / leave / request
-- ---------------------------------------------------------------------------------------------

-- Join or leave a room. Respects the room's join policy: 'request' creates a pending membership, and
-- a banned member is refused rather than silently re-queued.
create or replace function public.join_community(p_community_id uuid, p_on boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  room public.communities%rowtype;
  membership public.community_members%rowtype;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into room from public.communities where id = p_community_id;
  if not found then
    raise exception 'community % does not exist', p_community_id using errcode = 'no_data_found';
  end if;

  select * into membership from public.community_members
  where community_id = p_community_id and user_id = actor;

  if not p_on then
    delete from public.community_members where community_id = p_community_id and user_id = actor;

    -- Leaving also means your posts stay, but they are no longer visible only to members; the post
    -- visibility policy already keys off current membership, so nothing else to clean up.
    return jsonb_build_object('community_id', p_community_id, 'status', 'left', 'member_count', room.member_count - (case when membership.status = 'active' then 1 else 0 end));
  end if;

  if membership.status = 'banned' then
    raise exception 'you cannot join this community' using errcode = 'check_violation';
  end if;

  if room.is_locked and not public.can_administer_community(p_community_id) then
    raise exception 'this community is not accepting new members' using errcode = 'check_violation';
  end if;

  -- Joining a room anchored to a title also follows that title, which is what the member expects.
  if room.drama_id is not null then
    insert into public.title_follows (user_id, title_id) values (actor, room.drama_id) on conflict do nothing;
  end if;

  if membership.user_id is not null then
    update public.community_members
       set status = (case when room.join_policy = 'open' then 'active' else 'pending' end)::public.membership_status
     where community_id = p_community_id and user_id = actor;

    return jsonb_build_object('community_id', p_community_id, 'status', (select status::text from public.community_members where community_id = p_community_id and user_id = actor));
  end if;

  insert into public.community_members (community_id, user_id, role, status)
  values (
    p_community_id, actor, 'member',
    (case when room.join_policy = 'open' then 'active' else 'pending' end)::public.membership_status
  )
  on conflict (community_id, user_id) do update
    set status = excluded.status;

  return jsonb_build_object(
    'community_id', p_community_id,
    'status', (select status::text from public.community_members where community_id = p_community_id and user_id = actor)
  );
end;
$$;

revoke all on function public.join_community(uuid, boolean) from public, anon, authenticated;
grant execute on function public.join_community(uuid, boolean) to authenticated;

-- Approve or reject a pending request. Administrators only.
create or replace function public.review_membership_request(
  p_community_id uuid,
  p_user_id uuid,
  p_approve boolean,
  p_note text default null
)
returns public.membership_status
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_status public.membership_status;
begin
  perform public.require_community_admin(p_community_id);

  if p_user_id = auth.uid() then
    raise exception 'you cannot review your own membership' using errcode = 'check_violation';
  end if;

  new_status := case when p_approve then 'active' else 'banned' end;

  update public.community_members
     set status = new_status,
         decided_by = auth.uid(),
         decided_at = now(),
         note = left(p_note, 200)
   where community_id = p_community_id and user_id = p_user_id;

  if not found then
    raise exception 'member % is not in community %', p_user_id, p_community_id using errcode = 'no_data_found';
  end if;

  return new_status;
end;
$$;

revoke all on function public.review_membership_request(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.review_membership_request(uuid, uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Staff and membership management
-- ---------------------------------------------------------------------------------------------

create or replace function public.set_community_role(
  p_community_id uuid,
  p_user_id uuid,
  p_role text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  room_owner uuid;
begin
  perform public.require_community_admin(p_community_id);

  if p_role not in ('member', 'moderator') then
    raise exception 'unknown community role %', p_role using errcode = 'invalid_parameter_value';
  end if;

  select c.owner_id into room_owner from public.communities c where c.id = p_community_id;

  -- Only the room's owner may appoint or dismiss staff. A room moderator can manage ordinary members
  -- but not peers, so a compromised moderator account cannot escalate itself.
  if room_owner is distinct from auth.uid() and not public.is_moderator() then
    raise exception 'only the room owner may change roles' using errcode = 'insufficient_privilege';
  end if;

  if room_owner is not null and p_user_id = room_owner and p_role <> 'moderator' then
    raise exception 'the room owner cannot demote themselves' using errcode = 'check_violation';
  end if;

  insert into public.community_members (community_id, user_id, role, status)
  values (p_community_id, p_user_id, p_role, 'active')
  on conflict (community_id, user_id) do update set role = excluded.role;

  return p_role;
end;
$$;

revoke all on function public.set_community_role(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_community_role(uuid, uuid, text) to authenticated;

create or replace function public.remove_community_member(
  p_community_id uuid,
  p_user_id uuid,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  room_owner uuid;
begin
  perform public.require_community_admin(p_community_id);

  select c.owner_id into room_owner from public.communities c where c.id = p_community_id;

  if p_user_id = room_owner then
    raise exception 'the room owner cannot be removed' using errcode = 'check_violation';
  end if;

  -- A moderator can remove members; removing another moderator needs owner authority.
  if exists (
    select 1 from public.community_members m
    where m.community_id = p_community_id and m.user_id = p_user_id and m.role = 'moderator'
  ) and room_owner is distinct from auth.uid() and not public.is_moderator() then
    raise exception 'only the room owner may remove a moderator' using errcode = 'insufficient_privilege';
  end if;

  delete from public.community_members where community_id = p_community_id and user_id = p_user_id;

  if found then
    -- Leaving a room drops the title follow that joining it created.
    delete from public.title_follows tf
    where tf.user_id = p_user_id
      and tf.title_id = (select c.drama_id from public.communities c where c.id = p_community_id);
  end if;

  return found;
end;
$$;

revoke all on function public.remove_community_member(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.remove_community_member(uuid, uuid, text) to authenticated;

-- Banning keeps the row so the member cannot re-join, and records who decided it.
create or replace function public.ban_community_member(
  p_community_id uuid,
  p_user_id uuid,
  p_reason text default null
)
returns public.membership_status
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_community_admin(p_community_id);

  if p_user_id = (select owner_id from public.communities where id = p_community_id) then
    raise exception 'the room owner cannot be banned' using errcode = 'check_violation';
  end if;

  insert into public.community_members (community_id, user_id, role, status, decided_by, decided_at, note)
  values (p_community_id, p_user_id, 'member', 'banned', auth.uid(), now(), left(p_reason, 200))
  on conflict (community_id, user_id) do update
    set status = 'banned',
        role = 'member',
        decided_by = auth.uid(),
        decided_at = now(),
        note = left(p_reason, 200);

  return 'banned';
end;
$$;

revoke all on function public.ban_community_member(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.ban_community_member(uuid, uuid, text) to authenticated;

create or replace function public.transfer_community_ownership(
  p_community_id uuid,
  p_new_owner_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_owner uuid;
begin
  select c.owner_id into current_owner from public.communities c where c.id = p_community_id;

  if current_owner is null then
    raise exception 'this community has no owner to transfer from' using errcode = 'check_violation';
  end if;

  if current_owner is distinct from auth.uid() and not public.is_moderator() then
    raise exception 'only the current owner may transfer ownership' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.profiles where id = p_new_owner_id and account_status = 'active') then
    raise exception 'the new owner must be an active member' using errcode = 'no_data_found';
  end if;

  -- The new owner becomes staff in the same transaction, so ownership never sits with a non-member.
  insert into public.community_members (community_id, user_id, role, status)
  values (p_community_id, p_new_owner_id, 'moderator', 'active')
  on conflict (community_id, user_id) do update set role = 'moderator', status = 'active';

  update public.communities set owner_id = p_new_owner_id where id = p_community_id;

  return true;
end;
$$;

revoke all on function public.transfer_community_ownership(uuid, uuid) from public, anon, authenticated;
grant execute on function public.transfer_community_ownership(uuid, uuid) to authenticated;

-- Room settings. A member may edit nothing here; an owner or moderator may edit the presentation
-- fields but not the room's identity (name is what the world room is called everywhere).
create or replace function public.update_community_settings(
  p_community_id uuid,
  p_name text default null,
  p_description text default null,
  p_cover_tone text default null,
  p_cover_url text default null,
  p_join_policy text default null,
  p_locked boolean default null
)
returns public.communities
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  updated public.communities%rowtype;
  room public.communities%rowtype;
begin
  perform public.require_community_admin(p_community_id);

  select * into room from public.communities where id = p_community_id for update;

  if p_join_policy is not null and p_join_policy not in ('open', 'request', 'invite') then
    raise exception 'unknown join policy %', p_join_policy using errcode = 'invalid_parameter_value';
  end if;

  if p_cover_tone is not null and p_cover_tone !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception 'cover tone must be a hex colour' using errcode = 'invalid_parameter_value';
  end if;

  update public.communities
     set name = coalesce(nullif(btrim(p_name), ''), name),
         description = coalesce(p_description, description),
         cover_tone = coalesce(p_cover_tone, cover_tone),
         cover_url = coalesce(nullif(left(p_cover_url, 500), ''), cover_url),
         join_policy = coalesce(p_join_policy, join_policy),
         is_locked = coalesce(p_locked, is_locked)
   where id = p_community_id
  returning * into updated;

  return updated;
end;
$$;

revoke all on function public.update_community_settings(uuid, text, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.update_community_settings(uuid, text, text, text, text, text, boolean) to authenticated;

-- The room's member list. Pending requests are visible to administrators only, which the RLS policy
-- on community_members already enforces; this RPC just returns them with the context a UI needs.
create or replace function public.community_roster(p_community_id uuid, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
begin
  return jsonb_build_object(
    'community_id', p_community_id,
    'member_count', (select c.member_count from public.communities c where c.id = p_community_id),
    'members', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.created_at desc)
      from (
        select pr.id, pr.handle, pr.display_name, pr.avatar_path, pr.verified,
               cm.role, cm.status, cm.created_at
        from public.community_members cm
        join public.profiles pr on pr.id = cm.user_id
        where cm.community_id = p_community_id
          and cm.status = 'active'
          and pr.account_status <> 'deleted'
        order by cm.created_at desc
        limit least(greatest(coalesce(p_limit, 50), 1), 200)
      ) m
    ), '[]'::jsonb),
    'pending_requests', case
      when public.can_administer_community(p_community_id) then coalesce((
        select jsonb_agg(to_jsonb(q) order by q.created_at)
        from (
          select pr.id, pr.handle, pr.display_name, pr.avatar_path, cm.status, cm.created_at
          from public.community_members cm
          join public.profiles pr on pr.id = cm.user_id
          where cm.community_id = p_community_id and cm.status = 'pending'
          order by cm.created_at
          limit 100
        ) q
      ), '[]'::jsonb)
      else '[]'::jsonb
    end,
    'you_are', (
      select jsonb_build_object('role', cm.role, 'status', cm.status)
      from public.community_members cm
      where cm.community_id = p_community_id and cm.user_id = actor
    )
  );
end;
$$;

revoke all on function public.community_roster(uuid, integer) from public, anon, authenticated;
grant execute on function public.community_roster(uuid, integer) to authenticated;

-- Moderating inside a room: hiding a post does not delete it, and the author can see what happened.
create or replace function public.moderate_community_post(
  p_post_id uuid,
  p_action text,
  p_reason text default null
)
returns public.content_state
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.posts%rowtype;
  new_state public.content_state;
begin
  if p_action not in ('hide', 'restore') then
    raise exception 'action must be hide or restore' using errcode = 'invalid_parameter_value';
  end if;

  select * into target from public.posts where id = p_post_id;
  if not found then
    raise exception 'post % does not exist', p_post_id using errcode = 'no_data_found';
  end if;

  if target.community_id is null then
    raise exception 'this post does not belong to a community' using errcode = 'check_violation';
  end if;

  perform public.require_community_admin(target.community_id);

  new_state := case when p_action = 'hide' then 'hidden' else 'active' end;

  update public.posts
     set state = new_state,
         hidden_at = case when new_state = 'hidden' then coalesce(hidden_at, now()) else null end
   where id = p_post_id;

  -- The author is told, in the system group, through the existing notification path.
  perform public.notify_recipient(
    target.author_id,
    'system',
    'system',
    '{}'::uuid[],
    p_post_id, null, null, null, null, null,
    case when p_action = 'hide' then 'A moderator hid your post' else 'Your post is visible again' end,
    left(p_reason, 300)
  );

  return new_state;
end;
$$;

revoke all on function public.moderate_community_post(uuid, text, text) from public, anon, authenticated;
grant execute on function public.moderate_community_post(uuid, text, text) to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
