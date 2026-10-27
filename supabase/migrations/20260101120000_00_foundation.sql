-- Hallyu backend — 00 foundation.
-- Extensions, shared trigger helpers and the timestamp trigger every mutable table reuses.
-- This migration is safe on a fresh Supabase project and idempotent.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- gen_random_uuid() lives in pg_catalog on PG13+, but Supabase images keep pgcrypto in `extensions`.
-- Search-path includes both so every migration below can call it unqualified.
alter database postgres set search_path to public, extensions, pg_temp;

-- ---------------------------------------------------------------------------------------------
-- Shared triggers
-- ---------------------------------------------------------------------------------------------

-- Every table with an updated_at column uses this instead of repeating the same body.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is 'BEFORE UPDATE trigger that stamps updated_at = now().';

-- Moderator/admin check used by moderation policies and moderation-only RPCs.
-- SECURITY DEFINER so the policy does not recurse through profiles' own RLS.
create or replace function public.is_moderator()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('moderator', 'admin')
      and p.account_status = 'active'
  );
$$;

revoke all on function public.is_moderator() from public;
grant execute on function public.is_moderator() to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
