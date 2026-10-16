-- Hallyu backend — 23 catalog provenance and freshness.
--
-- The catalog in migration 02 is a cache. A cache that cannot say how old it is, or how often it
-- should be refreshed, is a liability: a show that finished airing three months ago still looks
-- "airing", and an episode that moved from Tuesday to Monday keeps sending the wrong reminder.
--
-- This migration gives every cached row provenance — when the provider last confirmed it, what the
-- record looked like then, and how many consecutive refreshes have failed to find it — plus the
-- bookkeeping tables (`catalog_sync_runs`, `catalog_provider_state`) an ingest job needs to be
-- idempotent and to retry safely.
--
-- Everything here is additive. No existing column changes type or meaning, so the tables the app
-- already reads keep working.

-- ---------------------------------------------------------------------------------------------
-- Provenance columns on the cached catalog
-- ---------------------------------------------------------------------------------------------

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

alter table public.titles
  add column if not exists popularity         numeric(10, 3),
  add column if not exists vote_average       numeric(3, 1),
  add column if not exists vote_count         integer     not null default 0,
  add column if not exists origin_country     text[]      not null default '{}',
  add column if not exists first_air_date     date,
  add column if not exists last_air_date      date,
  add column if not exists content_hash       text,
  add column if not exists catalog_synced_at  timestamptz,
  add column if not exists catalog_missing_count integer   not null default 0,
  add column if not exists catalog_unavailable_at timestamptz;

comment on column public.titles.popularity is 'Provider popularity at the last successful refresh. Never invented locally.';
comment on column public.titles.catalog_synced_at is 'When the provider last confirmed this record. NULL = never confirmed.';
comment on column public.titles.content_hash is 'md5 of the normalised ingest payload. An unchanged hash is the reason a refresh writes nothing.';
comment on column public.titles.catalog_missing_count is 'Consecutive refreshes in which the provider did not return this record. At the threshold the record leaves discovery but is never deleted (posts point at it).';

alter table public.people
  add column if not exists popularity        numeric(10, 3),
  add column if not exists known_for_count   integer     not null default 0,
  add column if not exists content_hash      text,
  add column if not exists catalog_synced_at timestamptz;

alter table public.title_people
  add column if not exists catalog_synced_at timestamptz;

alter table public.title_episodes
  add column if not exists catalog_synced_at timestamptz,
  add column if not exists air_time          time,
  add column if not exists episode_type      smallint not null default 1;

comment on column public.title_episodes.episode_type is '1 = standard, 2 = finale. Mirrors the provider value so a finale can be surfaced differently.';

-- A record that is unavailable must not sit in discovery pretending to be current.
create index if not exists titles_catalog_fresh_idx
  on public.titles (catalog_synced_at) where catalog_unavailable_at is null;
create index if not exists titles_airing_window_idx
  on public.titles (status, first_air_date, last_air_date);
create index if not exists titles_origin_country_gin_idx
  on public.titles using gin (origin_country);

-- ---------------------------------------------------------------------------------------------
-- Sync bookkeeping: one row per run, one row per provider
-- ---------------------------------------------------------------------------------------------

create table if not exists public.catalog_sync_runs (
  id             uuid primary key default gen_random_uuid(),
  job            text        not null,
  provider_id    text        not null references public.providers (id) on delete cascade,
  idempotency_key text       not null,
  status         text        not null default 'running',
  items_seen     integer     not null default 0,
  items_written  integer     not null default 0,
  items_unchanged integer    not null default 0,
  items_missing  integer     not null default 0,
  provider_requests integer  not null default 0,
  error          text,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  constraint catalog_sync_runs_status_known check (status in ('running', 'succeeded', 'failed', 'skipped')),
  constraint catalog_sync_runs_key_unique unique (provider_id, idempotency_key)
);

comment on table public.catalog_sync_runs is 'One row per catalog job run. (provider_id, idempotency_key) is unique, so a retried job can never double-count.';
comment on column public.catalog_sync_runs.idempotency_key is 'Caller-supplied key, e.g. "detail:tv:1399:2026-01-06". Replaying the same key returns the existing run instead of starting a second one.';

create index if not exists catalog_sync_runs_job_started_idx on public.catalog_sync_runs (job, started_at desc);
create index if not exists catalog_sync_runs_provider_started_idx on public.catalog_sync_runs (provider_id, started_at desc);

create table if not exists public.catalog_provider_state (
  provider_id         text primary key references public.providers (id) on delete cascade,
  last_success_at     timestamptz,
  last_attempt_at     timestamptz,
  last_failure_at     timestamptz,
  consecutive_failures integer     not null default 0,
  rate_limited_until  timestamptz,
  disabled_reason     text,
  total_items_written bigint      not null default 0,
  total_requests      bigint      not null default 0,
  updated_at          timestamptz not null default now()
);

comment on table public.catalog_provider_state is 'Per-provider health: last success, consecutive failures, and a rate-limit backoff the ingest job honours before making another request.';

