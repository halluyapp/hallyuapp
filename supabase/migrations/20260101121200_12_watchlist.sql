-- Hallyu backend — 12 watchlist and progress.
-- Mirrors `WatchlistItem` in lib/model.ts. Progress is monotonic per member: the database refuses to
-- move an episode pointer backwards through public.upsert_watchlist_item.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create type public.watch_status as enum ('want', 'watching', 'completed', 'dropped');

create table if not exists public.watchlist_items (
  user_id         uuid        not null references public.profiles (id) on delete cascade,
  title_id        uuid        not null references public.titles (id) on delete cascade,
  status          public.watch_status not null default 'want',
  season          smallint    not null default 1,
  current_episode smallint    not null default 0,
  note            text,
  added_at        timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz,
  primary key (user_id, title_id),
  constraint watchlist_items_season_positive check (season >= 1),
  constraint watchlist_items_episode_non_negative check (current_episode >= 0),
  constraint watchlist_items_note_length check (note is null or char_length(note) <= 200),
  constraint watchlist_items_completed_stamp check ((status = 'completed') = (completed_at is not null))
);

comment on table public.watchlist_items is 'What a member is watching, and how far. Never visible to another member.';

create index if not exists watchlist_items_status_idx on public.watchlist_items (user_id, status);

create trigger watchlist_items_set_updated_at
  before update on public.watchlist_items
  for each row execute function public.set_updated_at();

alter table public.watchlist_items enable row level security;

create policy watchlist_items_owner_all on public.watchlist_items
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.watchlist_items to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
