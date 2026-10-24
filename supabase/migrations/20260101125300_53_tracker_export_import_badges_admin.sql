-- =============================================================================================
-- Migration 53: Watch Tracker completion
--   * tracker_export()           — the caller's diary, reading log and shelf (data export)
--   * tracker_import_match()     — exact title+year matching for CSV imports (never fuzzy-writes)
--   * log_watch_batch()          — up to 500 imported watch events, per-row results
--   * year_review()              — a calendar year in numbers for the caller
--   * tracker_badges()           — the three tracker badges, computed from the caller's own data
--   * admin_tracker_overview()   — staff view: volume, members, streak distribution
-- Additive only. All member data stays owner-only.
-- =============================================================================================

set check_function_bodies = on;

-- ---------------------------------------------------------------------------------------------
-- 1. tracker_export — everything the member owns in the tracker, for the data export
-- ---------------------------------------------------------------------------------------------

create or replace function public.tracker_export()
returns jsonb
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

  return jsonb_build_object(
    'exported_at', now(),
    'watch_entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'title_id', e.title_id, 'watched_on', e.watched_on, 'watched_at', e.watched_at,
        'season', e.season, 'episode', e.episode, 'unit', e.unit, 'rating', e.rating,
        'note', e.note, 'source', e.source, 'visibility', e.visibility
      ) order by e.watched_at)
      from public.track_entries e where e.user_id = actor
    ), '[]'::jsonb),
    'reading_logs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'book_id', r.book_id, 'read_on', r.read_on, 'pages', r.pages
      ) order by r.created_at)
      from public.reading_logs r where r.user_id = actor
    ), '[]'::jsonb),
    'shelf', coalesce((
      select jsonb_agg(jsonb_build_object(
        'book_id', s.book_id, 'shelf', s.shelf, 'current_page', s.current_page,
        'rating', s.rating, 'note', s.note, 'started_on', s.started_on, 'finished_on', s.finished_on
      ) order by s.added_at)
      from public.shelf_items s where s.user_id = actor
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.tracker_export() from public;
grant execute on function public.tracker_export() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. tracker_import_match — exact (case-insensitive) title + year. Anything else is "unmatched".
--    Nothing is written here; the client shows unmatched rows for the member to resolve.
-- ---------------------------------------------------------------------------------------------

create or replace function public.tracker_import_match(p_items jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  result jsonb := '[]'::jsonb;
  item record;
  found_id uuid;
  n integer := 0;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then
    raise exception 'import is limited to 500 rows per request' using errcode = 'check_violation';
  end if;

  for item in
    select (ord - 1)::integer as idx,
           nullif(btrim(e->>'title'), '') as title,
           nullif(e->>'year', '')::integer as year
    from jsonb_array_elements(p_items) with ordinality as t(e, ord)
  loop
    found_id := null;
    if item.title is not null and item.year is not null then
      select t.id into found_id
      from public.titles t
      where lower(t.title) = lower(item.title) and t.year = item.year
      order by (t.media_type = 'movie') desc, t.created_at
      limit 1;
    end if;
    result := result || jsonb_build_object('index', item.idx, 'title_id', found_id, 'matched', found_id is not null);
    n := n + 1;
  end loop;

  return jsonb_build_object('results', result, 'count', n);
end;
$$;

revoke all on function public.tracker_import_match(jsonb) from public;
grant execute on function public.tracker_import_match(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. log_watch_batch — imports up to 500 rows through log_watch, one row at a time, so one bad
--    row never blocks the rest. Duplicates are counted, not failed.
-- ---------------------------------------------------------------------------------------------

create or replace function public.log_watch_batch(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  row_item jsonb;
  res jsonb;
  inserted_n integer := 0;
  duplicate_n integer := 0;
  rejected jsonb := '[]'::jsonb;
  idx integer := 0;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'import is limited to 500 rows per request' using errcode = 'check_violation';
  end if;

  for row_item in select value from jsonb_array_elements(p_rows) loop
    idx := idx + 1;
    begin
      res := public.log_watch(
        (row_item->>'title_id')::uuid,
        (row_item->>'watched_on')::date,
        nullif(row_item->>'season', '')::smallint,
        nullif(row_item->>'episode', '')::smallint,
        nullif(row_item->>'rating', '')::smallint,
        nullif(row_item->>'note', ''),
        coalesce(nullif(row_item->>'client_key', ''), 'import-' || md5(row_item::text)),
        'import'
      );
      if (res->>'duplicate')::boolean then
        duplicate_n := duplicate_n + 1;
      else
        inserted_n := inserted_n + 1;
      end if;
    exception when others then
      rejected := rejected || jsonb_build_object('index', idx - 1, 'reason', sqlerrm);
    end;
  end loop;

  return jsonb_build_object('inserted', inserted_n, 'duplicates', duplicate_n, 'rejected', rejected);
end;
$$;

revoke all on function public.log_watch_batch(jsonb) from public;
grant execute on function public.log_watch_batch(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. year_review — a calendar year in numbers (the data behind the Year in Review card)
-- ---------------------------------------------------------------------------------------------

create or replace function public.year_review(p_year integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  yr integer := coalesce(p_year, extract(year from (now() at time zone 'UTC'))::integer);
  entries integer;
  minutes integer;
  days integer;
  best_day date;
  best_count integer;
  top jsonb;
  pages_total integer;
  books integer;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select count(*)::integer, count(distinct e.watched_on)::integer,
         coalesce(sum(coalesce(ep.runtime_minutes, t.runtime_minutes, 0)), 0)::integer
    into entries, days, minutes
  from public.track_entries e
  join public.titles t on t.id = e.title_id
  left join public.title_episodes ep
    on ep.title_id = e.title_id and ep.season = e.season and ep.number = e.episode
  where e.user_id = actor and extract(year from e.watched_on) = yr;

  select e.watched_on, count(*)::integer into best_day, best_count
  from public.track_entries e
  where e.user_id = actor and extract(year from e.watched_on) = yr
  group by e.watched_on order by count(*) desc, e.watched_on limit 1;

  select coalesce(jsonb_agg(x order by x.entries desc, x.title), '[]'::jsonb) into top
  from (
    select t.title, t.poster_url, count(*)::integer as entries
    from public.track_entries e join public.titles t on t.id = e.title_id
    where e.user_id = actor and extract(year from e.watched_on) = yr
    group by t.id, t.title, t.poster_url
    order by count(*) desc, t.title limit 5
  ) x;

  select coalesce(sum(r.pages), 0)::integer into pages_total
  from public.reading_logs r where r.user_id = actor and extract(year from r.read_on) = yr;

  select count(*)::integer into books
  from public.shelf_items where user_id = actor and shelf = 'finished' and extract(year from finished_on) = yr;

  return jsonb_build_object(
    'year', yr, 'entries', entries, 'days_watched', days, 'minutes', minutes,
    'best_day', best_day, 'best_day_entries', coalesce(best_count, 0), 'top_titles', top,
    'pages_read', pages_total, 'books_finished', books
  );
end;
$$;

revoke all on function public.year_review(integer) from public;
grant execute on function public.year_review(integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. tracker_badges — the three tracker badges, computed from the caller's own history.
--    These are NOT Recognition awards: they never enter the Recognition ledger or Admin grants.
-- ---------------------------------------------------------------------------------------------

create or replace function public.tracker_badges()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  longest integer := 0;
  busiest integer := 0;
  completed_titles integer := 0;
  run integer := 0;
  prev date := null;
  d record;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  for d in select distinct watched_on from public.track_entries where user_id = actor order by watched_on loop
    if prev is not null and d.watched_on = prev + 1 then run := run + 1; else run := 1; end if;
    longest := greatest(longest, run);
    prev := d.watched_on;
  end loop;

  select coalesce(max(n), 0) into busiest from (
    select count(*)::integer as n from public.track_entries where user_id = actor group by watched_on
  ) x;

  -- Completionist: a series where every episode in the catalogue has been logged.
  select count(*)::integer into completed_titles from (
    select t.id
    from public.titles t
    join public.track_entries e on e.title_id = t.id and e.user_id = actor and e.unit = 'episode'
    where t.media_type = 'tv' and t.episode_count > 0
    group by t.id, t.episode_count
    having count(distinct (e.season, e.episode)) >= t.episode_count
  ) c;

  return jsonb_build_array(
    jsonb_build_object('id', 'daily_diarist', 'name', 'Daily Diarist', 'earned', longest >= 7,
      'progress', least(longest, 7), 'target', 7, 'detail', '7 days in a row'),
    jsonb_build_object('id', 'marathon', 'name', 'Marathon', 'earned', busiest >= 6,
      'progress', least(busiest, 6), 'target', 6, 'detail', '6 entries in one day'),
    jsonb_build_object('id', 'completionist', 'name', 'Completionist', 'earned', completed_titles >= 1,
      'progress', least(completed_titles, 1), 'target', 1, 'detail', 'Every episode of a series logged')
  );
end;
$$;

revoke all on function public.tracker_badges() from public;
grant execute on function public.tracker_badges() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. admin_tracker_overview — staff-only, aggregate. No member's diary is exposed.
-- ---------------------------------------------------------------------------------------------

create or replace function public.admin_tracker_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  today date := (now() at time zone 'UTC')::date;
  per_day jsonb;
  members_30 integer;
  entries_total integer;
  shelf_total integer;
  streak_buckets jsonb;
begin
  if not public.is_moderator() then
    raise exception 'staff privilege required' using errcode = 'insufficient_privilege';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'entries', coalesce(c.n, 0)) order by d.day), '[]'::jsonb)
    into per_day
  from generate_series(today - 13, today, interval '1 day') as d(day)
  left join (
    select watched_on, count(*)::integer as n from public.track_entries
    where watched_on >= today - 13 group by watched_on
  ) c on c.watched_on = d.day::date;

  select count(distinct user_id)::integer into members_30
  from public.track_entries where watched_on >= today - 29;

  select count(*)::integer into entries_total from public.track_entries;
  select count(*)::integer into shelf_total from public.shelf_items;

  -- Streak distribution: each member's longest run of consecutive watch days, bucketed.
  with runs as (
    select user_id, watched_on,
           watched_on - (row_number() over (partition by user_id order by watched_on))::integer as grp
    from (select distinct user_id, watched_on from public.track_entries) x
  ), lengths as (
    select user_id, count(*) as len from runs group by user_id, grp
  ), best as (
    select user_id, max(len) as longest from lengths group by user_id
  )
  select coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb) into streak_buckets from (
    select case when longest = 1 then '1 day'
                when longest between 2 and 6 then '2-6 days'
                when longest between 7 and 29 then '7-29 days'
                else '30+ days' end as bucket,
           count(*)::integer as n
    from best group by 1
  ) b;

  return jsonb_build_object(
    'per_day_last_14', per_day,
    'members_logging_last_30', members_30,
    'entries_total', entries_total,
    'shelf_books_total', shelf_total,
    'streak_distribution', streak_buckets
  );
end;
$$;

revoke all on function public.admin_tracker_overview() from public;
grant execute on function public.admin_tracker_overview() to authenticated, service_role;
