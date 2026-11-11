-- Repair live catalogue episode ingest, suspended-account write enforcement, and APK retention.
--
-- The episode guard introduced in migration 61 rejected the real service-role Edge Function even
-- though the other catalogue RPCs accepted it. Member identity is now active-only everywhere the
-- existing helper is used, closing both direct RLS writes and SECURITY DEFINER member RPCs for
-- suspended accounts. A separate non-deleted helper is used only for account/media deletion.
set check_function_bodies = off;

create or replace function public.current_profile_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id
    from public.profiles p
   where p.auth_sub = public.user_id()
     and p.account_status = 'active'
   limit 1;
$$;

comment on function public.current_profile_id() is
  'The active application profile for the verified Rork JWT subject. Suspended/deleted profiles resolve NULL, so member reads/writes and definer RPCs cannot act as them.';

-- Account deletion remains available to a suspended member. This helper is not granted to clients;
-- privileged definer functions use it after their own authentication and ownership checks.
create or replace function public.current_account_profile_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id
    from public.profiles p
   where p.auth_sub = public.user_id()
     and p.account_status <> 'deleted'
   limit 1;
$$;

revoke all on function public.current_account_profile_id() from public, anon, authenticated;
grant execute on function public.current_account_profile_id() to service_role;

create or replace function public.catalog_upsert_episodes(
  p_title_id uuid,
  p_season integer,
  p_episodes jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item jsonb;
  inserted integer := 0;
  keep_numbers integer[] := '{}';
  ep_number integer;
  ep_runtime smallint;
begin
  -- Match the other catalog ingest RPCs: execution is granted only to service_role. A member JWT
  -- resolves a profile; the service-role worker does not. Do not depend on a lone JWT claim setting
  -- that PostgREST does not consistently expose to this call.
  if public.current_profile_id() is not null then
    raise exception 'catalog ingest is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.titles where id = p_title_id) then
    raise exception 'title % does not exist', p_title_id using errcode = 'no_data_found';
  end if;

  if p_episodes is null or jsonb_typeof(p_episodes) <> 'array' then
    raise exception 'p_episodes must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;

  for item in select * from jsonb_array_elements(p_episodes) loop
    ep_number := coalesce(nullif(item ->> 'number', '')::integer, 0);
    if ep_number < 1 then
      continue;
    end if;

    keep_numbers := keep_numbers || ep_number;

    ep_runtime := nullif(left(item ->> 'runtime_minutes', 4), '')::smallint;
    if ep_runtime is not null and (ep_runtime < 1 or ep_runtime > 1200) then
      ep_runtime := null;
    end if;

    insert into public.title_episodes (
      title_id, season, number, title, air_date, air_time, runtime_minutes, synopsis, still_url, episode_type, catalog_synced_at
    )
    values (
      p_title_id,
      coalesce(nullif(item ->> 'season', '')::integer, p_season),
      ep_number,
      nullif(left(item ->> 'title', 200), ''),
      nullif(item ->> 'air_date', '')::date,
      nullif(left(item ->> 'air_time', 8), '')::time,
      ep_runtime,
      left(coalesce(item ->> 'synopsis', item ->> 'overview'), 2000),
      nullif(left(item ->> 'still_url', 500), ''),
      coalesce(nullif(item ->> 'episode_type', '')::smallint, 1),
      now()
    )
    on conflict (title_id, season, number) do update
      set title = coalesce(excluded.title, public.title_episodes.title),
          air_date = excluded.air_date,
          air_time = coalesce(excluded.air_time, public.title_episodes.air_time),
          runtime_minutes = coalesce(excluded.runtime_minutes, public.title_episodes.runtime_minutes),
          synopsis = coalesce(excluded.synopsis, public.title_episodes.synopsis),
          still_url = coalesce(excluded.still_url, public.title_episodes.still_url),
          episode_type = excluded.episode_type,
          catalog_synced_at = now()
    where
      public.title_episodes.title is distinct from excluded.title
      or public.title_episodes.air_date is distinct from excluded.air_date
      or public.title_episodes.air_time is distinct from excluded.air_time
      or public.title_episodes.runtime_minutes is distinct from excluded.runtime_minutes
      or public.title_episodes.synopsis is distinct from excluded.synopsis
      or public.title_episodes.still_url is distinct from excluded.still_url
      or public.title_episodes.episode_type is distinct from excluded.episode_type;

    if found then
      inserted := inserted + 1;
    end if;
  end loop;

  if cardinality(keep_numbers) > 0 then
    update public.title_episodes e
       set air_date = null,
           synopsis = coalesce(e.synopsis, 'Schedule withdrawn by the broadcaster')
     where e.title_id = p_title_id
       and e.season = p_season
       and not (e.number = any(keep_numbers))
       and not exists (
         select 1 from public.posts p
         where p.title_id = e.title_id and p.season = e.season and p.episode = e.number
       );
  end if;

  perform public.catalog_recompute_next_episode(p_title_id);
  perform public.catalog_recompute_title_state(p_title_id);

  return inserted;
end;
$$;


create or replace function public.delete_account()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := public.current_account_profile_id();
  removed_paths text[] := '{}';
  removed_count integer := 0;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.profiles where id = actor) then
    raise exception 'account profile not found' using errcode = 'no_data_found';
  end if;

  -- Queue every member-owned Storage object before removing DB metadata rows so nothing outlives the account.
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

  removed_count := public.queue_media_removal(removed_paths, 'account_deleted', actor);

  delete from public.direct_messages where sender_id = actor or recipient_id = actor;
  delete from public.follow_requests where requester_id = actor or target_id = actor;
  delete from public.hallyu_event_rsvps where user_id = actor;
  delete from public.title_ratings where user_id = actor;
  delete from public.post_poll_votes where user_id = actor;
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
  delete from public.media_uploads where user_id = actor;
  delete from public.post_shares where user_id = actor;
  delete from public.post_media where post_id in (select id from public.posts where author_id = actor);

  update public.comments
     set state = 'deleted'::public.content_state,
         deleted_at = coalesce(deleted_at, now()),
         body = '[deleted]'
   where author_id = actor;

  update public.posts
     set state = 'deleted'::public.content_state,
         deleted_at = coalesce(deleted_at, now()),
         title = null,
         body = '[deleted]',
         verdict = null,
         hashtags = '{}',
         mentions = '{}'
   where author_id = actor;

  update public.posts
     set mentions = array_remove(mentions, actor)
   where actor = any(mentions);

  update public.profiles
     set account_status = 'deleted',
         deleted_at = coalesce(deleted_at, now()),
         handle = 'deleted_' || substr(replace(actor::text, '-', ''), 1, 16),
         display_name = 'Deleted member',
         bio = null,
         avatar_path = null,
         banner_url = null,
         is_private = true,
         worlds = '{}',
         favorite_genres = '{}',
         onboarding_genres = '{}',
         favorite_title_ids = '{}'
   where id = actor;

  if not found then
    raise exception 'account deletion failed to update profile' using errcode = 'no_data_found';
  end if;

  return jsonb_build_object(
    'deleted', true,
    'user_id', actor,
    'media_objects_queued', removed_count,
    'deleted_at', now()
  );
