-- Hallyu backend — 07 communities (fandom rooms).
-- The social half of a world: a K-Drama room, an anime room, a movie-night room. Posts can be pinned
-- to a community instead of (or as well as) a title.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create table if not exists public.communities (
  id           uuid primary key default gen_random_uuid(),
  name         text        not null,
  fandom       text        not null references public.worlds (id) on delete restrict,
  description  text        not null default '',
  cover_tone   text        not null default '#1C1B1F',
  cover_url    text,
  drama_id     uuid        references public.titles (id) on delete set null,
  is_official  boolean     not null default false,
  member_count integer     not null default 0,
  post_count   integer     not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint communities_name_length check (char_length(btrim(name)) between 1 and 60),
  constraint communities_description_length check (char_length(description) <= 240),
  constraint communities_counts_non_negative check (member_count >= 0 and post_count >= 0)
);

comment on table public.communities is 'Fandom rooms. fandom is the world; drama_id optionally anchors a room to one title.';

create index if not exists communities_fandom_idx on public.communities (fandom, created_at desc);
create unique index if not exists communities_official_per_world on public.communities (fandom) where is_official;

create table if not exists public.community_members (
  community_id uuid        not null references public.communities (id) on delete cascade,
  user_id      uuid        not null references public.profiles (id) on delete cascade,
  role         text        not null default 'member',
  created_at   timestamptz not null default now(),
  primary key (community_id, user_id),
  constraint community_members_role_known check (role in ('member', 'moderator'))
);

comment on table public.community_members is 'Room membership. Moderators of a room are the community role, not the global profile role.';

create index if not exists community_members_user_idx on public.community_members (user_id);

create trigger communities_set_updated_at
  before update on public.communities
  for each row execute function public.set_updated_at();

create or replace function public.handle_community_member_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.communities set member_count = member_count + 1 where id = new.community_id;
    return new;
  end if;
  update public.communities set member_count = greatest(0, member_count - 1) where id = old.community_id;
  return old;
end;
$$;

create trigger community_members_count_insert after insert on public.community_members for each row execute function public.handle_community_member_count();
create trigger community_members_count_delete after delete on public.community_members for each row execute function public.handle_community_member_count();

-- ---------------------------------------------------------------------------------------------
-- Row level security — rooms are public surfaces; membership rows are private.
-- ---------------------------------------------------------------------------------------------

alter table public.communities enable row level security;
alter table public.community_members enable row level security;

create policy communities_select_all on public.communities for select to anon, authenticated using (true);
create policy communities_staff_all on public.communities
  for all to authenticated
  using (public.is_moderator() or exists (select 1 from public.community_members m where m.community_id = communities.id and m.user_id = auth.uid() and m.role = 'moderator'))
  with check (public.is_moderator() or exists (select 1 from public.community_members m where m.community_id = communities.id and m.user_id = auth.uid() and m.role = 'moderator'));

create policy community_members_select_visible on public.community_members
  for select to authenticated
  using (user_id = auth.uid() or public.is_moderator());

create policy community_members_self_insert on public.community_members
  for insert to authenticated
  with check (user_id = auth.uid() and role = 'member');

create policy community_members_self_delete on public.community_members
  for delete to authenticated
  using (user_id = auth.uid());

grant select on public.communities to anon, authenticated;
grant insert, update, delete on public.communities to authenticated;
grant select, insert, delete on public.community_members to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
