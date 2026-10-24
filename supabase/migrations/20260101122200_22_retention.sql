-- Hallyu backend — 22 retention.
-- delete_account() leaves an anonymous tombstone so replies and posts never dangle. This migration
-- adds the retention job that hard-deletes those tombstones (and their storage objects) once the
-- product's deletion window has passed, plus the cron wiring for the Edge Function that calls it.

-- Hard purge for accounts deleted more than `retention` ago. Never callable by a client: the only
-- roles allowed are service_role (the Edge Function) and postgres.
--
-- `drop function` first: a later migration changes this function's RETURNS TABLE shape, and
-- PostgreSQL refuses to redefine a function whose row type has changed (42P13). Dropping here is what
-- makes the whole set re-appliable over a project that was provisioned from a newer or older branch —
-- the live project cannot be rebuilt from scratch, it is brought forward file by file.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

drop function if exists public.purge_deleted_accounts(interval);

create or replace function public.purge_deleted_accounts(retention interval default interval '30 days')
returns table (profiles_purged integer, storage_objects_removed integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cutoff timestamptz := now() - retention;
  doomed uuid[];
  paths text[];
  removed integer := 0;
begin
  if auth.role() not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'retention purge is service-role only' using errcode = 'insufficient_privilege';
  end if;

  select coalesce(array_agg(p.id), '{}') into doomed
  from public.profiles p
  where p.account_status = 'deleted'
    and p.deleted_at is not null
    and p.deleted_at < cutoff;

  if array_length(doomed, 1) is null then
    return query select 0, 0;
    return;
  end if;

  select coalesce(array_agg(name), '{}') into paths
  from storage.objects
  where bucket_id = 'media' and public.storage_owner(name) = any(doomed);

  if array_length(paths, 1) is not null then
    delete from storage.objects where bucket_id = 'media' and name = any(paths);
    get diagnostics removed = row_count;
  end if;

  -- Cascades clear the member's posts, comments, reactions and everything else that points at them.
  delete from public.profiles where id = any(doomed);

  return query select array_length(doomed, 1), removed;
end;
$$;

revoke all on function public.purge_deleted_accounts(interval) from public, anon, authenticated;
grant execute on function public.purge_deleted_accounts(interval) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Scheduled invocation of the purge Edge Function
-- ---------------------------------------------------------------------------------------------

-- The Edge Function runs with the service role, so the schedule needs the project URL and a Vault
-- secret for the function JWT. Both are placeholders: set them once per project, then apply this
-- schedule (it is intentionally left commented out so a fresh clone never schedules a job against
-- credentials that do not exist yet).
--
--   select vault.create_secret('<project-url>', 'hallyu_project_url', 'Hallyu Supabase project URL');
--   select vault.create_secret('<anon-key>',     'hallyu_anon_key',    'Kicks the function with a signed JWT');
--
--   select cron.schedule(
--     'hallyu-purge-deleted-accounts',
--     '17 4 * * *',                                    -- 04:17 UTC daily
--     $$
--     select net.http_post(
--       url      := (select decrypted_secret from vault.decrypted_secrets where name = 'hallyu_project_url')
--                   || '/functions/v1/purge-deleted-accounts',
--       headers  := jsonb_build_object(
--                     'Content-Type', 'application/json',
--                     'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'hallyu_anon_key')
--                   ),
--       body     := jsonb_build_object('retention_days', 30)
--     );
--     $$
--   );
--
-- Requires `pg_cron` and `pg_net` (both available on Supabase projects; enable them in Dashboard →
-- Database → Extensions if they are not already on).

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
