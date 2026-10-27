-- Migration 55: episode reminder time zones and reminder re-surfacing.
--
-- Defect fixed: notify_at_for() passed push_tokens.locale (e.g. 'en-NG') to AT TIME ZONE, so the
-- scheduled alerts.upcoming_episodes job failed with 'time zone "en-NG" not recognized' for every
-- quiet-hours member with that locale.
--
-- Changes (additive; no existing row is rewritten, no column is dropped):
--   * push_tokens.time_zone: an IANA identifier such as 'Africa/Lagos', kept separate from locale.
--     Existing rows stay NULL, which means UTC until the device registers again.
--   * is_valid_time_zone(text): checks against the server's pg_timezone_names list.
--   * register_push_token gains p_time_zone. The 5-argument form is kept (old app builds still call
--     it). Invalid zones and malformed locales are stored as NULL instead of failing.
--   * member_time_zone(uuid) and notify_at_for() use only a valid zone, falling back to UTC.
--   * enqueue_notification: for 'drama' reminders, a reminder that has not fired yet is moved to
--     its new time, and one that already fired is left alone. Before, every hourly re-queue reset
--     read_at and created_at, so read reminders came back unread.

-- ---------------------------------------------------------------------------------------------
-- 1. Time-zone storage and validation
-- ---------------------------------------------------------------------------------------------

alter table public.push_tokens
  add column if not exists time_zone text
  check (time_zone is null or char_length(time_zone) between 1 and 64);

create or replace function public.is_valid_time_zone(p_zone text)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select p_zone is not null and exists (
    select 1 from pg_timezone_names where name = p_zone
  )
$$;

revoke all on function public.is_valid_time_zone(text) from public;
grant execute on function public.is_valid_time_zone(text) to anon, authenticated, service_role;

-- The zone a member's reminders are calculated in: their most recently seen device with a valid
-- zone, else UTC. A locale is never used here.
create or replace function public.member_time_zone(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select t.time_zone
      from public.push_tokens t
      where t.user_id = p_user_id
        and public.is_valid_time_zone(t.time_zone)
      order by t.last_seen_at desc nulls last, t.created_at desc
      limit 1
    ),
    'UTC'
  )
$$;

revoke all on function public.member_time_zone(uuid) from public, anon, authenticated;
grant execute on function public.member_time_zone(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Registration: accept the zone, keep the old five-argument call working
-- ---------------------------------------------------------------------------------------------

drop function if exists public.register_push_token(text, public.push_platform, text, text, text);

-- No defaults on this signature (see the wrapper below for why).
create or replace function public.register_push_token(
  p_token text,
  p_platform public.push_platform,
  p_device_name text,
  p_app_version text,
  p_locale text,
  p_time_zone text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  row_id uuid;
  clean_locale text;
  clean_zone text;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- A locale is a language tag, not a zone. Keep it only when it is a plain tag the column accepts.
  clean_locale := case
    when p_locale ~ '^[a-z]{2}(-[A-Za-z0-9]{2,8})?$' then p_locale
    else null
  end;
  -- A zone is kept only when PostgreSQL knows it. Anything else is stored as NULL (UTC fallback).
  clean_zone := case when public.is_valid_time_zone(p_time_zone) then p_time_zone else null end;

  insert into public.push_tokens as t (user_id, token, platform, device_name, app_version, locale, time_zone)
  values (actor, p_token, p_platform, p_device_name, p_app_version, clean_locale, clean_zone)
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        device_name = excluded.device_name,
        app_version = excluded.app_version,
        locale = excluded.locale,
        time_zone = coalesce(excluded.time_zone, t.time_zone),
        last_seen_at = now(),
        disabled_at = null
  returning t.id into row_id;

  return row_id;
end;
$$;

revoke all on function public.register_push_token(text, public.push_platform, text, text, text, text) from public, anon;
grant execute on function public.register_push_token(text, public.push_platform, text, text, text, text) to authenticated;

-- Older callers use two to five arguments (verify-backend, repro, app builds before this change).
-- The defaults live on this wrapper only, so a 2-, 3- or 5-argument call matches it alone and a
-- 6-argument call matches the function above alone. There is no ambiguous overload.
create or replace function public.register_push_token(
  p_token text,
  p_platform public.push_platform,
  p_device_name text default null,
  p_app_version text default null,
  p_locale text default null
)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.register_push_token(p_token, p_platform, p_device_name, p_app_version, p_locale, null::text)
$$;

revoke all on function public.register_push_token(text, public.push_platform, text, text, text) from public, anon;
grant execute on function public.register_push_token(text, public.push_platform, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Quiet hours in the member's real zone
-- ---------------------------------------------------------------------------------------------

-- 09:00 on the member's local day when quiet hours are on; the exact moment otherwise.
create or replace function public.notify_at_for(p_user_id uuid, p_moment timestamptz)
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when coalesce((select quiet_hours from public.user_preferences where user_id = p_user_id), false)
      then (
        date_trunc('day', p_moment at time zone public.member_time_zone(p_user_id))
        + interval '9 hours'
      ) at time zone public.member_time_zone(p_user_id)
    else p_moment
  end
$$;

revoke all on function public.notify_at_for(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.notify_at_for(uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. Reminders: move unfired ones, never re-surface fired ones
-- ---------------------------------------------------------------------------------------------

-- Same contract as migration 28, plus a branch for 'drama' reminders. Social coalescing is unchanged.
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
  existing_row record;
  key_clean text;
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

  key_clean := left(btrim(p_dedupe_key), 160);

  -- Episode reminders are re-queued by every scheduled run. A reminder that has not fired yet takes
  -- the new moment (for example, after the broadcaster moves the episode). One that already fired is
  -- left exactly as it is: it is not unread again, not moved to the top, and not counted twice.
  if p_group = 'drama' then
    select n.id, n.scheduled_for into existing_row
    from public.notifications n
    where n.recipient_id = p_recipient and n.dedupe_key = key_clean;
    if found then
      if existing_row.scheduled_for > now() then
        update public.notifications set
          scheduled_for = coalesce(p_scheduled_for, now()),
          body = coalesce(left(p_body, 500), body),
          deep_link = coalesce(left(p_deep_link, 300), deep_link),
          expires_at = coalesce(p_expires_at, expires_at)
        where id = existing_row.id;
      end if;
      return existing_row.id;
    end if;
  end if;

  insert into public.notifications (
    recipient_id, kind, "group", dedupe_key, actor_ids, post_id, comment_id, title_id,
    community_id, collection_id, episode, title, body, deep_link, scheduled_for, expires_at
  )
  values (
    p_recipient, p_kind, p_group, key_clean,
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
