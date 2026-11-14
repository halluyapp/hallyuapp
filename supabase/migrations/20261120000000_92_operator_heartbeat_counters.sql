-- The worker's health row existed but `tasks_processed` stayed at 0 and `last_error` was never
-- written, so the Control Centre could show "worker alive" and nothing about its work.
--
-- `operator_heartbeat()` now accepts the number of tasks the invocation processed and accumulates
-- it, and records the last error code/detail when one is supplied.

create or replace function public.operator_heartbeat(
  p_worker text,
  p_version text default null,
  p_meta jsonb default '{}'::jsonb,
  p_processed integer default 0,
  p_last_error text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  insert into public.operator_worker_health (worker_id, last_seen_at, version, meta, tasks_processed, last_error)
  values (p_worker, now(), p_version, coalesce(p_meta, '{}'::jsonb), greatest(coalesce(p_processed, 0), 0), p_last_error)
  on conflict (worker_id) do update
    set last_seen_at = now(),
        version = coalesce(excluded.version, public.operator_worker_health.version),
        meta = coalesce(excluded.meta, public.operator_worker_health.meta),
        tasks_processed = public.operator_worker_health.tasks_processed + greatest(coalesce(p_processed, 0), 0),
        last_error = coalesce(excluded.last_error, public.operator_worker_health.last_error);
end;
$$;
