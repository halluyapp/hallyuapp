-- Hallyu backend — 04 preferences, onboarding state and per-title alerts.
-- `user_preferences` mirrors `Prefs` in lib/store.tsx field for field: structured columns, no JSONB
-- blob, so the database can enforce each default. Onboarding state lives on `profiles` (see 03) and
-- is merged through the complete_onboarding RPC.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create type public.protection_level as enum ('strict', 'balanced', 'off');
create type public.autoplay_mode as enum ('always', 'wifi', 'never');

create table if not exists public.user_preferences (
  user_id              uuid primary key references public.profiles (id) on delete cascade,
  protection           public.protection_level not null default 'balanced',
  autoplay             public.autoplay_mode     not null default 'wifi',
  one_tap_reactions    boolean     not null default true,
  muted_words          text[]      not null default '{}',
  true_black           boolean     not null default false,
  personalization      boolean     not null default true,
  reduce_motion        boolean     not null default false,
  notify_episodes      boolean     not null default true,
  notify_social        boolean     not null default true,
  notify_highlights    boolean     not null default true,
  notify_system        boolean     not null default true,
  quiet_hours          boolean     not null default false,
  language             text        not null default 'en',
  guidelines_accepted  boolean     not null default false,
  guidelines_accepted_at timestamptz,
  data_saver           boolean     not null default false,
  terms_version        integer     not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint user_preferences_language_format check (language ~ '^[a-z]{2}(-[A-Za-z0-9]{2,8})?$'),
  constraint user_preferences_terms_version_non_negative check (terms_version >= 0),
  -- Accepting the guidelines must record when it happened.
  constraint user_preferences_guidelines_timestamp check (
    (guidelines_accepted and guidelines_accepted_at is not null) or (not guidelines_accepted)
  )
);

comment on table public.user_preferences is 'One row per member, created with the profile. Mirrors the client Prefs object.';

-- ---------------------------------------------------------------------------------------------
-- Per-title alerts ("notify me when this airs")
-- ---------------------------------------------------------------------------------------------

create table if not exists public.title_alerts (
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  title_id   uuid        not null references public.titles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, title_id)
);

create index if not exists title_alerts_title_idx on public.title_alerts (title_id);

-- ---------------------------------------------------------------------------------------------
-- Automatic preference row
-- ---------------------------------------------------------------------------------------------

create or replace function public.handle_new_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.user_preferences (user_id, guidelines_accepted, guidelines_accepted_at)
  values (new.id, false, null)
  on conflict (user_id) do nothing;

  -- Members who signed up with a verified email provider start from a known-good handle decision.
  return new;
end;
$$;

drop trigger if exists on_profile_created on public.profiles;
create trigger on_profile_created
  after insert on public.profiles
  for each row execute function public.handle_new_profile();

create trigger user_preferences_set_updated_at
  before update on public.user_preferences
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Row level security — a member's settings are theirs alone.
-- ---------------------------------------------------------------------------------------------

alter table public.user_preferences enable row level security;
alter table public.title_alerts enable row level security;

create policy user_preferences_owner_all on public.user_preferences
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy title_alerts_owner_all on public.title_alerts
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.user_preferences to authenticated;
grant select, insert, delete on public.title_alerts to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
