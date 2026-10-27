-- Hallyu backend — 36 audit-log survivability and account-deletion completeness.
--
-- Two defects that the audit trail introduced, both found auditing the phase against requirement 16
-- ("deleted-account behaviour") rather than by inference:
--
--   1. `moderation_actions.actor_id` was `not null references profiles(id) on delete restrict`. That
--      is the wrong direction for an audit log. `purge_deleted_accounts()` (migration 22) hard-deletes
--      a tombstoned profile, and `delete from public.profiles` would then be refused by the foreign
--      key for any account that had ever taken a moderation action — retention would break, silently,
--      for exactly the accounts it most needs to purge.
--
--   2. `record_moderation_action()` accepts the service role as a writer (an Edge Function acting on
--      behalf of a moderator), but it stored `auth.uid()`, which is NULL for the service role. Every
--      service-role moderation action would have failed on the not-null constraint.
--
-- The fix keeps the audit record and loses only the foreign key: the moderator's handle is copied into
-- the row at write time, so the log still names who acted long after the profile is gone.
--
-- This migration also completes `delete_account()` for the tables migrations 30 and 31 introduced.
-- Those tables hold personal data, and a tombstoned profile is never deleted, so leaving them behind
-- would keep a deleted member's uploads and shares alive indefinitely.

-- ---------------------------------------------------------------------------------------------
-- 1. The audit log outlives the profile
-- ---------------------------------------------------------------------------------------------

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

alter table public.moderation_actions
  add column if not exists actor_handle text;

comment on column public.moderation_actions.actor_handle is 'The acting member''s handle, copied at write time. The log has to survive the profile it refers to.';

-- Backfill the handles that exist today, before the constraint is relaxed.
update public.moderation_actions a
   set actor_handle = p.handle
  from public.profiles p
 where p.id = a.actor_id
   and a.actor_handle is null;

alter table public.moderation_actions
  alter column actor_id drop not null;

alter table public.moderation_actions
  drop constraint if exists moderation_actions_actor_id_fkey;

alter table public.moderation_actions
  add constraint moderation_actions_actor_id_fkey
  foreign key (actor_id) references public.profiles (id) on delete set null;

alter table public.moderation_actions
  add constraint moderation_actions_actor_recorded check (actor_id is not null or actor_handle is not null);

-- The recorder now names the actor rather than only pointing at them.
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
  actor_name text;
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

  -- The handle is copied here, while the row is written, because the profile it comes from may be
  -- purged long before anybody reads this record.
  select p.handle into actor_name from public.profiles p where p.id = actor;

  if actor is null then
    actor_name := coalesce(actor_name, 'service');
  end if;

  insert into public.moderation_actions (action, target_type, target_id, actor_id, actor_handle, report_id, reason, detail, reverses_id)
  values (p_action, p_target_type, p_target_id, actor, actor_name, p_report_id, left(p_reason, 500), coalesce(p_detail, '{}'::jsonb), p_reverses_id)
  returning id into row_id;

  return row_id;
end;
$$;

