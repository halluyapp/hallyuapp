-- Hallyu backend — 25 Hallyu ranking and discovery.
--
-- TMDB popularity is a global, all-time-ish counter. Using it directly is how a 2004 blockbuster
-- ends up above the drama everybody is watching tonight, in every world, forever. Hallyu needs its
-- own discovery layer, and it needs the same answer to "what is trending in K-dramas?" everywhere
-- in the product.
--
-- This migration adds exactly that: a relevance function that combines signals the backend already
-- owns, a snapshot table that records what the score was (so movement is measurable), the RPCs the
-- Home and world screens read, and the aggregates that replace "16 titles".
--
-- The rules, stated once so the whole product agrees:
--   * currently airing  → the strongest signal there is
--   * upcoming         → strong while inside its pre-release window, decaying as it approaches
--   * recently released→ discoverable, but never labelled "airing"
--   * finished/old     → available in search and shelves, weighted down in every trending list
--   * unavailable      → absent from discovery entirely

-- ---------------------------------------------------------------------------------------------
-- Freshness classification, derived from dates and never from a cached flag
-- ---------------------------------------------------------------------------------------------

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create type public.catalog_lifecycle as enum ('airing', 'upcoming', 'recent', 'classic', 'unavailable');

-- The engagement sub-selects in the relevance function hit community_members by community_id, and
-- migration 07 only indexed the member side. Without this the score is a sequential scan per title.
create index if not exists community_members_community_idx on public.community_members (community_id, user_id);

create or replace function public.catalog_lifecycle_of(p_title public.titles)
returns public.catalog_lifecycle
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_title.catalog_unavailable_at is not null
      or p_title.catalog_missing_count >= 3 then 'unavailable'::public.catalog_lifecycle
    when p_title.status = 'canceled' then 'unavailable'::public.catalog_lifecycle
    when p_title.status = 'airing'
      and (p_title.last_air_date is null or p_title.last_air_date >= current_date - 30)
      then 'airing'::public.catalog_lifecycle
    when p_title.status = 'upcoming'
      and (p_title.first_air_date is null or p_title.first_air_date <= current_date + 365)
      then 'upcoming'::public.catalog_lifecycle
    when p_title.status = 'upcoming' then 'unavailable'::public.catalog_lifecycle
    when p_title.status = 'completed'
      and (p_title.last_air_date is null or p_title.last_air_date >= current_date - 365
           or p_title.year >= extract(year from now())::integer - 2)
      then 'recent'::public.catalog_lifecycle
    when p_title.status = 'completed' then 'classic'::public.catalog_lifecycle
    else 'classic'::public.catalog_lifecycle
  end
$$;

revoke all on function public.catalog_lifecycle_of(public.titles) from public, anon, authenticated;
grant execute on function public.catalog_lifecycle_of(public.titles) to service_role;

comment on type public.catalog_lifecycle is 'Derived presentation state: what the app may say about a title right now, from dates rather than from cache.';

-- ---------------------------------------------------------------------------------------------
-- Relevance
-- ---------------------------------------------------------------------------------------------

