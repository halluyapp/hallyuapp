-- Hallyu backend — 13 notifications.
-- One table for every kind of social signal, matching the `Notification` shape the client renders.
-- Only the recipient can ever read a row; writers go through the trigger functions in migration 18.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create type public.notification_kind as enum (
  'reaction', 'comment', 'reply', 'follow', 'mention',
  'episode_aired', 'episode_live', 'drama_trending', 'collection_saved', 'system'
);

create type public.notification_group as enum ('social', 'drama', 'mentions', 'system');

create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  recipient_id  uuid        not null references public.profiles (id) on delete cascade,
  kind          public.notification_kind  not null,
  "group"       public.notification_group not null default 'social',
  actor_ids     uuid[]      not null default '{}',
  post_id       uuid        references public.posts (id) on delete cascade,
  comment_id    uuid        references public.comments (id) on delete cascade,
  title_id      uuid        references public.titles (id) on delete cascade,
  community_id  uuid        references public.communities (id) on delete cascade,
  collection_id uuid        references public.collections (id) on delete cascade,
  episode       smallint,
  title         text,
  body          text,
  read_at       timestamptz,
  created_at    timestamptz not null default now(),
  constraint notifications_episode_positive check (episode is null or episode >= 1)
);

comment on table public.notifications is 'Per-member notification inbox. Reads, updates and deletes are recipient-only; inserts happen in database triggers.';

create index if not exists notifications_recipient_created_idx on public.notifications (recipient_id, created_at desc);
create index if not exists notifications_recipient_unread_idx on public.notifications (recipient_id, created_at desc) where read_at is null;
create index if not exists notifications_kind_created_idx on public.notifications (kind, created_at desc);

alter table public.notifications enable row level security;

-- The inbox is the most private table in the schema: insert is deliberately NOT granted.
create policy notifications_recipient_select on public.notifications
  for select to authenticated
  using (recipient_id = auth.uid());

create policy notifications_recipient_update on public.notifications
  for update to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

create policy notifications_recipient_delete on public.notifications
  for delete to authenticated
  using (recipient_id = auth.uid() or public.is_moderator());

grant select, update, delete on public.notifications to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
