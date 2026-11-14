-- 78: remove the Hallyu AI Operator (bot) entirely.
--
-- The operator feature (tables, RPCs, triggers, scheduler and the official AI author profile) is
-- being retired. Fresh databases no longer create any of it because the operator migrations were
-- removed; this migration cleans up databases that already applied them.
--
-- Everything here is idempotent: `if exists` / catalogue checks mean it is safe to run whether or
-- not the operator was ever installed.

set check_function_bodies = off;

-- ── 1. Event triggers on member tables ──────────────────────────────────────────────────────────
-- These fired on new comments/DMs to enqueue operator work. Drop them explicitly before the
-- functions so no trigger is left pointing at a function that is about to disappear.
drop trigger if exists hallyu_ai_comment_event on public.comments;
drop trigger if exists hallyu_ai_dm_event on public.direct_messages;

-- ── 2. Every operator function / RPC ───────────────────────────────────────────────────────────
-- Drop by resolved signature so all overloads are covered without hard-coding argument lists.
-- The signature comes from the catalogue (never user input), so splicing it into the statement is
-- safe; CASCADE also removes any remaining trigger or policy that depends on these functions.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'hallyu\_ai\_%'
  loop
    execute 'drop function if exists ' || r.signature::text || ' cascade';
  end loop;
end;
$$;

-- ── 3. Operator state tables ───────────────────────────────────────────────────────────────────
-- Publication references task, so CASCADE keeps the drop order irrelevant.
drop table if exists public.hallyu_ai_publication cascade;
drop table if exists public.hallyu_ai_tool_call cascade;
drop table if exists public.hallyu_ai_approval cascade;
drop table if exists public.hallyu_ai_event cascade;
drop table if exists public.hallyu_ai_schedule cascade;
drop table if exists public.hallyu_ai_memory cascade;
drop table if exists public.hallyu_ai_task cascade;
drop table if exists public.hallyu_ai_vault cascade;

-- ── 4. The official AI author profile and its content ─────────────────────────────────────────
-- The operator published posts/comments/polls as a `profiles.is_ai = true` account. Remove that
-- account; posts and comments cascade from profiles, so its content goes with it. The column is
-- only present on databases that ran the operator migrations, so guard on its existence.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'is_ai'
  ) then
    -- moderation_actions.actor_id is ON DELETE RESTRICT, so skip any AI profile that somehow
    -- performed a moderation action rather than failing the whole migration on that edge case.
    delete from public.profiles p
     where p.is_ai
       and not exists (
         select 1 from public.moderation_actions ma where ma.actor_id = p.id
       );

    if exists (select 1 from public.profiles where is_ai) then
      raise notice 'hallyu_ai: an AI profile with moderation history was left in place';
    end if;
  end if;
end;
$$;

reset check_function_bodies;
