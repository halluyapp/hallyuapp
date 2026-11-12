-- Hallyu AI operator: durable state for the autonomous AI executive (HALLYU_AI_PROJECT.md).
--
-- Access model: every table enables RLS with NO policies — no client, not even an admin, touches
-- these tables directly. The hallyu-ai-operator edge function runs as service_role and mediates
-- every read/write after re-verifying the caller's live profiles.role. Admin surfaces read
-- through the security definer RPCs at the bottom, which re-check the admin/ceo role server-side,
-- matching the platform's existing authorization model (profiles.role, profiles.account_status).
--
-- Honest-state rule: tasks record failures in `error`, tool calls record their real outcome, and
-- nothing here is ever marked delivered/completed by anything other than the operator function.

set check_function_bodies = off;

-- ── core tables ────────────────────────────────────────────────────────────────────────────────

create table if not exists public.hallyu_ai_task (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'chat',           -- chat | research | content | campaign | digest | ops
  status text not null default 'queued',       -- queued | running | awaiting_approval | completed | failed | cancelled
  title text not null default 'Untitled task',
  prompt text not null,
  requester_profile_id uuid references public.profiles (id) on delete set null,
  requester_role text,                         -- snapshot of profiles.role at request time
  plan jsonb not null default '[]'::jsonb,     -- the operator's declared step list
  result jsonb,                                -- final structured answer / report
  error text,
  model text,                                  -- model id that ran the task
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.hallyu_ai_tool_call (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.hallyu_ai_task (id) on delete cascade,
  seq int not null,
  tool text not null,
  args jsonb not null default '{}'::jsonb,
  result jsonb,
  status text not null default 'ok',           -- ok | error | denied | awaiting_approval
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.hallyu_ai_approval (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.hallyu_ai_task (id) on delete cascade,
  tool text not null,
  args jsonb not null default '{}'::jsonb,
  reason text not null,                        -- why the operator needs this action
  status text not null default 'pending',      -- pending | approved | rejected
  requested_at timestamptz not null default now(),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz
);

create table if not exists public.hallyu_ai_schedule (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kind text not null,                          -- daily_intelligence | community_pulse | growth_watch | ops_watch
  interval_minutes int not null default 1440,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  last_run_at timestamptz,
  last_status text,
  created_at timestamptz not null default now()
);

create table if not exists public.hallyu_ai_memory (
  kind text not null,                          -- decision | campaign_outcome | pattern | note
  key text not null,
  value jsonb not null,
  task_id uuid references public.hallyu_ai_task (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (kind, key)
);

-- ── bookkeeping ────────────────────────────────────────────────────────────────────────────────

create or replace function public.hallyu_ai_touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists hallyu_ai_task_touch on public.hallyu_ai_task;
create trigger hallyu_ai_task_touch
before update on public.hallyu_ai_task
for each row execute function public.hallyu_ai_touch_updated_at();

-- ── lockdown: service_role only ────────────────────────────────────────────────────────────────

alter table public.hallyu_ai_task enable row level security;
alter table public.hallyu_ai_tool_call enable row level security;
alter table public.hallyu_ai_approval enable row level security;
alter table public.hallyu_ai_schedule enable row level security;
alter table public.hallyu_ai_memory enable row level security;

revoke all on public.hallyu_ai_task from anon, authenticated;
revoke all on public.hallyu_ai_tool_call from anon, authenticated;
revoke all on public.hallyu_ai_approval from anon, authenticated;
revoke all on public.hallyu_ai_schedule from anon, authenticated;
revoke all on public.hallyu_ai_memory from anon, authenticated;

-- ── admin read/decide surface (re-checks the live role on every call) ─────────────────────────

create or replace function public.hallyu_ai_is_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles
    where id = public.current_profile_id()
      and account_status = 'active'
      and role in ('admin', 'ceo')
  );
$$;

revoke all on function public.hallyu_ai_is_staff() from public, anon;

create or replace function public.hallyu_ai_admin_tasks(p_limit int default 50)
returns setof public.hallyu_ai_task
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.*
  from public.hallyu_ai_task t
  where public.hallyu_ai_is_staff()
  order by t.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

create or replace function public.hallyu_ai_admin_approvals()
returns setof public.hallyu_ai_approval
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.*
  from public.hallyu_ai_approval a
  where a.status = 'pending'
    and public.hallyu_ai_is_staff()
  order by a.requested_at asc;
$$;

-- Approve/reject an operator request. An approval returns the task to the queue so the operator
-- resumes its plan; a rejection closes it honestly as cancelled.
create or replace function public.hallyu_ai_decide_approval(p_approval uuid, p_approve boolean, p_note text default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task uuid;
begin
  if not public.hallyu_ai_is_staff() then
    raise exception 'admin or ceo role required' using errcode = '42501';
  end if;
  update public.hallyu_ai_approval
  set status = case when p_approve then 'approved' else 'rejected' end,
      decided_by = public.current_profile_id(),
      decided_at = now(),
      reason = reason || coalesce(' — ' || btrim(p_note), '')
  where id = p_approval and status = 'pending'
  returning task_id into v_task;
  if v_task is null then
    return 'already-decided';
  end if;
  if p_approve then
    update public.hallyu_ai_task set status = 'queued', error = null where id = v_task;
  else
    update public.hallyu_ai_task
    set status = 'cancelled', error = 'approval rejected by staff', finished_at = now()
    where id = v_task;
  end if;
  return case when p_approve then 'approved' else 'rejected' end;
end;
$$;

revoke all on function public.hallyu_ai_admin_tasks(int) from public, anon;
revoke all on function public.hallyu_ai_admin_approvals() from public, anon;
revoke all on function public.hallyu_ai_decide_approval(uuid, boolean, text) from public, anon;
grant execute on function public.hallyu_ai_admin_tasks(int) to authenticated;
grant execute on function public.hallyu_ai_admin_approvals() to authenticated;
grant execute on function public.hallyu_ai_decide_approval(uuid, boolean, text) to authenticated;
