-- =============================================================================================
-- Migration 51: Watch Tracker & Diary (Phase 1)
--   * `track_entries`: one dated row per watch event (episode or movie), private by default.
--   * RPCs: log_watch (idempotent, daily cap, advances watchlist progress), delete_watch_entry,
--     watch_diary_page (member-local day buckets), tracker_summary (streaks, totals, heatmap).
--   * Owner-only RLS. Writes happen only through SECURITY DEFINER RPCs.
--   * Additive only. No existing table is rewritten.
-- =============================================================================================

set check_function_bodies = on;

-- ---------------------------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------------------------

create table if not exists public.track_entries (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references public.profiles (id) on delete cascade,
  title_id        uuid        not null references public.titles (id) on delete cascade,
  watched_on      date        not null,
  watched_at      timestamptz not null default now(),
  season          smallint,
  episode         smallint,
  unit            text        not null default 'episode' check (unit in ('episode', 'movie')),
  is_rewatch      boolean     not null default false,
  rating          smallint    check (rating is null or rating between 1 and 5),
  note            text        check (note is null or char_length(note) <= 280),
  source          text        not null default 'manual' check (source in ('manual', 'mark_watched', 'import')),
  client_key      text        check (client_key is null or char_length(client_key) between 8 and 120),
  visibility      text        not null default 'private' check (visibility in ('private', 'aggregate')),
  created_at      timestamptz not null default now(),
  constraint track_entries_episode_shape check (
    (unit = 'episode' and season is not null and episode is not null and season >= 1 and episode >= 1)
    or (unit = 'movie' and season is null and episode is null)
  ),
  constraint track_entries_no_future check (watched_on <= (now() at time zone 'UTC')::date + 1)
);

-- One first-time watch per title/episode/day. Rewatches are allowed as separate rows.
create unique index if not exists track_entries_first_watch_uidx
  on public.track_entries (user_id, title_id, season, episode, watched_on)
  where is_rewatch = false;

create unique index if not exists track_entries_client_key_uidx
  on public.track_entries (user_id, client_key)
  where client_key is not null;

create index if not exists track_entries_user_day_idx
  on public.track_entries (user_id, watched_on desc);

alter table public.track_entries enable row level security;

drop policy if exists track_entries_owner_select on public.track_entries;
create policy track_entries_owner_select
  on public.track_entries
  for select
  to authenticated
  using (user_id = auth.uid());

-- No direct insert/update/delete policies. Every write goes through the RPCs below.
revoke all on public.track_entries from anon, authenticated;
grant select on public.track_entries to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. log_watch — the only write path for a watch event
-- ---------------------------------------------------------------------------------------------

create or replace function public.log_watch(
  p_title_id    uuid,
  p_watched_on  date,
  p_season      smallint default null,
  p_episode     smallint default null,
  p_rating      smallint default null,
  p_note        text default null,
  p_client_key  text default null,
  p_source      text default 'manual'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor       uuid := auth.uid();
  today_utc   date := (now() at time zone 'UTC')::date;
  unit_value  text;
  existing    public.track_entries%rowtype;
  inserted    public.track_entries%rowtype;
  day_count   integer;
  wl          public.watchlist_items%rowtype;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.titles where id = p_title_id) then
    raise exception 'title % does not exist', p_title_id using errcode = 'no_data_found';
  end if;

  if p_watched_on is null or p_watched_on > today_utc + 1 then
    raise exception 'watched_on cannot be in the future' using errcode = 'check_violation';
  end if;

  if p_watched_on < today_utc - 3650 then
    raise exception 'watched_on is too far in the past' using errcode = 'check_violation';
  end if;

  if p_note is not null and char_length(p_note) > 280 then
    raise exception 'note must be 280 characters or fewer' using errcode = 'check_violation';
  end if;

  if p_rating is not null and (p_rating < 1 or p_rating > 5) then
    raise exception 'rating must be between 1 and 5' using errcode = 'check_violation';
  end if;

  if p_source not in ('manual', 'mark_watched', 'import') then
    raise exception 'unknown source %', p_source using errcode = 'check_violation';
  end if;

  -- Idempotency: a retried client request returns the original row.
  if p_client_key is not null then
    select * into existing from public.track_entries
    where user_id = actor and client_key = p_client_key;
    if found then
      return jsonb_build_object('entry_id', existing.id, 'duplicate', true);
    end if;
  end if;

  unit_value := case when p_season is null and p_episode is null then 'movie' else 'episode' end;

  -- Duplicate first-watch on the same day: return the existing row, do not double count.
  if unit_value = 'episode' then
    select * into existing from public.track_entries
    where user_id = actor and title_id = p_title_id
      and season = p_season and episode = p_episode
      and watched_on = p_watched_on and is_rewatch = false;
    if found then
      return jsonb_build_object('entry_id', existing.id, 'duplicate', true);
    end if;
  end if;

  -- Daily cap keeps accidental loops and bad imports from flooding the diary.
  select count(*) into day_count from public.track_entries
  where user_id = actor and watched_on = p_watched_on;
  if day_count >= 60 then
    raise exception 'daily diary limit of 60 entries reached' using errcode = 'check_violation';
  end if;

  insert into public.track_entries (
    user_id, title_id, watched_on, season, episode, unit, rating, note, source, client_key
  ) values (
    actor, p_title_id, p_watched_on, p_season, p_episode, unit_value, p_rating,
    nullif(btrim(p_note), ''), p_source, p_client_key
  )
  returning * into inserted;

  -- Advance the existing watch pointer in the same transaction (never move it backwards).
  if unit_value = 'episode' then
    insert into public.watchlist_items (user_id, title_id, status, season, current_episode, updated_at)
    values (actor, p_title_id, 'watching', p_season, p_episode, now())
    on conflict (user_id, title_id) do update
      set current_episode = greatest(public.watchlist_items.current_episode, excluded.current_episode),
          season = case when excluded.current_episode >= public.watchlist_items.current_episode
                        then excluded.season else public.watchlist_items.season end,
          status = case when public.watchlist_items.status = 'want' then 'watching'::public.watch_status
                        else public.watchlist_items.status end,
          updated_at = now();
  end if;

  return jsonb_build_object('entry_id', inserted.id, 'duplicate', false);
