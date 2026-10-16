-- Hallyu backend — 16 analytics.
-- Append-heavy, so the table is RANGE-partitioned by month with a default partition, BRIN-indexed on
-- occurred_at (cheapest index for a monotonically increasing column) and written only through
-- public.record_event(). No free-text payloads, no raw IP, no email: the caller may only send a
-- short event name and a small JSONB property bag.

create table if not exists public.analytics_events (
  id           bigint      generated always as identity,
  occurred_at  timestamptz not null default now(),
  received_at  timestamptz not null default now(),
  user_id      uuid        references public.profiles (id) on delete set null,
  -- Guests have no user id; the client keeps an install-scoped uuid instead.
  anonymous_id uuid,
  session_id   uuid,
  name         text        not null,
  properties   jsonb       not null default '{}'::jsonb,
  platform     text,
  app_version  text,
  primary key (id, occurred_at),
  constraint analytics_events_name_format check (name ~ '^[a-z0-9_]{2,48}(\.[a-z0-9_]{2,32}){0,3}$'),
  constraint analytics_events_properties_is_object check (jsonb_typeof(properties) = 'object'),
  constraint analytics_events_identity_present check (user_id is not null or anonymous_id is not null),
  constraint analytics_events_platform_known check (platform is null or platform in ('ios', 'android', 'web')),
  constraint analytics_events_app_version_length check (app_version is null or char_length(app_version) <= 32)
) partition by range (occurred_at);

comment on table public.analytics_events is 'Product events. Partitioned monthly; write only through record_event().';

create table if not exists public.analytics_events_default
  partition of public.analytics_events default;

-- Row security has to be switched on per relation: enabling it on a partitioned parent governs the
-- rows a query returns through the parent, but a partition read *by name* is checked against that
-- partition's own RLS flag — and a partition with RLS disabled is readable by anyone holding a
-- grant on it. Partitions inherit the parent's privileges only when accessed through the parent, so
-- the protection below is what makes a future `grant select on all tables in schema public` (an easy
-- mistake) a no-op here instead of a leak. Enabling RLS with no policy is deny-all, which is correct
-- for events; the moderator policy on the parent still applies to parent queries.
alter table public.analytics_events_default enable row level security;

create index if not exists analytics_events_occurred_brin_idx on public.analytics_events using brin (occurred_at);
create index if not exists analytics_events_user_recent_idx on public.analytics_events (user_id, occurred_at desc);
create index if not exists analytics_events_name_time_idx on public.analytics_events (name, occurred_at desc);
create index if not exists analytics_events_properties_gin_idx on public.analytics_events using gin (properties jsonb_path_ops);

-- Creates the monthly partition for a month if it is missing. Called by record_event(); safe to call
-- by hand after importing historical data. SECURITY DEFINER because authenticated clients may not
-- run DDL.
create or replace function public.ensure_event_partition(p_month date default (now() at time zone 'utc')::date)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  start_of_month date := date_trunc('month', p_month::timestamp)::date;
  end_of_month   date := (date_trunc('month', p_month::timestamp) + interval '1 month')::date;
  partition_name text := 'analytics_events_' || to_char(start_of_month, 'YYYY_MM');
begin
  if exists (select 1 from pg_class where relname = partition_name and relnamespace = 'public'::regnamespace) then
    return partition_name;
  end if;

  execute format(
    'create table public.%I partition of public.analytics_events for values from (%L) to (%L)',
    partition_name, start_of_month, end_of_month
  );

  -- A partition created without its own RLS flag would be readable by name for anyone holding a
  -- grant on it (partitions do not inherit the parent's privileges when accessed directly). The
  -- parent's moderator policy still governs queries through public.analytics_events.
  execute format('alter table public.%I enable row level security', partition_name);

  return partition_name;
end;
$$;

revoke all on function public.ensure_event_partition(date) from public, anon, authenticated;
grant execute on function public.ensure_event_partition(date) to service_role;

alter table public.analytics_events enable row level security;

-- Nobody reads events as a client; only the ingest RPC writes and only moderators may read.
create policy analytics_events_moderator_select on public.analytics_events
  for select to authenticated
  using (public.is_moderator());

grant select on public.analytics_events to authenticated;