revoke all on function public.record_moderation_action(public.moderation_action_kind, public.moderation_target, uuid, text, uuid, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.record_moderation_action(public.moderation_action_kind, public.moderation_target, uuid, text, uuid, jsonb, uuid)
  to authenticated, service_role;

comment on table public.moderation_actions is 'Append-only log of every privileged action. Written in the same transaction as the change it describes, and it outlives the profile it names.';

-- ---------------------------------------------------------------------------------------------
-- 2. Account deletion covers the tables added since
-- ---------------------------------------------------------------------------------------------

-- Same contract as migration 20: soft-delete the identity so replies never dangle, hard-delete
-- everything private. Only the deletion list grows — nothing about the previous behaviour changes.
create or replace function public.delete_account()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  removed_paths text[] := '{}';
  removed_count integer := 0;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- Objects this member uploaded, plus the files attached to their posts, plus their avatar.
  select coalesce(array_agg(path), '{}') into removed_paths
  from (
    select m.storage_path as path
    from public.post_media m
    join public.posts p on p.id = m.post_id
    where p.author_id = actor
    union
    select m.poster_path
    from public.post_media m
    join public.posts p on p.id = m.post_id
    where p.author_id = actor and m.poster_path is not null
    union
    select u.storage_path
    from public.media_uploads u
    where u.user_id = actor
    union
    select u.poster_path
    from public.media_uploads u
    where u.user_id = actor and u.poster_path is not null
    union
    select avatar_path from public.profiles where id = actor and avatar_path is not null
    union
    select name from storage.objects where bucket_id = 'media' and public.storage_owner(name) = actor
  ) paths;

  if array_length(removed_paths, 1) is not null then
    delete from storage.objects where bucket_id = 'media' and name = any(removed_paths);
    get diagnostics removed_count = row_count;
  end if;

  -- Private and personal data: gone.
  delete from public.notifications where recipient_id = actor;
  delete from public.notification_deliveries d
    where not exists (select 1 from public.notifications n where n.id = d.notification_id);
  delete from public.push_tokens where user_id = actor;
  delete from public.title_alerts where user_id = actor;
  delete from public.watchlist_items where user_id = actor;
  delete from public.saves where user_id = actor;
  delete from public.reactions where user_id = actor;
  delete from public.community_members where user_id = actor;
  delete from public.collection_follows where user_id = actor;
  delete from public.person_follows where user_id = actor;
  delete from public.title_follows where user_id = actor;
  delete from public.follows where follower_id = actor or target_id = actor;
  delete from public.blocks where blocker_id = actor or blocked_id = actor;
  delete from public.mutes where user_id = actor or muted_user_id = actor;
  delete from public.reports where reporter_id = actor;
  delete from public.user_preferences where user_id = actor;
  delete from public.collections where owner_id = actor;
  delete from public.analytics_events where user_id = actor;

  -- Added by migrations 30 and 31. A tombstone is never deleted, so without these the member's
  -- upload records and share history would outlive the account that owns them.
  delete from public.media_uploads where user_id = actor;
  delete from public.post_shares where user_id = actor;

  -- Mentions in other people's posts would otherwise point at a scrubbed account.
  update public.posts set mentions = array_remove(mentions, actor) where actor = any(mentions);

  -- The identity itself: kept as an anonymous tombstone so replies and posts stay readable.
  update public.profiles
     set account_status = 'deleted',
         deleted_at = coalesce(deleted_at, now()),
         display_name = 'Deleted member',
         handle = 'deleted_' || substr(replace(actor::text, '-', ''), 1, 16),
         bio = null,
         avatar_path = null,
         worlds = '{}',
         favorite_genres = '{}',
         onboarding_genres = '{}',
         is_private = true
   where id = actor;

  return jsonb_build_object(
    'deleted', true,
    'media_objects_removed', removed_count,
    'deleted_at', now()
  );
end;
$$;

revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;

-- The retention purge hard-deletes the tombstone. moderation_actions rows keep their handle and lose
-- only the reference, so this delete can no longer be refused by the audit log.
--
-- `drop function` first, for the same reason as in migration 22: migration 37 changes this function's
-- RETURNS TABLE shape (storage_objects_removed → storage_objects_queued) and PostgreSQL refuses to
-- redefine a function whose row type has changed (42P13). The grants are re-issued below regardless.
drop function if exists public.purge_deleted_accounts(interval);

create or replace function public.purge_deleted_accounts(retention interval default interval '30 days')
returns table (profiles_purged integer, storage_objects_removed integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cutoff timestamptz := now() - retention;
  doomed uuid[];
  paths text[];
  removed integer := 0;
begin
  if auth.role() not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'retention purge is service-role only' using errcode = 'insufficient_privilege';
  end if;

  select coalesce(array_agg(p.id), '{}') into doomed
  from public.profiles p
  where p.account_status = 'deleted'
    and p.deleted_at is not null
    and p.deleted_at < cutoff;

  if array_length(doomed, 1) is null then
    return query select 0, 0;
    return;
  end if;

  select coalesce(array_agg(name), '{}') into paths
  from storage.objects
  where bucket_id = 'media' and public.storage_owner(name) = any(doomed);

  if array_length(paths, 1) is not null then
    delete from storage.objects where bucket_id = 'media' and name = any(paths);
    get diagnostics removed = row_count;
  end if;

  -- Cascades clear the member's posts, comments, reactions and everything else that points at them.
  delete from public.profiles where id = any(doomed);

  return query select array_length(doomed, 1), removed;
end;
$$;

revoke all on function public.purge_deleted_accounts(interval) from public, anon, authenticated;
grant execute on function public.purge_deleted_accounts(interval) to service_role;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
