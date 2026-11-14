-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 85 · PHASE 1 STABILISATION
--
-- Repairs confirmed by the Phase 0 audit (docs/operator/AUDIT-REPORT.md):
--   1. Task lifecycle states — extend the status CHECK with the full lifecycle vocabulary.
--   2. Suspension expiry  — add profiles.suspended_until and enforce it.
--   3. Ban vs suspension  — add profiles.is_banned; a ban is no longer a plain suspension.
--   4. Audit immutability — block UPDATE/DELETE on operator_audit.
--   5. Queue sweep        — maintenance sweeps must not create billable model tasks.
--   6. Executive DM       — an admin/CEO who DMs the staff profile opens an `admin_control`
--                           conversation (not `member_ai`), so the executive chat can live in DMs.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. Task lifecycle states ────────────────────────────────────────────────────────────────────────
alter table public.operator_task drop constraint if exists operator_task_status;
alter table public.operator_task
  add constraint operator_task_status check (status in (
    'received', 'understanding', 'investigating', 'planning', 'awaiting_approval',
    'queued', 'executing', 'verifying', 'completed', 'partially_completed',
    'blocked', 'failed', 'cancelled', 'retrying', 'running'
  ));

-- ── 2 & 3. Suspension expiry and permanent-ban distinction ──────────────────────────────────────────
alter table public.profiles add column if not exists suspended_until timestamptz;
alter table public.profiles add column if not exists is_banned boolean not null default false;

comment on column public.profiles.suspended_until is
  'When a temporary suspension ends. NULL with account_status=suspended and is_banned=false means indefinite pending review.';
comment on column public.profiles.is_banned is
  'Permanent ban flag. Distinct from a temporary suspension so the UI and enforcement can tell them apart.';

