-- Hallyu backend — 06 social graph.
-- Four separate edge tables rather than one polymorphic `follows`, because a real foreign key is
-- worth more here than one tidy table: Postgres itself then refuses a follow of a title that does
-- not exist, and the counts on `profiles` / `titles` / `people` / `collections` cannot drift into
-- pointing at nothing.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create table if not exists public.follows (
  follower_id uuid        not null references public.profiles (id) on delete cascade,
  target_id   uuid        not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, target_id),
  constraint follows_no_self_follow check (follower_id <> target_id)
);

comment on table public.follows is 'Member -> member follows (AppState.follows.users).';

create index if not exists follows_target_idx on public.follows (target_id, created_at desc);

create table if not exists public.title_follows (
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  title_id   uuid        not null references public.titles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, title_id)
);

create index if not exists title_follows_title_idx on public.title_follows (title_id);

create table if not exists public.person_follows (
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  person_id  uuid        not null references public.people (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, person_id)
);

create index if not exists person_follows_person_idx on public.person_follows (person_id);

create table if not exists public.collection_follows (
  user_id       uuid        not null references public.profiles (id) on delete cascade,
  collection_id uuid        not null references public.collections (id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (user_id, collection_id)
);

create index if not exists collection_follows_collection_idx on public.collection_follows (collection_id);

-- ---------------------------------------------------------------------------------------------
-- Blocks and mutes
-- ---------------------------------------------------------------------------------------------

create table if not exists public.blocks (
  blocker_id uuid        not null references public.profiles (id) on delete cascade,
  blocked_id uuid        not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_no_self_block check (blocker_id <> blocked_id)
);

comment on table public.blocks is 'Hard block: hides content in both directions and removes the follows between the pair.';

create index if not exists blocks_blocked_idx on public.blocks (blocked_id);

create table if not exists public.mutes (
  user_id       uuid        not null references public.profiles (id) on delete cascade,
  muted_user_id uuid        references public.profiles (id) on delete cascade,
  muted_title_id uuid       references public.titles (id) on delete cascade,
  created_at    timestamptz not null default now(),
  constraint mutes_exactly_one_target check ((muted_user_id is not null)::int + (muted_title_id is not null)::int = 1),
  constraint mutes_no_self_mute check (muted_user_id is null or muted_user_id <> user_id)
);

comment on table public.mutes is 'Soft mute: content stays reachable by link but leaves feeds (AppState.mutedUsers / mutedDramas).';

create unique index if not exists mutes_user_unique on public.mutes (user_id, muted_user_id) where muted_user_id is not null;
create unique index if not exists mutes_title_unique on public.mutes (user_id, muted_title_id) where muted_title_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Count maintenance
-- ---------------------------------------------------------------------------------------------

create or replace function public.handle_follow_counts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.profiles set follower_count = follower_count + 1 where id = new.target_id;
    update public.profiles set following_count = following_count + 1 where id = new.follower_id;
    return new;
  end if;

  update public.profiles set follower_count = greatest(0, follower_count - 1) where id = old.target_id;
  update public.profiles set following_count = greatest(0, following_count - 1) where id = old.follower_id;
  return old;
end;
$$;

create trigger follows_count_insert after insert on public.follows for each row execute function public.handle_follow_counts();
create trigger follows_count_delete after delete on public.follows for each row execute function public.handle_follow_counts();

create or replace function public.handle_title_follow_counts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.titles set follower_count = follower_count + 1 where id = new.title_id;
    return new;
  end if;
  update public.titles set follower_count = greatest(0, follower_count - 1) where id = old.title_id;
  return old;
end;
$$;

create trigger title_follows_count_insert after insert on public.title_follows for each row execute function public.handle_title_follow_counts();
create trigger title_follows_count_delete after delete on public.title_follows for each row execute function public.handle_title_follow_counts();

create or replace function public.handle_person_follow_counts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.people set follower_count = follower_count + 1 where id = new.person_id;
    return new;
  end if;
  update public.people set follower_count = greatest(0, follower_count - 1) where id = old.person_id;
  return old;
end;
$$;

create trigger person_follows_count_insert after insert on public.person_follows for each row execute function public.handle_person_follow_counts();
create trigger person_follows_count_delete after delete on public.person_follows for each row execute function public.handle_person_follow_counts();

create or replace function public.handle_collection_follow_counts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.collections set follower_count = follower_count + 1 where id = new.collection_id;
    return new;
  end if;
  update public.collections set follower_count = greatest(0, follower_count - 1) where id = old.collection_id;
  return old;
end;
$$;

create trigger collection_follows_count_insert after insert on public.collection_follows for each row execute function public.handle_collection_follow_counts();
create trigger collection_follows_count_delete after delete on public.collection_follows for each row execute function public.handle_collection_follow_counts();

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------

alter table public.follows enable row level security;
alter table public.title_follows enable row level security;
alter table public.person_follows enable row level security;
alter table public.collection_follows enable row level security;
alter table public.blocks enable row level security;
alter table public.mutes enable row level security;

-- The follower graph is a public product surface: you can see who follows whom.
create policy follows_select_all on public.follows for select to authenticated using (true);
create policy follows_owner_insert on public.follows for insert to authenticated with check (follower_id = auth.uid());
create policy follows_owner_delete on public.follows for delete to authenticated using (follower_id = auth.uid());

create policy title_follows_select_all on public.title_follows for select to authenticated using (true);
create policy title_follows_owner_insert on public.title_follows for insert to authenticated with check (user_id = auth.uid());
create policy title_follows_owner_delete on public.title_follows for delete to authenticated using (user_id = auth.uid());

create policy person_follows_select_all on public.person_follows for select to authenticated using (true);
create policy person_follows_owner_insert on public.person_follows for insert to authenticated with check (user_id = auth.uid());
create policy person_follows_owner_delete on public.person_follows for delete to authenticated using (user_id = auth.uid());

create policy collection_follows_select_all on public.collection_follows for select to authenticated using (true);
create policy collection_follows_owner_insert on public.collection_follows for insert to authenticated with check (user_id = auth.uid());
create policy collection_follows_owner_delete on public.collection_follows for delete to authenticated using (user_id = auth.uid());

-- Followers of a private collection can read the collection itself (policy added now that the table exists).
create policy collections_select_followed on public.collections
  for select to authenticated
  using (exists (select 1 from public.collection_follows f where f.collection_id = collections.id and f.user_id = auth.uid()));

-- Blocks are private bookkeeping — only the blocker ever sees the list.
create policy blocks_owner_all on public.blocks
  for all to authenticated
  using (blocker_id = auth.uid())
  with check (blocker_id = auth.uid() and blocked_id <> auth.uid());

create policy mutes_owner_all on public.mutes
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select on public.follows, public.title_follows, public.person_follows, public.collection_follows to authenticated;
grant insert, delete on public.follows, public.title_follows, public.person_follows, public.collection_follows to authenticated;
grant select, insert, delete on public.blocks, public.mutes to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
