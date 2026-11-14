-- Fix: the executive's first Direct Message to Hallyu AI failed with
--   new row for relation "operator_conversation" violates check constraint
--   "operator_conversation_participant"
--
-- Two defects in the same path, both fatal for the first executive DM:
--
-- 1. `operator_capture_member_dm()` opened the `admin_control` conversation with a NULL
-- member_profile_id, but `operator_conversation_participant` requires a member for every channel
-- except `public_thread` (where external_thread_id stands in). The constraint is right and the
-- trigger was wrong: an admin conversation still belongs to exactly one person — the executive who
-- owns it — so it is keyed by their profile id. That also keeps one admin conversation per
-- executive instead of one shared across every administrator.

create or replace function public.operator_capture_member_dm()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_staff uuid := public.operator_staff_profile_id();
  v_conv uuid;
  v_event uuid;
  v_is_exec boolean := false;
  v_channel text;
  v_task_type text;
begin
  if v_staff is null or new.recipient_id <> v_staff or new.sender_id = v_staff then
    return new;
  end if;

  -- An admin or CEO messaging the Operator is the executive conversation, and must open the
  -- admin_control channel so it is reachable from Direct Messages (not the Admin Console).
  select coalesce(role in ('admin', 'ceo'), false) into v_is_exec
    from public.profiles where id = new.sender_id;
  v_channel := case when v_is_exec then 'admin_control' else 'member_ai' end;
  v_task_type := case when v_is_exec then 'admin_command' else 'reply_member_dm' end;

  -- The conversation always belongs to the person who wrote the message, executive or not.
  v_conv := public.operator_ensure_conversation(v_channel, new.sender_id, null, 'Direct message');

  insert into public.operator_message (
    conversation_id, direction, author_profile_id, author_type, body, external_message_id, delivery_status
  )
  -- `operator_message_author` allows member/staff/system; an executive is staff.
  values (v_conv, 'inbound', new.sender_id, case when v_is_exec then 'staff' else 'member' end, new.body, new.id, 'not_required')
  on conflict (external_message_id) where external_message_id is not null do nothing;

  update public.operator_conversation
     set last_inbound_at = now(), updated_at = now()
   where id = v_conv;

  v_event := public.operator_enqueue_event(
    'dm', 'member_message', 'dm:' || new.id::text, v_conv, new.sender_id,
    v_channel, v_conv, jsonb_build_object('body', new.body, 'dm_id', new.id),
    new.id::text
  );

  perform public.operator_create_task(
    v_task_type,
    jsonb_build_object('conversation_id', v_conv, 'body', new.body),
    v_conv, new.sender_id, v_channel, v_conv,
    'dm:' || new.id::text, 3, v_event
  );

  return new;
end;
$$;
