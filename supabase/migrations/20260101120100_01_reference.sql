-- Hallyu backend — 01 reference data.
-- Lookup tables that the rest of the schema references by id instead of hard-coded strings, so a
-- fifth world or a second catalog provider can be added by inserting a row.

-- Declared here (not with the tables that first use it) so every later migration can rely on it.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create type public.visibility as enum ('public', 'private');

create table if not exists public.worlds (
  id          text primary key,
  label       text        not null,
  short_label text        not null,
  flag        text        not null,
  tint        text        not null,
  sort_order  smallint    not null default 0,
  created_at  timestamptz not null default now(),
  constraint worlds_id_format check (id ~ '^[a-z][a-z0-9_]{1,30}$'),
  constraint worlds_sort_order_non_negative check (sort_order >= 0)
);

comment on table public.worlds is 'The Hallyu fandom worlds. lib/fandoms.ts is the client mirror of this table.';

create table if not exists public.providers (
  id         text primary key,
  label      text        not null,
  base_url   text,
  is_active  boolean     not null default true,
  created_at timestamptz not null default now(),
  constraint providers_id_format check (id ~ '^[a-z][a-z0-9_]{1,30}$')
);

comment on table public.providers is 'External entertainment catalogs (tmdb today, others later). Posts/titles never hard-code a provider name.';

insert into public.worlds (id, label, short_label, flag, tint, sort_order) values
  ('kdrama',    'K-Dramas',  'K-Drama', '🇰🇷', '#FB7185', 10),
  ('cdrama',    'C-Dramas',  'C-Drama', '🇨🇳', '#F2B84B', 20),
  ('anime',     'Anime',     'Anime',   '🇯🇵', '#60A5FA', 30),
  ('hollywood', 'Hollywood', 'Hollywood','🇺🇸', '#34D399', 40)
on conflict (id) do update
  set label = excluded.label,
      short_label = excluded.short_label,
      flag = excluded.flag,
      tint = excluded.tint,
      sort_order = excluded.sort_order;

insert into public.providers (id, label, base_url) values
  ('tmdb', 'TMDB', 'https://api.themoviedb.org/3')
on conflict (id) do update
  set label = excluded.label,
      base_url = excluded.base_url;

-- Reference data is public and read-only for clients.
alter table public.worlds enable row level security;
alter table public.providers enable row level security;

create policy worlds_select_all on public.worlds for select to anon, authenticated using (true);
create policy providers_select_active on public.providers for select to anon, authenticated using (is_active);

grant select on public.worlds to anon, authenticated;
grant select on public.providers to anon, authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
