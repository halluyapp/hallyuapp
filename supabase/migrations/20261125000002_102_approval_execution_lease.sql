-- Deployed worker transitions running -> executing. Accept both leased execution states,
-- but never consume a grant from an unleased task or a stale/expired worker.
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
  if t.id is null or t.status not in ('running','executing') or t.lease_owner is null or t.lease_expires_at is null or t.lease_expires_at<=now() or t.input->>'_approved_action_id' is distinct from p_approval::text then return false; end if;
  if not exists(select 1 from public.profiles where id=a.decided_by and role in ('admin','ceo') and account_status='active') then return false; end if;
  if not exists(select 1 from public.operator_tool where name=p_action and enabled) then return false; end if;
  update public.operator_approval set consumed_at=now() where id=a.id;
  perform public.operator_audit_write('approval.consumed','succeeded',p_task,a.decided_by,'admin','approval',a.id::text,jsonb_build_object('action',p_action));
  return true;
end;
$$;
revoke all on function public.operator_consume_approval(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.operator_consume_approval(uuid,uuid,text,jsonb) to service_role;
