-- Hallyu backend — 28 notification lifecycle and push delivery.
--
-- Migration 13 creates notification *rows* and migration 18 creates them from triggers. That is
-- deliberately the whole job of the database: no trigger in this schema performs a network call,
-- because a trigger that fails halfway leaves the transaction half-done.
--
-- This migration adds the other half of the promise — actually getting the notification to a
-- device — as an explicit, resumable queue:
--
--   notifications            one row per recipient per event (already existed)
--   notification_deliveries  one row per (notification, device token)
--
-- The push worker claims a batch, sends it, and records the outcome per delivery. A transient
-- failure schedules a retry with backoff; an invalid token disables that device forever and fails
-- its remaining deliveries, so a dead install is never attempted twice.
--
-- Dedupe and coalescing live in `public.enqueue_notification`, which the episode/title alerts and
-- any future scheduled source use: one row per (recipient, dedupe_key), with a coalesce counter and
-- the latest actor list, so "12 people reacted to your review" is one row that grows, not twelve.

-- ---------------------------------------------------------------------------------------------
-- Lifecycle columns
-- ---------------------------------------------------------------------------------------------

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

alter table public.notifications
  add column if not exists dedupe_key     text,
  add column if not exists coalesce_count integer     not null default 1,
  add column if not exists expires_at     timestamptz,
  add column if not exists scheduled_for  timestamptz not null default now();

comment on column public.notifications.dedupe_key is 'Stable identity of the underlying event, e.g. "episode:1399:1:6". Unique per recipient: re-queuing the same event updates the existing row instead of adding another.';
comment on column public.notifications.coalesce_count is 'How many events this row represents. The client renders "N people reacted".';
comment on column public.notifications.expires_at is 'After this the row is removed by the retention job. Defaults come from notify_recipient callers.';
comment on column public.notifications.scheduled_for is 'When the row becomes eligible for delivery. Episode reminders are created with a future date so nothing is pushed before the air time.';

create unique index if not exists notifications_dedupe_key_idx
  on public.notifications (recipient_id, dedupe_key)
  where dedupe_key is not null;

create index if not exists notifications_scheduled_idx
  on public.notifications (scheduled_for, created_at desc)
  where read_at is null;

-- Deep-link destination. Stored on the row rather than derived by the client, so a notification
-- can always open the thing it is about even after the schema it points at is gone.
alter table public.notifications
  add column if not exists deep_link text;

comment on column public.notifications.deep_link is 'In-app route for the notification, e.g. "/drama/<uuid>" or "/post/<uuid>". Owned by the backend, never by the client.';

-- ---------------------------------------------------------------------------------------------
-- Delivery queue
-- ---------------------------------------------------------------------------------------------

create type public.delivery_status as enum ('queued', 'sending', 'sent', 'failed', 'invalid_token', 'skipped');

create table if not exists public.notification_deliveries (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid        not null references public.notifications (id) on delete cascade,
  push_token_id   uuid        not null references public.push_tokens (id) on delete cascade,
  status          public.delivery_status not null default 'queued',
  attempt         integer     not null default 0,
  provider        text,
  provider_message_id text,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint notification_deliveries_attempt_non_negative check (attempt >= 0),
  constraint notification_deliveries_sent_stamp check ((status = 'sent') = (sent_at is not null)),
  constraint notification_deliveries_target_unique unique (notification_id, push_token_id)
);

comment on table public.notification_deliveries is 'One row per (notification, device). The push worker claims, sends, and records; the database decides who is eligible.';
comment on column public.notification_deliveries.next_attempt_at is 'Retry time. A transient failure pushes this forward with backoff; an invalid token stops the row for good.';

create index if not exists notification_deliveries_due_idx
  on public.notification_deliveries (next_attempt_at)
  where status in ('queued', 'failed');

create index if not exists notification_deliveries_notification_idx
  on public.notification_deliveries (notification_id, status);

create index if not exists notification_deliveries_token_idx
  on public.notification_deliveries (push_token_id, status);

alter table public.notification_deliveries enable row level security;

-- A member may see that their own notification was delivered to their own devices, and nothing else.
create policy notification_deliveries_owner_select on public.notification_deliveries
  for select to authenticated
  using (
    exists (
      select 1 from public.notifications n
      where n.id = notification_deliveries.notification_id and n.recipient_id = auth.uid()
    )
  );

create policy notification_deliveries_service_only on public.notification_deliveries
  for all to service_role using (true) with check (true);

grant select on public.notification_deliveries to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Deduplicated enqueue
-- ---------------------------------------------------------------------------------------------