end;
$$;

revoke all on function public.log_watch(uuid, date, smallint, smallint, smallint, text, text, text) from public;
grant execute on function public.log_watch(uuid, date, smallint, smallint, smallint, text, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. delete_watch_entry — the member removes a mistaken entry
-- ---------------------------------------------------------------------------------------------

create or replace function public.delete_watch_entry(p_entry_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  removed integer;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  delete from public.track_entries where id = p_entry_id and user_id = actor;
  get diagnostics removed = row_count;
  return removed > 0;
end;
$$;

revoke all on function public.delete_watch_entry(uuid) from public;
grant execute on function public.delete_watch_entry(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. watch_diary_page — newest-first page of the caller's own diary
-- ---------------------------------------------------------------------------------------------

create or replace function public.watch_diary_page(
  p_before  timestamptz default null,
  p_limit   integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  lim   integer := greatest(1, least(coalesce(p_limit, 30), 100));
  rows  jsonb;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select coalesce(jsonb_agg(row_to_json(page) order by page.watched_at desc), '[]'::jsonb)
    into rows
  from (
    select e.id, e.title_id, e.watched_on, e.watched_at, e.season, e.episode, e.unit,
           e.rating, e.note, e.source,
           t.title, t.poster_url, t.media_type,
           t.runtime_minutes as title_runtime,
           ep.runtime_minutes as episode_runtime
    from public.track_entries e
    join public.titles t on t.id = e.title_id
    left join public.title_episodes ep
      on ep.title_id = e.title_id and ep.season = e.season and ep.number = e.episode
    where e.user_id = actor
      and (p_before is null or e.watched_at < p_before)
    order by e.watched_at desc
    limit lim
  ) page;

  return jsonb_build_object('entries', rows);
end;
$$;

revoke all on function public.watch_diary_page(timestamptz, integer) from public;
grant execute on function public.watch_diary_page(timestamptz, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. tracker_summary — streaks, totals and a 365-day heatmap for the caller
--    `p_today` is the member's local date, so streaks follow their own calendar.
-- ---------------------------------------------------------------------------------------------

create or replace function public.tracker_summary(p_today date default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  today date := coalesce(p_today, (now() at time zone 'UTC')::date);
  total_entries integer;
  total_minutes integer;
  days_active integer;
  current_streak integer := 0;
  longest_streak integer := 0;
  heatmap jsonb;
  today_count integer;
  run integer := 0;
  prev date := null;
  cursor_day date;
  d record;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if today > (now() at time zone 'UTC')::date + 1 then
    raise exception 'today cannot be in the future' using errcode = 'check_violation';
  end if;

  select count(*) into total_entries from public.track_entries where user_id = actor;

  select coalesce(sum(coalesce(ep.runtime_minutes, t.runtime_minutes, 0)), 0)::integer
    into total_minutes
  from public.track_entries e
  join public.titles t on t.id = e.title_id
  left join public.title_episodes ep
    on ep.title_id = e.title_id and ep.season = e.season and ep.number = e.episode
  where e.user_id = actor;

  select count(distinct watched_on) into days_active from public.track_entries where user_id = actor;

  select count(*) into today_count from public.track_entries
  where user_id = actor and watched_on = today;

  -- Streaks: consecutive distinct watch days, longest ever and the run ending today or yesterday.
  for d in
    select distinct watched_on from public.track_entries
    where user_id = actor order by watched_on
  loop
    if prev is not null and d.watched_on = prev + 1 then
      run := run + 1;
    else
      run := 1;
    end if;
    longest_streak := greatest(longest_streak, run);
    prev := d.watched_on;
  end loop;

  -- Current streak: start from today, or yesterday if today has no entry yet (the day isn't over),
  -- then walk backwards one day at a time while each day has at least one entry.
  cursor_day := today;
  if not exists (select 1 from public.track_entries where user_id = actor and watched_on = today) then
    cursor_day := today - 1;
  end if;
  loop
    exit when not exists (
      select 1 from public.track_entries where user_id = actor and watched_on = cursor_day
    );
    current_streak := current_streak + 1;
    cursor_day := cursor_day - 1;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('day', x.watched_on, 'count', x.n) order by x.watched_on), '[]'::jsonb)
    into heatmap
  from (
    select watched_on, count(*)::integer as n from public.track_entries
    where user_id = actor and watched_on > today - 365 and watched_on <= today + 1
    group by watched_on
  ) x;

  return jsonb_build_object(
    'today', today,
    'today_count', today_count,
    'total_entries', total_entries,
    'total_minutes', total_minutes,
    'days_active', days_active,
    'current_streak', current_streak,
    'longest_streak', longest_streak,
    'heatmap', heatmap
  );
end;
$$;

revoke all on function public.tracker_summary(date) from public;
grant execute on function public.tracker_summary(date) to authenticated, service_role;
