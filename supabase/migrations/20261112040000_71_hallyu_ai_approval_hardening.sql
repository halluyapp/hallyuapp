-- Approval is fail-closed for public actions and bound to the exact proposed action.
set check_function_bodies = off;

create or replace function public.hallyu_ai_decide_approval_verified(
  p_approval uuid,
  p_approve boolean,
  p_note text default null,
  p_approver uuid default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task uuid;
begin
  if p_approver is null or not exists (
    select 1 from public.profiles
    where id = p_approver and account_status = 'active' and role in ('admin', 'ceo')
  ) then
    raise exception 'active admin or ceo role required' using errcode = '42501';
  end if;

  update public.hallyu_ai_approval
     set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = p_approver,
         decided_at = now(),
         reason = reason || coalesce(' — ' || left(btrim(p_note), 500), '')
   where id = p_approval
     and status = 'pending'
     and requested_at > now() - interval '24 hours'
   returning task_id into v_task;

  if v_task is null then
    return 'already-decided-or-expired';
  end if;
  if p_approve then
    update public.hallyu_ai_task set status = 'queued', error = null where id = v_task;
    return 'approved';
  end if;
  update public.hallyu_ai_task
     set status = 'cancelled', error = 'approval rejected by staff', finished_at = now()
   where id = v_task;
  return 'rejected';
end;
$$;

create or replace function public.hallyu_ai_claim_approval(p_task uuid, p_tool text, p_args jsonb)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  update public.hallyu_ai_approval a
     set status = 'consumed'
   where a.id = (
     select candidate.id
       from public.hallyu_ai_approval candidate
       join public.profiles approver on approver.id = candidate.decided_by
      where candidate.task_id = p_task
        and candidate.tool = p_tool
        and candidate.args = coalesce(p_args, '{}'::jsonb)
        and candidate.status = 'approved'
        and candidate.decided_at > now() - interval '24 hours'
        and approver.account_status = 'active'
        and approver.role in ('admin', 'ceo')
      order by candidate.decided_at desc
      limit 1
      for update of candidate skip locked
   )
   returning a.id into v_id;
  return v_id is not null;
end;
$$;

revoke all on function public.hallyu_ai_decide_approval_verified(uuid, boolean, text, uuid) from public, anon, authenticated;
revoke all on function public.hallyu_ai_claim_approval(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.hallyu_ai_decide_approval_verified(uuid, boolean, text, uuid) to service_role;
grant execute on function public.hallyu_ai_claim_approval(uuid, text, jsonb) to service_role;

reset check_function_bodies;


-- The operator's service-role credential cannot call the broadcast RPC directly. Its only path is
-- this atomic executor, which consumes an exact approved payload before sending.
revoke execute on function public.send_admin_broadcast(text, text, text) from service_role;

drop function if exists public.hallyu_ai_execute_broadcast(uuid, jsonb);
create function public.hallyu_ai_execute_broadcast(p_task uuid, p_args jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_title text;
  v_body text;
  v_path text;
  v_count integer;
begin
  if coalesce(auth.role(), current_setting('request.jwt.claim.role', true), current_user) <> 'service_role' then
    raise exception 'operator service role required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_args) <> 'object'
     or coalesce(p_args->>'title', '') = ''
     or coalesce(p_args->>'body', '') = ''
     or coalesce(p_args->>'path', '') = '' then
    raise exception 'complete broadcast title, body and path required' using errcode = '22023';
  end if;
  if not public.hallyu_ai_claim_approval(p_task, 'send_broadcast', p_args) then
    raise exception 'a current approval for this exact broadcast is required' using errcode = '42501';
  end if;
  v_title := left(btrim(p_args->>'title'), 120);
  v_body := left(btrim(p_args->>'body'), 500);
  v_path := left(btrim(p_args->>'path'), 500);
  select public.send_admin_broadcast(v_title, v_body, v_path) into v_count;
  return v_count;
end;
$$;

revoke all on function public.hallyu_ai_execute_broadcast(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.hallyu_ai_execute_broadcast(uuid, jsonb) to service_role;

-- Earlier onboarding steps persist preferences but must not mark a new account complete.
create or replace function public.complete_onboarding(
  p_worlds text[] default '{}',
  p_genres text[] default '{}',
  p_step integer default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  updated public.profiles%rowtype;
  unknown_world text;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  select w.id into unknown_world
    from unnest(coalesce(p_worlds, '{}')) w(id)
    left join public.worlds known on known.id = w.id
   where known.id is null
   limit 1;
  if unknown_world is not null then
    raise exception 'unknown world %', unknown_world using errcode = 'invalid_parameter_value';
  end if;
  if p_step is not null and (p_step < 0 or p_step > 20) then
    raise exception 'onboarding step out of range' using errcode = 'check_violation';
  end if;
  update public.profiles
     set worlds = coalesce(p_worlds, worlds),
         onboarding_genres = coalesce(p_genres, onboarding_genres),
         onboarding_step = coalesce(p_step, onboarding_step),
         onboarding_completed = case
           when p_step is null then onboarding_completed
           else p_step >= 5
         end
   where id = actor
  returning * into updated;
  return updated;
end;
$$;

revoke all on function public.complete_onboarding(text[], text[], integer) from public, anon;
grant execute on function public.complete_onboarding(text[], text[], integer) to authenticated;
