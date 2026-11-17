-- Voice ledger stores usage, not audio or transcript. Forward-only and independent of legacy voice tables.
create table public.operator_voice_request (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.profiles(id) on delete cascade,
  action text not null check (action in ('transcribe','synthesize')),
  model text not null,
  outcome text not null default 'reserved' check (outcome in ('reserved','succeeded','failed')),
  usage jsonb,
  error_code text,
  created_at timestamptz not null default now()
);
create index operator_voice_request_actor_time on public.operator_voice_request(actor_id, created_at desc);
alter table public.operator_voice_request enable row level security;
revoke all on public.operator_voice_request from anon, authenticated;
grant select, insert, update on public.operator_voice_request to service_role;
create policy operator_voice_request_admin_read on public.operator_voice_request for select to authenticated using (public.is_admin());
grant select on public.operator_voice_request to authenticated;

-- Serialize reservations globally to enforce both per-user and total limits under concurrency.
-- Failed and abandoned reservations still count: retries cannot bypass spend limits.
create or replace function public.operator_voice_reserve(p_actor uuid, p_action text, p_model text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('operator_voice_budget', 0));
  if not exists (select 1 from public.profiles where id = p_actor and account_status = 'active') then
    raise exception 'voice_access_denied';
  end if;
  if (select count(*) from public.operator_voice_request where actor_id = p_actor and created_at > now() - interval '1 minute') >= 6
     or (select count(*) from public.operator_voice_request where actor_id = p_actor and created_at > now() - interval '24 hours') >= 100
     or (select count(*) from public.operator_voice_request where created_at > now() - interval '24 hours') >= 1000 then
    raise exception 'voice_limit_exceeded';
  end if;
  insert into public.operator_voice_request(actor_id, action, model) values (p_actor, p_action, p_model) returning id into v_id;
  return v_id;
end; $$;
revoke all on function public.operator_voice_reserve(uuid,text,text) from public, anon, authenticated;
grant execute on function public.operator_voice_reserve(uuid,text,text) to service_role;