create or replace function public.operator_suspend_member(
  p_profile_id uuid,
  p_reason text,
  p_days integer default 7
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_staff uuid := public.operator_staff_profile_id();
  v_target public.profiles%rowtype;
  v_action_id uuid;
  v_until timestamptz;
begin
  perform public.operator_require_service();

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'a suspension needs a reason' using errcode = 'invalid_parameter_value';
  end if;
  if p_days < 0 or p_days > 3650 then
    raise exception 'suspension length is out of range' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_target from public.profiles where id = p_profile_id for update;
  if not found then
    raise exception 'member % does not exist', p_profile_id using errcode = 'no_data_found';
  end if;
  if v_target.role <> 'member' then
    raise exception 'the operator may only suspend ordinary members' using errcode = 'insufficient_privilege';
  end if;
  if v_target.is_ai then
    raise exception 'the operator may not suspend AI staff' using errcode = 'insufficient_privilege';
  end if;

  v_until := case when p_days > 0 then now() + make_interval(days => p_days) else null end;

  update public.profiles
     set account_status = 'suspended',
         suspended_until = v_until,
         is_banned = false
   where id = p_profile_id;

  insert into public.moderation_actions (action, target_type, target_id, actor_id, actor_handle, reason, detail)
  values (
    'user_suspended', 'user', p_profile_id, v_staff,
    (select handle::text from public.profiles where id = v_staff),
    left(p_reason, 500),
    jsonb_build_object('source', 'hallyu_ai_operator', 'days', p_days, 'suspended_until', v_until)
  )
  returning id into v_action_id;

  perform public.operator_audit_write(
    'moderation.suspend', 'succeeded', null, v_staff, 'staff',
    'member', p_profile_id::text,
    jsonb_build_object('reason', p_reason, 'days', p_days, 'suspended_until', v_until, 'moderation_action_id', v_action_id)
  );

  return jsonb_build_object(
    'profile_id', p_profile_id,
    'account_status', 'suspended',
    'suspended_until', v_until,
    'days', p_days,
    'moderation_action_id', v_action_id,
    'verified', true
  );
end;
$$;

create or replace function public.operator_ban_member(
  p_profile_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_staff uuid := public.operator_staff_profile_id();
  v_target public.profiles%rowtype;
  v_action_id uuid;
begin
  perform public.operator_require_service();

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'a ban needs a reason' using errcode = 'invalid_parameter_value';
  end if;

  select * into v_target from public.profiles where id = p_profile_id for update;
  if not found then
    raise exception 'member % does not exist', p_profile_id using errcode = 'no_data_found';
  end if;
  if v_target.role <> 'member' then
    raise exception 'the operator may only ban ordinary members' using errcode = 'insufficient_privilege';
  end if;
  if v_target.is_ai then
    raise exception 'the operator may not ban AI staff' using errcode = 'insufficient_privilege';
  end if;

  update public.profiles
     set account_status = 'suspended',
         is_banned = true,
         suspended_until = null
   where id = p_profile_id;

  insert into public.moderation_actions (action, target_type, target_id, actor_id, actor_handle, reason, detail)
  values (
    'user_suspended', 'user', p_profile_id, v_staff,
    (select handle::text from public.profiles where id = v_staff),
    left(p_reason, 500),
    jsonb_build_object('source', 'hallyu_ai_operator', 'permanent', true)
  )
  returning id into v_action_id;

  perform public.operator_audit_write(
    'moderation.ban', 'succeeded', null, v_staff, 'staff',
    'member', p_profile_id::text,
    jsonb_build_object('reason', p_reason, 'moderation_action_id', v_action_id)
  );

  return jsonb_build_object(
    'profile_id', p_profile_id,
    'account_status', 'suspended',
    'is_banned', true,
    'permanent', true,
    'moderation_action_id', v_action_id,
    'verified', true
  );
end;
$$;

revoke all on function public.operator_suspend_member(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.operator_suspend_member(uuid, text, integer) to service_role;
revoke all on function public.operator_ban_member(uuid, text) from public, anon, authenticated;
grant execute on function public.operator_ban_member(uuid, text) to service_role;

-- Lift expired temporary suspensions. Called from the minute tick.
create or replace function public.operator_expire_suspensions()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_count integer := 0;
begin
  update public.profiles
     set account_status = 'active',
         suspended_until = null
   where account_status = 'suspended'
     and is_banned = false
     and suspended_until is not null
     and suspended_until <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.operator_expire_suspensions() from public, anon, authenticated;
grant execute on function public.operator_expire_suspensions() to service_role;

-- ── 4. Audit immutability ──────────────────────────────────────────────────────────────────────────
create or replace function public.operator_audit_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'operator_audit is append-only; % is not permitted', tg_op using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists operator_audit_no_update on public.operator_audit;
create trigger operator_audit_no_update
  before update or delete on public.operator_audit
  for each row execute function public.operator_audit_immutable();

-- ── 5. Maintenance sweeps must not create billable model tasks ─────────────────────────────────────
create or replace function public.operator_scheduler_sweep()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  r        public.operator_schedule%rowtype;
  v_task   uuid;
  v_count  integer := 0;
  v_next   timestamptz;
begin
  for r in
    select *
    from public.operator_schedule
    where enabled
      and next_run_at <= now()
    order by next_run_at
    for update skip locked
  loop
    -- Pure maintenance sweeps are handled by the tick itself (recovery, expiry). They must never
    -- be enqueued as a model task, or every minute would burn provider credits for nothing.
    if r.task_type not in ('queue_sweep') then
      insert into public.operator_task (task_type, status, priority, input, idempotency_key)
      values (
        r.task_type,
        'queued',
        4,
        r.payload,
        'schedule:' || r.name || ':' || floor(extract(epoch from r.next_run_at))::bigint::text
      )
      on conflict (idempotency_key) where idempotency_key is not null do nothing
      returning id into v_task;
    end if;

    v_next := now() + make_interval(secs => coalesce(r.interval_seconds, 3600));

    update public.operator_schedule
       set last_run_at = now(),
           last_task_id = coalesce(v_task, last_task_id),
           next_run_at = v_next,
           updated_at = now()
     where id = r.id;

    if v_task is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

create or replace function public.operator_scheduler_tick()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_enqueued integer := 0;
  v_recovered integer := 0;
  v_expired integer := 0;
begin
  begin
    v_enqueued := public.operator_scheduler_sweep();
  exception when others then
    perform public.operator_audit_write('scheduler.sweep', 'failed', null, null, 'system', 'schedule', null,
      jsonb_build_object('error', sqlerrm));
  end;

  begin
    v_recovered := public.operator_recover_stale_tasks();
  exception when others then
    perform public.operator_audit_write('scheduler.recover', 'failed', null, null, 'system', 'task', null,
      jsonb_build_object('error', sqlerrm));
  end;

  begin
    v_expired := public.operator_expire_suspensions();
  exception when others then
    perform public.operator_audit_write('scheduler.expire', 'failed', null, null, 'system', 'member', null,
      jsonb_build_object('error', sqlerrm));
  end;

  return jsonb_build_object('enqueued', v_enqueued, 'recovered', v_recovered, 'expired', v_expired, 'at', now());
end;
$$;

revoke all on function public.operator_scheduler_sweep() from anon, authenticated;
revoke all on function public.operator_scheduler_tick() from anon, authenticated;
grant execute on function public.operator_scheduler_sweep() to service_role;
grant execute on function public.operator_scheduler_tick() to service_role;

-- ── 6. Executive DM opens an admin_control conversation ────────────────────────────────────────────
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

  v_conv := public.operator_ensure_conversation(v_channel, case when v_is_exec then null else new.sender_id end, null, 'Direct message');

  insert into public.operator_message (
    conversation_id, direction, author_profile_id, author_type, body, external_message_id, delivery_status
  )
  values (v_conv, 'inbound', new.sender_id, case when v_is_exec then 'admin' else 'member' end, new.body, new.id, 'not_required')
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
