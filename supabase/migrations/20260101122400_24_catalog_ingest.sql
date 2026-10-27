-- Hallyu backend — 24 catalog ingest.
--
-- The Edge Function that talks to TMDB does no business logic. It fetches, normalises into the
-- shapes documented below, and calls these functions. Everything that decides *what a record means*
-- lives here, in one place, under the service role, so the ingest is:
--
--   idempotent  — replaying the same payload updates the same rows and creates nothing new
--   incremental — an unchanged payload writes zero rows (content_hash short-circuit)
--   safe        — a record the provider stops returning is flagged, never deleted
--
-- Every function here is SECURITY DEFINER, pins its search_path, is revoked from PUBLIC/anon/
-- authenticated, and is granted to the service role only.

-- ---------------------------------------------------------------------------------------------
-- Run bookkeeping
-- ---------------------------------------------------------------------------------------------

-- Starts a run, or returns the existing one. Replaying an idempotency key is a no-op, so a retried
-- job can never create a second row or double-count.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create or replace function public.catalog_begin_run(
  p_job text,
  p_provider_id text default 'tmdb',
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  run_id uuid;
  key text;
begin
  if actor is not null then
    raise exception 'catalog ingest is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  if p_provider_id is null or not exists (select 1 from public.providers pr where pr.id = p_provider_id and pr.is_active) then
    raise exception 'catalog provider % is not active', p_provider_id using errcode = 'no_data_found';
  end if;

  key := coalesce(p_idempotency_key, p_job || ':' || to_char(now() at time zone 'utc', 'YYYYMMDDHH24'));

  select r.id into run_id
  from public.catalog_sync_runs r
  where r.provider_id = p_provider_id and r.idempotency_key = key;

  if run_id is not null then
    return run_id;
  end if;

  insert into public.catalog_sync_runs (job, provider_id, idempotency_key, status)
  values (p_job, p_provider_id, key, 'running')
  returning id into run_id;

  insert into public.catalog_provider_state (provider_id, last_attempt_at)
  values (p_provider_id, now())
  on conflict (provider_id) do update
    set last_attempt_at = now(),
        total_requests = public.catalog_provider_state.total_requests + 1;

  return run_id;
end;
$$;

revoke all on function public.catalog_begin_run(text, text, text) from public, anon, authenticated;
grant execute on function public.catalog_begin_run(text, text, text) to service_role;

create or replace function public.catalog_finish_run(
  p_run_id uuid,
  p_status text,
  p_items_seen integer default 0,
  p_items_written integer default 0,
  p_items_unchanged integer default 0,
  p_items_missing integer default 0,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  run_row public.catalog_sync_runs%rowtype;
begin
  if auth.uid() is not null then
    raise exception 'catalog ingest is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  if p_status not in ('succeeded', 'failed', 'skipped') then
    raise exception 'invalid run status %', p_status using errcode = 'invalid_parameter_value';
  end if;

  select * into run_row from public.catalog_sync_runs where id = p_run_id for update;
  if not found then
    raise exception 'catalog sync run % does not exist', p_run_id using errcode = 'no_data_found';
  end if;

  -- A finished run is never re-finished: the numbers belong to the attempt that ran.
  if run_row.finished_at is not null then
    return;
  end if;

  update public.catalog_sync_runs
     set status = p_status,
         items_seen = greatest(items_seen, coalesce(p_items_seen, 0)),
         items_written = greatest(items_written, coalesce(p_items_written, 0)),
         items_unchanged = greatest(items_unchanged, coalesce(p_items_unchanged, 0)),
         items_missing = greatest(items_missing, coalesce(p_items_missing, 0)),
         error = left(p_error, 500),
         finished_at = now()
   where id = p_run_id;

  -- Provider health: a success clears the failure streak, a failure grows it and records the reason.
  if p_status = 'succeeded' then
    update public.catalog_provider_state
       set last_success_at = now(),
           consecutive_failures = 0,
           rate_limited_until = null,
           disabled_reason = null,
           total_items_written = public.catalog_provider_state.total_items_written + coalesce(p_items_written, 0)
     where provider_id = run_row.provider_id;
  elsif p_status = 'failed' then
    update public.catalog_provider_state
       set last_failure_at = now(),
           consecutive_failures = public.catalog_provider_state.consecutive_failures + 1,
           disabled_reason = case when public.catalog_provider_state.consecutive_failures + 1 >= 10
                                  then 'ingest failing repeatedly' else public.catalog_provider_state.disabled_reason end
     where provider_id = run_row.provider_id;
  end if;
end;
$$;

revoke all on function public.catalog_finish_run(uuid, text, integer, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.catalog_finish_run(uuid, text, integer, integer, integer, integer, text) to service_role;

-- A provider that is failing or rate limited is skipped rather than retried in a tight loop.
create or replace function public.catalog_provider_is_usable(p_provider_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select s.consecutive_failures < 10
         and (s.rate_limited_until is null or s.rate_limited_until < now())
      from public.catalog_provider_state s
      where s.provider_id = p_provider_id
    ),
    true
  )
$$;

revoke all on function public.catalog_provider_is_usable(text) from public, anon, authenticated;
grant execute on function public.catalog_provider_is_usable(text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Titles
-- ---------------------------------------------------------------------------------------------

-- Upserts one title. Returns the row id and whether anything was actually written.
--
-- Expected payload (jsonb):
--   {
--     "external_id": "1399",              -- required, provider id
--     "media_type": "tv",                -- required, 'tv' | 'movie'
--     "world": "kdrama",                 -- required, must exist in public.worlds
--     "title": "Game of Thrones",        -- required
--     "original_title": null,
--     "year": 2011,                      -- required (end of the original run / release year)
--     "status": "completed",             -- 'upcoming' | 'airing' | 'completed' | 'canceled'
--     "popularity": 123.4,               -- provider popularity, may be null
--     "vote_average": 8.4,               -- provider rating, may be null
--     "vote_count": 21000,
--     "overview": null,
--     "poster_url": null,
--     "backdrop_url": null,
--     "runtime_minutes": 60,
--     "original_language": "en",
--     "genres": ["Drama"],
--     "tags": [],
--     "network": "HBO",
--     "airs_on": null,
--     "streaming_on": [],
--     "origin_country": ["KR"],
--     "first_air_date": "2011-04-17",
--     "last_air_date": "2019-05-19",
--     "episode_count": 73,
--     "season_count": 8,
--     "provider_data": {}                -- opaque provider extras; never contains a credential
--   }
create or replace function public.catalog_upsert_title(
  p_provider_id text,
  p_payload jsonb
)
returns table (id uuid, written boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  target_provider text := coalesce(p_provider_id, 'tmdb');
  v_external_id text;
  kind public.media_type;
  world_id text;
  title_name text;
  release_year integer;
  status_value public.title_status;
  payload_hash text;
  existing_hash text;
  row_id uuid;
  did_write boolean := false;
begin
  if actor is not null then
    raise exception 'catalog ingest is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;

  v_external_id := nullif(btrim(p_payload ->> 'external_id'), '');
  kind := nullif(p_payload ->> 'media_type', '')::public.media_type;
  world_id := nullif(btrim(p_payload ->> 'world'), '');
  title_name := nullif(btrim(p_payload ->> 'title'), '');
  release_year := (p_payload ->> 'year')::integer;
  status_value := coalesce(nullif(p_payload ->> 'status', '')::public.title_status, 'upcoming');

  if v_external_id is null then
    raise exception 'payload.external_id is required' using errcode = 'invalid_parameter_value';
  end if;
  if kind is null then
    raise exception 'payload.media_type must be tv or movie' using errcode = 'invalid_parameter_value';
  end if;
  if title_name is null then
    raise exception 'payload.title is required' using errcode = 'invalid_parameter_value';
  end if;
  if release_year is null or release_year < 1888 or release_year > 2200 then
    raise exception 'payload.year % is out of range', release_year using errcode = 'invalid_parameter_value';
  end if;
  if world_id is null or not exists (select 1 from public.worlds w where w.id = world_id) then
    raise exception 'payload.world % is not a known world', world_id using errcode = 'no_data_found';
  end if;

  -- The hash covers everything the backend treats as a real change. Reordering the JSON keys or
  -- adding a harmless provider extra does not count, which keeps refreshes genuinely incremental.
  payload_hash := md5(
    coalesce(p_payload ->> 'original_title', '') || '|' ||
    coalesce(p_payload ->> 'status', '') || '|' ||
    coalesce(p_payload ->> 'synopsis', p_payload ->> 'overview', '') || '|' ||
    coalesce(p_payload ->> 'poster_url', '') || '|' ||
    coalesce(p_payload ->> 'backdrop_url', '') || '|' ||
    coalesce(p_payload ->> 'trailer_url', '') || '|' ||
    coalesce(p_payload ->> 'runtime_minutes', '') || '|' ||
    coalesce(p_payload ->> 'network', '') || '|' ||
    coalesce(p_payload ->> 'first_air_date', '') || '|' ||
    coalesce(p_payload ->> 'last_air_date', '') || '|' ||
    coalesce(p_payload ->> 'episode_count', '') || '|' ||
    coalesce(p_payload ->> 'season_count', '') || '|' ||
    coalesce(p_payload ->> 'popularity', '') || '|' ||
    coalesce(p_payload ->> 'vote_average', '') || '|' ||
    coalesce((p_payload -> 'streaming_on')::text, '[]') || '|' ||
    coalesce((p_payload -> 'genres')::text, '[]') || '|' ||
    coalesce((p_payload -> 'tags')::text, '[]') || '|' ||
    coalesce((p_payload -> 'origin_country')::text, '[]')
  );

  select t.id, t.content_hash into row_id, existing_hash
  from public.titles t
  where t.provider_id = target_provider and t.external_id = v_external_id and t.media_type = kind;

  if row_id is not null and existing_hash = payload_hash then
    -- Nothing changed, but the record is confirmed present: reset the missing streak and stamp it.
    -- (`id` is also this function's RETURNS TABLE out-column; qualify the table column.)
    update public.titles
       set catalog_synced_at = now(),
           catalog_missing_count = 0,
           catalog_unavailable_at = null
     where public.titles.id = row_id;

    return query select row_id, false;
    return;
  end if;

  insert into public.titles as t (
    provider_id, external_id, media_type, world, title, original_title, year, end_year, status,
    runtime_minutes, original_language, synopsis, poster_url, backdrop_url, trailer_url, tone, genres, tags,
    network, streaming_on, airs_on, episode_count, season_count, popularity, vote_average,
    vote_count, origin_country, first_air_date, last_air_date, provider_data, content_hash,
    catalog_synced_at, catalog_missing_count, catalog_unavailable_at
  )
  values (
    target_provider, v_external_id, kind, world_id, left(title_name, 200),
    nullif(left(p_payload ->> 'original_title', 200), ''),
    release_year,
    greatest(release_year, coalesce(nullif(p_payload ->> 'end_year', '')::integer, release_year)),
    status_value,
    nullif(left(p_payload ->> 'runtime_minutes', 4), '')::smallint,
    nullif(left(p_payload ->> 'original_language', 12), ''),
    nullif(left(coalesce(p_payload ->> 'synopsis', p_payload ->> 'overview'), 2000), ''),
    nullif(left(p_payload ->> 'poster_url', 500), ''),
    nullif(left(p_payload ->> 'backdrop_url', 500), ''),
    nullif(left(p_payload ->> 'trailer_url', 500), ''),
    nullif(left(p_payload ->> 'tone', 60), ''),
    coalesce((select array_agg(value #>> '{}') from jsonb_array_elements(coalesce(p_payload -> 'genres', '[]'::jsonb)) value), '{}'),
    coalesce((select array_agg(value #>> '{}') from jsonb_array_elements(coalesce(p_payload -> 'tags', '[]'::jsonb)) value), '{}'),
    nullif(left(p_payload ->> 'network', 120), ''),
    coalesce((select array_agg(value #>> '{}') from jsonb_array_elements(coalesce(p_payload -> 'streaming_on', '[]'::jsonb)) value), '{}'),
    nullif(left(p_payload ->> 'airs_on', 120), ''),
    coalesce(nullif(p_payload ->> 'episode_count', '')::smallint, 0),
    coalesce(nullif(p_payload ->> 'season_count', '')::smallint, 0),
    nullif(left(p_payload ->> 'popularity', 12), '')::numeric,
    nullif(left(p_payload ->> 'vote_average', 4), '')::numeric,
    greatest(coalesce(nullif(p_payload ->> 'vote_count', '')::integer, 0), 0),
    coalesce((select array_agg(value #>> '{}') from jsonb_array_elements(coalesce(p_payload -> 'origin_country', '[]'::jsonb)) value), '{}'),
    nullif(p_payload ->> 'first_air_date', '')::date,
    nullif(p_payload ->> 'last_air_date', '')::date,
    coalesce(p_payload -> 'provider_data', '{}'::jsonb),
    payload_hash,
    now(),
    0,
    null
  )
  on conflict (provider_id, external_id, media_type) do update
    set world = excluded.world,
        title = excluded.title,
        original_title = coalesce(excluded.original_title, t.original_title),
        year = excluded.year,
        end_year = excluded.end_year,
        status = excluded.status,
        runtime_minutes = coalesce(excluded.runtime_minutes, t.runtime_minutes),
        original_language = coalesce(excluded.original_language, t.original_language),
        synopsis = coalesce(excluded.synopsis, t.synopsis),
        poster_url = coalesce(excluded.poster_url, t.poster_url),
        backdrop_url = coalesce(excluded.backdrop_url, t.backdrop_url),
        trailer_url = coalesce(excluded.trailer_url, t.trailer_url),
        tone = coalesce(excluded.tone, t.tone),
        genres = case when cardinality(excluded.genres) > 0 then excluded.genres else t.genres end,
        tags = case when cardinality(excluded.tags) > 0 then excluded.tags else t.tags end,
        network = coalesce(excluded.network, t.network),
        streaming_on = case when cardinality(excluded.streaming_on) > 0 then excluded.streaming_on else t.streaming_on end,
        airs_on = coalesce(excluded.airs_on, t.airs_on),
        episode_count = greatest(excluded.episode_count, t.episode_count),
        season_count = greatest(excluded.season_count, t.season_count),
        popularity = coalesce(excluded.popularity, t.popularity),
        vote_average = coalesce(excluded.vote_average, t.vote_average),
        vote_count = greatest(excluded.vote_count, t.vote_count),
        origin_country = case when cardinality(excluded.origin_country) > 0 then excluded.origin_country else t.origin_country end,
        first_air_date = coalesce(excluded.first_air_date, t.first_air_date),
        last_air_date = coalesce(excluded.last_air_date, t.last_air_date),
        provider_data = excluded.provider_data,
        content_hash = excluded.content_hash,
        catalog_synced_at = now(),
        catalog_missing_count = 0,
        catalog_unavailable_at = null
  returning t.id into row_id;

  did_write := true;

  -- Availability status is derived from the dates the provider gave us, not stored twice: a show
  -- whose whole run is in the past is completed, one whose dates have not started is upcoming.
  perform public.catalog_recompute_title_state(row_id);

  return query select row_id, did_write;
end;
$$;

revoke all on function public.catalog_upsert_title(text, jsonb) from public, anon, authenticated;
grant execute on function public.catalog_upsert_title(text, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Availability and freshness, derived from dates
-- ---------------------------------------------------------------------------------------------

-- Keeps titles.status honest without asking the provider: a title whose last air date is in the past
-- is not "airing" no matter what a stale cached field says, and one that has not started is not
-- "completed". Movies use year/end_year, series use first_air_date/last_air_date.
create or replace function public.catalog_recompute_title_state(p_title_id uuid)
returns public.title_status
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t public.titles%rowtype;
  derived public.title_status;
begin
  select * into t from public.titles where id = p_title_id for update;
  if not found then
    return null;
  end if;

  derived := t.status;

  if t.status <> 'canceled' then
    if t.media_type = 'movie' then
      if t.year > extract(year from now())::integer then
        derived := 'upcoming';
      else
        derived := 'completed';
      end if;
    else
      -- No known start date and no provider status: treat as upcoming rather than inventing one.
      if t.first_air_date is null then
        derived := case when t.status in ('airing', 'completed') then t.status else 'upcoming' end;
      elsif t.first_air_date > current_date then
        derived := 'upcoming';
      elsif t.last_air_date is not null and t.last_air_date < current_date then
        derived := 'completed';
      elsif t.status = 'upcoming' and t.first_air_date <= current_date then
        -- The provider said "upcoming" but the show has started: it is airing now.
        derived := 'airing';
      else
        derived := t.status;
      end if;
    end if;
  end if;

  update public.titles
     set status = derived,
         end_year = case
           when media_type = 'movie' then year
           when derived = 'completed' and end_year is null then greatest(year, extract(year from coalesce(last_air_date, current_date))::integer)
           else end_year
         end
   where id = p_title_id;

  -- next_episode_at is derived from the episode table, never set by a client or a cached field.
  perform public.catalog_recompute_next_episode(p_title_id);

  return derived;
end;
$$;

revoke all on function public.catalog_recompute_title_state(uuid) from public, anon, authenticated;
grant execute on function public.catalog_recompute_title_state(uuid) to service_role;

create or replace function public.catalog_recompute_next_episode(p_title_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  upcoming timestamptz;
begin
  select min(e.air_date::timestamptz)
    into upcoming
  from public.title_episodes e
  where e.title_id = p_title_id and e.air_date is not null and e.air_date >= current_date;

  update public.titles set next_episode_at = upcoming where id = p_title_id;
  return upcoming;
end;
$$;

revoke all on function public.catalog_recompute_next_episode(uuid) from public, anon, authenticated;
grant execute on function public.catalog_recompute_next_episode(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Episodes
-- ---------------------------------------------------------------------------------------------

-- Replaces the episode list for one season. Episodes the provider still returns are upserted;
-- episodes it dropped are removed for that season only. Episodes that Hallyu content points at are
-- kept rather than deleted, so a schedule change cannot orphan a discussion.
--
-- p_episodes: [{"season":1,"number":1,"title":"…","air_date":"2026-01-06","runtime_minutes":60,
--               "overview":"…","still_url":"…","air_time":"21:00","episode_type":1}, …]
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
begin
  if auth.uid() is not null then
    raise exception 'catalog ingest is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.titles where id = p_title_id) then
    raise exception 'title % does not exist', p_title_id using errcode = 'no_data_found';
  end if;

  if p_episodes is null or jsonb_typeof(p_episodes) <> 'array' then
    raise exception 'p_episodes must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;

  for item in select * from jsonb_array_elements(p_episodes) loop
    declare
      ep_number integer := coalesce(nullif(item ->> 'number', '')::integer, 0);
    begin
      if ep_number < 1 then
        continue; -- a provider row without an episode number is not addressable, skip it
      end if;

      keep_numbers := keep_numbers || ep_number;

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
        nullif(left(item ->> 'runtime_minutes', 4), '')::smallint,
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
    end;
  end loop;

  -- Retire episodes the provider dropped, unless a post pins that exact season/episode.
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

  return inserted;
end;
$$;

revoke all on function public.catalog_upsert_episodes(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.catalog_upsert_episodes(uuid, integer, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------
-- People and cast
-- ---------------------------------------------------------------------------------------------

-- p_payload: {"external_id":"…","name":"…","korean_name":null,"photo_url":null,
--              "birth_date":null,"bio":null,"known_for":true}
create or replace function public.catalog_upsert_person(
  p_provider_id text,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_provider text := coalesce(p_provider_id, 'tmdb');
  v_external_id text;
  person_name text;
  row_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'catalog ingest is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  v_external_id := nullif(btrim(p_payload ->> 'external_id'), '');
  person_name := nullif(btrim(p_payload ->> 'name'), '');

  if v_external_id is null or person_name is null then
    raise exception 'person payload requires external_id and name' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.people as p (
    provider_id, external_id, name, korean_name, photo_url, birth_date, bio, known_for_count, catalog_synced_at
  )
  values (
    target_provider, v_external_id, left(person_name, 200),
    nullif(left(p_payload ->> 'korean_name', 200), ''),
    nullif(left(p_payload ->> 'photo_url', 500), ''),
    nullif(p_payload ->> 'birth_date', '')::date,
    left(p_payload ->> 'bio', 2000),
    greatest(coalesce(nullif(p_payload ->> 'known_for_count', '')::integer, 0), 0),
    now()
  )
  on conflict (provider_id, external_id) do update
    set name = excluded.name,
        korean_name = coalesce(excluded.korean_name, p.korean_name),
        photo_url = coalesce(excluded.photo_url, p.photo_url),
        birth_date = coalesce(excluded.birth_date, p.birth_date),
        bio = coalesce(excluded.bio, p.bio),
        known_for_count = excluded.known_for_count,
        catalog_synced_at = now()
  returning p.id into row_id;

  return row_id;
end;
$$;

revoke all on function public.catalog_upsert_person(text, jsonb) from public, anon, authenticated;
grant execute on function public.catalog_upsert_person(text, jsonb) to service_role;

-- Replaces the credited cast for a title.
-- p_credits: [{"external_id":"…","name":"…","job":"actor","character":"…","order_index":0}, …]
create or replace function public.catalog_upsert_title_people(
  p_title_id uuid,
  p_credits jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item jsonb;
  v_person_id uuid;
  written integer := 0;
  job_value text;
begin
  if auth.uid() is not null then
    raise exception 'catalog ingest is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.titles where id = p_title_id) then
    raise exception 'title % does not exist', p_title_id using errcode = 'no_data_found';
  end if;

  if p_credits is null or jsonb_typeof(p_credits) <> 'array' then
    raise exception 'p_credits must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;

  for item in select * from jsonb_array_elements(p_credits) loop
    job_value := coalesce(nullif(item ->> 'job', ''), 'actor');
    if job_value not in ('actor', 'director', 'writer', 'creator', 'producer') then
      continue;
    end if;

    v_person_id := public.catalog_upsert_person(
      'tmdb',
      jsonb_build_object(
        'external_id', item ->> 'external_id',
        'name', item ->> 'name',
        'korean_name', item ->> 'korean_name',
        'photo_url', item ->> 'photo_url'
      )
    );

    if v_person_id is null then
      continue;
    end if;

    insert into public.title_people as tp (title_id, person_id, character, job, order_index, catalog_synced_at)
    values (
      p_title_id, v_person_id,
      nullif(left(item ->> 'character', 200), ''),
      job_value,
      greatest(coalesce(nullif(item ->> 'order_index', '')::integer, 0), 0),
      now()
    )
    on conflict (title_id, person_id) do update
      set character = coalesce(excluded.character, tp.character),
          job = excluded.job,
          order_index = excluded.order_index,
          catalog_synced_at = now()
    where
      tp.character is distinct from excluded.character
      or tp.job is distinct from excluded.job
      or tp.order_index is distinct from excluded.order_index;

    if found then
      written := written + 1;
    end if;
  end loop;

  return written;
end;
$$;

revoke all on function public.catalog_upsert_title_people(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.catalog_upsert_title_people(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Records the provider no longer returns
-- ---------------------------------------------------------------------------------------------

-- Called after a *complete* list sync (a discover page, a world sweep) — never after a single-item
-- lookup, because "not in this page" is not "gone". Counts the miss, and at the threshold marks the
-- record unavailable: it leaves discovery but is never deleted, because posts still point at it.
create or replace function public.catalog_mark_missing(
  p_provider_id text,
  p_media_type public.media_type,
  p_external_ids text[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'catalog ingest is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  if p_external_ids is null or cardinality(p_external_ids) = 0 then
    return 0;
  end if;

  update public.titles t
     set catalog_missing_count = t.catalog_missing_count + 1,
         catalog_unavailable_at = case
           when t.catalog_missing_count + 1 >= public.catalog_missing_threshold() then now()
           else t.catalog_unavailable_at
         end
   where t.provider_id = p_provider_id
     and t.media_type = p_media_type
     and t.external_id = any(p_external_ids);

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.catalog_mark_missing(text, public.media_type, text[]) from public, anon, authenticated;
grant execute on function public.catalog_mark_missing(text, public.media_type, text[]) to service_role;

comment on function public.catalog_mark_missing(text, public.media_type, text[]) is
  'Marks records absent from a full provider listing. Deletes nothing: a title row is referenced by posts, watchlist entries and collections.';

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
