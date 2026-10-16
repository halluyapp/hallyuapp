-- Hallyu backend — 14 push tokens.
-- Device registration for the episode reminder / social notification path. A push token is a
-- credential: only its owner may read it, and no policy ever exposes another member's tokens.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create type public.push_platform as enum ('ios', 'android', 'web');

create table if not exists public.push_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid        not null references public.profiles (id) on delete cascade,
  token        text        not null,
  platform     public.push_platform not null,
  device_name  text,
  app_version  text,
  locale       text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  disabled_at  timestamptz,
  constraint push_tokens_token_not_blank check (length(btrim(token)) > 20),
  constraint push_tokens_device_name_length check (device_name is null or char_length(device_name) <= 80),
  constraint push_tokens_locale_format check (locale is null or locale ~ '^[a-z]{2}(-[A-Za-z0-9]{2,8})?$')
);

comment on table public.push_tokens is 'Push registration tokens. A token is unique across the platform so a reinstall re-uses the row instead of leaking a dead one.';

create unique index if not exists push_tokens_token_key on public.push_tokens (token);
create index if not exists push_tokens_user_idx on public.push_tokens (user_id);
create index if not exists push_tokens_active_idx on public.push_tokens (user_id) where disabled_at is null;

-- No `updated_at` trigger here: this table has no `updated_at` column — `set_updated_at()` writes
-- `new.updated_at`, so the trigger made EVERY update of a push token fail ("record \"new\" has no
-- field \"updated_at\""). The row's own freshness marker is `last_seen_at`, which register_push_token
-- and disable_push_token maintain.

alter table public.push_tokens enable row level security;

create policy push_tokens_owner_select on public.push_tokens
  for select to authenticated
  using (user_id = auth.uid());

-- Direct inserts only work for tokens that are not registered yet. Re-assignment after an account
-- switch goes through public.register_push_token(), which is the only path allowed to move a token
-- between members.
create policy push_tokens_owner_insert on public.push_tokens
  for insert to authenticated
  with check (user_id = auth.uid());

create policy push_tokens_owner_update on public.push_tokens
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy push_tokens_owner_delete on public.push_tokens
  for delete to authenticated
  using (user_id = auth.uid());

grant select, insert, update, delete on public.push_tokens to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
