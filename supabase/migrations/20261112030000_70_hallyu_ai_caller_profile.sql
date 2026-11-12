-- Caller identity for the AI operator.
--
-- WHY: the operator is invoked from the app with a Rork-issued access token. The Supabase edge
-- gateway cannot verify those tokens (they are not signed with this project's JWT secret), so
-- `verify_jwt = true` rejects every real call before the function runs. The old function body then
-- trusted an *unsigned* `sub` claim from the Authorization header, which any caller could forge.
--
-- This RPC is the authoritative check instead: PostgREST validates the token's signature and
-- exposes its claims to SQL, so `public.user_id()` only resolves for a genuine token, and the
-- profile is only returned while the account is active. A forged or anon token resolves to nothing.
--
-- Granted to `authenticated` only: the operator calls it with the member's own Bearer credential
-- (apikey stays the service key so the request reaches PostgREST), and nothing else can use it.
set check_function_bodies = off;

create or replace function public.hallyu_ai_caller_profile()
returns table(id uuid, role text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.role
    from public.profiles p
   where p.auth_sub = public.user_id()
     and p.account_status = 'active'
   limit 1;
$$;

comment on function public.hallyu_ai_caller_profile() is
  'The active profile (id + role) for the caller''s verified token. Used by hallyu-ai-operator to resolve identity without trusting client-supplied claims; returns no row for anon, suspended or forged callers.';

revoke all on function public.hallyu_ai_caller_profile() from public;
grant execute on function public.hallyu_ai_caller_profile() to authenticated;
