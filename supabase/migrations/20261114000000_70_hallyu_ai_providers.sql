-- Hallyu AI provider configurations and usage tracking.
-- Multi-provider support: Gemini, OpenAI-compatible, Anthropic-compatible adapters.
--
-- Access model: service_role only. The admin console reads through security-definer RPCs.
-- API keys are encrypted at rest and never returned to the client.

create table if not exists public.hallyu_ai_provider_configs (
  id uuid primary key default gen_random_uuid(),
  name text not null,                                 -- 'gemini', 'openai', 'anthropic', 'rork'
  provider_type text not null check (provider_type in ('gemini','openai','anthropic','rork')),
  endpoint text not null,                             -- provider API base URL
  api_key_encrypted text not null,                    -- encrypted server-side secret
  model text not null,                                -- default model for this provider
  auth_method text not null default 'bearer',         -- 'bearer' | 'api_key' | 'custom'
  enabled boolean not null default true,
  priority integer not null default 100,              -- lower = tried first
  cooldown_until timestamptz,                         -- set after repeated failures
  rate_limit_remaining integer,                       -- last observed remaining quota
  rate_limit_resets_at timestamptz,                   -- when quota resets
  last_successful_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  total_requests integer not null default 0,
  total_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hallyu_ai_provider_configs_enabled_priority_idx
  on public.hallyu_ai_provider_configs (enabled, priority);

alter table public.hallyu_ai_provider_configs enable row level security;
revoke all on public.hallyu_ai_provider_configs from anon, authenticated;
create policy hallyu_ai_provider_configs_no_direct_access on public.hallyu_ai_provider_configs
  for all to public using (false) with check (false);

-- Usage tracking per provider per day.
create table if not exists public.hallyu_ai_provider_usage (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.hallyu_ai_provider_configs (id) on delete cascade,
  provider_name text not null,
  model text not null,
  request_date date not null default current_date,
  requests_count integer not null default 0,
  failures_count integer not null default 0,
  total_tokens_in integer not null default 0,
  total_tokens_out integer not null default 0,
  avg_latency_ms double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, request_date)
);

create index if not exists hallyu_ai_provider_usage_date_idx
  on public.hallyu_ai_provider_usage (request_date desc);

alter table public.hallyu_ai_provider_usage enable row level security;
revoke all on public.hallyu_ai_provider_usage from anon, authenticated;
create policy hallyu_ai_provider_usage_no_direct_access on public.hallyu_ai_provider_usage
  for all to public using (false) with check (false);

