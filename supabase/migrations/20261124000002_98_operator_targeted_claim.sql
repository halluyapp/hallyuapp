-- Wake signals include a task ID. Honor it atomically so unrelated queued work cannot take the
-- place of an explicitly requested conversation task. Existing generic queue claiming remains.
create or replace function public.operator_claim_task_by_id(p_worker text,p_task uuid)
returns setof public.operator_task language plpgsql security definer set search_path = public,pg_temp as $$
begin
  return query with claimed as (
    select t.id from public.operator_task t
    where t.id=p_task and t.status in ('queued','retrying') and t.available_at<=now()
      and t.attempt_count<t.max_attempts
    for update skip locked
  ) update public.operator_task t set status='running',lease_owner=p_worker,
    lease_expires_at=now()+interval '120 seconds',attempt_count=t.attempt_count+1,
    started_at=coalesce(t.started_at,now()),updated_at=now()
    where t.id in (select id from claimed) returning t.*;
end; $$;
revoke all on function public.operator_claim_task_by_id(text,uuid) from public,anon,authenticated;
grant execute on function public.operator_claim_task_by_id(text,uuid) to service_role;

-- Release-test ledger: no passwords, tokens or real member content. Used only by the temporary
-- worker-token-protected acceptance function; ledger remains as audit evidence after its removal.
create table public.operator_acceptance_run (
  id uuid primary key,
  state text not null check(state in ('running','finished','failed')),
  fixture_user_ids uuid[] not null default '{}',
  report jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
alter table public.operator_acceptance_run enable row level security;
revoke all on public.operator_acceptance_run from anon,authenticated;
grant all on public.operator_acceptance_run to service_role;
create policy operator_acceptance_run_admin_read on public.operator_acceptance_run for select to authenticated using(public.is_admin());
grant select on public.operator_acceptance_run to authenticated;
