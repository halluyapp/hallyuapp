-- Hallyu backend — 41 catalog lifecycle reconciliation, world classification enforcement,
-- balanced multi-world rankings, world leaders, moderation trigger repair, rich notification
-- titles/deep-links, and transactional device delivery fan-out.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------------------------
-- 1. Authoritative world classification check (shared across lifecycle, ranking, and browse)
-- ---------------------------------------------------------------------------------------------

create or replace function public.catalog_is_valid_world(
  p_world text,
  p_media_type text,
  p_original_language text,
  p_origin_country text[],
  p_genres text[]
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_lang text := lower(coalesce(p_original_language, ''));
  v_origin text[] := coalesce(p_origin_country, '{}'::text[]);
  v_genres text[] := coalesce(p_genres, '{}'::text[]);
  v_is_animated boolean := ('Animation' = any(v_genres));
begin
  if p_world not in ('kdrama', 'cdrama', 'anime', 'hollywood') then
    return false;
  end if;

  if p_world = 'kdrama' then
    return (v_lang = 'ko' or v_origin && array['KR'] or (v_lang = '' and cardinality(v_origin) = 0));
  end if;

  if p_world = 'cdrama' then
    return (
      v_lang in ('zh', 'cn', 'yue', 'nan', 'bo', 'wuu')
      or v_origin && array['CN', 'TW', 'HK']
      or (v_lang = '' and cardinality(v_origin) = 0)
    );
  end if;

  if p_world = 'anime' then
    if cardinality(v_genres) > 0 and not v_is_animated then
      return false;
    end if;
    return (
      v_lang = 'ja'
      or v_origin && array['JP']
      or v_is_animated
      or (v_lang = '' and cardinality(v_origin) = 0)
    );
  end if;

  if p_world = 'hollywood' then
    if v_lang in ('ko', 'zh', 'cn', 'yue', 'nan', 'bo', 'wuu') then
      return false;
    end if;
    if (v_lang = 'ja' or (v_origin && array['JP'] and not (v_origin && array['US', 'GB', 'CA', 'AU', 'NZ', 'IE']))) then
      return false;
    end if;
    return (
      v_lang = 'en'
      or v_origin && array['US', 'GB', 'CA', 'AU', 'NZ', 'IE']
      or (v_lang = '' and cardinality(v_origin) = 0)
    );
  end if;

  return false;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Accurate catalog title state machine (provider status + air dates + episode schedule)
-- ---------------------------------------------------------------------------------------------

create or replace function public.catalog_recompute_title_state(p_title_id uuid)
returns public.title_status
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t public.titles%rowtype;
  derived public.title_status;
  v_provider_status text;
  v_has_active_episode boolean := false;
begin
  select * into t from public.titles where id = p_title_id for update;
  if not found then
    return null;
  end if;

  perform public.catalog_recompute_next_episode(p_title_id);
  select * into t from public.titles where id = p_title_id;

  v_provider_status := lower(btrim(coalesce(t.provider_data ->> 'status', '')));

  if v_provider_status in ('canceled', 'cancelled') or t.status = 'canceled' then
    derived := 'canceled';

  elsif t.media_type = 'movie' then
    if (t.first_air_date is not null and t.first_air_date > current_date)
       or v_provider_status in ('rumored', 'planned', 'in production', 'post production')
       or (t.first_air_date is null and t.year > extract(year from current_date)::integer) then
      derived := 'upcoming';
    else
      derived := 'completed';
    end if;

  else
    select exists (
      select 1
        from public.title_episodes e
       where e.title_id = p_title_id
         and e.air_date is not null
         and e.air_date between (current_date - 35) and (current_date + 45)
    ) into v_has_active_episode;

    if (t.first_air_date is not null and t.first_air_date > current_date)
       or (t.first_air_date is null and v_provider_status in ('rumored', 'planned', 'pilot', 'in production', 'post production')) then
      derived := 'upcoming';

    elsif v_provider_status = 'ended' then
      derived := 'completed';

    elsif (t.next_episode_at is not null
           and t.next_episode_at >= (current_date - 7)::timestamptz
           and t.next_episode_at <= (current_date + 60)::timestamptz)
       or v_has_active_episode
       or (v_provider_status = 'returning series'
           and ((t.last_air_date is not null and t.last_air_date >= current_date - 45)
                or (t.last_air_date is null and t.first_air_date is not null and t.first_air_date >= current_date - 60)))
       or (v_provider_status = ''
           and t.last_air_date is null
           and t.first_air_date is not null
           and t.first_air_date >= current_date - 35) then
      derived := 'airing';

    elsif v_provider_status in ('returning series', 'in production', 'planned')
          and t.next_episode_at is not null
          and t.next_episode_at > (current_date + 60)::timestamptz then
      derived := 'upcoming';

    elsif t.last_air_date is not null and t.last_air_date < current_date - 35 then
      derived := 'completed';

    elsif v_provider_status = '' and t.last_air_date is null and t.first_air_date is null then
      derived := t.status;

    else
      derived := 'completed';
    end if;
  end if;

  if derived is distinct from t.status then
    update public.titles
       set status = derived,
           updated_at = now()
     where id = p_title_id;
  end if;

  return derived;
end;
$$;

revoke all on function public.catalog_recompute_title_state(uuid) from public, anon, authenticated;
grant execute on function public.catalog_recompute_title_state(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Upsert title & episodes preserving enriched detail fields across thin list refreshes
-- ---------------------------------------------------------------------------------------------

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
  release_year := coalesce(
    nullif(p_payload ->> 'year', '')::integer,
    extract(year from coalesce(nullif(p_payload ->> 'first_air_date', '')::date, current_date))::integer
  );
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

  payload_hash := md5(
    coalesce(p_payload ->> 'original_title', '') || '|' ||
    coalesce(p_payload ->> 'status', '') || '|' ||
    coalesce(p_payload -> 'provider_data' ->> 'status', '') || '|' ||
    coalesce(p_payload ->> 'synopsis', p_payload ->> 'overview', '') || '|' ||
    coalesce(p_payload ->> 'poster_url', '') || '|' ||
    coalesce(p_payload ->> 'backdrop_url', '') || '|' ||
    coalesce(p_payload ->> 'trailer_url', '') || '|' ||
    coalesce(p_payload ->> 'runtime_minutes', '') || '|' ||
    coalesce(p_payload ->> 'network', '') || '|' ||
    coalesce(p_payload ->> 'first_air_date', '') || '|' ||
    coalesce(p_payload ->> 'last_air_date', '') || '|' ||
    coalesce(p_payload ->> 'next_episode_at', '') || '|' ||
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
    update public.titles
       set catalog_synced_at = now(),
           catalog_missing_count = 0,
           catalog_unavailable_at = null
     where public.titles.id = row_id;

    perform public.catalog_recompute_title_state(row_id);

    return query select row_id, false;
    return;
  end if;

  insert into public.titles as t (
    provider_id, external_id, media_type, world, title, original_title, year, end_year, status,
    runtime_minutes, original_language, synopsis, poster_url, backdrop_url, trailer_url, tone, genres, tags,
    network, streaming_on, airs_on, episode_count, season_count, popularity, vote_average,
    vote_count, origin_country, first_air_date, last_air_date, next_episode_at, provider_data, content_hash,
    catalog_synced_at, catalog_missing_count, catalog_unavailable_at
  )
  values (
    target_provider, v_external_id, kind, world_id, left(title_name, 200),
    nullif(left(p_payload ->> 'original_title', 200), ''),
    release_year,
    greatest(release_year, coalesce(nullif(p_payload ->> 'end_year', '')::integer, release_year)),
    status_value,
    nullif(nullif(left(p_payload ->> 'runtime_minutes', 4), '')::smallint, 0),
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
    nullif(p_payload ->> 'next_episode_at', '')::timestamptz,
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
        status = case
          when coalesce(excluded.provider_data ->> 'status', '') <> '' then excluded.status
          else coalesce(t.status, excluded.status)
        end,
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
        next_episode_at = coalesce(excluded.next_episode_at, t.next_episode_at),
        provider_data = case
          when coalesce(excluded.provider_data ->> 'status', '') <> '' then excluded.provider_data
          else coalesce(t.provider_data, '{}'::jsonb) || jsonb_strip_nulls(excluded.provider_data)
        end,
        content_hash = excluded.content_hash,
        catalog_synced_at = now(),
        catalog_missing_count = 0,
        catalog_unavailable_at = null
  returning t.id into row_id;

  did_write := true;

  perform public.catalog_recompute_title_state(row_id);

  return query select row_id, did_write;
end;
$$;

revoke all on function public.catalog_upsert_title(text, jsonb) from public, anon, authenticated;
grant execute on function public.catalog_upsert_title(text, jsonb) to service_role;

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
    ep_number := coalesce(nullif(item ->> 'number', '')::integer, 0);
    if ep_number < 1 then
      continue;
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

revoke all on function public.catalog_upsert_episodes(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.catalog_upsert_episodes(uuid, integer, jsonb) to service_role;

-- Deterministic global lock order on people.external_id eliminates concurrent AB/BA 40P01 deadlocks.
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

  for item in
    select distinct on (value ->> 'external_id') value
    from jsonb_array_elements(p_credits) as value
    where nullif(btrim(value ->> 'external_id'), '') is not null
    order by (value ->> 'external_id') asc, coalesce(nullif(value ->> 'order_index', '')::integer, 0) asc
  loop
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
-- 4. Lifecycle, relevance score & discovery RPCs (exact preserved return shapes)
-- ---------------------------------------------------------------------------------------------

create or replace function public.catalog_lifecycle_of(p_title public.titles)
returns public.catalog_lifecycle
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_title.catalog_unavailable_at is not null
      or p_title.catalog_missing_count >= 3
      or p_title.status = 'canceled'
      or not public.catalog_is_valid_world(
        p_title.world,
        p_title.media_type::text,
        p_title.original_language,
        p_title.origin_country,
        p_title.genres
      ) then 'unavailable'::public.catalog_lifecycle
    when p_title.status = 'airing'
      and (
        p_title.next_episode_at >= (current_date - 7)::timestamptz
        or p_title.last_air_date is null
        or p_title.last_air_date >= current_date - 45
      )
      then 'airing'::public.catalog_lifecycle
    when p_title.status = 'upcoming'
      and (
        (p_title.first_air_date is not null and p_title.first_air_date between current_date + 1 and current_date + 365)
        or (p_title.next_episode_at is not null and p_title.next_episode_at::date between current_date + 1 and current_date + 365)
        or p_title.first_air_date is null
      )
      then 'upcoming'::public.catalog_lifecycle
    when p_title.status = 'upcoming' then 'unavailable'::public.catalog_lifecycle
    when p_title.status = 'completed'
      and (p_title.last_air_date >= current_date - 365
           or p_title.first_air_date >= current_date - 365
           or p_title.year >= extract(year from now())::integer - 2)
      then 'recent'::public.catalog_lifecycle
    else 'classic'::public.catalog_lifecycle
  end
$$;

revoke all on function public.catalog_lifecycle_of(public.titles) from public, anon, authenticated;
grant execute on function public.catalog_lifecycle_of(public.titles) to service_role;

create or replace function public.catalog_relevance_score(
  p_title public.titles,
  p_lifecycle public.catalog_lifecycle default null,
  p_world text default null
)
returns double precision
language sql
immutable
set search_path = public, pg_temp
as $$
  with context as (
    select
      coalesce(p_lifecycle, public.catalog_lifecycle_of(p_title)) as life,
      (select count(*) from public.title_follows tf where tf.title_id = p_title.id)::double precision as followers,
      (select count(*) from public.posts po where po.title_id = p_title.id and po.state = 'active')::double precision as posts,
      (select count(*) from public.title_episodes e where e.title_id = p_title.id and e.air_date >= current_date - 14)::double precision as recent_episodes,
      (select count(*) from public.community_members cm where cm.community_id in (select c.id from public.communities c where c.drama_id = p_title.id))::double precision as room_members
  )
  select
    (case ctx.life
       when 'airing' then 0.50
       when 'upcoming' then 0.34
       when 'recent' then 0.22
       when 'classic' then 0.06
       else 0.0
     end)
    + least(0.18, (ln(coalesce(greatest(p_title.popularity, 0), 0) + 1) / ln(501)) * 0.18)
    + (coalesce(p_title.vote_average, 0) / 10.0) * 0.05 * least(1.0, coalesce(p_title.vote_count, 0)::double precision / 400.0)
    + least(0.12, ctx.recent_episodes * 0.04)
    + least(0.12, (ln(ctx.followers + 1) / ln(1001)) * 0.08)
    + least(0.10, (ln(ctx.posts + 1) / ln(501)) * 0.05)
    + least(0.05, (ln(ctx.room_members + 1) / ln(2001)) * 0.05)
    - (case when p_title.genres && array['Reality', 'Talk', 'News', 'Kids'] then 0.24 else 0.0 end)
    - (case when ctx.life = 'classic'
            then least(0.10, greatest(0, extract(year from now()) - p_title.year - 5) / 100.0)
            else 0.0 end)
  from context ctx
$$;

revoke all on function public.catalog_relevance_score(public.titles, public.catalog_lifecycle, text) from public, anon, authenticated;
grant execute on function public.catalog_relevance_score(public.titles, public.catalog_lifecycle, text) to service_role;

create or replace function public.trending_titles(
  p_world text default null,
  p_lifecycle public.catalog_lifecycle[] default null,
  p_genre text default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  title text,
  original_title text,
  year smallint,
  media_type public.media_type,
  status public.title_status,
  lifecycle public.catalog_lifecycle,
  score double precision,
  poster_url text,
  backdrop_url text,
  genres text[],
  synopsis text,
  next_episode_at timestamptz,
  episode_count smallint,
  season_count smallint,
  network text,
  world text,
  follower_count integer,
  vote_average numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    select
      t.id, t.title, t.original_title, t.year, t.media_type, t.status,
      public.catalog_lifecycle_of(t) as lifecycle,
      round(public.catalog_relevance_score(t)::numeric, 6)::double precision as score,
      t.poster_url, t.backdrop_url, t.genres, t.synopsis, t.next_episode_at,
      t.episode_count, t.season_count, t.network, t.world, t.follower_count, t.vote_average,
      row_number() over (
        partition by t.world
        order by public.catalog_relevance_score(t) desc, t.popularity desc nulls last, t.id asc
      ) as world_slot
    from public.titles t
    where (p_world is null or t.world = p_world)
      and (p_genre is null or p_genre = any(t.genres))
      and public.catalog_lifecycle_of(t) <> 'unavailable'
      and (
        case
          when p_lifecycle is null then public.catalog_lifecycle_of(t) <> 'classic'
          else public.catalog_lifecycle_of(t) = any(p_lifecycle)
        end
      )
  )
  select
    c.id, c.title, c.original_title, c.year, c.media_type, c.status,
    c.lifecycle, c.score,
    c.poster_url, c.backdrop_url, c.genres, c.synopsis, c.next_episode_at,
    c.episode_count, c.season_count, c.network, c.world, c.follower_count, c.vote_average
  from candidates c
  order by
    case when p_world is null then c.world_slot else 0 end asc,
    c.score desc,
    c.id asc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.trending_titles(text, public.catalog_lifecycle[], text, integer, integer) from public, anon, authenticated;
grant execute on function public.trending_titles(text, public.catalog_lifecycle[], text, integer, integer) to anon, authenticated;

create or replace function public.airing_titles(
  p_world text default null,
  p_limit integer default 40,
  p_offset integer default 0
)
returns table (
  id uuid,
  title text,
  year smallint,
  media_type public.media_type,
  world text,
  poster_url text,
  backdrop_url text,
  genres text[],
  synopsis text,
  next_episode_at timestamptz,
  season_count smallint,
  episode_count smallint,
  network text,
  airs_on text,
  follower_count integer,
  episodes_this_week integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    select
      t.id, t.title, t.year, t.media_type, t.world, t.poster_url, t.backdrop_url, t.genres,
      t.synopsis, t.next_episode_at, t.season_count, t.episode_count, t.network, t.airs_on, t.follower_count,
      (select count(*)::integer from public.title_episodes e
        where e.title_id = t.id and e.air_date between current_date and current_date + 7)::integer as episodes_this_week,
      public.catalog_relevance_score(t) as rel_score,
      row_number() over (
        partition by t.world
        order by
          case when t.genres && array['Reality', 'Talk', 'News', 'Kids'] then 1 else 0 end asc,
          case when t.next_episode_at is not null and t.next_episode_at >= current_date::timestamptz then 0 else 1 end asc,
          t.next_episode_at asc nulls last,
          public.catalog_relevance_score(t) desc,
          t.id asc
      ) as world_slot
    from public.titles t
    where (p_world is null or t.world = p_world)
      and t.status = 'airing'
      and public.catalog_lifecycle_of(t) = 'airing'
  )
  select
    c.id, c.title, c.year, c.media_type, c.world, c.poster_url, c.backdrop_url, c.genres,
    c.synopsis, c.next_episode_at, c.season_count, c.episode_count, c.network, c.airs_on, c.follower_count,
    c.episodes_this_week
  from candidates c
  order by
    case when p_world is null and c.world_slot <= 6 then c.world_slot else 999 end asc,
    c.next_episode_at asc nulls last,
    c.rel_score desc,
    c.id asc
  limit least(greatest(coalesce(p_limit, 40), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.airing_titles(text, integer, integer) from public, anon, authenticated;
grant execute on function public.airing_titles(text, integer, integer) to anon, authenticated;

create or replace function public.upcoming_titles(
  p_world text default null,
  p_days integer default 180,
  p_limit integer default 40,
  p_offset integer default 0
)
returns table (
  id uuid,
  title text,
  year smallint,
  media_type public.media_type,
  world text,
  poster_url text,
  backdrop_url text,
  genres text[],
  synopsis text,
  first_air_date date,
  season_count smallint,
  network text,
  follower_count integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    select
      t.id, t.title, t.year, t.media_type, t.world, t.poster_url, t.backdrop_url, t.genres,
      t.synopsis,
      coalesce(
        case when t.first_air_date > current_date then t.first_air_date else null end,
        case when t.next_episode_at is not null and t.next_episode_at::date > current_date then t.next_episode_at::date else null end
      ) as effective_date,
      t.season_count, t.network, t.follower_count,
      public.catalog_relevance_score(t) as rel_score,
      row_number() over (
        partition by t.world
        order by
          coalesce(
            case when t.first_air_date > current_date then t.first_air_date else null end,
            t.next_episode_at::date
          ) asc nulls last,
          public.catalog_relevance_score(t) desc,
          t.id asc
      ) as world_slot
    from public.titles t
    where (p_world is null or t.world = p_world)
      and t.status = 'upcoming'
      and public.catalog_lifecycle_of(t) = 'upcoming'
      and (
        (t.first_air_date is not null and t.first_air_date between current_date + 1 and current_date + least(greatest(coalesce(p_days, 180), 1), 730))
        or (t.next_episode_at is not null and t.next_episode_at::date between current_date + 1 and current_date + least(greatest(coalesce(p_days, 180), 1), 730))
      )
  )
  select
    c.id, c.title, c.year, c.media_type, c.world, c.poster_url, c.backdrop_url, c.genres,
    c.synopsis, c.effective_date as first_air_date, c.season_count, c.network, c.follower_count
  from candidates c
  where c.effective_date is not null
  order by
    case when p_world is null and c.world_slot <= 6 then c.world_slot else 999 end asc,
    c.effective_date asc,
    c.rel_score desc,
    c.id asc
  limit least(greatest(coalesce(p_limit, 40), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.upcoming_titles(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.upcoming_titles(text, integer, integer, integer) to anon, authenticated;

create or replace function public.world_leaders()
returns table (
  id uuid,
  title text,
  original_title text,
  year smallint,
  media_type public.media_type,
  status public.title_status,
  lifecycle public.catalog_lifecycle,
  score double precision,
  poster_url text,
  backdrop_url text,
  genres text[],
  synopsis text,
  next_episode_at timestamptz,
  first_air_date date,
  episode_count smallint,
  season_count smallint,
  network text,
  world text,
  follower_count integer,
  vote_average numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    select
      t.id, t.title, t.original_title, t.year, t.media_type, t.status,
      public.catalog_lifecycle_of(t) as lifecycle,
      round(public.catalog_relevance_score(t)::numeric, 6)::double precision as score,
      t.poster_url, t.backdrop_url, t.genres, t.synopsis, t.next_episode_at,
      t.first_air_date, t.episode_count, t.season_count, t.network, t.world,
      t.follower_count, t.vote_average,
      row_number() over (
        partition by t.world
        order by
          case when t.backdrop_url is not null or t.poster_url is not null then 0 else 1 end asc,
          public.catalog_relevance_score(t) desc,
          t.popularity desc nulls last,
          t.id asc
      ) as rn
    from public.titles t
    where t.world in ('kdrama', 'cdrama', 'anime', 'hollywood')
      and public.catalog_lifecycle_of(t) not in ('unavailable', 'classic')
  )
  select
    c.id, c.title, c.original_title, c.year, c.media_type, c.status,
    c.lifecycle, c.score, c.poster_url, c.backdrop_url, c.genres, c.synopsis,
    c.next_episode_at, c.first_air_date, c.episode_count, c.season_count,
    c.network, c.world, c.follower_count, c.vote_average
  from candidates c
  where c.rn = 1
  order by array_position(array['kdrama', 'cdrama', 'anime', 'hollywood'], c.world) asc;
$$;

revoke all on function public.world_leaders() from public;
grant execute on function public.world_leaders() to anon, authenticated;

create or replace function public.top_rated_titles(
  p_world text default null,
  p_limit integer default 24
)
returns setof public.titles
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with scored as (
    select
      t.id,
      t.vote_count,
      ((t.vote_count::numeric / (t.vote_count::numeric + 150.0)) * coalesce(t.vote_average, 0)
        + (150.0 / (t.vote_count::numeric + 150.0)) * 7.2) as weighted_rating,
      row_number() over (
        partition by t.world
        order by
          ((t.vote_count::numeric / (t.vote_count::numeric + 150.0)) * coalesce(t.vote_average, 0)
            + (150.0 / (t.vote_count::numeric + 150.0)) * 7.2) desc,
          t.vote_count desc,
          t.id asc
      ) as world_slot
    from public.titles t
    where public.catalog_lifecycle_of(t) <> 'unavailable'
      and t.status <> 'upcoming'
      and coalesce(t.vote_count, 0) >= 40
      and coalesce(t.vote_average, 0) >= 7.0
      and (t.first_air_date is null or t.first_air_date <= current_date)
      and (p_world is null or t.world = p_world)
  )
  select t.*
  from public.titles t
  join scored s on s.id = t.id
  order by
    case when p_world is null then s.world_slot else 0 end asc,
    s.weighted_rating desc,
    s.vote_count desc,
    s.id asc
  limit greatest(1, least(coalesce(p_limit, 24), 100));
$$;

revoke all on function public.top_rated_titles(text, integer) from public;
grant execute on function public.top_rated_titles(text, integer) to anon, authenticated;

create or replace function public.browse_titles(
  p_genre text default null,
  p_provider text default null,
  p_world text default null,
  p_sort text default 'relevance',
  p_limit integer default 24,
  p_offset integer default 0
)
returns setof public.titles
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.*
  from public.titles t
  where public.catalog_lifecycle_of(t) <> 'unavailable'
    and (p_genre is null
         or exists (select 1 from unnest(t.genres) g where lower(btrim(g)) = lower(btrim(p_genre))))
    and (p_provider is null or exists (select 1 from unnest(t.streaming_on) s where lower(btrim(s)) = lower(btrim(p_provider))))
    and (p_world is null or t.world = p_world)
  order by
    case p_sort
      when 'popular' then coalesce(t.popularity, 0)::double precision
      when 'top' then coalesce(t.vote_average, 0)::double precision
      when 'new' then t.year::double precision
      else public.catalog_relevance_score(t)
    end desc nulls last,
    t.id asc
  limit least(greatest(coalesce(p_limit, 24), 1), 60)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.browse_titles(text, text, text, text, integer, integer) from public;
grant execute on function public.browse_titles(text, text, text, text, integer, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Notification generation, moderation report resolution fix, transactional fan-out & self-test
-- ---------------------------------------------------------------------------------------------

create or replace function public.notify_recipient(
  p_recipient uuid,
  p_kind public.notification_kind,
  p_group public.notification_group,
  p_actor_ids uuid[] default '{}',
  p_post_id uuid default null,
  p_comment_id uuid default null,
  p_title_id uuid default null,
  p_community_id uuid default null,
  p_collection_id uuid default null,
  p_episode smallint default null,
  p_title text default null,
  p_body text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  prefs public.user_preferences%rowtype;
  v_actor_name text;
  v_actor_handle text;
  v_resolved_title text;
  v_deep_link text;
begin
  if p_recipient is null then
    return;
  end if;

  select * into prefs from public.user_preferences where user_id = p_recipient;
  if not found then
    return;
  end if;

  if p_group = 'social' and not prefs.notify_social then
    return;
  end if;
  if p_group = 'system' and not prefs.notify_system then
    return;
  end if;
  if p_group = 'drama' and not prefs.notify_episodes then
    return;
  end if;

  if cardinality(p_actor_ids) > 0 and exists (
    select 1 from public.blocks b
    where (b.blocker_id = p_recipient and b.blocked_id = any(p_actor_ids))
       or (b.blocked_id = p_recipient and b.blocker_id = any(p_actor_ids))
  ) then
    return;
  end if;

  if cardinality(p_actor_ids) > 0 then
    select coalesce(nullif(btrim(display_name), ''), '@' || handle), handle
      into v_actor_name, v_actor_handle
      from public.profiles
     where id = p_actor_ids[1];
  end if;

  v_resolved_title := coalesce(
    nullif(btrim(p_title), ''),
    case p_kind::text
      when 'follow' then coalesce(v_actor_name, 'New member') || ' followed you'
      when 'comment' then coalesce(v_actor_name, 'Someone') || ' commented on your post'
      when 'reply' then coalesce(v_actor_name, 'Someone') || ' replied to your comment'
      when 'reaction' then coalesce(v_actor_name, 'Someone') || ' reacted to your post'
      when 'collection_saved' then coalesce(v_actor_name, 'Someone') || ' saved your collection'
      else 'Hallyu'
    end
  );

  v_deep_link := case
    when p_post_id is not null then '/post/' || p_post_id::text
    when p_title_id is not null then '/drama/hallyu-' || p_title_id::text
    when p_collection_id is not null then '/collection/' || p_collection_id::text
    when v_actor_handle is not null then '/user/' || v_actor_handle
    else '/notifications'
  end;

  insert into public.notifications (
    recipient_id, kind, "group", actor_ids, post_id, comment_id, title_id,
    community_id, collection_id, episode, title, body, deep_link
  )
  values (
    p_recipient, p_kind, p_group, p_actor_ids, p_post_id, p_comment_id, p_title_id,
    p_community_id, p_collection_id, p_episode, v_resolved_title, p_body, v_deep_link
  );
end;
$$;

revoke all on function public.notify_recipient(uuid, public.notification_kind, public.notification_group, uuid[], uuid, uuid, uuid, uuid, uuid, smallint, text, text)
  from public, anon, authenticated;

-- Fix 13-arg typo in migration 18 so resolving moderation reports emits system notifications cleanly.
create or replace function public.handle_notify_moderation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('resolved', 'dismissed') and old.status is distinct from new.status then
    perform public.notify_recipient(
      new.reporter_id,
      'system',
      'system',
      '{}',
      null, null, null, null, null, null,
      'We looked at your report',
      coalesce(nullif(btrim(new.resolution), ''), 'Status updated to ' || new.status::text)
    );
  end if;
  return new;
end;
$$;

-- Transactional device delivery fan-out immediately on notification creation.
create or replace function public.handle_notification_fanout_and_wake()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.notification_deliveries (notification_id, push_token_id, next_attempt_at)
  select
    new.id,
    t.id,
    greatest(now(), new.scheduled_for)
  from public.push_tokens t
  join public.profiles pr on pr.id = t.user_id
  where t.user_id = new.recipient_id
    and t.disabled_at is null
    and pr.account_status = 'active'
    and case new."group"
      when 'social' then coalesce((select notify_social from public.user_preferences p where p.user_id = t.user_id), false)
      when 'system' then coalesce((select notify_system from public.user_preferences p where p.user_id = t.user_id), false)
      when 'drama' then coalesce((select notify_episodes from public.user_preferences p where p.user_id = t.user_id), false)
      else true
    end
  on conflict (notification_id, push_token_id) do nothing;

  return new;
end;
$$;

drop trigger if exists notifications_fanout_and_wake on public.notifications;
create trigger notifications_fanout_and_wake
  after insert on public.notifications
  for each row execute function public.handle_notification_fanout_and_wake();

create or replace function public.send_test_notification()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_notif_id uuid;
  v_token_count integer := 0;
  v_delivery_count integer := 0;
begin
  if v_actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select count(*) into v_token_count
    from public.push_tokens
   where user_id = v_actor
     and disabled_at is null;

  insert into public.notifications (
    recipient_id,
    kind,
    "group",
    title,
    body,
    deep_link
  )
  values (
    v_actor,
    'system',
    'system',
    'Hallyu notifications are live',
    'Remote server delivery and device banners are active for your account.',
    '/notifications'
  )
  returning id into v_notif_id;

  select count(*) into v_delivery_count
    from public.notification_deliveries
   where notification_id = v_notif_id;

  return jsonb_build_object(
    'notification_id', v_notif_id,
    'active_push_tokens', v_token_count,
    'queued_deliveries', v_delivery_count,
    'created_at', now()
  );
end;
$$;

revoke all on function public.send_test_notification() from public, anon;
grant execute on function public.send_test_notification() to authenticated;

reset check_function_bodies;