-- The single entry point for anything that is not an immediate social trigger. Idempotent on
-- (recipient_id, dedupe_key): re-running the same event bumps coalesce_count and refreshes the
-- timestamp instead of inserting a second row.
create or replace function public.enqueue_notification(
  p_recipient uuid,
  p_kind public.notification_kind,
  p_group public.notification_group,
  p_dedupe_key text,
  p_actor_ids uuid[] default '{}',
  p_post_id uuid default null,
  p_comment_id uuid default null,
  p_title_id uuid default null,
  p_community_id uuid default null,
  p_collection_id uuid default null,
  p_episode smallint default null,
  p_title text default null,
  p_body text default null,
  p_deep_link text default null,
  p_scheduled_for timestamptz default null,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  prefs public.user_preferences%rowtype;
  row_id uuid;
  created boolean := false;
begin
  if p_recipient is null or p_dedupe_key is null or length(btrim(p_dedupe_key)) = 0 then
    raise exception 'recipient and dedupe_key are required' using errcode = 'invalid_parameter_value';
  end if;

  if length(p_dedupe_key) > 160 then
    raise exception 'dedupe_key is too long' using errcode = 'invalid_parameter_value';
  end if;

  select * into prefs from public.user_preferences where user_id = p_recipient;
  if not found then
    return null; -- no preference row means no member; nothing to notify
  end if;

  -- Preferences are honoured at creation, exactly as notify_recipient does, so a scheduled job can
  -- never create work the member has switched off.
  if p_group = 'social' and not prefs.notify_social then return null; end if;
  if p_group = 'system' and not prefs.notify_system then return null; end if;
  if p_group = 'drama' and not prefs.notify_episodes then return null; end if;

  if exists (
    select 1 from public.profiles pr
    where pr.id = p_recipient and pr.account_status <> 'active'
  ) then
    return null; -- suspended and deleted accounts are not notified
  end if;

  -- Never across a block.
  if cardinality(p_actor_ids) > 0 and exists (
    select 1 from public.blocks b
    where (b.blocker_id = p_recipient and b.blocked_id = any(p_actor_ids))
       or (b.blocked_id = p_recipient and b.blocker_id = any(p_actor_ids))
  ) then
    return null;
  end if;

  insert into public.notifications (
    recipient_id, kind, "group", dedupe_key, actor_ids, post_id, comment_id, title_id,
    community_id, collection_id, episode, title, body, deep_link, scheduled_for, expires_at
  )
  values (
    p_recipient, p_kind, p_group, left(btrim(p_dedupe_key), 160),
    p_actor_ids, p_post_id, p_comment_id, p_title_id, p_community_id, p_collection_id,
    p_episode, left(p_title, 160), left(p_body, 500), left(p_deep_link, 300),
    coalesce(p_scheduled_for, now()),
    coalesce(p_expires_at, now() + interval '90 days')
  )
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do update
    set coalesce_count = public.notifications.coalesce_count + 1,
        actor_ids = (
          select coalesce(array_agg(distinct a), '{}'::uuid[])
          from unnest(public.notifications.actor_ids || excluded.actor_ids) a
        ),
        created_at = now(),
        read_at = null,
        body = coalesce(excluded.body, public.notifications.body),
        deep_link = coalesce(excluded.deep_link, public.notifications.deep_link),
        scheduled_for = excluded.scheduled_for
  returning id, (xmax = 0) into row_id, created;

  return row_id;
end;
$$;

revoke all on function public.enqueue_notification(uuid, public.notification_kind, public.notification_group, text, uuid[], uuid, uuid, uuid, uuid, uuid, smallint, text, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.enqueue_notification(uuid, public.notification_kind, public.notification_group, text, uuid[], uuid, uuid, uuid, uuid, uuid, smallint, text, text, text, timestamptz, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------------------------
-- Fan-out: one notification row to every eligible device
-- ---------------------------------------------------------------------------------------------

-- Creates the delivery rows for a notification. Idempotent on (notification_id, push_token_id): a
-- repeated fan-out adds nothing. Skips tokens that are disabled, whose owner has the relevant
-- preference off, or whose owner deleted or suspended the account.
create or replace function public.fanout_notification(p_notification_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n public.notifications%rowtype;
  created integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'notification fan-out is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  select * into n from public.notifications where id = p_notification_id;
  if not found then
    return 0;
  end if;

  insert into public.notification_deliveries (notification_id, push_token_id, next_attempt_at)
  select
    n.id,
    t.id,
    greatest(now(), n.scheduled_for)
  from public.push_tokens t
  join public.profiles pr on pr.id = t.user_id
  where t.user_id = n.recipient_id
    and t.disabled_at is null
    and pr.account_status = 'active'
    and case n."group"
      when 'social' then coalesce((select notify_social from public.user_preferences p where p.user_id = t.user_id), false)
      when 'system' then coalesce((select notify_system from public.user_preferences p where p.user_id = t.user_id), false)
      when 'drama' then coalesce((select notify_episodes from public.user_preferences p where p.user_id = t.user_id), false)
      else true
    end
  on conflict (notification_id, push_token_id) do nothing;

  get diagnostics created = row_count;
  return created;
end;
$$;

revoke all on function public.fanout_notification(uuid) from public, anon, authenticated;
grant execute on function public.fanout_notification(uuid) to service_role;

-- Fans out everything that is due and has no delivery rows yet. Safe to run every minute.
create or replace function public.fanout_due_notifications(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pending record;
  created integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'notification fan-out is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  for pending in
    select n.id
    from public.notifications n
    where n.scheduled_for <= now()
      and (n.expires_at is null or n.expires_at > now())
      and not exists (select 1 from public.notification_deliveries d where d.notification_id = n.id)
    order by n.scheduled_for asc
    limit least(greatest(coalesce(p_limit, 500), 1), 5000)
  loop
    created := created + public.fanout_notification(pending.id);
  end loop;

  return created;
end;
$$;

revoke all on function public.fanout_due_notifications(integer) from public, anon, authenticated;
grant execute on function public.fanout_due_notifications(integer) to service_role;

-- ---------------------------------------------------------------------------------------------
-- The push worker's claim / report cycle
-- ---------------------------------------------------------------------------------------------

-- Hands the worker a batch of deliveries to attempt, marking them 'sending' so a second worker
-- cannot pick up the same rows. Attempts are bounded by a max_attempts argument, not by wall time.
create or replace function public.claim_notification_deliveries(
  p_limit integer default 100,
  p_max_attempts integer default 5
)
returns table (
  delivery_id uuid,
  notification_id uuid,
  push_token_id uuid,
  token text,
  platform public.push_platform,
  attempt integer,
  title text,
  body text,
  deep_link text,
  payload jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  batch_size integer := least(greatest(coalesce(p_limit, 100), 1), 1000);
  attempts_allowed integer := least(greatest(coalesce(p_max_attempts, 5), 1), 10);
begin
  if auth.uid() is not null then
    raise exception 'push delivery is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  return query
  with due as (
    select d.id
    from public.notification_deliveries d
    join public.notifications n on n.id = d.notification_id
    join public.push_tokens t on t.id = d.push_token_id
    where d.status in ('queued', 'failed')
      and d.next_attempt_at <= now()
      and d.attempt < attempts_allowed
      and t.disabled_at is null
      and n.scheduled_for <= now()
      and (n.expires_at is null or n.expires_at > now())
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = n.recipient_id and b.blocked_id = any(n.actor_ids))
           or (b.blocked_id = n.recipient_id and b.blocker_id = any(n.actor_ids))
      )
    order by d.next_attempt_at asc, d.created_at asc
    -- `for update skip locked` is what makes two workers at once safe.
    for update of d skip locked
    limit batch_size
  )
  update public.notification_deliveries d
     set status = 'sending',
         attempt = d.attempt + 1,
         updated_at = now()
    from due, public.notifications n, public.push_tokens t
   where d.id = due.id
     and n.id = d.notification_id
     and t.id = d.push_token_id
  returning
    d.id,
    d.notification_id,
    d.push_token_id,
    t.token,
    t.platform,
    d.attempt,
    left(n.title, 160),
    left(n.body, 500),
    left(n.deep_link, 300),
    jsonb_build_object(
      'notification_id', n.id,
      'kind', n.kind,
      'group', n."group",
      'coalesce_count', n.coalesce_count,
      'episode', n.episode,
      'title_id', n.title_id,
      'post_id', n.post_id,
      'comment_id', n.comment_id,
      'community_id', n.community_id,
      'collection_id', n.collection_id
    );
end;
$$;

revoke all on function public.claim_notification_deliveries(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_notification_deliveries(integer, integer) to service_role;

-- Records one delivery outcome. `p_invalid` means the provider told us the token is gone: the token
-- is disabled and every other pending delivery for it is failed in the same transaction, so a dead
-- install costs one round trip rather than one per notification.
create or replace function public.report_delivery(
  p_delivery_id uuid,
  p_sent boolean,
  p_error text default null,
  p_invalid boolean default false,
  p_provider_message_id text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d public.notification_deliveries%rowtype;
begin
  if auth.uid() is not null then
    raise exception 'push delivery is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  select * into d from public.notification_deliveries where id = p_delivery_id for update;
  if not found then
    return;
  end if;

  if p_invalid then
    update public.push_tokens set disabled_at = now() where id = d.push_token_id;

    update public.notification_deliveries
       set status = 'invalid_token',
           last_error = left(coalesce(p_error, 'token rejected by provider'), 300),
           provider_message_id = left(p_provider_message_id, 200),
           updated_at = now()
     where push_token_id = d.push_token_id
       and status in ('queued', 'failed', 'sending')
       and id <> d.delivery_id;

    update public.notification_deliveries
       set status = 'invalid_token',
           last_error = left(coalesce(p_error, 'token rejected by provider'), 300),
           provider_message_id = left(p_provider_message_id, 200),
           updated_at = now()
     where id = d.delivery_id;

    return;
  end if;

  if p_sent then
    update public.notification_deliveries
       set status = 'sent',
           sent_at = now(),
           last_error = null,
           provider_message_id = left(p_provider_message_id, 200),
           updated_at = now()
     where id = d.delivery_id;
    return;
  end if;

  -- Transient failure: exponential backoff, capped, and the attempt ceiling decides when it stops.
  update public.notification_deliveries
     set status = (case when d.attempt >= 5 then 'failed' else 'queued' end)::public.delivery_status,
         last_error = left(p_error, 300),
         next_attempt_at = now() + make_interval(mins => least(60, (2 ^ greatest(d.attempt, 1))::integer)),
         updated_at = now()
   where id = d.delivery_id;
end;
$$;

revoke all on function public.report_delivery(uuid, boolean, text, boolean, text) from public, anon, authenticated;
grant execute on function public.report_delivery(uuid, boolean, text, boolean, text) to service_role;

-- Members manage their own devices: unregister one, or disable every one (a "turn off all
-- notifications" that does not need the client to enumerate tokens).
create or replace function public.disable_push_token(p_token_id uuid)
returns boolean
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

  update public.push_tokens
     set disabled_at = coalesce(disabled_at, now())
   where id = p_token_id and user_id = actor;

  return found;
end;
$$;

revoke all on function public.disable_push_token(uuid) from public, anon, authenticated;
grant execute on function public.disable_push_token(uuid) to authenticated;

create or replace function public.disable_all_push_tokens()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  touched integer;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  update public.push_tokens set disabled_at = coalesce(disabled_at, now()) where user_id = actor;
  get diagnostics touched = row_count;
  return touched;
end;
$$;

revoke all on function public.disable_all_push_tokens() from public, anon, authenticated;
grant execute on function public.disable_all_push_tokens() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------------------------

-- Removes notifications past their expiry, collapses the delivery rows behind them, and drops
-- deliveries that exhausted their attempts. Runs hourly through the dispatcher.
create or replace function public.job_expire_notifications(
  p_retention interval default interval '90 days'
)
returns table (notifications_removed integer, deliveries_removed integer, read_removed integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed_notifications integer := 0;
  removed_deliveries integer := 0;
  removed_read integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'scheduled jobs are a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  -- Old, read, and long past any sensible inbox window.
  delete from public.notifications
   where created_at < now() - p_retention
     and read_at is not null;
  get diagnostics removed_notifications = row_count;

  -- Expired rows the member never opened still go at double the window.
  delete from public.notifications
   where created_at < now() - (p_retention * 2);
  get diagnostics removed_read = row_count;

  -- Deliveries that never made it and never will.
  delete from public.notification_deliveries
   where status = 'failed'
     and next_attempt_at < now() - interval '7 days';
  get diagnostics removed_deliveries = row_count;

  return query select removed_notifications, removed_deliveries, removed_read;
end;
$$;

revoke all on function public.job_expire_notifications(interval) from public, anon, authenticated;
grant execute on function public.job_expire_notifications(interval) to service_role;

-- Small unread badge read that never leaves the inbox: grouped counts, not rows.
create or replace function public.notification_summary()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with actor as (select auth.uid() as id)
  select jsonb_build_object(
    'unread', (select count(*) from public.notifications n, actor a where n.recipient_id = a.id and n.read_at is null),
    'unread_by_group', coalesce((
      select jsonb_object_agg(n."group", n.total)
      from (
        select n."group", count(*)::integer as total
        from public.notifications n, actor a
        where n.recipient_id = a.id and n.read_at is null
        group by n."group"
      ) n
    ), '{}'::jsonb)
  )
  from actor
  where actor.id is not null
$$;

revoke all on function public.notification_summary() from public, anon, authenticated;
grant execute on function public.notification_summary() to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
