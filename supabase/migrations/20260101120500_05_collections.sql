-- Hallyu backend — 05 collections.
-- A collection is a member's shelf of titles ("slow burns worth it"), optionally public. Items point
-- at cached titles rather than duplicating catalog data.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create table if not exists public.collections (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid        not null references public.profiles (id) on delete cascade,
  title          text        not null,
  description    text,
  visibility     public.visibility not null default 'private',
  item_count     integer     not null default 0,
  follower_count integer     not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint collections_title_length check (char_length(btrim(title)) between 1 and 60),
  constraint collections_description_length check (description is null or char_length(description) <= 240),
  constraint collections_counts_non_negative check (item_count >= 0 and follower_count >= 0)
);

comment on table public.collections is 'Member-owned shelves of titles. Private by default, matching lib/model.ts Visibility.';

create index if not exists collections_owner_idx on public.collections (owner_id, updated_at desc);
create index if not exists collections_public_idx on public.collections (updated_at desc)
  where visibility = 'public' and item_count > 0;

create table if not exists public.collection_items (
  collection_id uuid        not null references public.collections (id) on delete cascade,
  title_id      uuid        not null references public.titles (id) on delete cascade,
  note          text,
  position      integer     not null default 0,
  added_at      timestamptz not null default now(),
  primary key (collection_id, title_id),
  constraint collection_items_note_length check (note is null or char_length(note) <= 200),
  constraint collection_items_position_non_negative check (position >= 0)
);

create index if not exists collection_items_title_idx on public.collection_items (title_id);

create trigger collections_set_updated_at
  before update on public.collections
  for each row execute function public.set_updated_at();

-- Keep collections.item_count exact: it is displayed on a card and must not drift.
create or replace function public.handle_collection_item_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.collections set item_count = item_count + 1 where id = new.collection_id;
    return new;
  end if;

  update public.collections set item_count = greatest(0, item_count - 1) where id = old.collection_id;
  return old;
end;
$$;

create trigger collection_items_count_insert
  after insert on public.collection_items
  for each row execute function public.handle_collection_item_count();
create trigger collection_items_count_delete
  after delete on public.collection_items
  for each row execute function public.handle_collection_item_count();

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------

alter table public.collections enable row level security;
alter table public.collection_items enable row level security;

-- A collection is visible when it is public, when you own it, or when you follow it (the follower
-- policy is added in 06, once public.collection_follows exists).
create policy collections_select_visible on public.collections
  for select to authenticated
  using (
    visibility = 'public'
    or owner_id = auth.uid()
    or public.is_moderator()
  );

create policy collections_select_anonymous on public.collections
  for select to anon
  using (visibility = 'public');

create policy collections_owner_insert on public.collections
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy collections_owner_update on public.collections
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy collections_owner_delete on public.collections
  for delete to authenticated
  using (owner_id = auth.uid() or public.is_moderator());

-- Items inherit their collection's visibility — there is no way to leak an item from a private shelf.
create policy collection_items_select_visible on public.collection_items
  for select to authenticated
  using (exists (select 1 from public.collections c where c.id = collection_items.collection_id));

create policy collection_items_select_anonymous on public.collection_items
  for select to anon
  using (exists (select 1 from public.collections c where c.id = collection_items.collection_id and c.visibility = 'public'));

create policy collection_items_owner_insert on public.collection_items
  for insert to authenticated
  with check (exists (select 1 from public.collections c where c.id = collection_id and c.owner_id = auth.uid()));

create policy collection_items_owner_delete on public.collection_items
  for delete to authenticated
  using (exists (select 1 from public.collections c where c.id = collection_id and c.owner_id = auth.uid()));

grant select on public.collections to anon, authenticated;
grant insert, update, delete on public.collections to authenticated;
grant select on public.collection_items to anon, authenticated;
grant insert, delete on public.collection_items to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
