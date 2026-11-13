-- Hallyu AI event tracking: durable queues for DMs and comment mentions
-- that the 24/7 autonomous operator must process. Every row is a real
-- event that must be acknowledged, processed, and marked completed/failed.
--
-- Access model: service_role only via the operator. No client access.
set check_function_bodies = off;

create table if not exists public.hallyu_ai_dm_event (
  id uuid primary key default gen_random_uuid(),
  conversation_id text not null,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  body text not null,
  message_id text not null unique,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'pending', -- pending | completed | failed | skipped
  error text,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  not_before timestamptz not null default now()
);

create table if not exists public.hallyu_ai_comment_event (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.comments (id) on delete cascade,
  post_id uuid not null references public.posts (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  mentioned_handle text not null,
  body text not null,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'pending', -- pending | completed | failed | skipped
  error text,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  not_before timestamptz not null default now()
);

create index if not exists hallyu_ai_dm_event_due_idx
  on public.hallyu_ai_dm_event (status, not_before, created_at);
create index if not exists hallyu_ai_comment_event_due_idx
  on public.hallyu_ai_comment_event (status, not_before, created_at);

alter table public.hallyu_ai_dm_event enable row level security;
alter table public.hallyu_ai_comment_event enable row level security;

revoke all on public.hallyu_ai_dm_event from anon, authenticated;
revoke all on public.hallyu_ai_comment_event from anon, authenticated;

create policy hallyu_ai_dm_event_no_direct_access on public.hallyu_ai_dm_event
  for all to public using (false) with check (false);
create policy hallyu_ai_comment_event_no_direct_access on public.hallyu_ai_comment_event
  for all to public using (false) with check (false);

-- Claim due DM events atomically for a single dispatcher tick.
create or replace function public.hallyu_ai_claim_due_dm_events(p_limit integer default 3)
returns setof public.hallyu_ai_dm_event
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
    with due as (
      select id from public.hallyu_ai_dm_event
      where status = 'pending' and not_before <= now()
      order by not_before, created_at
      limit least(greatest(p_limit, 1), 10) for update skip locked
    ), claimed as (
      update public.hallyu_ai_dm_event s
      set status = 'running', attempt_count = attempt_count + 1
      from due where s.id = due.id returning s.*
    ) select * from claimed;
end; $$;

-- Claim due comment mention events atomically.
create or replace function public.hallyu_ai_claim_due_comment_events(p_limit integer default 3)
returns setof public.hallyu_ai_comment_event
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
    with due as (
      select id from public.hallyu_ai_comment_event
      where status = 'pending' and not_before <= now()
      order by not_before, created_at
      limit least(greatest(p_limit, 1), 10) for update skip locked
    ), claimed as (
      update public.hallyu_ai_comment_event s
      set status = 'running', attempt_count = attempt_count + 1
      from due where s.id = due.id returning s.*
    ) select * from claimed;
end; $$;

revoke all on function public.hallyu_ai_claim_due_dm_events(integer) from public, anon, authenticated;
revoke all on function public.hallyu_ai_claim_due_comment_events(integer) from public, anon, authenticated;
grant execute on function public.hallyu_ai_claim_due_dm_events(integer) to service_role;
grant execute on function public.hallyu_ai_claim_due_comment_events(integer) to service_role;

-- Admin read surfaces for the dashboard.
create or replace function public.hallyu_ai_admin_dm_events(p_limit integer default 50)
returns setof public.hallyu_ai_dm_event
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from public.hallyu_ai_dm_event
  where public.hallyu_ai_is_staff()
  order by created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

create or replace function public.hallyu_ai_admin_comment_events(p_limit integer default 50)
returns setof public.hallyu_ai_comment_event
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from public.hallyu_ai_comment_event
  where public.hallyu_ai_is_staff()
  order by created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

revoke all on function public.hallyu_ai_admin_dm_events(integer) from public, anon;
revoke all on function public.hallyu_ai_admin_comment_events(integer) from public, anon;
grant execute on function public.hallyu_ai_admin_dm_events(integer) to authenticated;
grant execute on function public.hallyu_ai_admin_comment_events(integer) to authenticated;

reset check_function_bodies;
