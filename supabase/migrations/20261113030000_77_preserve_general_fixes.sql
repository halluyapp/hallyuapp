-- 77: preserve two general product fixes that were originally bundled into the retired Hallyu AI
-- Operator migrations. Neither has anything to do with the bot; they are kept so removing the
-- operator does not regress onboarding or direct messages.
--
--   * complete_onboarding: earlier steps must persist preferences without marking a brand-new
--     account complete. (Originally shipped in migration 71.)
--   * direct_messages structured content: message_type + rich_content, additive and backward
--     compatible. (Originally shipped in migration 74.)

set check_function_bodies = off;

-- ── onboarding completion only at the final step ───────────────────────────────────────────────
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

-- ── structured direct messages (additive, backward compatible) ─────────────────────────────────
alter table public.direct_messages add column if not exists message_type text not null default 'text';
alter table public.direct_messages add column if not exists rich_content jsonb;

reset check_function_bodies;