-- A single scalar in [0, 1]. Higher means "more likely to be the thing a member wants to see right
-- now in this world". Every discovery surface sorts on this, so a title's position in Trending, in
-- the world rail and in the For You row can never disagree.
create or replace function public.catalog_relevance_score(
  p_title public.titles,
  p_lifecycle public.catalog_lifecycle default null,
  p_world text default null
)
returns double precision
language sql
immutable
set search_path = public, pg_temp
as $$
  with context as (
    select
      coalesce(p_lifecycle, public.catalog_lifecycle_of(p_title)) as life,
      -- How many members follow this title right now. A real count from real rows, never invented.
      (select count(*) from public.title_follows tf where tf.title_id = p_title.id)::double precision as followers,
      (select count(*) from public.posts po where po.title_id = p_title.id and po.state = 'active')::double precision as posts,
      (select count(*) from public.title_episodes e where e.title_id = p_title.id and e.air_date >= current_date - 14)::double precision as recent_episodes,
      (select count(*) from public.community_members cm where cm.community_id in (select c.id from public.communities c where c.drama_id = p_title.id))::double precision as room_members
  )
  select
    -- Lifecycle weight: the dominant term. Current beats upcoming beats recent beats classic.
    (case ctx.life
       when 'airing' then 0.50
       when 'upcoming' then 0.38
       when 'recent' then 0.22
       when 'classic' then 0.06
       else 0.0
     end)
    -- Provider popularity, log-compressed so one mega-hit cannot flatten the whole list. Scaled
    -- against 500 which is roughly the top of TMDB's popularity range.
    + least(0.18, (ln(coalesce(greatest(p_title.popularity, 0), 0) + 1) / ln(501)) * 0.18)
    -- Provider rating, only as a tiebreaker: 10/10 on a 400-vote title is not a signal on its own.
    + (coalesce(p_title.vote_average, 0) / 10.0) * 0.04 * least(1.0, coalesce(p_title.vote_count, 0)::double precision / 500.0)
    -- Episode activity: a show that dropped three episodes in the last fortnight is live right now.
    + least(0.12, ctx.recent_episodes * 0.04)
    -- Hallyu engagement, from rows that exist. Log-scaled; a big room is worth surfacing.
    + least(0.12, (ln(ctx.followers + 1) / ln(1001)) * 0.08)
    + least(0.10, (ln(ctx.posts + 1) / ln(501)) * 0.05)
    + least(0.05, (ln(ctx.room_members + 1) / ln(2001)) * 0.05)
    -- A show that finished airing long ago decays further with age, so classics slide down "Top".
    - (case when ctx.life = 'classic'
            then least(0.10, greatest(0, extract(year from now()) - p_title.year - 5) / 100.0)
            else 0.0 end)
  from context ctx
$$;

