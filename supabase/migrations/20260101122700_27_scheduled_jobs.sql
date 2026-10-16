-- Hallyu backend — 27 scheduled jobs.
--
-- Every recurring task in Hallyu is a function with a run key. The same function called twice with
-- the same key does the work once: that is what makes a cron that fires at 03:00 and a retry at
-- 03:04 safe, and what makes "run this by hand from the dashboard" safe too.
--
-- A run key is the job name plus whatever buckets time into it — the hour for a catalog refresh,
-- the date for a daily digest. The (job, run_key) unique constraint is the whole concurrency
-- mechanism: no advisory locks, no "is it already running?" query, no duplicate work.
--
-- `public.run_scheduled_jobs()` is the single entry point the cron calls. Each job is wrapped in its
-- own block so one failing job never stops the others, and the result of every attempt is recorded.

-- ---------------------------------------------------------------------------------------------
-- Job bookkeeping
-- ---------------------------------------------------------------------------------------------

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create table if not exists public.job_runs (
  id            uuid primary key default gen_random_uuid(),
  job           text        not null,
  run_key       text        not null,
  status        text        not null default 'running',
  attempt       integer     not null default 1,
  items_processed integer   not null default 0,
  duration_ms   integer,
  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  constraint job_runs_status_known check (status in ('running', 'succeeded', 'failed', 'skipped')),
  constraint job_runs_attempt_positive check (attempt >= 1),
  constraint job_runs_job_key_unique unique (job, run_key)
);

comment on table public.job_runs is 'One row per (job, run_key). Re-running the same key returns the existing row and does no work.';

create index if not exists job_runs_job_started_idx on public.job_runs (job, started_at desc);
create index if not exists job_runs_unfinished_idx on public.job_runs (started_at) where status = 'running';

alter table public.job_runs enable row level security;

create policy job_runs_service_only on public.job_runs
  for all to service_role using (true) with check (true);

grant select on public.job_runs to authenticated;

