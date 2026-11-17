-- Exact-action, expiring, single-use approvals. No provider or autonomy policy is enabled here.
alter table public.operator_approval add column if not exists expires_at timestamptz not null default (now()+interval '24 hours');
alter table public.operator_approval add column if not exists consumed_at timestamptz;

create or replace function public.operator_decide_approval(p_approval uuid,p_decision text,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.operator_approval; t public.operator_task; actor uuid:=public.current_profile_id(); args jsonb;
begin
  if actor is null or not public.is_admin() then raise exception 'admin role required' using errcode='42501'; end if;
  if p_decision is null or p_decision not in ('approved','rejected') then raise exception 'invalid decision' using errcode='22023'; end if;
  select * into a from public.operator_approval where id=p_approval for update;
  if a.id is null then raise exception 'approval not found' using errcode='P0002'; end if;
  if a.status<>'pending' then raise exception 'approval already decided' using errcode='23514'; end if;
  if a.expires_at<=now() then
    update public.operator_approval set status='expired' where id=a.id;
    update public.operator_task set status='cancelled',updated_at=now() where id=a.task_id and status='awaiting_approval';
    perform public.operator_audit_write('approval.expired','rejected',a.task_id,actor,'admin','approval',a.id::text,'{}'::jsonb);
    return jsonb_build_object('approval_id',a.id,'status','expired','verified',true);
  end if;
  select * into t from public.operator_task where id=a.task_id for update;
  if t.id is null or t.status<>'awaiting_approval' then raise exception 'task no longer awaiting approval' using errcode='23514'; end if;
  if p_decision='approved' then
    -- Existing requests store raw JSON arguments. Never approve a free-form instruction instead.
    args:=case jsonb_typeof(a.payload->'arguments') when 'string' then (a.payload->>'arguments')::jsonb else a.payload->'arguments' end;
    if jsonb_typeof(args) is distinct from 'object' or a.payload->>'tool' is distinct from a.action then
      raise exception 'approval must bind exact tool and object arguments' using errcode='22023';
    end if;
    if not exists(select 1 from public.operator_tool where name=a.action and enabled) then
      raise exception 'tool disabled or missing' using errcode='23514';
    end if;
  end if;
  update public.operator_approval set status=p_decision,decided_by=actor,decided_at=now(),note=left(p_note,500) where id=a.id;
  update public.operator_task set status=case when p_decision='approved' then 'queued' else 'cancelled' end,
    input=case when p_decision='approved' then coalesce(input,'{}'::jsonb)||jsonb_build_object('_approved_action_id',a.id) else input end,
    available_at=now(),updated_at=now(),lease_owner=null,lease_expires_at=null,
    attempt_count=case when p_decision='approved' then 0 else attempt_count end where id=t.id;
  perform public.operator_audit_write('approval.'||p_decision,'succeeded',t.id,actor,'admin','approval',a.id::text,jsonb_build_object('action',a.action,'expires_at',a.expires_at));
  return jsonb_build_object('approval_id',a.id,'status',p_decision,'verified',true);
end;
$$;
revoke all on function public.operator_decide_approval(uuid,text,text) from public,anon;
grant execute on function public.operator_decide_approval(uuid,text,text) to authenticated,service_role;

create or replace function public.operator_consume_approval(p_approval uuid,p_task uuid,p_action text,p_arguments jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.operator_approval; t public.operator_task; args jsonb;
begin
  perform public.operator_require_service();
  select * into a from public.operator_approval where id=p_approval for update;
  if a.id is null or a.status<>'approved' or a.consumed_at is not null or a.expires_at<=now() or a.task_id is distinct from p_task or a.action is distinct from p_action then return false; end if;
  args:=case jsonb_typeof(a.payload->'arguments') when 'string' then (a.payload->>'arguments')::jsonb else a.payload->'arguments' end;
  if jsonb_typeof(p_arguments) is distinct from 'object' or args is distinct from p_arguments or a.payload->>'tool' is distinct from p_action then return false; end if;
  select * into t from public.operator_task where id=p_task for update;
  if t.id is null or t.status<>'running' or t.input->>'_approved_action_id' is distinct from p_approval::text then return false; end if;
  if not exists(select 1 from public.profiles where id=a.decided_by and role in ('admin','ceo') and account_status='active') then return false; end if;
  if not exists(select 1 from public.operator_tool where name=p_action and enabled) then return false; end if;
  update public.operator_approval set consumed_at=now() where id=a.id;
  perform public.operator_audit_write('approval.consumed','succeeded',p_task,a.decided_by,'admin','approval',a.id::text,jsonb_build_object('action',p_action));
  return true;
end;
$$;
revoke all on function public.operator_consume_approval(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.operator_consume_approval(uuid,uuid,text,jsonb) to service_role;
