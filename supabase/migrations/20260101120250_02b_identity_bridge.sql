-- Reconstructed source for the live Rork identity bridge (recorded remotely as 02b).
-- The original Rork-managed file was not present in this checkout. user_id() was verified against
-- project ltyymanoidagwsapgiql on 2026-11-11. Rork subjects are opaque text, never cast to UUID.
set check_function_bodies = off;

create or replace function public.user_id()
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '{}')::jsonb ->> 'sub',
    nullif(current_setting('request.jwt.claim.sub', true), '')
  )::text;
$$;

grant execute on function public.user_id() to anon, authenticated, service_role;
reset check_function_bodies;
