-- Two silent failures found while verifying the operator's own reporting:
--
-- 1. Tasks that entered `retrying` were never woken again. `operator_redispatch_queued()` only
--    looked at `status = 'queued'`, so a retry whose wake-up was lost (or that was scheduled with
--    backoff) stayed `retrying` forever. Eleven moderation_sweep tasks were in exactly that state.
-- 2. `operator_provider_usage` rejected every write: the table only accepts
--    succeeded/failed/rejected/timeout, and the worker was sending `success`, so the ledger stayed
--    empty and provider health never updated. The worker side of that is fixed in the same commit.
--
-- The redispatch function now also picks up due retries and returns them to `queued` before posting
-- the wake-up.

create or replace function public.operator_redispatch_queued(p_limit integer default 5)
returns integer
language plpgsql
security definer
set search_path to 'public', 'vault', 'net', 'pg_temp'
as $$
declare
  v_token text;
  v_task record;
  v_count integer := 0;
begin
  select decrypted_secret into v_token from vault.decrypted_secrets
   where name in ('operator_worker_token', 'hallyu_operator_worker_token') limit 1;
  if v_token is null then return 0; end if;

  for v_task in
    select id, status from public.operator_task
     where lease_owner is null
       and (
         (status = 'queued' and created_at < now() - interval '2 minutes')
         or (status = 'retrying' and available_at <= now())
       )
     order by coalesce(available_at, created_at)
     limit greatest(1, least(coalesce(p_limit, 5), 20))
  loop
    begin
      if v_task.status = 'retrying' then
        update public.operator_task
           set status = 'queued', lease_owner = null
         where id = v_task.id;
      end if;

      perform net.http_post(
        url := 'https://ltyymanoidagwsapgiql.supabase.co/functions/v1/operator-worker',
        body := jsonb_build_object('task_id', v_task.id),
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_token),
        timeout_milliseconds := 5000);
      v_count := v_count + 1;
    exception when others then
      perform public.operator_audit_write('worker.redispatch','failed', v_task.id, null, 'system','task', v_task.id::text, jsonb_build_object('reason', sqlerrm));
    end;
  end loop;
  return v_count;
end;
$$;
