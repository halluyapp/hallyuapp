-- Hallyu backend — 29 episode and title alerts.
--
-- Alerts are generated from live catalog data, never from a cached schedule held anywhere else:
-- the query below reads `title_episodes`, which the catalog job refreshes. If an episode moves from
-- Tuesday to Monday, the reminder that was queued for Tuesday is simply never created.
--
-- Three jobs, all service-role only and all idempotent through `public.enqueue_notification`'s
-- (recipient, dedupe_key) uniqueness:
--
--   job_queue_upcoming_episodes  one reminder per member per episode, scheduled for its air time
--   job_queue_new_episodes       "Episode 6 is out" once it has aired
--   job_queue_title_updates      a title that changed status is worth telling the people who follow it
--
-- Eligibility is explicit: a title alert, a watchlist row that is still being watched, or a follow.
-- Nothing is sent to a member who has no relationship with the title, and notify_episodes must be on
-- (enqueue_notification re-checks it, so a preference flipped after queueing still wins).

-- ---------------------------------------------------------------------------------------------
-- Who is interested in a title
-- ---------------------------------------------------------------------------------------------

-- One place that decides eligibility, so "watchlist or alert or follow" cannot drift between jobs.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create or replace function public.title_audience(p_title_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct uid from (
    select a.user_id as uid from public.title_alerts a where a.title_id = p_title_id
    union all
    select w.user_id from public.watchlist_items w where w.title_id = p_title_id and w.status = 'watching'
    union all
    select f.user_id from public.title_follows f where f.title_id = p_title_id
  ) interested
$$;

revoke all on function public.title_audience(uuid) from public, anon, authenticated;
grant execute on function public.title_audience(uuid) to service_role;

-- Quiet hours are a preference with no schedule column, so the convention is: members who asked for
-- them get reminders from 09:00 local (stored locale) instead of at the exact air time.
create or replace function public.notify_at_for(p_user_id uuid, p_moment timestamptz)
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when coalesce((select quiet_hours from public.user_preferences where user_id = p_user_id), false)
      -- 09:00 on the member's local day. The sum is parenthesised so `at time zone` applies to the
      -- timestamp; unparenthesised the shift binds to the interval and PostgreSQL looks for
      -- timezone(text, interval), which does not exist.
      then (
        date_trunc('day', p_moment at time zone coalesce(
          (select locale from public.push_tokens where user_id = p_user_id order by created_at desc limit 1),
          'UTC'
        )) + interval '9 hours'
      )
      at time zone coalesce(
        (select locale from public.push_tokens where user_id = p_user_id order by created_at desc limit 1),
        'UTC'
      )
    else p_moment
  end
$$;

revoke all on function public.notify_at_for(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.notify_at_for(uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Upcoming episode reminders
-- ---------------------------------------------------------------------------------------------

-- Queues "Episode 7 airs at 21:00" for everyone in the audience, scheduled for the air time. The
-- dedupe key is episode-specific, so a re-run cannot queue it twice, and a schedule change simply
-- produces a different moment for a key that has not fired yet.
create or replace function public.job_queue_upcoming_episodes(
  p_from_date date default current_date,
  p_to_date date default (current_date + 2),
  p_limit integer default 500
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ep record;
  member uuid;
  queued integer := 0;
  air_moment timestamptz;
begin
  if auth.uid() is not null then
    raise exception 'episode alerts are a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  for ep in
    select
      e.title_id, e.season, e.number, e.title as episode_title, e.air_date, e.air_time,
      e.episode_type, t.title as title_name, t.world
    from public.title_episodes e
    join public.titles t on t.id = e.title_id
    where e.air_date between p_from_date and p_to_date
      and t.status = 'airing'
      and public.catalog_lifecycle_of(t) = 'airing'
      and t.catalog_unavailable_at is null
    order by e.air_date, e.season, e.number
    limit least(greatest(coalesce(p_limit, 500), 1), 5000)
  loop
    -- Provider air dates are dates, not timestamps; 21:00 UTC is the project's airing convention and
    -- is adjusted per member below when quiet hours are on.
    air_moment := ep.air_date::timestamptz + coalesce(ep.air_time, time '21:00');

    for member in select public.title_audience(ep.title_id) loop
      perform public.enqueue_notification(
        member,
        'episode_live',
        'drama',
        format('episode:%s:%s:%s', ep.title_id, ep.season, ep.number),
        '{}'::uuid[],
        null, null,
        ep.title_id,
        null, null,
        ep.number,
        ep.title_name,
        case
          when ep.episode_type = 2 then 'The finale is on tonight.'
          when ep.episode_title is not null then 'Episode ' || ep.number || ': ' || left(ep.episode_title, 120)
          else 'Episode ' || ep.number || ' airs tonight.'
        end,
        '/drama/' || ep.title_id::text,
        public.notify_at_for(member, air_moment),
        -- Reminders are useful for a week, then they are noise.
        least(air_moment, now()) + interval '7 days'
      );
      queued := queued + 1;
    end loop;
  end loop;

  return queued;
end;
$$;

revoke all on function public.job_queue_upcoming_episodes(date, date, integer) from public, anon, authenticated;
grant execute on function public.job_queue_upcoming_episodes(date, date, integer) to service_role;

-- ---------------------------------------------------------------------------------------------
-- New episodes
-- ---------------------------------------------------------------------------------------------

-- "Your show has a new episode out." Keyed on the episode too, so an outage or a rerun is invisible
-- and a member never receives the same episode twice.
create or replace function public.job_queue_new_episodes(
  p_from_date date default current_date,
  p_to_date date default current_date
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ep record;
  member uuid;
  queued integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'episode alerts are a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  for ep in
    select
      e.title_id, e.season, e.number, e.title as episode_title, e.air_date, e.air_time,
      t.title as title_name, t.world
    from public.title_episodes e
    join public.titles t on t.id = e.title_id
    where e.air_date between p_from_date and p_to_date
      and e.air_date <= current_date
      and t.catalog_unavailable_at is null
      and (t.status = 'airing' or t.status = 'completed')
    order by e.air_date, e.season, e.number
  loop
    for member in select public.title_audience(ep.title_id) loop
      perform public.enqueue_notification(
        member,
        'episode_aired',
        'drama',
        format('aired:%s:%s:%s', ep.title_id, ep.season, ep.number),
        '{}'::uuid[],
        null, null,
        ep.title_id,
        null, null,
        ep.number,
        ep.title_name,
        case
          when ep.episode_title is not null then 'Episode ' || ep.number || ': ' || left(ep.episode_title, 120) || ' is out.'
          else 'Episode ' || ep.number || ' is out.'
        end,
        '/episode/' || ep.title_id::text || '/' || ep.season::text || '/' || ep.number::text,
        now(),
        now() + interval '14 days'
      );
      queued := queued + 1;
    end loop;
  end loop;

  return queued;
end;
$$;

revoke all on function public.job_queue_new_episodes(date, date) from public, anon, authenticated;
grant execute on function public.job_queue_new_episodes(date, date) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Title lifecycle updates
-- ---------------------------------------------------------------------------------------------

-- A title that started, finished or got cancelled is news for the people who follow it. The key
-- includes the status, so "started airing" and "finished" are two separate messages.
create or replace function public.job_queue_title_updates(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t record;
  member uuid;
  queued integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'episode alerts are a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  for t in
    select id, title, world, status, first_air_date, last_air_date
    from public.titles
    where catalog_unavailable_at is null
      and updated_at > now() - interval '26 hours'
      and status in ('airing', 'completed', 'upcoming')
      and (
        (status = 'airing' and first_air_date between current_date - 2 and current_date)
        or (status = 'completed' and last_air_date between current_date - 2 and current_date)
      )
    order by updated_at desc
    limit least(greatest(coalesce(p_limit, 200), 1), 2000)
  loop
    for member in select public.title_audience(t.id) loop
      perform public.enqueue_notification(
        member,
        case when t.status = 'airing' then 'drama_trending'::public.notification_kind else 'system'::public.notification_kind end,
        'drama',
        format('title-status:%s:%s', t.id, t.status),
        '{}'::uuid[],
        null, null,
        t.id,
        null, null,
        null,
        t.title,
        case
          when t.status = 'airing' then 'is on now.'
          when t.status = 'completed' then 'has finished airing.'
          else 'is coming.'
        end,
        '/drama/' || t.id::text,
        public.notify_at_for(member, now()),
        now() + interval '14 days'
      );
      queued := queued + 1;
    end loop;
  end loop;

  return queued;
end;
$$;

revoke all on function public.job_queue_title_updates(integer) from public, anon, authenticated;
grant execute on function public.job_queue_title_updates(integer) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Wiring these into the dispatcher
-- ---------------------------------------------------------------------------------------------

-- `run_scheduled_jobs` (migration 27) calls the job names it knows. These three are new, so the
-- dispatcher's list is replaced here with one that includes them. The signature is unchanged.
create or replace function public.run_scheduled_jobs(p_jobs text[] default null)
returns table (job text, status text, run_id uuid, items integer, error text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  entry text;
  run_key_value text;
  claim_row record;
  retention_row record;
  handled integer := 0;
  job_error text;
  outcome text;
begin
  if auth.uid() is not null then
    raise exception 'scheduled jobs are a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  perform public.job_release_stale();

  foreach entry in array coalesce(
    p_jobs,
    array[
      'catalog.status',
      'catalog.episode_schedule',
      'catalog.prune',
      'catalog.aggregates',
      'catalog.trending',
      'alerts.upcoming_episodes',
      'alerts.new_episodes',
      'alerts.title_updates',
      'notifications.fanout',
      'notifications.retention',
      'media.reconcile',
      'moderation.audit'
    ]
  ) loop
    run_key_value := case
      when entry in ('catalog.trending', 'moderation.audit')
        then (now() at time zone 'utc')::date::text
      when entry in ('alerts.upcoming_episodes', 'alerts.new_episodes', 'alerts.title_updates', 'notifications.fanout', 'notifications.retention', 'media.reconcile')
        then to_char(now() at time zone 'utc', 'YYYY-MM-DD') || 'T' || to_char(date_trunc('hour', now()), 'HH24')
      else to_char(date_trunc('hour', now()), 'YYYY-MM-DD') || 'T' || to_char(date_trunc('hour', now()), 'HH24')
    end;

    job_error := null;
    outcome := 'skipped';

    for claim_row in select * from public.job_claim(entry, run_key_value) loop
      if claim_row.did_claim then
        begin
          case entry
            when 'catalog.status' then
              handled := public.job_reconcile_catalog_status();
            when 'catalog.episode_schedule' then
              handled := public.job_reconcile_episode_schedule();
            when 'catalog.prune' then
              handled := (select coalesce(titles_parked, 0) + coalesce(titles_available, 0) from public.job_prune_stale_catalog());
            when 'catalog.aggregates' then
              handled := public.job_recompute_community_post_counts();
            when 'catalog.trending' then
              handled := public.refresh_trending(null);
            when 'alerts.upcoming_episodes' then
              handled := public.job_queue_upcoming_episodes();
            when 'alerts.new_episodes' then
              handled := public.job_queue_new_episodes();
            when 'alerts.title_updates' then
              handled := public.job_queue_title_updates();
            when 'notifications.fanout' then
              handled := public.fanout_due_notifications();
            when 'notifications.retention' then
              select * into retention_row from public.job_expire_notifications();
              handled := coalesce(retention_row.notifications_removed, 0)
                       + coalesce(retention_row.deliveries_removed, 0)
                       + coalesce(retention_row.read_removed, 0);
            when 'media.reconcile' then
              handled := 0; -- replaced by migration 30
            when 'moderation.audit' then
              handled := 0; -- replaced by migration 33
            else
              raise exception 'unknown job %', entry using errcode = 'invalid_parameter_value';
          end case;
          outcome := 'succeeded';
        exception when others then
          job_error := left(sqlerrm, 500);
          outcome := 'failed';
        end;

        perform public.job_complete(claim_row.id, outcome, handled, job_error);

        return query select entry, outcome, claim_row.id, handled, job_error;
        return;
      end if;
    end loop;
  end loop;

  return;
end;
$$;

revoke all on function public.run_scheduled_jobs(text[]) from public, anon, authenticated;
grant execute on function public.run_scheduled_jobs(text[]) to service_role;

comment on function public.job_queue_upcoming_episodes(date, date, integer) is
  'Idempotent reminder queue. Re-running the same window re-uses each (recipient, episode) dedupe key, so a member can never be reminded twice for the same episode.';

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
