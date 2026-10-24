-- Hallyu backend — 21 catalog search, feed and analytics RPCs.
-- These are the three reads/writes the client cannot express safely as a plain PostgREST query:
-- a block-aware ranked feed, a trigram/tsvector title search, and a validated event ingest.

-- ---------------------------------------------------------------------------------------------
-- Feed: ranked, block-aware, mute-aware
-- ---------------------------------------------------------------------------------------------

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create or replace function public.feed_posts(
  p_scope text default 'for_you',
  p_world text default null,
  p_title_id uuid default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns setof public.posts
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  limit_rows integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  offset_rows integer := greatest(coalesce(p_offset, 0), 0);
begin
  if p_scope not in ('for_you', 'following', 'latest', 'title') then
    raise exception 'unknown feed scope %', p_scope using errcode = 'invalid_parameter_value';
  end if;
  if p_world is not null and not exists (select 1 from public.worlds where id = p_world) then
    raise exception 'unknown world %', p_world using errcode = 'invalid_parameter_value';
  end if;

  return query
  with visible as (
    select p.*
    from public.posts p
    where p.state = 'active'
      and p.visibility = 'public'
      and (p_world is null or p.world = p_world)
      and (p_title_id is null or p.title_id = p_title_id or p.secondary_title_id = p_title_id)
      -- Mutes and blocks are applied here, in the database, not by the client.
      and not exists (
        select 1 from public.mutes m
        where m.user_id = actor and (m.muted_user_id = p.author_id or m.muted_title_id = p.title_id)
      )
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = actor and b.blocked_id = p.author_id)
           or (b.blocked_id = actor and b.blocker_id = p.author_id)
      )
      and (
        -- A private account's posts only reach the people who follow it (plus the author).
        actor is not null and p.author_id = actor
        or not exists (select 1 from public.profiles pr where pr.id = p.author_id and pr.is_private)
      )
      and (
        p_scope <> 'following'
        or actor is null
        or exists (select 1 from public.follows f where f.follower_id = actor and f.target_id = p.author_id)
      )
  )
  select v.*
  from visible v
  order by
    case
      when p_scope = 'latest' then v.created_at
      else (v.loved_count + v.cried_count + v.screamed_count + v.swooned_count + v.laughed_count + v.furious_count) * 1.0
           + extract(epoch from (now() - v.created_at)) / -3600.0
    end desc,
    v.created_at desc
  limit limit_rows
  offset offset_rows;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Catalog search over the cached titles
-- ---------------------------------------------------------------------------------------------

-- `extensions` is in the pinned search_path because the fuzzy match below uses pg_trgm's `%`
-- operator, which migration 00 installs into the extensions schema. A function's `set search_path`
-- *replaces* the session's for the body; it does not extend it. Left out, the body does not merely
-- depend on luck — it cannot resolve: `operator does not exist: text % text`, raised while the
-- function is created if body validation is on, and on the first call if it was created with
-- validation off. (Migration 34 replaces this function with an `ilike` version, so this definition
-- only has to carry the window in between — during which the trigram index is usable.)
create or replace function public.search_titles(
  p_query text,
  p_world text default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns setof public.titles
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select t.*
  from public.titles t
  where (
      t.search_document @@ websearch_to_tsquery('simple', p_query)
      or t.title % p_query
      or coalesce(t.original_title, '') % p_query
    )
    and (p_world is null or t.world = p_world)
    and exists (select 1 from public.providers pr where pr.id = t.provider_id and pr.is_active)
  order by
    -- Popular titles that also match the words rank first.
    ts_rank_cd(t.search_document, websearch_to_tsquery('simple', p_query)) desc,
    t.year desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ---------------------------------------------------------------------------------------------
-- Analytics ingest
-- ---------------------------------------------------------------------------------------------

create or replace function public.record_event(
  p_name text,
  p_properties jsonb default '{}'::jsonb,
  p_anonymous_id uuid default null,
  p_session_id uuid default null,
  p_platform text default null,
  p_app_version text default null
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  new_id bigint;
begin
  if p_name is null or p_name !~ '^[a-z0-9_]{2,48}(\.[a-z0-9_]{2,32}){0,3}$' then
    raise exception 'event name % is not a valid event name', p_name using errcode = 'invalid_parameter_value';
  end if;

  if p_properties is null or jsonb_typeof(p_properties) <> 'object' then
    raise exception 'properties must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;

  -- Keep the property bag small: analytics are not a data lake.
  if pg_column_size(p_properties) > 2048 then
    raise exception 'event properties are too large (max 2 kB)' using errcode = 'program_limit_exceeded';
  end if;

  -- An anonymous event needs an install id; an authenticated one may omit it.
  if actor is null and p_anonymous_id is null then
    raise exception 'anonymous events require an anonymous_id' using errcode = 'invalid_parameter_value';
  end if;

  perform public.ensure_event_partition((now() at time zone 'utc')::date);

  insert into public.analytics_events (user_id, anonymous_id, session_id, name, properties, platform, app_version)
  values (actor, p_anonymous_id, p_session_id, p_name, p_properties, p_platform, left(p_app_version, 32))
  returning id into new_id;

  return new_id;
end;
$$;

grant execute on function public.feed_posts(text, text, uuid, integer, integer) to anon, authenticated;
grant execute on function public.search_titles(text, text, integer, integer) to anon, authenticated;
grant execute on function public.record_event(text, jsonb, uuid, uuid, text, text) to anon, authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
