-- Hallyu backend — 38 one ranking for every browse surface.
--
-- Genre and streaming-provider pages used to be answered by the client reading `titles` directly
-- and sorting on the raw provider `popularity` column. Trending, the world rails and For You all
-- sort on `public.catalog_relevance_score`, which folds in lifecycle, episode activity and real
-- Hallyu engagement. So the same title could sit at the top of Trending and at the bottom of its
-- own genre page, and the genre page's number was a stale provider figure rather than anything
-- Hallyu computed. Two orderings for one catalog is the bug; this removes the second one.
--
-- `browse_titles` is now the single answer to "titles matching this filter, in Hallyu's order". It
-- returns whole `titles` rows because that is what the client maps onto a Drama, and filtering is
-- deliberately done in SQL rather than by post-filtering a ranked page: filtering after ranking
-- silently drops everything that fell below the cut, so a genre page could show fewer than 24
-- titles while claiming to have more.
--
-- `catalog_relevance_score` is granted to service_role only — a client must not be able to call it
-- directly. This function is SECURITY DEFINER, so it evaluates it on the caller's behalf and the
-- grant below only exposes the ordered result.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create or replace function public.browse_titles(
  p_genre text default null,
  p_provider text default null,
  p_world text default null,
  p_sort text default 'relevance',
  p_limit integer default 24,
  p_offset integer default 0
)
returns setof public.titles
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.*
  from public.titles t
  where (p_genre is null
         -- Case-insensitive on purpose: the app's genre labels are display strings ("Romance")
         -- and the ingest normalises provider genre names, so an exact match would silently return
         -- an empty page for a spelling difference.
         or exists (select 1 from unnest(t.genres) g where lower(btrim(g)) = lower(btrim(p_genre))))
    and (p_provider is null or exists (select 1 from unnest(t.streaming_on) s where lower(btrim(s)) = lower(btrim(p_provider))))
    and (p_world is null or t.world = p_world)
  order by
    -- One CASE so every sort shares a single type and, more importantly, so a new sort is one line
    -- rather than a second query. 'relevance' is the default precisely because it is the ordering
    -- the rest of the app already shows.
    case p_sort
      when 'popular' then coalesce(t.popularity, 0)::double precision
      when 'top' then coalesce(t.vote_average, 0)::double precision
      when 'new' then t.year::double precision
      else public.catalog_relevance_score(t)
    end desc nulls last,
    t.id asc
  limit least(greatest(coalesce(p_limit, 24), 1), 60)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.browse_titles(text, text, text, text, integer, integer) from public;
grant execute on function public.browse_titles(text, text, text, text, integer, integer) to anon, authenticated;

comment on function public.browse_titles(text, text, text, text, integer, integer) is
  'Titles matching a genre / streaming provider / world filter, ordered by Hallyu relevance unless another sort is named. The single browse ordering, so genre pages cannot disagree with Trending.';

-- An unrecognised p_sort deliberately falls through to 'relevance' in the CASE above rather than
-- raising: a typo in the client degrades to the app-wide ordering instead of an error page. There
-- is no separate "is this sort valid" function — nothing calls one, and a check the server never
-- consults is documentation pretending to be a constraint.

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
