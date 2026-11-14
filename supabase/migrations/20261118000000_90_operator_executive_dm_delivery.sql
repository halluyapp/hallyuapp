-- Fix: the executive's Direct Messages never showed the Operator's replies.
--
-- `operator_send_staff_message()` mirrored its answer into `public.direct_messages` only for
-- `member_ai` conversations. An `admin_control` (executive) conversation wrote only the operator
-- record, so a CEO talking to Hallyu AI in the existing DM screen saw their own messages and no
-- reply — even though the task had completed and the answer existed.
--
-- Both DM channels now deliver into the real DM table; public threads still reply into the comment
-- thread they came from.

create or replace function public.operator_send_staff_message(
  p_conversation uuid,
  p_body text,
  p_task uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_conv public.operator_conversation;
  v_staff uuid := public.operator_staff_profile_id();
  v_dm uuid;
  v_comment uuid;
  v_msg uuid;
  v_clean text := btrim(coalesce(p_body, ''));
begin
  if v_clean = '' then
    raise exception 'operator_send_staff_message: empty body' using errcode = '22023';
  end if;

  select * into v_conv from public.operator_conversation where id = p_conversation;
  if v_conv.id is null then
    raise exception 'operator_send_staff_message: conversation % not found', p_conversation using errcode = '22023';
  end if;

  if v_conv.channel in ('member_ai', 'admin_control') then
    if v_conv.member_profile_id is null then
      raise exception 'operator_send_staff_message: DM conversation % has no member', p_conversation using errcode = '22023';
    end if;
    insert into public.direct_messages (sender_id, recipient_id, body)
    values (v_staff, v_conv.member_profile_id, left(v_clean, 2000))
    returning id into v_dm;
  elsif v_conv.channel = 'public_thread' then
    if v_conv.external_thread_id is null then
      raise exception 'operator_send_staff_message: public thread without a thread id' using errcode = '22023';
    end if;
    -- Reply into the exact thread the mention came from.
    insert into public.comments (post_id, author_id, body, parent_id)
    values (
      (select post_id from public.comments where id = v_conv.external_thread_id),
      v_staff,
      left(v_clean, 2000),
      v_conv.external_thread_id
    )
    returning id into v_comment;
  end if;

  insert into public.operator_message (
    conversation_id, direction, author_profile_id, author_type, body,
    external_message_id, delivery_status, task_id
  )
  values (
    p_conversation, 'outbound', v_staff, 'staff', v_clean,
    coalesce(v_dm, v_comment), 'sent', p_task
  )
  returning id into v_msg;

  update public.operator_conversation
     set last_outbound_at = now(), updated_at = now()
   where id = p_conversation;

  perform public.operator_audit_write(
    'message.send', 'succeeded', p_task, v_staff, 'staff',
    v_conv.channel, p_conversation::text,
    jsonb_build_object('external_message_id', coalesce(v_dm, v_comment))
  );

  return jsonb_build_object(
    'operator_message_id', v_msg,
    'external_message_id', coalesce(v_dm, v_comment),
    'channel', v_conv.channel,
    'verified', true
  );
end;
$$;
