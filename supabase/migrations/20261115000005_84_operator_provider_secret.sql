-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 84 · PROVIDER CREDENTIAL BRIDGE
--
-- The two provider API keys are server-side secrets. They are stored in Supabase Vault (never in
-- this repository, never in a client bundle). This function is the only way the worker can read
-- one, and it is executable by `service_role` only. It resolves exactly the provider it is asked
-- for — there is no list, no fallback, and no way to enumerate the other key.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.operator_provider_secret(p_provider text)
returns text
language plpgsql
security definer
set search_path to 'public', 'vault', 'pg_temp'
as $$
declare
  v_secret text;
begin
  if p_provider is null or p_provider not in ('apinex', 'coarena') then
    return null;
  end if;

  select decrypted_secret
    into v_secret
    from vault.decrypted_secrets
   where name = 'operator_provider_' || p_provider || '_key'
   limit 1;

  return v_secret;
end;
$$;

revoke all on function public.operator_provider_secret(text) from anon, authenticated, public;
grant execute on function public.operator_provider_secret(text) to service_role;