end;
$$;

revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated, service_role;

-- Media deletion is allowed for the member's own account (including suspension) and for service
-- jobs, but a suspended caller must not become indistinguishable from a service worker here.
create or replace function public.queue_media_removal(
  p_paths text[],
  p_reason public.media_removal_reason,
  p_requested_by uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  queued integer := 0;
  actor uuid := public.current_account_profile_id();
begin
  if actor is not null and p_requested_by is distinct from actor and not public.is_moderator() then
    raise exception 'a member may only queue their own media' using errcode = 'insufficient_privilege';
  end if;

  if p_paths is null or array_length(p_paths, 1) is null then
    return 0;
  end if;

  insert into public.media_removal_queue (path, reason, requested_by)
  select distinct path, p_reason, p_requested_by
  from unnest(p_paths) as path
  where path is not null and length(btrim(path)) > 0
  on conflict (path) do nothing;

  get diagnostics queued = row_count;
  return queued;
end;
$$;

revoke all on function public.queue_media_removal(text[], public.media_removal_reason, uuid) from public, anon;
grant execute on function public.queue_media_removal(text[], public.media_removal_reason, uuid) to authenticated, service_role;

-- The former SQL trigger attempted direct storage.objects deletion, which Supabase's
-- protect_objects_delete trigger forbids. Release cleanup now uses the Storage API in the
-- release-maintenance Edge Function after CI verifies the newly published APK checksum.
drop trigger if exists app_releases_prune_trg on storage.objects;
drop function if exists public.prune_app_release_objects();

reset check_function_bodies;
