-- Migration 47: Full-Stack Audit Bug Fixes
--   1. Fix `public.on_direct_message_notify()` trigger: read `new.recipient_id` directly from
--      `public.direct_messages` (no `public.conversations` relation) and route deep link cleanly
--      to `/messages/<sender.handle>`.
--   2. Fix `public.submit_support_ticket(...)`: reject empty/null subject or description with
--      `invalid_parameter_value` (`22023`) instead of inserting placeholder probe tickets into
--      the live staff inbox during null-argument RPC signature checks, and remove stale probe rows.
--   3. Keep `check_function_bodies = on` strictly enabled throughout.

set check_function_bodies = on;

-- 1. Direct Message Push & Inbox Trigger
create or replace function public.on_direct_message_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sender public.profiles%rowtype;
begin
  if new.recipient_id is null or new.recipient_id = new.sender_id then
    return new;
  end if;

  select * into sender from public.profiles where id = new.sender_id;

  perform public.enqueue_notification(
    p_recipient := new.recipient_id,
    p_kind := 'mention',
    p_group := 'social',
    p_dedupe_key := 'dm:' || new.id::text,
    p_actor_ids := array[new.sender_id],
    p_title := coalesce(sender.display_name, '@' || coalesce(sender.handle::text, 'member')) || ' sent you a message',
    p_body := left(coalesce(nullif(btrim(new.body), ''), 'Shared something with you on Hallyu'), 140),
    p_deep_link := case
      when sender.handle is not null then '/messages/' || sender.handle::text
      else '/messages'
    end
  );

  return new;
end;
$$;

drop trigger if exists direct_messages_notify_after_insert on public.direct_messages;
create trigger direct_messages_notify_after_insert
  after insert on public.direct_messages
  for each row execute function public.on_direct_message_notify();

-- 2. Support Ticket & Bug Report Submission RPC (strict input validation — zero probe spam)
create or replace function public.submit_support_ticket(
  p_category text,
  p_subject text,
  p_description text,
  p_reporter_email text default null,
  p_screenshot_url text default null,
  p_app_version text default null,
  p_platform text default null,
  p_route_name text default null,
  p_diagnostics jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  tid uuid;
  cat text := coalesce(nullif(btrim(p_category), ''), 'bug');
  clean_subject text := btrim(coalesce(p_subject, ''));
  clean_desc text := btrim(coalesce(p_description, ''));
  staff_rec record;
begin
  if char_length(clean_subject) < 2 or char_length(clean_desc) < 3 then
    raise exception 'subject and description are required' using errcode = 'invalid_parameter_value';
  end if;

  if cat not in ('bug', 'crash', 'missing_title', 'upload', 'account', 'feature') then
    cat := 'bug';
  end if;

  insert into public.support_tickets (
    reporter_id, reporter_email, category, subject, description,
    screenshot_url, app_version, platform, route_name, diagnostics
  )
  values (
    uid,
    nullif(btrim(coalesce(p_reporter_email, '')), ''),
    cat,
    left(clean_subject, 200),
    left(clean_desc, 4000),
    nullif(btrim(coalesce(p_screenshot_url, '')), ''),
    nullif(btrim(coalesce(p_app_version, '')), ''),
    nullif(btrim(coalesce(p_platform, '')), ''),
    nullif(btrim(coalesce(p_route_name, '')), ''),
    coalesce(p_diagnostics, '{}'::jsonb)
  )
  returning id into tid;

  for staff_rec in
    select id from public.profiles
     where role in ('admin', 'moderator')
       and account_status = 'active'
       and (uid is null or id <> uid)
  loop
    perform public.enqueue_notification(
      p_recipient := staff_rec.id,
      p_kind := 'system',
      p_group := 'system',
      p_dedupe_key := 'ticket:' || tid::text,
      p_actor_ids := case when uid is not null then array[uid] else '{}'::uuid[] end,
      p_title := 'New ' || upper(cat) || ' report',
      p_body := left(clean_subject || ' — ' || clean_desc, 160),
      p_deep_link := '/settings/moderation'
    );
  end loop;

  return tid;
end;
$$;

grant execute on function public.submit_support_ticket(text, text, text, text, text, text, text, text, jsonb) to anon, authenticated, service_role;

-- Remove stale CI null-probe placeholder rows and their duplicate notifications
delete from public.notifications
where dedupe_key in (
  select 'ticket:' || id::text
  from public.support_tickets
  where reporter_id is null
    and subject = 'Hallyu Report'
    and description = 'Submitted from app'
);

delete from public.support_tickets
where reporter_id is null
  and subject = 'Hallyu Report'
  and description = 'Submitted from app';