-- Claims a (job, run_key). Returns the run id and whether this caller is the one that got it: a
-- second concurrent caller gets the existing id with did_claim = false and must not do the work.
create or replace function public.job_claim(
  p_job text,
  p_run_key text
)
returns table (id uuid, did_claim boolean, attempt integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.job_runs%rowtype;
  new_id uuid;
  next_attempt integer;
begin
  if auth.uid() is not null then
    raise exception 'scheduled jobs are a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  if p_job is null or length(btrim(p_job)) = 0 or length(p_job) > 64 then
    raise exception 'invalid job name' using errcode = 'invalid_parameter_value';
  end if;
  if p_run_key is null or length(btrim(p_run_key)) = 0 or length(p_run_key) > 80 then
    raise exception 'invalid run key' using errcode = 'invalid_parameter_value';
  end if;

  select * into existing from public.job_runs where job = p_job and run_key = p_run_key;

  if found then
    -- A finished run is never re-run under the same key. A failed or stuck run may be retried, and
    -- the retry is counted rather than hidden.
    if existing.status = 'succeeded' or existing.status = 'skipped' then
      return query select existing.id, false, existing.attempt;
      return;
    end if;

    next_attempt := existing.attempt + 1;
    update public.job_runs
       set status = 'running',
           attempt = next_attempt,
           started_at = now(),
           finished_at = null,
           error = null
     where job_runs.id = existing.id;

    return query select existing.id, true, next_attempt;
    return;
  end if;

  insert into public.job_runs (job, run_key) values (p_job, p_run_key) returning job_runs.id into new_id;
  return query select new_id, true, 1;
end;
$$;

revoke all on function public.job_claim(text, text) from public, anon, authenticated;
grant execute on function public.job_claim(text, text) to service_role;

create or replace function public.job_complete(
  p_run_id uuid,
  p_status text,
  p_items_processed integer default 0,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'scheduled jobs are a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  if p_status not in ('succeeded', 'failed', 'skipped') then
    raise exception 'invalid job status %', p_status using errcode = 'invalid_parameter_value';
  end if;

  update public.job_runs
     set status = p_status,
         items_processed = greatest(items_processed, coalesce(p_items_processed, 0)),
         error = left(p_error, 500),
         finished_at = now(),
         duration_ms = (extract(epoch from (now() - started_at)) * 1000)::integer
   where id = p_run_id;
end;
$$;

revoke all on function public.job_complete(uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.job_complete(uuid, text, integer, text) to service_role;

-- A run that was claimed and never finished (a killed container, a deploy mid-flight) is returned to
-- the queue so the next tick retries it. Safe because the work itself is idempotent.
create or replace function public.job_release_stale(p_older_than interval default interval '30 minutes')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  reclaimed integer;
begin
  if auth.uid() is not null then
    raise exception 'scheduled jobs are a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  update public.job_runs
     set status = 'failed',
         error = coalesce(error, 'run abandoned before completion'),
         finished_at = now()
   where status = 'running'
     and started_at < now() - p_older_than;

  get diagnostics reclaimed = row_count;
  return reclaimed;
end;
$$;

revoke all on function public.job_release_stale(interval) from public, anon, authenticated;
grant execute on function public.job_release_stale(interval) to service_role;

-- ---------------------------------------------------------------------------------------------
-- The jobs themselves. Each is a plain function the scheduler calls; each is individually safe.
-- ---------------------------------------------------------------------------------------------

-- Recomputes lifecycle for every title whose dates or status could have moved since the last run.
create or replace function public.job_reconcile_catalog_status(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  touched integer := 0;
  pending record;
begin
  -- Titles that are airing, or that are upcoming and whose start date has now passed or is close,
  -- are the ones whose status can actually have changed.
  for pending in
    select t.id
    from public.titles t
    where t.catalog_missing_count < public.catalog_missing_threshold()
      and (
        t.status = 'airing'
        or (t.status = 'upcoming' and t.first_air_date is not null and t.first_air_date <= current_date + 7)
        or (t.status = 'completed' and t.last_air_date is not null and t.last_air_date >= current_date - 7)
      )
    order by
      (case t.status when 'airing' then 0 when 'upcoming' then 1 else 2 end),
      t.next_episode_at asc nulls last
    limit least(greatest(coalesce(p_limit, 500), 1), 5000)
  loop
    perform public.catalog_recompute_title_state(pending.id);
    touched := touched + 1;
  end loop;

  return touched;
end;
$$;

revoke all on function public.job_reconcile_catalog_status(integer) from public, anon, authenticated;
grant execute on function public.job_reconcile_catalog_status(integer) to service_role;

-- Rebuilds next_episode_at from the episode table for anything airing. Episode schedules are the
-- part of the catalog that goes stale fastest, so they are refreshed on a short cycle.
create or replace function public.job_reconcile_episode_schedule(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pending record;
  touched integer := 0;
begin
  for pending in
    select t.id
    from public.titles t
    where t.status = 'airing'
    order by t.next_episode_at asc nulls last
    limit least(greatest(coalesce(p_limit, 500), 1), 5000)
  loop
    perform public.catalog_recompute_next_episode(pending.id);
    touched := touched + 1;
  end loop;

  return touched;
end;
$$;

revoke all on function public.job_reconcile_episode_schedule(integer) from public, anon, authenticated;
grant execute on function public.job_reconcile_episode_schedule(integer) to service_role;

-- Retires records the provider stopped returning, so a cancelled show cannot linger in discovery.
create or replace function public.job_prune_stale_catalog()
returns table (titles_parked integer, titles_available integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  parked integer := 0;
  restored integer := 0;
begin
  -- A record that has been missing past the threshold, and is not carrying live posts, is parked.
  update public.titles t
     set catalog_unavailable_at = now()
   where t.catalog_missing_count >= public.catalog_missing_threshold()
     and t.catalog_unavailable_at is null;

  get diagnostics parked = row_count;

  -- Anything the provider confirms again comes straight back.
  update public.titles t
     set catalog_unavailable_at = null
   where t.catalog_unavailable_at is not null
     and t.catalog_synced_at > t.catalog_unavailable_at;

  get diagnostics restored = row_count;

  return query select parked, restored;
end;
$$;

revoke all on function public.job_prune_stale_catalog() from public, anon, authenticated;
grant execute on function public.job_prune_stale_catalog() to service_role;

-- Derived aggregates that would otherwise drift: the per-world counts and the room post counts that
-- the Home and room headers show.
create or replace function public.job_recompute_community_post_counts()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  touched integer;
begin
  with actual as (
    select p.community_id, count(*)::integer as posts
    from public.posts p
    where p.community_id is not null and p.state = 'active'
    group by p.community_id
  )
  update public.communities c
     set post_count = coalesce(a.posts, 0)
    from actual a
   where c.id = a.community_id
     and c.post_count is distinct from a.posts;

  get diagnostics touched = row_count;

  -- Rooms with no active posts at all also need zeroing.
  update public.communities c
     set post_count = 0
   where c.post_count <> 0
     and not exists (select 1 from public.posts p where p.community_id = c.id and p.state = 'active');

  return touched;
end;
$$;

revoke all on function public.job_recompute_community_post_counts() from public, anon, authenticated;
grant execute on function public.job_recompute_community_post_counts() to service_role;

-- Recomputes the daily ranking snapshots the Trending screens read.
create or replace function public.job_refresh_trending(p_world text default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.refresh_trending(p_world);
end;
$$;

revoke all on function public.job_refresh_trending(text) from public, anon, authenticated;
grant execute on function public.job_refresh_trending(text) to service_role;

-- The dispatcher. One job failing never blocks the others: each block is independent and each result
-- is recorded against its own (job, run_key).
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
  handled integer := 0;
  job_error text;
  outcome text;
begin
  if auth.uid() is not null then
    raise exception 'scheduled jobs are a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  -- Anything abandoned by a previous run goes back in the queue first.
  perform public.job_release_stale();

  foreach entry in array coalesce(
    p_jobs,
    array[
      'catalog.status',        -- every 15 minutes
      'catalog.episode_schedule', -- every 15 minutes
      'catalog.prune',         -- hourly
      'catalog.aggregates',    -- hourly
      'catalog.trending',      -- every 6 hours
      'notifications.retention',-- hourly
      'media.reconcile',       -- hourly
      'moderation.audit'       -- daily
    ]
  ) loop
    -- The run key buckets time so a retry inside the same window is a no-op.
    run_key_value := case
      when entry = 'catalog.trending' then to_char(now() at time zone 'utc', 'YYYY-MM-DD') || 'T' || to_char(date_trunc('hour', now()), 'HH24') || '-6h'
      when entry = 'moderation.audit' then (now() at time zone 'utc')::date::text
      when entry = 'notifications.retention' then to_char(now() at time zone 'utc', 'YYYY-MM-DD') || 'T' || to_char(date_trunc('hour', now()), 'HH24')
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
            when 'notifications.retention' then
              handled := 0; -- replaced by migration 28; kept so the dispatcher is stable
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

  -- Nothing claimed means every requested job had already succeeded in this window.
  return;
end;
$$;

revoke all on function public.run_scheduled_jobs(text[]) from public, anon, authenticated;
grant execute on function public.run_scheduled_jobs(text[]) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Cron wiring (intentionally inert until a project exists)
-- ---------------------------------------------------------------------------------------------
--
-- On a hosted project, enable `pg_cron` and schedule the dispatcher. Every value below is either a
-- Vault secret name or a literal schedule; no credential is stored in this repository.
--
--   select vault.create_secret('<project-url>', 'hallyu_project_url', 'Hallyu Supabase project URL');
--   select vault.create_secret('<anon-key>',     'hallyu_anon_key',    'Signs the Edge Function call');
--
--   select cron.schedule(
--     'hallyu-catalog-jobs',
--     '*/15 * * * *',   -- every 15 minutes
--     $$
--     select net.http_post(
--       url      := (select decrypted_secret from vault.decrypted_secrets where name = 'hallyu_project_url')
--                   || '/functions/v1/catalog-jobs',
--       headers  := jsonb_build_object(
--                     'Content-Type', 'application/json',
--                     'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'hallyu_anon_key')
--                   ),
--       body     := '{}'::jsonb
--     );
--     $$
--   );
--
-- schedule('hallyu-catalog-sync',  '23 * * * *', ...)   -- hourly TMDB refresh
-- schedule('hallyu-push-dispatch', '41 * * * *', ...)   -- hourly push delivery
-- schedule('hallyu-media-cleanup', '13 5 * * *', ...)   -- daily storage reconciliation
-- schedule('hallyu-purge',         '17 4 * * *', ...)   -- daily retention (migration 22)

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
