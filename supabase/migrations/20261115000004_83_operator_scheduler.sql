-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 83 · 24/7 SCHEDULER
--
-- The Operator must run without a human awake. Two independent wake-up paths exist:
--
--   1. Event-driven  — `operator_capture_member_dm` / `operator_capture_mention` insert a task,
--                      and the `operator_dispatch_task` trigger POSTs to the worker function.
--   2. Time-driven   — this migration. `pg_cron` ticks once a minute, calls
--                      `operator_scheduler_sweep()`, which enqueues every due row from
--                      `operator_schedule`. The same insert trigger then wakes the worker, so the
--                      scheduler never needs its own HTTP credential — it rides the existing one.
--
-- The sweep is idempotent: each due occurrence produces at most one task, keyed by
-- `schedule:<name>:<epoch-of-next_run_at>`. Running the tick twice in the same minute is a no-op.
--
-- This replaces the retired `hallyu-ai-scheduler` edge function and its OIDC GitHub workflow.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- pg_cron is shipped with Supabase but not installed by default. It must live in `pg_catalog`
-- for the background worker to resolve `cron.schedule` reliably.
create extension if not exists pg_cron with schema pg_catalog;

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- Enqueue every schedule whose `next_run_at` has passed.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
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
    -- One task per due occurrence. The partial unique index on idempotency_key makes this safe
    -- even if two ticks overlap.
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

    -- Advance the clock regardless of whether the task was new, so a stuck schedule cannot spin.
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

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- One tick = sweep due schedules + recover tasks whose lease expired (worker died mid-run).
-- ───────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.operator_scheduler_tick()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_enqueued integer := 0;
  v_recovered integer := 0;
begin
  begin
    v_enqueued := public.operator_scheduler_sweep();
  exception when others then
    perform public.operator_audit_write(
      'scheduler.sweep', 'failed', null, null, 'system', 'schedule', null,
      jsonb_build_object('error', sqlerrm)
    );
  end;

  begin
    v_recovered := public.operator_recover_stale_tasks();
  exception when others then
    perform public.operator_audit_write(
      'scheduler.recover', 'failed', null, null, 'system', 'task', null,
      jsonb_build_object('error', sqlerrm)
    );
  end;

  return jsonb_build_object('enqueued', v_enqueued, 'recovered', v_recovered, 'at', now());
end;
$$;

revoke all on function public.operator_scheduler_sweep() from anon, authenticated;
revoke all on function public.operator_scheduler_tick() from anon, authenticated;
grant execute on function public.operator_scheduler_sweep() to service_role;
grant execute on function public.operator_scheduler_tick() to service_role;

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- Register the minute tick. `cron.schedule(name, ...)` upserts by job name, so re-running this
-- migration will not create duplicate jobs.
-- ───────────────────────────────────────────────────────────────────────────────────────────────
select cron.schedule(
  'hallyu-operator-tick',
  '* * * * *',
  $$select public.operator_scheduler_tick();$$
);

-- Baseline audit entry.
insert into public.operator_audit (actor_type, action, outcome, resource_type, details)
select 'system', 'operator.scheduler', 'succeeded', 'cron',
       jsonb_build_object('job', 'hallyu-operator-tick', 'every', '1 minute')
where not exists (
  select 1 from public.operator_audit where action = 'operator.scheduler'
);
