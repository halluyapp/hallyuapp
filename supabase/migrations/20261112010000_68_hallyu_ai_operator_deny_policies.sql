-- Migration 67 enabled row level security on the `hallyu_ai_*` operator tables but shipped no
-- policy, relying on "RLS on + no policy = deny all". That is the intended access model (only the
-- service-role edge function and the SECURITY DEFINER admin RPCs may touch these tables), but the
-- repository gate `scripts/verify-sql.mjs` requires every RLS table to carry an explicit policy.
--
-- This migration states the deny-all rule in SQL instead of implying it: the same guarantee, now
-- visible and enforced by policy. Nothing grants a client read or write access, and the exact same
-- `for all … using (false) with check (false)` shape is already used for `public.ci_build_vault`.

set check_function_bodies = off;

drop policy if exists hallyu_ai_task_deny_clients on public.hallyu_ai_task;
create policy hallyu_ai_task_deny_clients on public.hallyu_ai_task
  for all
  using (false)
  with check (false);

drop policy if exists hallyu_ai_tool_call_deny_clients on public.hallyu_ai_tool_call;
create policy hallyu_ai_tool_call_deny_clients on public.hallyu_ai_tool_call
  for all
  using (false)
  with check (false);

drop policy if exists hallyu_ai_approval_deny_clients on public.hallyu_ai_approval;
create policy hallyu_ai_approval_deny_clients on public.hallyu_ai_approval
  for all
  using (false)
  with check (false);

drop policy if exists hallyu_ai_schedule_deny_clients on public.hallyu_ai_schedule;
create policy hallyu_ai_schedule_deny_clients on public.hallyu_ai_schedule
  for all
  using (false)
  with check (false);

drop policy if exists hallyu_ai_memory_deny_clients on public.hallyu_ai_memory;
create policy hallyu_ai_memory_deny_clients on public.hallyu_ai_memory
  for all
  using (false)
  with check (false);

-- Identity helper used by the operator's first lookup hop. Migration 67 shipped the edge function
-- calling `hallyu_ai_profile_by_sub` but never created it, so every request silently fell through to
-- a direct `profiles` read. Creating it removes that dead hop; service_role only, because it resolves
-- an arbitrary auth subject to a profile.
create or replace function public.hallyu_ai_profile_by_sub(p_sub text)
returns table (id uuid, role text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.role
  from public.profiles p
  where p.auth_sub = p_sub
    and p.account_status = 'active'
  limit 1;
$$;

revoke all on function public.hallyu_ai_profile_by_sub(text) from public, anon, authenticated;
grant execute on function public.hallyu_ai_profile_by_sub(text) to service_role;

reset check_function_bodies;
