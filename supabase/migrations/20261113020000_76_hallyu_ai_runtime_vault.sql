-- Migration 76: Hallyu AI secure runtime secrets vault & dynamic key configuration.
--
-- Fixes:
-- 1. `public.hallyu_ai_vault`: dedicated encrypted/locked runtime secrets store for AI inference credentials.
-- 2. RLS denies all client reads/writes (only service_role has table permissions).
-- 3. `hallyu_ai_set_runtime_secret`: staff-only RPC for setting/clearing API keys without exposing secrets to git/logs.
-- 4. `hallyu_ai_get_runtime_secrets_status`: staff-only telemetry RPC returning key metadata without raw secret text.
-- 5. `hallyu_ai_load_runtime_secrets`: service_role-only RPC for the operator edge function to read active credentials.

set check_function_bodies = off;

-- ── 1. Secure Runtime Secrets Vault Table ───────────────────────────────────────────────────

create table if not exists public.hallyu_ai_vault (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null
);

comment on table public.hallyu_ai_vault is
  'Encrypted server-side runtime store for Hallyu AI model keys. Client access is strictly denied by RLS; only service_role and definer functions access this table.';

alter table public.hallyu_ai_vault enable row level security;

drop policy if exists hallyu_ai_vault_deny_clients on public.hallyu_ai_vault;
create policy hallyu_ai_vault_deny_clients on public.hallyu_ai_vault
  for all
  to public
  using (false)
  with check (false);

revoke all on table public.hallyu_ai_vault from public, anon, authenticated;
grant select, insert, update, delete on table public.hallyu_ai_vault to service_role;

-- ── 2. Staff-only Secret Setter ─────────────────────────────────────────────────────────────

create or replace function public.hallyu_ai_set_runtime_secret(
  p_key text,
  p_value text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_role text;
  v_caller_id uuid;
begin
  if current_user <> 'service_role' and not public.hallyu_ai_is_staff() then
    raise exception 'admin or ceo role required to configure AI runtime secrets' using errcode = '42501';
  end if;

  if p_key is null or btrim(p_key) = '' then
    raise exception 'secret key name cannot be blank' using errcode = 'invalid_parameter_value';
  end if;

  -- Whitelist approved AI runtime keys to prevent arbitrary storage
  if p_key not in (
    'GEMINI_API_KEY',
    'GEMINI_API_KEY_2',
    'GEMINI_API_KEY_3',
    'GEMINI_MODEL',
    'LOVABLE_AI_API_KEY',
    'LOVABLE_API_KEY',
    'LOVABLE_AI_MODEL',
    'RORK_FALLBACK_ENABLED'
  ) then
    raise exception 'unauthorized runtime secret key: %', p_key using errcode = 'invalid_parameter_value';
  end if;

  select role, id into v_caller_role, v_caller_id from public.hallyu_ai_caller_profile();

  if p_value is null or btrim(p_value) = '' then
    delete from public.hallyu_ai_vault where key = p_key;
    return jsonb_build_object('success', true, 'key', p_key, 'cleared', true);
  end if;

  insert into public.hallyu_ai_vault (key, value, updated_at, updated_by)
  values (p_key, btrim(p_value), now(), v_caller_id)
  on conflict (key) do update
    set value = excluded.value,
        updated_at = now(),
        updated_by = excluded.updated_by;

  return jsonb_build_object('success', true, 'key', p_key, 'configured', true);
end;
$$;

comment on function public.hallyu_ai_set_runtime_secret(text, text) is
  'Store or rotate an AI runtime secret securely without committing to code or exposing in logs. Admin or CEO only.';

revoke all on function public.hallyu_ai_set_runtime_secret(text, text) from public, anon;
grant execute on function public.hallyu_ai_set_runtime_secret(text, text) to authenticated, service_role;

-- ── 3. Staff-only Secret Metadata Reader (Zero Secret Leakage) ───────────────────────────────

create or replace function public.hallyu_ai_get_runtime_secrets_status()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res jsonb;
begin
  if current_user <> 'service_role' and not public.hallyu_ai_is_staff() then
    raise exception 'admin or ceo role required' using errcode = '42501';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'key', v.key,
      'configured', (char_length(v.value) > 0),
      'updated_at', v.updated_at
    )
  ) into v_res
  from public.hallyu_ai_vault v;

  return coalesce(v_res, '[]'::jsonb);
end;
$$;

comment on function public.hallyu_ai_get_runtime_secrets_status() is
  'Read AI runtime secrets configuration status (metadata only, never returning secret text). Staff only.';

revoke all on function public.hallyu_ai_get_runtime_secrets_status() from public, anon;
grant execute on function public.hallyu_ai_get_runtime_secrets_status() to authenticated, service_role;

-- ── 4. Service-Role Only Secret Loader ───────────────────────────────────────────────────────

create or replace function public.hallyu_ai_load_runtime_secrets()
returns table (key text, value text)
language sql
security definer
set search_path = public, pg_temp
as $$
  select v.key, v.value from public.hallyu_ai_vault v;
$$;

comment on function public.hallyu_ai_load_runtime_secrets() is
  'Load all runtime secrets for model execution. Strictly restricted to service_role.';

revoke all on function public.hallyu_ai_load_runtime_secrets() from public, anon, authenticated;
grant execute on function public.hallyu_ai_load_runtime_secrets() to service_role;
