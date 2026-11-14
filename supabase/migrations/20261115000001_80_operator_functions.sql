-- 80: Hallyu AI Operator — server functions, queue mechanics and event capture.
--
-- Everything here is SECURITY DEFINER with a pinned search_path. The browser never calls the
-- queue internals directly: the worker authenticates with a server-side token, and the admin
-- console goes through the operator-admin Edge Function.

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Identity helpers
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_staff_profile_id()
returns uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select profile_id from public.operator_staff where active order by created_at limit 1;
$$;

comment on function public.operator_staff_profile_id() is
  'The profile id of the active Hallyu AI staff identity. Used to recognise inbound member-to-AI messages without trusting message text.';

create or replace function public.operator_is_staff(p_profile uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (select 1 from public.operator_staff s where s.profile_id = p_profile and s.active);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Conversation identity
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_ensure_conversation(
  p_channel text,
  p_member uuid,
  p_thread uuid default null,
  p_subject text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_staff uuid := public.operator_staff_profile_id();
  v_id uuid;
begin
  if p_channel not in ('admin_control', 'member_ai', 'public_thread') then
    raise exception 'operator_ensure_conversation: unknown channel %', p_channel using errcode = '22023';
  end if;

  select id into v_id
  from public.operator_conversation
  where channel = p_channel
    and coalesce(member_profile_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(p_member, '00000000-0000-0000-0000-000000000000'::uuid)
    and coalesce(external_thread_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(p_thread, '00000000-0000-0000-0000-000000000000'::uuid)
  limit 1;

  if v_id is not null then
    return v_id;
  end if;

  insert into public.operator_conversation (channel, staff_profile_id, member_profile_id, external_thread_id, subject)
  values (p_channel, v_staff, p_member, p_thread, p_subject)
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id
    from public.operator_conversation
    where channel = p_channel
      and coalesce(member_profile_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = coalesce(p_member, '00000000-0000-0000-0000-000000000000'::uuid)
      and coalesce(external_thread_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = coalesce(p_thread, '00000000-0000-0000-0000-000000000000'::uuid)
    limit 1;
  end if;

  return v_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Audit
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_audit_write(
  p_action text,
  p_outcome text,
  p_task uuid default null,
  p_actor uuid default null,
  p_actor_type text default 'system',
  p_resource_type text default null,
  p_resource_id text default null,
  p_details jsonb default '{}'::jsonb
)
returns bigint
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
  insert into public.operator_audit (task_id, actor_profile_id, actor_type, action, outcome, resource_type, resource_id, details)
  values (p_task, p_actor, coalesce(p_actor_type, 'system'), p_action, p_outcome, p_resource_type, p_resource_id, coalesce(p_details, '{}'::jsonb))
  returning id;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Event intake (idempotent)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_enqueue_event(
  p_source text,
  p_event_type text,
  p_idempotency_key text,
  p_conversation uuid default null,
  p_actor uuid default null,
  p_destination_type text default null,
  p_destination_id uuid default null,
  p_payload jsonb default '{}'::jsonb,
  p_external_event_id text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_id uuid;
begin
  insert into public.operator_event (
    source, event_type, external_event_id, conversation_id, actor_profile_id,
    destination_type, destination_id, payload, idempotency_key
  )
  values (
    p_source, p_event_type, p_external_event_id, p_conversation, p_actor,
    p_destination_type, p_destination_id, coalesce(p_payload, '{}'::jsonb), p_idempotency_key
  )
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.operator_event where idempotency_key = p_idempotency_key;
  end if;

  return v_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Task lifecycle
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_create_task(
  p_task_type text,
  p_input jsonb default '{}'::jsonb,
  p_conversation uuid default null,
  p_requester uuid default null,
  p_destination_type text default null,
  p_destination_id uuid default null,
  p_idempotency_key text default null,
  p_priority integer default 5,
  p_source_event uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_id uuid;
  v_provider text;
  v_model text;
begin
  select provider, model_id into v_provider, v_model
  from public.operator_provider
  where is_default and enabled
  limit 1;

  insert into public.operator_task (
    task_type, status, priority, source_event_id, conversation_id, requester_profile_id,
    destination_type, destination_id, provider, model, input, idempotency_key
  )
  values (
    p_task_type, 'queued', coalesce(p_priority, 5), p_source_event, p_conversation, p_requester,
    p_destination_type, p_destination_id, v_provider, v_model, coalesce(p_input, '{}'::jsonb), p_idempotency_key
  )
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning id into v_id;

  if v_id is null and p_idempotency_key is not null then
    select id into v_id from public.operator_task where idempotency_key = p_idempotency_key;
  end if;

  if v_id is not null and p_source_event is not null then
    update public.operator_event set task_id = v_id where id = p_source_event and task_id is null;
  end if;

  return v_id;
end;
$$;

create or replace function public.operator_claim_task(p_worker text, p_limit integer default 1)
returns setof public.operator_task
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  return query
  with claimed as (
    select t.id
    from public.operator_task t
    where t.status in ('queued', 'retrying')
      and t.available_at <= now()
    order by t.priority asc, t.available_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 1), 20))
  )
  update public.operator_task t
     set status = 'running',
         lease_owner = p_worker,
         lease_expires_at = now() + interval '90 seconds',
         attempt_count = t.attempt_count + 1,
         started_at = coalesce(t.started_at, now()),
         updated_at = now()
   where t.id in (select id from claimed)
  returning t.*;
end;
$$;

create or replace function public.operator_complete_task(p_task uuid, p_result jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  update public.operator_task
     set status = 'completed',
         result = coalesce(p_result, '{}'::jsonb),
         finished_at = now(),
         updated_at = now(),
         lease_owner = null,
         lease_expires_at = null,
         error_code = null,
         error_detail = null
   where id = p_task;
end;
$$;

create or replace function public.operator_fail_task(
  p_task uuid,
  p_error_code text,
  p_error_detail text default null,
  p_retryable boolean default false
)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_attempts integer;
  v_max integer;
  v_status text;
begin
  select attempt_count, max_attempts into v_attempts, v_max
  from public.operator_task where id = p_task for update;

  if v_attempts is null then
    return 'missing';
  end if;

  if p_retryable and v_attempts < v_max then
    v_status := 'retrying';
    update public.operator_task
       set status = 'retrying',
           error_code = p_error_code,
           error_detail = p_error_detail,
           available_at = now() + make_interval(secs => least(300, 5 * power(2, v_attempts)::integer)),
           lease_owner = null,
           lease_expires_at = null,
           updated_at = now()
     where id = p_task;
  else
    v_status := 'failed';
    update public.operator_task
       set status = 'failed',
           error_code = p_error_code,
           error_detail = p_error_detail,
           finished_at = now(),
           lease_owner = null,
           lease_expires_at = null,
           updated_at = now()
     where id = p_task;
  end if;

  return v_status;
end;
$$;

-- Recover tasks whose worker died mid-flight. Safe to call repeatedly.
create or replace function public.operator_recover_stale_tasks()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_count integer;
begin
  with stale as (
    update public.operator_task
       set status = case when attempt_count < max_attempts then 'retrying' else 'failed' end,
           error_code = coalesce(error_code, 'lease_expired'),
           available_at = now(),
           lease_owner = null,
           lease_expires_at = null,
           finished_at = case when attempt_count >= max_attempts then now() else null end,
           updated_at = now()
     where status = 'running'
       and lease_expires_at is not null
       and lease_expires_at < now()
    returning 1
  )
  select count(*) into v_count from stale;
  return v_count;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Usage, health, provider configuration
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_record_usage(
  p_provider text,
  p_model text,
  p_outcome text,
  p_task uuid default null,
  p_input_tokens integer default null,
  p_output_tokens integer default null,
  p_total_tokens integer default null,
  p_estimated_cost numeric default null,
  p_latency_ms integer default null,
  p_http_status integer default null,
  p_error_code text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  insert into public.operator_provider_usage (
    task_id, provider, model, outcome, input_tokens, output_tokens, total_tokens,
    estimated_cost_usd, latency_ms, http_status, error_code
  )
  values (
    p_task, p_provider, p_model, p_outcome, p_input_tokens, p_output_tokens, p_total_tokens,
    p_estimated_cost, p_latency_ms, p_http_status, p_error_code
  );

  if p_outcome = 'succeeded' then
    update public.operator_provider
       set health = 'available', last_ok_at = now(), last_error_code = null, last_error_detail = null
     where provider = p_provider;
  else
    update public.operator_provider
       set last_error_at = now(),
           last_error_code = p_error_code,
           health = case
             when p_http_status = 401 or p_http_status = 403 then 'auth_error'
             when p_http_status = 402 then 'billing_error'
             when p_http_status = 429 then 'rate_limited'
             when p_http_status >= 500 then 'unavailable'
             else 'degraded'
           end
     where provider = p_provider;
  end if;
end;
$$;

create or replace function public.operator_heartbeat(p_worker text, p_version text default null, p_meta jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  insert into public.operator_worker_health (worker_id, last_seen_at, version, meta)
  values (p_worker, now(), p_version, coalesce(p_meta, '{}'::jsonb))
  on conflict (worker_id) do update
    set last_seen_at = now(),
        version = coalesce(excluded.version, public.operator_worker_health.version),
        meta = coalesce(excluded.meta, public.operator_worker_health.meta);
end;
$$;

-- Deliberate, permission-checked model selection. Never a silent failover.
create or replace function public.operator_set_active_model(
  p_provider text,
  p_model text,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_allowed boolean;
begin
  if not public.is_admin() then
    raise exception 'operator_set_active_model: administrator role required' using errcode = '42501';
  end if;

  select coalesce((autonomy ->> 'may_switch_model')::boolean, false) into v_allowed
  from public.operator_policy where id;

  if not coalesce(v_allowed, false) and p_actor is distinct from (select id from public.profiles where role = 'ceo' limit 1) then
    raise exception 'operator_set_active_model: model switching is administrator-only under current policy' using errcode = '42501';
  end if;

  if not exists (select 1 from public.operator_provider where provider = p_provider and enabled) then
    raise exception 'operator_set_active_model: provider % is not enabled', p_provider using errcode = '22023';
  end if;

  update public.operator_provider set is_default = false where is_default;
  update public.operator_provider
     set model_id = p_model, is_default = true, updated_at = now()
   where provider = p_provider;

  perform public.operator_audit_write(
    'provider.select', 'succeeded', null, p_actor, 'admin',
    'provider', p_provider, jsonb_build_object('model', p_model)
  );

  return jsonb_build_object('provider', p_provider, 'model', p_model);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Context assembly (scoped, minimal)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_conversation_context(p_conversation uuid, p_limit integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_conv public.operator_conversation;
  v_messages jsonb;
  v_memory jsonb;
begin
  select * into v_conv from public.operator_conversation where id = p_conversation;
  if v_conv.id is null then
    return jsonb_build_object('error', 'conversation_not_found');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'direction', m.direction,
           'author_type', m.author_type,
           'body', m.body,
           'at', m.created_at
         ) order by m.created_at), '[]'::jsonb)
    into v_messages
  from (
    select * from public.operator_message
    where conversation_id = p_conversation
    order by created_at desc
    limit greatest(1, least(coalesce(p_limit, 20), 60))
  ) m;

  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    into v_memory
  from public.operator_memory
  where (scope = 'member' and scope_id = v_conv.member_profile_id)
     or (scope = 'admin' and v_conv.channel = 'admin_control')
     or scope = 'platform'
     or (scope = 'operational' and (expires_at is null or expires_at > now()));

  return jsonb_build_object(
    'conversation_id', v_conv.id,
    'channel', v_conv.channel,
    'member_profile_id', v_conv.member_profile_id,
    'external_thread_id', v_conv.external_thread_id,
    'messages', v_messages,
    'memory', v_memory
  );
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Outbound delivery — writes the real platform row, then records it
-- ─────────────────────────────────────────────────────────────────────────────
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

  if v_conv.channel = 'member_ai' then
    if v_conv.member_profile_id is null then
      raise exception 'operator_send_staff_message: member conversation without a member' using errcode = '22023';
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Worker authentication
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_verify_worker(p_token text)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'vault', 'pg_temp'
as $$
  select coalesce(auth.role() = 'service_role', false)
     and p_token is not null
     and exists (
       select 1 from vault.decrypted_secrets
       where name in ('operator_worker_token', 'hallyu_operator_worker_token')
         and decrypted_secret = p_token
     );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Event capture triggers
-- ─────────────────────────────────────────────────────────────────────────────
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
begin
  if v_staff is null or new.recipient_id <> v_staff or new.sender_id = v_staff then
    return new;
  end if;

  v_conv := public.operator_ensure_conversation('member_ai', new.sender_id, null, 'Member DM');

  insert into public.operator_message (
    conversation_id, direction, author_profile_id, author_type, body, external_message_id, delivery_status
  )
  values (v_conv, 'inbound', new.sender_id, 'member', new.body, new.id, 'not_required')
  on conflict (external_message_id) where external_message_id is not null do nothing;

  update public.operator_conversation
     set last_inbound_at = now(), updated_at = now()
   where id = v_conv;

  v_event := public.operator_enqueue_event(
    'dm', 'member_message', 'dm:' || new.id::text, v_conv, new.sender_id,
    'member_ai', v_conv, jsonb_build_object('body', new.body, 'dm_id', new.id),
    new.id::text
  );

  perform public.operator_create_task(
    'reply_member_dm',
    jsonb_build_object('conversation_id', v_conv, 'body', new.body),
    v_conv, new.sender_id, 'member_ai', v_conv,
    'dm:' || new.id::text, 3, v_event
  );

  return new;
end;
$$;

create or replace function public.operator_capture_mention()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_staff uuid := public.operator_staff_profile_id();
  v_handle text;
  v_conv uuid;
  v_event uuid;
begin
  if v_staff is null or new.author_id = v_staff then
    return new;
  end if;

  select handle into v_handle from public.profiles where id = v_staff;
  if v_handle is null then
    return new;
  end if;

  if new.body not ilike '%@' || v_handle || '%' then
    return new;
  end if;

  v_conv := public.operator_ensure_conversation('public_thread', null, new.id, 'Public mention');

  insert into public.operator_message (
    conversation_id, direction, author_profile_id, author_type, body, external_message_id, delivery_status
  )
  values (v_conv, 'inbound', new.author_id, 'member', new.body, new.id, 'not_required')
  on conflict (external_message_id) where external_message_id is not null do nothing;

  update public.operator_conversation
     set last_inbound_at = now(), updated_at = now()
   where id = v_conv;

  v_event := public.operator_enqueue_event(
    'mention', 'public_mention', 'comment:' || new.id::text, v_conv, new.author_id,
    'comment', new.id, jsonb_build_object('body', new.body, 'post_id', new.post_id), new.id::text
  );

  perform public.operator_create_task(
    'reply_public_mention',
    jsonb_build_object('conversation_id', v_conv, 'body', new.body, 'post_id', new.post_id),
    v_conv, new.author_id, 'comment', new.id,
    'comment:' || new.id::text, 4, v_event
  );

  return new;
end;
$$;

-- Wake the worker as soon as a task is queued. Failure here must never block the insert —
-- the scheduler is the backstop.
create or replace function public.operator_dispatch_task()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'vault', 'net', 'pg_temp'
as $$
declare
  v_token text;
begin
  if new.status <> 'queued' then
    return new;
  end if;

  select decrypted_secret into v_token
  from vault.decrypted_secrets
  where name in ('operator_worker_token', 'hallyu_operator_worker_token')
  limit 1;

  if v_token is null then
    perform public.operator_audit_write(
      'worker.dispatch', 'failed', new.id, null, 'system', 'task', new.id::text,
      jsonb_build_object('reason', 'worker token unavailable')
    );
    return new;
  end if;

  begin
    perform net.http_post(
      url := 'https://ltyymanoidagwsapgiql.supabase.co/functions/v1/operator-worker',
      body := jsonb_build_object('task_id', new.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token),
      timeout_milliseconds := 5000
    );
  exception when others then
    perform public.operator_audit_write(
      'worker.dispatch', 'failed', new.id, null, 'system', 'task', new.id::text,
      jsonb_build_object('reason', 'wake request failed')
    );
  end;

  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Trigger wiring (idempotent)
-- ─────────────────────────────────────────────────────────────────────────────
drop trigger if exists operator_capture_member_dm on public.direct_messages;
create trigger operator_capture_member_dm
  after insert on public.direct_messages
  for each row execute function public.operator_capture_member_dm();

drop trigger if exists operator_capture_mention on public.comments;
create trigger operator_capture_mention
  after insert on public.comments
  for each row execute function public.operator_capture_mention();

drop trigger if exists operator_dispatch_task on public.operator_task;
create trigger operator_dispatch_task
  after insert on public.operator_task
  for each row execute function public.operator_dispatch_task();

drop trigger if exists operator_staff_touch on public.operator_staff;
create trigger operator_staff_touch
  before update on public.operator_staff
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. Execute grants
-- ─────────────────────────────────────────────────────────────────────────────
revoke all on function public.operator_claim_task(text, integer) from anon, authenticated;
revoke all on function public.operator_complete_task(uuid, jsonb) from anon, authenticated;
revoke all on function public.operator_fail_task(uuid, text, text, boolean) from anon, authenticated;
revoke all on function public.operator_recover_stale_tasks() from anon, authenticated;
revoke all on function public.operator_record_usage(text, text, text, uuid, integer, integer, integer, numeric, integer, integer, text) from anon, authenticated;
revoke all on function public.operator_heartbeat(text, text, jsonb) from anon, authenticated;
revoke all on function public.operator_enqueue_event(text, text, text, uuid, uuid, text, uuid, jsonb, text) from anon, authenticated;
revoke all on function public.operator_create_task(text, jsonb, uuid, uuid, text, uuid, text, integer, uuid) from anon, authenticated;
revoke all on function public.operator_send_staff_message(uuid, text, uuid) from anon, authenticated;
revoke all on function public.operator_verify_worker(text) from anon, authenticated;
revoke all on function public.operator_conversation_context(uuid, integer) from anon, authenticated;

grant execute on function public.operator_staff_profile_id() to authenticated, service_role;
grant execute on function public.operator_is_staff(uuid) to authenticated, service_role;
grant execute on function public.operator_ensure_conversation(text, uuid, uuid, text) to service_role;
grant execute on function public.operator_audit_write(text, text, uuid, uuid, text, text, text, jsonb) to service_role;
grant execute on function public.operator_enqueue_event(text, text, text, uuid, uuid, text, uuid, jsonb, text) to service_role;
grant execute on function public.operator_create_task(text, jsonb, uuid, uuid, text, uuid, text, integer, uuid) to service_role;
grant execute on function public.operator_claim_task(text, integer) to service_role;
grant execute on function public.operator_complete_task(uuid, jsonb) to service_role;
grant execute on function public.operator_fail_task(uuid, text, text, boolean) to service_role;
grant execute on function public.operator_recover_stale_tasks() to service_role;
grant execute on function public.operator_record_usage(text, text, text, uuid, integer, integer, integer, numeric, integer, integer, text) to service_role;
grant execute on function public.operator_heartbeat(text, text, jsonb) to service_role;
grant execute on function public.operator_set_active_model(text, text, uuid) to authenticated, service_role;
grant execute on function public.operator_conversation_context(uuid, integer) to service_role;
grant execute on function public.operator_send_staff_message(uuid, text, uuid) to service_role;
grant execute on function public.operator_verify_worker(text) to service_role;