create trigger catalog_provider_state_set_updated_at
  before update on public.catalog_provider_state
  for each row execute function public.set_updated_at();

-- These two tables are operational state. No client reads or writes them; the ingest Edge Function
-- runs as the service role (which bypasses RLS) and the policies below exist so that an
-- authenticated member can neither read nor forge a sync record.
alter table public.catalog_sync_runs enable row level security;
alter table public.catalog_provider_state enable row level security;

create policy catalog_sync_runs_service_only on public.catalog_sync_runs
  for all to service_role using (true) with check (true);

create policy catalog_provider_state_service_only on public.catalog_provider_state
  for all to service_role using (true) with check (true);

grant select on public.catalog_sync_runs, public.catalog_provider_state to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Freshness policy
-- ---------------------------------------------------------------------------------------------

-- How stale a record is allowed to get before the refresh job must look at it again. The schedule
-- follows how fast the thing actually changes: an airing drama moves weekly, a completed show is
-- effectively frozen, and a record the provider keeps failing to return is only retried occasionally.
create or replace function public.catalog_refresh_interval(p_status public.title_status)
returns interval
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_status
    when 'airing' then interval '12 hours'
    when 'upcoming' then interval '2 days'
    when 'completed' then interval '14 days'
    else interval '30 days'
  end
$$;

revoke all on function public.catalog_refresh_interval(public.title_status) from public, anon, authenticated;
grant execute on function public.catalog_refresh_interval(public.title_status) to authenticated, service_role;

-- Records whose availability has been lost for too long stop appearing in discovery. They are kept:
-- posts, watchlist entries and collections still point at them, and the retention job is the only
-- thing that ever removes a title.
create or replace function public.catalog_missing_threshold()
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select 5
$$;

revoke all on function public.catalog_missing_threshold() from public, anon, authenticated;
grant execute on function public.catalog_missing_threshold() to service_role;

-- The work queue for the refresh job: which records are due, newest need first. This is the only
-- place that decides staleness, so the ingest job and the UI can never disagree about it.
create or replace function public.titles_needing_refresh(
  p_world text default null,
  p_limit integer default 100
)
returns table (
  title_id uuid,
  provider_id text,
  external_id text,
  media_type public.media_type,
  status public.title_status,
  priority integer,
  reason text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id,
    t.provider_id,
    t.external_id,
    t.media_type,
    t.status,
    -- Higher runs first: never-synced and currently-airing records matter most.
    (case when t.catalog_synced_at is null then 0 else 1 end) * 1000
      + (case when t.status = 'airing' then 300 when t.status = 'upcoming' then 200 else 100 end)
      + greatest(0, 200 - (extract(epoch from (now() - coalesce(t.catalog_synced_at, now() - interval '1 day'))) / 3600)::integer),
    case
      when t.catalog_synced_at is null then 'never_synced'
      when t.catalog_unavailable_at is not null then 'previously_unavailable'
      when t.catalog_synced_at < now() - public.catalog_refresh_interval(t.status) then 'stale'
      else 'fresh'
    end
  from public.titles t
  where (p_world is null or t.world = p_world)
    and exists (select 1 from public.providers pr where pr.id = t.provider_id and pr.is_active)
    and (
      t.catalog_synced_at is null
      or t.catalog_unavailable_at is not null
      or t.catalog_synced_at < now() - public.catalog_refresh_interval(t.status)
    )
    and t.catalog_missing_count < public.catalog_missing_threshold()
  order by
    (case when t.catalog_synced_at is null then 0 else 1 end) asc,
    (case when t.status = 'airing' then 0 when t.status = 'upcoming' then 1 else 2 end) asc,
    t.catalog_synced_at asc nulls first,
    t.id asc
  limit least(greatest(coalesce(p_limit, 100), 1), 500)
$$;

revoke all on function public.titles_needing_refresh(text, integer) from public, anon, authenticated;
grant execute on function public.titles_needing_refresh(text, integer) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Provider health
-- ---------------------------------------------------------------------------------------------

create or replace function public.catalog_provider_health()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_object_agg(
      s.provider_id,
      jsonb_build_object(
        'last_success_at', s.last_success_at,
        'last_attempt_at', s.last_attempt_at,
        'last_failure_at', s.last_failure_at,
        'consecutive_failures', s.consecutive_failures,
        'rate_limited_until', s.rate_limited_until,
        'disabled_reason', s.disabled_reason,
        'total_items_written', s.total_items_written,
        'total_requests', s.total_requests,
        'usable', s.consecutive_failures < 10 and (s.rate_limited_until is null or s.rate_limited_until < now())
      )
    ),
    '{}'::jsonb
  )
  from public.catalog_provider_state s
$$;

revoke all on function public.catalog_provider_health() from public, anon;
grant execute on function public.catalog_provider_health() to service_role;

comment on function public.catalog_provider_health() is 'Ingest pre-flight: returns per-provider health so a job can skip a provider that is failing instead of hammering it.';

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