-- Central AI identity uses hallyu_ai_profile_id() from migration 68.
-- Admin read: provider configs without the encrypted key.
create or replace function public.hallyu_ai_admin_provider_configs()
returns table (
  id uuid,
  name text,
  provider_type text,
  endpoint text,
  model text,
  auth_method text,
  enabled boolean,
  priority integer,
  cooldown_until timestamptz,
  rate_limit_remaining integer,
  rate_limit_resets_at timestamptz,
  last_successful_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  total_requests integer,
  total_failures integer,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    id, name, provider_type, endpoint, model, auth_method, enabled, priority,
    cooldown_until, rate_limit_remaining, rate_limit_resets_at,
    last_successful_at, last_error, last_error_at,
    total_requests, total_failures, created_at, updated_at
  from public.hallyu_ai_provider_configs
  where public.hallyu_ai_is_staff()
  order by priority, created_at;
$$;

revoke all on function public.hallyu_ai_admin_provider_configs() from public, anon;
grant execute on function public.hallyu_ai_admin_provider_configs() to authenticated;

-- Admin read: provider usage stats.
create or replace function public.hallyu_ai_admin_provider_usage(p_limit integer default 100)
returns table (
  id uuid,
  provider_id uuid,
  provider_name text,
  model text,
  request_date date,
  requests_count integer,
  failures_count integer,
  total_tokens_in integer,
  total_tokens_out integer,
  avg_latency_ms double precision,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    id, provider_id, provider_name, model, request_date, requests_count,
    failures_count, total_tokens_in, total_tokens_out, avg_latency_ms,
    created_at, updated_at
  from public.hallyu_ai_provider_usage
  where public.hallyu_ai_is_staff()
  order by request_date desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

revoke all on function public.hallyu_ai_admin_provider_usage(integer) from public, anon;
grant execute on function public.hallyu_ai_admin_provider_usage(integer) to authenticated;

-- Admin: upsert a provider config (encrypted key stored server-side only).
create or replace function public.hallyu_ai_admin_upsert_provider(
  p_id uuid default null,
  p_name text,
  p_provider_type text,
  p_endpoint text,
  p_api_key text,
  p_model text,
  p_auth_method text default 'bearer',
  p_enabled boolean default true,
  p_priority integer default 100
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.hallyu_ai_is_staff() then
    raise exception 'admin or ceo role required' using errcode = '42501';
  end if;

  if p_id is not null then
    update public.hallyu_ai_provider_configs
    set name = p_name,
        provider_type = p_provider_type,
        endpoint = p_endpoint,
        api_key_encrypted = case when p_api_key is not null then p_api_key else api_key_encrypted end,
        model = p_model,
        auth_method = p_auth_method,
        enabled = p_enabled,
        priority = p_priority,
        updated_at = now()
    where id = p_id
    returning id into v_id;
  else
    insert into public.hallyu_ai_provider_configs (
      name, provider_type, endpoint, api_key_encrypted, model,
      auth_method, enabled, priority
    ) values (
      p_name, p_provider_type, p_endpoint, p_api_key, p_model,
      p_auth_method, p_enabled, p_priority
    ) returning id into v_id;
  end if;

  return v_id;
end;
$$;

revoke all on function public.hallyu_ai_admin_upsert_provider(uuid,text,text,text,text,text,text,boolean,integer) from public, anon;
grant execute on function public.hallyu_ai_admin_upsert_provider(uuid,text,text,text,text,text,text,boolean,integer) to authenticated;

-- Admin: delete a provider config.
create or replace function public.hallyu_ai_admin_delete_provider(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.hallyu_ai_is_staff() then
    raise exception 'admin or ceo role required' using errcode = '42501';
  end if;

  delete from public.hallyu_ai_provider_configs where id = p_id;
  return true;
end;
$$;

revoke all on function public.hallyu_ai_admin_delete_provider(uuid) from public, anon;
grant execute on function public.hallyu_ai_admin_delete_provider(uuid) to authenticated;

-- Admin: record usage statistics.
create or replace function public.hallyu_ai_record_provider_usage(
  p_provider_id uuid,
  p_provider_name text,
  p_model text,
  p_success boolean,
  p_tokens_in integer default 0,
  p_tokens_out integer default 0,
  p_latency_ms double precision default null,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_date date := current_date;
begin
  insert into public.hallyu_ai_provider_usage (
    provider_id, provider_name, model, request_date,
    requests_count, failures_count, total_tokens_in, total_tokens_out,
    avg_latency_ms, created_at, updated_at
  ) values (
    p_provider_id, p_provider_name, p_model, v_date,
    1, case when p_success then 0 else 1 end,
    p_tokens_in, p_tokens_out, p_latency_ms, now(), now()
  )
  on conflict (provider_id, request_date) do update set
    requests_count = hallyu_ai_provider_usage.requests_count + 1,
    failures_count = hallyu_ai_provider_usage.failures_count + case when p_success then 0 else 1 end,
    total_tokens_in = hallyu_ai_provider_usage.total_tokens_in + p_tokens_in,
    total_tokens_out = hallyu_ai_provider_usage.total_tokens_out + p_tokens_out,
    avg_latency_ms = case
      when hallyu_ai_provider_usage.avg_latency_ms is null then p_latency_ms
      when p_latency_ms is null then hallyu_ai_provider_usage.avg_latency_ms
      else (hallyu_ai_provider_usage.avg_latency_ms + p_latency_ms) / 2
    end,
    updated_at = now();

  update public.hallyu_ai_provider_configs
  set total_requests = total_requests + 1,
      total_failures = total_failures + case when p_success then 0 else 1 end,
      last_successful_at = case when p_success then now() else last_successful_at end,
      last_error = case when p_success then null else p_error end,
      last_error_at = case when p_success then null else now() end,
      updated_at = now()
  where id = p_provider_id;
end;
$$;

revoke all on function public.hallyu_ai_record_provider_usage(uuid,text,text,boolean,integer,integer,double precision,text) from public, anon, authenticated;
grant execute on function public.hallyu_ai_record_provider_usage(uuid,text,text,boolean,integer,integer,double precision,text) to service_role;

-- Default: seed a Gemini provider row if none exist (disabled until key configured).
insert into public.hallyu_ai_provider_configs (name, provider_type, endpoint, api_key_encrypted, model, auth_method, enabled, priority)
select 'Gemini (configure key)', 'gemini', 'https://generativelanguage.googleapis.com/v1beta', '', 'gemini-1.5-pro', 'bearer', false, 10
where not exists (select 1 from public.hallyu_ai_provider_configs);

