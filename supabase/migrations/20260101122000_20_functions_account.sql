-- Hallyu backend — 20 account RPCs.
-- Preference merges, onboarding, watchlist writes, the cold-start bootstrap read, and the one
-- destructive operation the product exposes: delete_account().

-- ---------------------------------------------------------------------------------------------
-- Preferences: an allow-listed merge, never an arbitrary column write
-- ---------------------------------------------------------------------------------------------

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create or replace function public.merge_preferences(p_patch jsonb)
returns public.user_preferences
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  merged public.user_preferences%rowtype;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'patch must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;

  -- An allow-listed merge. Each key is read with its own type cast, so a client cannot smuggle an
  -- arbitrary column write in through the patch object, and an unknown key is simply ignored.
  update public.user_preferences p
     set protection = case when p_patch ? 'protection' then (p_patch ->> 'protection')::public.protection_level else p.protection end,
         autoplay = case when p_patch ? 'autoplay' then (p_patch ->> 'autoplay')::public.autoplay_mode else p.autoplay end,
         one_tap_reactions = case when p_patch ? 'one_tap_reactions' then (p_patch ->> 'one_tap_reactions')::boolean else p.one_tap_reactions end,
         muted_words = case
           when p_patch ? 'muted_words' then array(select jsonb_array_elements_text(p_patch -> 'muted_words'))
           else p.muted_words
         end,
         true_black = case when p_patch ? 'true_black' then (p_patch ->> 'true_black')::boolean else p.true_black end,
         personalization = case when p_patch ? 'personalization' then (p_patch ->> 'personalization')::boolean else p.personalization end,
         reduce_motion = case when p_patch ? 'reduce_motion' then (p_patch ->> 'reduce_motion')::boolean else p.reduce_motion end,
         notify_episodes = case when p_patch ? 'notify_episodes' then (p_patch ->> 'notify_episodes')::boolean else p.notify_episodes end,
         notify_social = case when p_patch ? 'notify_social' then (p_patch ->> 'notify_social')::boolean else p.notify_social end,
         notify_highlights = case when p_patch ? 'notify_highlights' then (p_patch ->> 'notify_highlights')::boolean else p.notify_highlights end,
         notify_system = case when p_patch ? 'notify_system' then (p_patch ->> 'notify_system')::boolean else p.notify_system end,
         quiet_hours = case when p_patch ? 'quiet_hours' then (p_patch ->> 'quiet_hours')::boolean else p.quiet_hours end,
         language = case when p_patch ? 'language' then (p_patch ->> 'language') else p.language end,
         data_saver = case when p_patch ? 'data_saver' then (p_patch ->> 'data_saver')::boolean else p.data_saver end,
         terms_version = case when p_patch ? 'terms_version' then (p_patch ->> 'terms_version')::integer else p.terms_version end,
         -- Accepting the guidelines must record when; withdrawing it clears the stamp.
         guidelines_accepted = case when p_patch ? 'guidelines_accepted' then (p_patch ->> 'guidelines_accepted')::boolean else p.guidelines_accepted end,
         guidelines_accepted_at = case
           when p_patch ? 'guidelines_accepted'
             then case when (p_patch ->> 'guidelines_accepted')::boolean then now() else null end
           else p.guidelines_accepted_at
         end
   where p.user_id = actor;

  select * into merged from public.user_preferences where user_id = actor;
  return merged;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Onboarding
-- ---------------------------------------------------------------------------------------------

