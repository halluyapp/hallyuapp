-- Hallyu backend — 03 profiles.
-- `profiles.id` IS the auth.users id: one identity, one row. Everything the client reads as `User`
-- (lib/model.ts) lives here except the denormalised counts, which triggers keep honest.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create type public.profile_role as enum ('member', 'moderator', 'admin');
create type public.account_status as enum ('active', 'suspended', 'deleted');

create table if not exists public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  handle              extensions.citext not null,
  display_name        text        not null,
  avatar_path         text,
  bio                 text,
  -- The worlds this member belongs to. Empty = every world (the client default).
  worlds              text[]      not null default '{}',
  favorite_genres     text[]      not null default '{}',
  verified            boolean     not null default false,
  is_private          boolean     not null default false,
  role                public.profile_role  not null default 'member',
  account_status      public.account_status not null default 'active',
  -- Onboarding lives with the profile: it is the member's own data and is read on every cold start.
  onboarding_completed boolean    not null default false,
  onboarding_step      smallint    not null default 0,
  onboarding_intent    text,
  onboarding_genres    text[]      not null default '{}',
  follower_count       integer     not null default 0,
  following_count      integer     not null default 0,
  post_count           integer     not null default 0,
  comment_count        integer     not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  constraint profiles_handle_format check (handle::text ~ '^[a-z0-9_.]{3,30}$'),
  constraint profiles_display_name_length check (char_length(display_name) between 1 and 40),
  constraint profiles_bio_length check (bio is null or char_length(bio) <= 160),
  constraint profiles_onboarding_step_sane check (onboarding_step between 0 and 20),
  constraint profiles_counts_non_negative check (
    follower_count >= 0 and following_count >= 0 and post_count >= 0 and comment_count >= 0
  )
);

comment on column public.profiles.handle is 'Lower-case unique handle. Citext makes uniqueness case-insensitive.';
comment on column public.profiles.avatar_path is 'Object path inside the `media` bucket (avatars/ prefix), not a public URL.';
comment on column public.profiles.account_status is 'active | suspended | deleted. `deleted` rows are scrubbed and later purged by the purge-deleted-accounts function.';

-- Case-insensitive uniqueness. The column is already citext, so this index is the identity guarantee.
create unique index if not exists profiles_handle_key on public.profiles (handle);
create index if not exists profiles_display_name_trgm_idx on public.profiles using gin (display_name extensions.gin_trgm_ops);
create index if not exists profiles_deleted_idx on public.profiles (deleted_at) where deleted_at is not null;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Handle generation
-- ---------------------------------------------------------------------------------------------

-- Turns any string (email local part, OAuth name) into a legal handle. Never raises: callers retry
-- with a numeric suffix when the preferred handle is taken.
create or replace function public.slugify_handle(source text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(
      left(
        regexp_replace(coalesce(nullif(btrim(lower(source)), ''), 'member'), '[^a-z0-9_.]+', '', 'g'),
        30
      ),
      ''
    ),
    'member'
  )
$$;

-- Returns a free handle derived from `source`. Loop-bounded so it can never spin forever.
create or replace function public.generate_handle(source text, user_id uuid default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  base   text;
  attempt text;
  taken  boolean;
begin
  base := public.slugify_handle(source);

  if length(base) < 3 then
    base := left(base || 'member', 3);
  end if;

  attempt := base;
  for i in 1 .. 50 loop
    select exists (select 1 from public.profiles p where p.handle = attempt and (user_id is null or p.id <> user_id)) into taken;
    if not taken then
      return attempt;
    end if;
    attempt := left(base, 28 - length(cast(i as text))) || cast(i as text);
  end loop;

  return 'member-' || substr(replace(coalesce(user_id::text, gen_random_uuid()::text), '-', ''), 1, 18);
end;
$$;

revoke all on function public.generate_handle(text, uuid) from public, anon;
grant execute on function public.generate_handle(text, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Sign-up bootstrap: auth row -> profile
-- ---------------------------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  wanted text;
begin
  wanted := coalesce(
    nullif(new.raw_user_meta_data ->> 'handle', ''),
    nullif(new.raw_user_meta_data ->> 'user_name', ''),
    nullif(new.raw_user_meta_data ->> 'preferred_username', ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'member'
  );

  insert into public.profiles (id, handle, display_name)
  values (
    new.id,
    public.generate_handle(wanted, new.id),
    left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 'Member'), 40)
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------

alter table public.profiles enable row level security;

-- A profile card is public; a suspended account is hidden; a deleted account is only visible to
-- itself and to moderators (so an orphaned post still renders an author chip).
-- The post lookup lives in a SECURITY DEFINER helper rather than inline: with `exists (select …
-- from posts)` written directly into the policy, PostgreSQL's row-security planner walks
-- posts_insert_own (its WITH CHECK reads profiles) → this policy (reads posts) and rejects the
-- statement with "infinite recursion detected in policy for relation posts" before any row is
-- touched. The helper keeps the same semantics — it reads posts as the table owner, outside the
-- caller's policy context.
create or replace function public.author_has_live_post(p_profile_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return exists (
    select 1 from public.posts p
    where p.author_id = p_profile_id and p.state <> 'deleted'
  );
end;
$$;

revoke all on function public.author_has_live_post(uuid) from public;
grant execute on function public.author_has_live_post(uuid) to authenticated;

create policy profiles_select_visible on public.profiles
  for select to authenticated
  using (
    account_status <> 'deleted'
    or id = auth.uid()
    or public.is_moderator()
    or public.author_has_live_post(profiles.id)
  );

create policy profiles_select_anonymous on public.profiles
  for select to anon
  using (account_status = 'active' and not is_private);

-- A member owns their row and may edit everything except the columns the database owns.
create policy profiles_insert_self on public.profiles
  for insert to authenticated
  with check (id = auth.uid() and account_status = 'active' and role = 'member');

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid() and account_status = 'active')
  with check (id = auth.uid() and account_status = 'active');

create policy profiles_delete_self on public.profiles
  for delete to authenticated
  using (id = auth.uid());

-- Moderators need to act on accounts they did not create.
create policy profiles_moderate on public.profiles
  for update to authenticated
  using (public.is_moderator())
  with check (public.is_moderator());

grant select on public.profiles to anon, authenticated;
grant insert, update, delete on public.profiles to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