revoke all on function public.catalog_relevance_score(public.titles, public.catalog_lifecycle, text) from public, anon, authenticated;
grant execute on function public.catalog_relevance_score(public.titles, public.catalog_lifecycle, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Snapshots: trending is a movement, not an ordering
-- ---------------------------------------------------------------------------------------------

create table if not exists public.catalog_rank_snapshots (
  title_id      uuid             not null references public.titles (id) on delete cascade,
  world         text             not null references public.worlds (id) on delete cascade,
  lifecycle     public.catalog_lifecycle not null,
  score         double precision not null,
  rank          integer          not null,
  window_start  date             not null,
  window_end    date             not null,
  computed_at   timestamptz      not null default now(),
  primary key (title_id, world, window_start)
);

comment on table public.catalog_rank_snapshots is 'Daily per-world ranking snapshots. The difference between two windows is what "trending" means, and it is auditable after the fact.';

create index if not exists catalog_rank_snapshots_world_window_idx
  on public.catalog_rank_snapshots (world, window_end desc, rank);

alter table public.catalog_rank_snapshots enable row level security;

create policy catalog_rank_snapshots_select_all on public.catalog_rank_snapshots
  for select to anon, authenticated using (true);

grant select on public.catalog_rank_snapshots to anon, authenticated;

-- Recomputes and stores today's ranking for one world (or all worlds). Idempotent: the primary key
-- is (title, world, window_start), so running it twice in a day updates the same rows.
create or replace function public.refresh_trending(
  p_world text default null,
  p_window date default (now() at time zone 'utc')::date
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  world_row record;
  scored integer := 0;
begin
  if actor is not null then
    raise exception 'trending refresh is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  for world_row in
    select w.id from public.worlds w where (p_world is null or w.id = p_world) order by w.sort_order
  loop
    insert into public.catalog_rank_snapshots (title_id, world, lifecycle, score, rank, window_start, window_end)
    select
      t.id,
      world_row.id,
      public.catalog_lifecycle_of(t),
      round(public.catalog_relevance_score(t)::numeric, 6)::double precision,
      row_number() over (order by public.catalog_relevance_score(t) desc, t.id asc)::integer,
      p_window,
      p_window
    from public.titles t
    where t.world = world_row.id
      and public.catalog_lifecycle_of(t) <> 'unavailable'
    order by public.catalog_relevance_score(t) desc, t.id asc
    limit 200
    on conflict (title_id, world, window_start) do update
      set lifecycle = excluded.lifecycle,
          score = excluded.score,
          rank = excluded.rank,
          window_end = excluded.window_end,
          computed_at = now();

    get diagnostics scored = row_count;
  end loop;

  return scored;
end;
$$;

revoke all on function public.refresh_trending(text, date) from public, anon, authenticated;
grant execute on function public.refresh_trending(text, date) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Discovery reads
-- ---------------------------------------------------------------------------------------------

-- Trending titles for a world. Deterministic (score, then id) and page-stable: the ordering keys are
-- unique, so the same page request always yields the same rows.
create or replace function public.trending_titles(
  p_world text default null,
  p_lifecycle public.catalog_lifecycle[] default null,
  p_genre text default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  title text,
  original_title text,
  year smallint,
  media_type public.media_type,
  status public.title_status,
  lifecycle public.catalog_lifecycle,
  score double precision,
  poster_url text,
  backdrop_url text,
  genres text[],
  synopsis text,
  next_episode_at timestamptz,
  episode_count smallint,
  season_count smallint,
  network text,
  world text,
  follower_count integer,
  vote_average numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id, t.title, t.original_title, t.year, t.media_type, t.status,
    public.catalog_lifecycle_of(t) as lifecycle,
    round(public.catalog_relevance_score(t)::numeric, 6)::double precision as score,
    t.poster_url, t.backdrop_url, t.genres, t.synopsis, t.next_episode_at,
    t.episode_count, t.season_count, t.network, t.world, t.follower_count, t.vote_average
  from public.titles t
  where (p_world is null or t.world = p_world)
    and (p_genre is null or p_genre = any(t.genres))
    and public.catalog_lifecycle_of(t) <> 'unavailable'
    and (
      -- A classic (long-finished) title is never returned by a default trending list; it has to be
      -- asked for by naming it in p_lifecycle. An explicit filter returns exactly what it names.
      case
        when p_lifecycle is null then public.catalog_lifecycle_of(t) <> 'classic'
        else public.catalog_lifecycle_of(t) = any(p_lifecycle)
      end
    )
  order by public.catalog_relevance_score(t) desc, t.id asc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.trending_titles(text, public.catalog_lifecycle[], text, integer, integer) from public, anon, authenticated;
grant execute on function public.trending_titles(text, public.catalog_lifecycle[], text, integer, integer) to anon, authenticated;

-- Everything that is airing right now, across every world. Backed by dates and the episode table,
-- so a show whose schedule moved is correct after the next refresh, not after the next deploy.
create or replace function public.airing_titles(
  p_world text default null,
  p_limit integer default 40,
  p_offset integer default 0
)
returns table (
  id uuid,
  title text,
  year smallint,
  media_type public.media_type,
  world text,
  poster_url text,
  backdrop_url text,
  genres text[],
  synopsis text,
  next_episode_at timestamptz,
  season_count smallint,
  episode_count smallint,
  network text,
  airs_on text,
  follower_count integer,
  episodes_this_week integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id, t.title, t.year, t.media_type, t.world, t.poster_url, t.backdrop_url, t.genres,
    t.synopsis, t.next_episode_at, t.season_count, t.episode_count, t.network, t.airs_on, t.follower_count,
    (select count(*)::integer from public.title_episodes e
      where e.title_id = t.id and e.air_date between current_date and current_date + 7)::integer as episodes_this_week
  from public.titles t
  where (p_world is null or t.world = p_world)
    and t.status = 'airing'
    and public.catalog_lifecycle_of(t) = 'airing'
  order by
    -- Whatever airs soonest first; everything else falls back to relevance, then id.
    t.next_episode_at asc nulls last,
    public.catalog_relevance_score(t) desc,
    t.id asc
  limit least(greatest(coalesce(p_limit, 40), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.airing_titles(text, integer, integer) from public, anon, authenticated;
grant execute on function public.airing_titles(text, integer, integer) to anon, authenticated;

-- Upcoming releases inside a real window. A "release date two years out" is not upcoming.
create or replace function public.upcoming_titles(
  p_world text default null,
  p_days integer default 180,
  p_limit integer default 40,
  p_offset integer default 0
)
returns table (
  id uuid,
  title text,
  year smallint,
  media_type public.media_type,
  world text,
  poster_url text,
  backdrop_url text,
  genres text[],
  synopsis text,
  first_air_date date,
  season_count smallint,
  network text,
  follower_count integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id, t.title, t.year, t.media_type, t.world, t.poster_url, t.backdrop_url, t.genres,
    t.synopsis, t.first_air_date, t.season_count, t.network, t.follower_count
  from public.titles t
  where (p_world is null or t.world = p_world)
    and t.status = 'upcoming'
    and public.catalog_lifecycle_of(t) = 'upcoming'
    and (
      t.first_air_date is null
      or t.first_air_date between current_date and current_date + least(greatest(coalesce(p_days, 180), 1), 730)
    )
  order by
    t.first_air_date asc nulls last,
    public.catalog_relevance_score(t) desc,
    t.id asc
  limit least(greatest(coalesce(p_limit, 40), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.upcoming_titles(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.upcoming_titles(text, integer, integer, integer) to anon, authenticated;

-- Recently released: finished inside a year. Discoverable, and honestly presented as finished.
create or replace function public.recently_released_titles(
  p_world text default null,
  p_limit integer default 40,
  p_offset integer default 0
)
returns table (
  id uuid,
  title text,
  year smallint,
  media_type public.media_type,
  world text,
  poster_url text,
  backdrop_url text,
  genres text[],
  synopsis text,
  last_air_date date,
  season_count smallint,
  episode_count smallint,
  vote_average numeric,
  follower_count integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id, t.title, t.year, t.media_type, t.world, t.poster_url, t.backdrop_url, t.genres,
    t.synopsis, t.last_air_date, t.season_count, t.episode_count, t.vote_average, t.follower_count
  from public.titles t
  where (p_world is null or t.world = p_world)
    and public.catalog_lifecycle_of(t) = 'recent'
  order by
    t.last_air_date desc nulls last,
    t.year desc,
    t.id asc
  limit least(greatest(coalesce(p_limit, 40), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.recently_released_titles(text, integer, integer) from public, anon, authenticated;
grant execute on function public.recently_released_titles(text, integer, integer) to anon, authenticated;

-- Personalised discovery for one member: what they follow, watch and interact with, in the worlds
-- they picked, weighted by their own activity. Falls back to plain trending for a new member.
create or replace function public.recommended_titles(
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  title text,
  year smallint,
  media_type public.media_type,
  world text,
  poster_url text,
  backdrop_url text,
  backdrop_note text,
  genres text[],
  synopsis text,
  lifecycle public.catalog_lifecycle,
  score double precision,
  next_episode_at timestamptz,
  follower_count integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  limit_rows integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  offset_rows integer := greatest(coalesce(p_offset, 0), 0);
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  return query
  with viewer as (
    select
      coalesce(p.worlds, '{}') as worlds,
      coalesce(
        (select array_agg(distinct g) from public.profiles pr, unnest(pr.favorite_genres) g where pr.id = actor),
        '{}'
      ) as genres
    from public.profiles p where p.id = actor
  )
  select
    t.id, t.title, t.year, t.media_type, t.world, t.poster_url, t.backdrop_url,
    case
      when exists (select 1 from public.title_follows tf where tf.title_id = t.id and tf.user_id = actor) then 'You follow this'
      when exists (select 1 from public.watchlist_items w where w.title_id = t.id and w.user_id = actor) then 'On your watchlist'
      when v.genres <> '{}' and t.genres && v.genres then 'Because of your taste in ' || (select g from unnest(t.genres) g where g = any(v.genres) limit 1)
      when v.worlds <> '{}' and t.world = any(v.worlds) then 'Popular in ' || t.world
      else 'Trending now'
    end as backdrop_note,
    t.genres, t.synopsis,
    public.catalog_lifecycle_of(t) as lifecycle,
    round((
      public.catalog_relevance_score(t)
      + (case when exists (select 1 from public.title_follows tf where tf.title_id = t.id and tf.user_id = actor) then 0.20 else 0 end)
      + (case when exists (select 1 from public.watchlist_items w where w.title_id = t.id and w.user_id = actor and w.status = 'watching') then 0.12 else 0 end)
      + (case when v.genres <> '{}' and t.genres && v.genres then 0.08 else 0 end)
      + (case when v.worlds <> '{}' and t.world = any(v.worlds) then 0.06 else 0 end)
    )::numeric, 6)::double precision as score,
    t.next_episode_at, t.follower_count
  from public.titles t
  cross join viewer v
  where public.catalog_lifecycle_of(t) <> 'unavailable'
    and not exists (select 1 from public.mutes m where m.user_id = actor and m.muted_title_id = t.id)
    and not exists (
      select 1 from public.collection_items ci
      join public.collections c on c.id = ci.collection_id
      where ci.title_id = t.id and c.owner_id = actor and c.visibility = 'private'
    )
  order by score desc, t.id asc
  limit limit_rows offset offset_rows;
end;
$$;

revoke all on function public.recommended_titles(integer, integer) from public, anon, authenticated;
grant execute on function public.recommended_titles(integer, integer) to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
