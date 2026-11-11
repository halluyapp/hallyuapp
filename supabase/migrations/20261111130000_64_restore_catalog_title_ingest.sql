-- Restore the actual titles-schema ingest implementation after migration 61 accidentally
-- reintroduced the obsolete name/overview/release_year column mapping. The Edge normalizer emits
-- title/synopsis/origin_country and rich detail fields; thin list refreshes must preserve detail.
set check_function_bodies = off;

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
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and current_user not in ('service_role', 'postgres', 'supabase_admin') then
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
reset check_function_bodies;
