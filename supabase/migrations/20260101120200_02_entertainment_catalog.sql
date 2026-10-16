-- Hallyu backend — 02 entertainment catalog cache.
-- Hallyu does NOT mirror TMDB. It stores the minimum needed to attach posts, watchlist entries and
-- collections to a title: the provider + external id, the world, and a small cached metadata blob
-- that makes a hub renderable without a catalog round-trip. Every provider-specific field lives
-- behind (provider_id, external_id), so a second catalog can be ingested the same way.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create type public.media_type as enum ('tv', 'movie');
create type public.title_status as enum ('upcoming', 'airing', 'completed', 'canceled');

-- ---------------------------------------------------------------------------------------------
-- People (actors, creators)
-- ---------------------------------------------------------------------------------------------

create table if not exists public.people (
  id            uuid primary key default gen_random_uuid(),
  provider_id   text        not null references public.providers (id) on delete cascade,
  external_id   text        not null,
  name          text        not null,
  korean_name   text,
  photo_url     text,
  birth_date    date,
  bio           text,
  follower_count integer    not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint people_provider_external_key unique (provider_id, external_id),
  constraint people_external_id_not_blank check (length(btrim(external_id)) > 0),
  constraint people_name_not_blank check (length(btrim(name)) > 0),
  constraint people_follower_count_non_negative check (follower_count >= 0)
);

comment on table public.people is 'Cached cast/creator records keyed by provider + external id (TMDB person ids today).';

create index if not exists people_name_trgm_idx on public.people using gin (name extensions.gin_trgm_ops);
create index if not exists people_provider_idx on public.people (provider_id);

-- ---------------------------------------------------------------------------------------------
-- Titles
-- ---------------------------------------------------------------------------------------------

create table if not exists public.titles (
  id               uuid primary key default gen_random_uuid(),
  provider_id      text            not null references public.providers (id) on delete cascade,
  external_id      text            not null,
  media_type       public.media_type not null,
  world            text            not null references public.worlds (id) on delete restrict,
  title            text            not null,
  original_title   text,
  year             smallint        not null,
  end_year         smallint,
  status           public.title_status not null default 'upcoming',
  runtime_minutes  smallint,
  original_language text,
  synopsis         text,
  poster_url       text,
  backdrop_url     text,
  trailer_url      text,
  tone             text,
  community_rating numeric(3, 1),
  genres           text[]          not null default '{}',
  tags             text[]          not null default '{}',
  network          text,
  streaming_on     text[]          not null default '{}',
  airs_on          text,
  next_episode_at  timestamptz,
  episode_count    smallint        not null default 0,
  season_count     smallint        not null default 0,
  follower_count   integer         not null default 0,
  -- Genuinely provider-shaped leftovers (raw provider payload slices, localisation maps).
  provider_data    jsonb           not null default '{}'::jsonb,
  created_at       timestamptz     not null default now(),
  updated_at       timestamptz     not null default now(),
  constraint titles_provider_external_key unique (provider_id, external_id, media_type),
  constraint titles_title_not_blank check (length(btrim(title)) > 0),
  constraint titles_external_id_not_blank check (length(btrim(external_id)) > 0),
  constraint titles_year_sane check (year between 1888 and 2200),
  constraint titles_end_year_sane check (end_year is null or end_year between year and 2200),
  constraint titles_runtime_sane check (runtime_minutes is null or runtime_minutes between 1 and 1200),
  constraint titles_rating_sane check (community_rating is null or community_rating between 0 and 10),
  constraint titles_episode_count_non_negative check (episode_count >= 0),
  constraint titles_season_count_non_negative check (season_count >= 0),
  constraint titles_follower_count_non_negative check (follower_count >= 0),
  constraint titles_provider_data_is_object check (jsonb_typeof(provider_data) = 'object')
);

comment on table public.titles is 'Cached entertainment titles. The canonical identity is (provider_id, external_id, media_type); everything else is disposable cache.';

create index if not exists titles_world_idx on public.titles (world);
create index if not exists titles_status_air_date_idx on public.titles (status, next_episode_at);
create index if not exists titles_year_desc_idx on public.titles (year desc);
create index if not exists titles_genres_gin_idx on public.titles using gin (genres);
create index if not exists titles_title_trgm_idx on public.titles using gin (title extensions.gin_trgm_ops);
-- Server-side catalog search (search_titles RPC) uses this generated column.
-- The array join has to be IMMUTABLE to sit inside a generated column, and `array_to_string` is
-- stable on current PostgreSQL engines — the same wrapper the live project runs (connection report §3).
create or replace function public.genres_search_text(p_genres text[])
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(array_to_string(p_genres, ' '), '')
$$;

alter table public.titles
  add column if not exists search_document tsvector
  generated always as (
    to_tsvector('simple',
      coalesce(title, '') || ' ' || coalesce(original_title, '') || ' ' ||
      public.genres_search_text(genres) || ' ' || coalesce(network, '')
    )
  ) stored;
create index if not exists titles_search_gin_idx on public.titles using gin (search_document);

-- ---------------------------------------------------------------------------------------------
-- Cast + episodes
-- ---------------------------------------------------------------------------------------------

create table if not exists public.title_people (
  title_id   uuid        not null references public.titles (id) on delete cascade,
  person_id  uuid        not null references public.people (id) on delete cascade,
  character  text,
  job        text        not null default 'actor',
  order_index integer    not null default 0,
  primary key (title_id, person_id),
  constraint title_people_job_known check (job in ('actor', 'director', 'writer', 'creator', 'producer'))
);

create index if not exists title_people_person_idx on public.title_people (person_id);
create index if not exists title_people_title_order_idx on public.title_people (title_id, order_index);

create table if not exists public.title_episodes (
  title_id      uuid         not null references public.titles (id) on delete cascade,
  season        smallint     not null,
  number        smallint     not null,
  title         text,
  air_date      date,
  runtime_minutes smallint,
  synopsis      text,
  still_url     text,
  created_at    timestamptz  not null default now(),
  updated_at    timestamptz  not null default now(),
  primary key (title_id, season, number),
  constraint title_episodes_season_positive check (season >= 1),
  constraint title_episodes_number_positive check (number >= 1),
  constraint title_episodes_runtime_sane check (runtime_minutes is null or runtime_minutes between 1 and 1200)
);

create index if not exists title_episodes_air_date_idx on public.title_episodes (air_date) where air_date is not null;

create trigger titles_set_updated_at
  before update on public.titles
  for each row execute function public.set_updated_at();
create trigger people_set_updated_at
  before update on public.people
  for each row execute function public.set_updated_at();
create trigger title_episodes_set_updated_at
  before update on public.title_episodes
  for each row execute function public.set_updated_at();

-- The catalog is a read-mostly cache: anyone may read it, only the ingest path (service role) writes.
alter table public.people enable row level security;
alter table public.titles enable row level security;
alter table public.title_people enable row level security;
alter table public.title_episodes enable row level security;

create policy people_select_all on public.people for select to anon, authenticated using (true);
create policy titles_select_all on public.titles for select to anon, authenticated using (true);
create policy title_people_select_all on public.title_people for select to anon, authenticated using (true);
create policy title_episodes_select_all on public.title_episodes for select to anon, authenticated using (true);

grant select on public.people, public.titles, public.title_people, public.title_episodes to anon, authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
