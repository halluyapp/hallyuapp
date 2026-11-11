-- Reconstructed source for live migration 60: reject nonsensical provider episode runtimes.
-- The deployed definition was inspected on 2026-11-11. Values outside 1..1200 minutes are treated
-- as missing rather than overflowing smallint or producing impossible schedules.
set check_function_bodies = off;

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

grant execute on function public.catalog_upsert_episodes(uuid, integer, jsonb) to service_role;
reset check_function_bodies;
