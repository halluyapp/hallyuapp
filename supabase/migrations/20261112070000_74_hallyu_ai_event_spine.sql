-- Hallyu AI event spine: real-time DMs and mentions instead of 30-minute polling.
--
-- A Direct Message to @hallyu.ai or a comment mention now creates a durable event the moment the row
-- is written, so the work is never lost between scheduler ticks. Creation and delivery are separate
-- on purpose: the trigger does one cheap insert and nothing else, and a worker claims and processes
-- events (hallyu_ai_claim_events, then the operator's `event.process`). No trigger performs network
-- I/O, so a member's message can never fail or slow down because an AI wake-up did.
--
-- Wiring for lower latency (dashboard, not schema): a database webhook on INSERT of hallyu_ai_event
-- can call /functions/v1/hallyu-ai-operator with {"action":"event.process"} using a service
-- credential, which drains the queue in under a second. Without it the event waits for the next
-- scheduler drain instead, and the row is still processed exactly once.

-- ── durable event queue ──────────────────────────────────────────────────────────────────────
create table if not exists public.hallyu_ai_event (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('dm', 'mention')),
  source_id uuid not null,
  profile_id uuid,
  dedupe_key text not null unique,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed', 'dead')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  task_id uuid,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hallyu_ai_event_due_idx
  on public.hallyu_ai_event (next_attempt_at) where status = 'pending';
create index if not exists hallyu_ai_event_source_idx on public.hallyu_ai_event (kind, source_id);

alter table public.hallyu_ai_event enable row level security;
-- This queue is backend-only: both policies deny every client, and the operator reads and writes it
-- with the service credential, which bypasses RLS by design.
drop policy if exists hallyu_ai_event_deny_clients on public.hallyu_ai_event;
create policy hallyu_ai_event_deny_clients on public.hallyu_ai_event for all to public using (false);
drop policy if exists hallyu_ai_event_no_direct_access on public.hallyu_ai_event;
create policy hallyu_ai_event_no_direct_access on public.hallyu_ai_event for all to public using (false);

-- ── structured DM support (backward compatible) ─────────────────────────────────────────────
-- Rich responses are additive: every existing row keeps rendering as ordinary plain text.
alter table public.direct_messages add column if not exists message_type text not null default 'text';
alter table public.direct_messages add column if not exists rich_content jsonb;

-- ── enqueue ─────────────────────────────────────────────────────────────────────────────────
-- Idempotent by construction: the dedupe key is the source row, so re-delivery or a retried insert
-- can never produce a second event (and therefore never a second reply).
create or replace function public.hallyu_ai_enqueue_event(p_kind text, p_source uuid, p_profile uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text := p_kind || ':' || p_source::text;
  v_id uuid;
begin
  insert into public.hallyu_ai_event (kind, source_id, profile_id, dedupe_key)
  values (p_kind, p_source, p_profile, v_key)
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end $$;

-- ── triggers: one cheap insert each, no reasoning and no network ────────────────────────────
create or replace function public.hallyu_ai_on_direct_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ai uuid := public.hallyu_ai_profile_id();
begin
  -- The AI never answers itself, and a message between two people is not our business.
  if v_ai is null or new.sender_id = v_ai or new.recipient_id <> v_ai then
    return new;
  end if;
  perform public.hallyu_ai_enqueue_event('dm', new.id, new.sender_id);
  return new;
end $$;

create or replace function public.hallyu_ai_on_comment_mention()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ai uuid := public.hallyu_ai_profile_id();
begin
  if v_ai is null or new.author_id = v_ai or new.state <> 'active' then
    return new;
  end if;
  if new.body is null or new.body !~* '@hallyu\.ai' then
    return new;
  end if;
  perform public.hallyu_ai_enqueue_event('mention', new.id, new.author_id);
  return new;
end $$;

drop trigger if exists hallyu_ai_dm_event on public.direct_messages;
create trigger hallyu_ai_dm_event
  after insert on public.direct_messages
  for each row execute function public.hallyu_ai_on_direct_message();

drop trigger if exists hallyu_ai_comment_event on public.comments;
create trigger hallyu_ai_comment_event
  after insert on public.comments
  for each row execute function public.hallyu_ai_on_comment_mention();

-- ── worker primitives ───────────────────────────────────────────────────────────────────────
create or replace function public.hallyu_ai_claim_events(p_limit integer default 3)
returns setof public.hallyu_ai_event
language sql
security definer
set search_path = public, pg_temp
as $$
  with due as (
    select e.id
    from public.hallyu_ai_event e
    where e.status = 'pending' and e.next_attempt_at <= now()
    order by e.next_attempt_at, e.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 3), 10))
  )
  update public.hallyu_ai_event e
     set status = 'processing', attempts = e.attempts + 1, updated_at = now()
    from due
   where e.id = due.id
  returning e.*;
$$;

-- A worker that dies mid-event must not strand it: anything processing for too long is retried.
create or replace function public.hallyu_ai_recover_stale_events(p_after interval default interval '5 minutes')
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.hallyu_ai_event
     set status = case when attempts >= 5 then 'dead' else 'pending' end,
         next_attempt_at = now(),
         last_error = coalesce(last_error, 'worker stopped before reporting a result'),
         updated_at = now()
   where status = 'processing' and updated_at < now() - p_after;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.hallyu_ai_enqueue_event(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.hallyu_ai_claim_events(integer) from public, anon, authenticated;
revoke all on function public.hallyu_ai_recover_stale_events(interval) from public, anon, authenticated;

-- ── honest publication counting ─────────────────────────────────────────────────────────────
-- A comment reply is engagement, not one of the three daily content publications. The counter now
-- separates qualifying feed output from replies, so the target cannot be satisfied by chatter.
create or replace function public.hallyu_ai_publication_summary()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with today as (
    select pub.*
    from public.hallyu_ai_publication pub
    where pub.status = 'published'
      and pub.published_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
  )
  select jsonb_build_object(
    'today_utc', to_char(now() at time zone 'utc', 'YYYY-MM-DD'),
    'published_today', (select count(*) from today where action in ('publish_post', 'create_poll')),
    'replies_today', (select count(*) from today where action = 'reply_comment'),
    'target_today', 3,
    'pending', (select count(*) from public.hallyu_ai_publication pub where pub.status = 'pending'),
    'failed', (select count(*) from public.hallyu_ai_publication pub where pub.status = 'failed'),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
        'action', pub.action, 'status', pub.status, 'target_id', pub.target_id,
        'at', pub.published_at, 'error', pub.error
      ) order by pub.created_at desc)
      from (select * from public.hallyu_ai_publication order by created_at desc limit 10) pub
    ), '[]'::jsonb)
  );
$$;