create or replace function public.complete_onboarding(
  p_worlds text[] default '{}',
  p_genres text[] default '{}',
  p_step integer default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  updated public.profiles%rowtype;
  unknown_world text;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select w.id into unknown_world
  from unnest(coalesce(p_worlds, '{}')) w(id)
  left join public.worlds known on known.id = w.id
  where known.id is null
  limit 1;

  if unknown_world is not null then
    raise exception 'unknown world %', unknown_world using errcode = 'invalid_parameter_value';
  end if;

  if p_step is not null and (p_step < 0 or p_step > 20) then
    raise exception 'onboarding step out of range' using errcode = 'check_violation';
  end if;

  update public.profiles
     set worlds = coalesce(p_worlds, worlds),
         onboarding_genres = coalesce(p_genres, onboarding_genres),
         onboarding_step = coalesce(p_step, onboarding_step),
         onboarding_completed = true
   where id = actor
  returning * into updated;

  return updated;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Watchlist / progress
-- ---------------------------------------------------------------------------------------------

create or replace function public.upsert_watchlist_item(
  p_title_id uuid,
  p_status public.watch_status default null,
  p_season smallint default null,
  p_episode smallint default null,
  p_total smallint default null,
  p_note text default null
)
returns public.watchlist_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  existing public.watchlist_items%rowtype;
  next_season smallint;
  next_episode smallint;
  next_status public.watch_status;
  updated public.watchlist_items%rowtype;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.titles where id = p_title_id) then
    raise exception 'title % does not exist', p_title_id using errcode = 'no_data_found';
  end if;

  select * into existing from public.watchlist_items where user_id = actor and title_id = p_title_id for update;

  next_season := coalesce(p_season, existing.season, 1);
  next_episode := coalesce(p_episode, existing.current_episode, 0);
  next_status := coalesce(p_status, existing.status, 'want');

  if next_season < 1 or next_episode < 0 then
    raise exception 'invalid season or episode' using errcode = 'check_violation';
  end if;

  -- Progress cannot move backwards inside a season; starting a new season resets the pointer.
  if found and next_season = existing.season and next_episode < existing.current_episode then
    raise exception 'progress cannot move backwards (season %, episode %)', existing.season, existing.current_episode
      using errcode = 'check_violation';
  end if;

  -- Reaching the end of a season (or asking for it) completes the title.
  if p_total is not null and p_total > 0 and next_status = 'watching' and next_episode >= p_total then
    next_status := 'completed';
  end if;

  insert into public.watchlist_items (user_id, title_id, status, season, current_episode, note, completed_at)
  values (
    actor, p_title_id, next_status, next_season, next_episode, left(p_note, 200),
    case when next_status = 'completed' then now() else null end
  )
  on conflict (user_id, title_id) do update
    set status = excluded.status,
        season = excluded.season,
        current_episode = excluded.current_episode,
        note = coalesce(excluded.note, public.watchlist_items.note),
        completed_at = excluded.completed_at
  returning * into updated;

  return updated;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Handle availability (sign-up helper)
-- ---------------------------------------------------------------------------------------------

create or replace function public.handle_is_available(p_handle text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.slugify_handle(p_handle) ~ '^[a-z0-9_.]{3,30}$'
     and not exists (select 1 from public.profiles where handle = public.slugify_handle(p_handle));
$$;

-- ---------------------------------------------------------------------------------------------
-- Cold start: one round trip for everything the app needs before its first render
-- ---------------------------------------------------------------------------------------------

create or replace function public.get_bootstrap()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  profile_row public.profiles%rowtype;
  prefs_row public.user_preferences%rowtype;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into profile_row from public.profiles where id = actor;
  if not found then
    raise exception 'profile % does not exist', actor using errcode = 'no_data_found';
  end if;

  select * into prefs_row from public.user_preferences where user_id = actor;

  return jsonb_build_object(
    'profile', to_jsonb(profile_row),
    'prefs', to_jsonb(prefs_row),
    'unread_count', (select count(*) from public.notifications where recipient_id = actor and read_at is null),
    'follows', jsonb_build_object(
      'users', coalesce((select jsonb_agg(target_id) from public.follows where follower_id = actor), '[]'::jsonb),
      'titles', coalesce((select jsonb_agg(title_id) from public.title_follows where user_id = actor), '[]'::jsonb),
      'people', coalesce((select jsonb_agg(person_id) from public.person_follows where user_id = actor), '[]'::jsonb),
      'collections', coalesce((select jsonb_agg(collection_id) from public.collection_follows where user_id = actor), '[]'::jsonb)
    ),
    'saved_post_ids', coalesce((select jsonb_agg(post_id) from public.saves where user_id = actor), '[]'::jsonb),
    'watchlist', coalesce((select jsonb_agg(to_jsonb(w)) from public.watchlist_items w where w.user_id = actor), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Account deletion
-- ---------------------------------------------------------------------------------------------

-- Soft-deletes the identity (so existing posts never dangle) and hard-deletes everything private.
-- SECURITY DEFINER because it has to reach storage.objects, which no authenticated role may write.
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

grant execute on function public.merge_preferences(jsonb) to authenticated;
grant execute on function public.complete_onboarding(text[], text[], integer) to authenticated;
grant execute on function public.upsert_watchlist_item(uuid, public.watch_status, smallint, smallint, smallint, text) to authenticated;
grant execute on function public.handle_is_available(text) to anon, authenticated;
grant execute on function public.get_bootstrap() to authenticated;
grant execute on function public.delete_account() to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
