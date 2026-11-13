-- Hallyu AI event triggers: auto-create durable events when members interact with @hallyu.ai.
-- DMs sent to the AI identity and comments mentioning @hallyu.ai become durable events
-- the operator processes autonomously (bounded retries, exponential backoff, idempotency).
-- All triggers are service_role-only; no client can inject events.

create or replace function public.hallyu_ai_record_dm_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ai_profile_id uuid;
begin
  select id into v_ai_profile_id
  from public.profiles
  where handle = 'hallyu.ai' and is_ai and account_status = 'active'
  limit 1;

  if v_ai_profile_id is null then
    return null;
  end if;

  -- Only record DMs sent TO the AI identity (never unsolicited outbound).
  if new.recipient_id = v_ai_profile_id then
    insert into public.hallyu_ai_dm_event (
      conversation_id, sender_id, recipient_id, body, message_id, status, not_before
    ) values (
      coalesce(new.id::text, gen_random_uuid()::text),
      new.sender_id, new.recipient_id, new.body, new.id::text,
      'pending', now()
    ) on conflict (message_id) do nothing;
  end if;

  return null;
end;
$$;

create trigger hallyu_ai_dm_event_trigger
  after insert on public.direct_messages
  for each row
  execute function public.hallyu_ai_record_dm_event();

create or replace function public.hallyu_ai_record_comment_mention_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ai_profile_id uuid;
begin
  select id into v_ai_profile_id
  from public.profiles
  where handle = 'hallyu.ai' and is_ai and account_status = 'active'
  limit 1;

  if v_ai_profile_id is null then
    return null;
  end if;

  -- Only record active public comments that mention @hallyu.ai.
  if new.state = 'active'
     and new.body ilike '%@hallyu.ai%'
     and new.author_id <> v_ai_profile_id then
    insert into public.hallyu_ai_comment_event (
      comment_id, post_id, author_id, mentioned_handle, body, status, not_before
    ) values (
      new.id, new.post_id, new.author_id, '@hallyu.ai', new.body,
      'pending', now()
    ) on conflict do nothing;
  end if;

  return null;
end;
$$;

create trigger hallyu_ai_comment_mention_event_trigger
  after insert on public.comments
  for each row
  execute function public.hallyu_ai_record_comment_mention_event();

-- Grant execute on trigger functions to service_role (trigger execution context).
grant execute on function public.hallyu_ai_record_dm_event() to service_role;
grant execute on function public.hallyu_ai_record_comment_mention_event() to service_role;
