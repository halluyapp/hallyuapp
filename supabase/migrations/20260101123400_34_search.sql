-- Hallyu backend — 34 search.
--
-- `search_titles` (migration 21) covers the catalog. The app also searches people, rooms,
-- collections and members, and it needs one ranked answer across all of them rather than five
-- requests the client has to merge — merging in the client would mean each result set is ranked
-- without knowledge of the others, which is exactly the blind ranking problem this backend already
-- fixed for titles.
--
-- Privacy rules that the search *must* not leak:
--   * a private member is findable only by name/handle exact-ish match and never shows their posts
--   * a private collection is never returned to anybody but its owner and followers
--   * a suspended or deleted member never appears at all
--   * nobody appears in results for somebody they blocked, or who blocked them
--
-- Ordering is deterministic: every query ends with a unique tiebreaker (`id`), so two identical
-- requests return two identical pages and a cursor page never repeats or skips a row.

-- ---------------------------------------------------------------------------------------------
-- A shared relevance helper
-- ---------------------------------------------------------------------------------------------

-- Rank key for a title row. Used by both search_titles' successor and the federated search so the
-- two never disagree about what "relevant" means.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create or replace function public.title_search_rank(
  p_search_document tsvector,
  p_title text,
  p_original_title text,
  p_query text,
  p_lifecycle public.catalog_lifecycle default null
)
returns double precision
language sql
immutable
set search_path = public, pg_temp
as $$
  select
    -- An exact-ish title match outranks a body-of-words match; a prefix match outranks a mid-word one.
    (case when lower(p_title) = lower(btrim(p_query)) then 1.0 else 0 end) * 1.0
    + (case when lower(p_title) like lower(btrim(p_query)) || '%' then 0.6 else 0 end)
    + (case when coalesce(p_original_title, '') ilike '%' || btrim(p_query) || '%' then 0.4 else 0 end)
    + ts_rank_cd(p_search_document, websearch_to_tsquery('simple', p_query)) * 0.5
    -- Search relevance is not a popularity contest, but a current title beating a 1998 one on a tie
    -- is the difference between a useful result and a nostalgia dump.
    + coalesce(
        (case p_lifecycle
           when 'airing' then 0.30
           when 'upcoming' then 0.22
           when 'recent' then 0.12
           when 'classic' then 0.0
           else 0.0
         end),
        0.0
      )
$$;

revoke all on function public.title_search_rank(tsvector, text, text, text, public.catalog_lifecycle) from public, anon, authenticated;
grant execute on function public.title_search_rank(tsvector, text, text, text, public.catalog_lifecycle) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Titles: deterministic, lifecycle-aware
-- ---------------------------------------------------------------------------------------------

-- Replaces `search_titles` (migration 21) with the same argument list and a better ordering. The old
-- function ranked by raw ts_rank then year, which put a 1994 film with one matching word above a
-- drama that is on air tonight and matches every word.
create or replace function public.search_titles(
  p_query text,
  p_world text default null,
  p_limit integer default 20,
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
  where (
      t.search_document @@ websearch_to_tsquery('simple', p_query)
      or t.title ilike '%' || btrim(p_query) || '%'
      or coalesce(t.original_title, '') ilike '%' || btrim(p_query) || '%'
      or coalesce(array_to_string(t.genres, ' '), '') ilike '%' || btrim(p_query) || '%'
    )
    and (p_world is null or t.world = p_world)
    -- A record the provider has stopped returning stays findable by direct title, but is never
    -- offered as a discovery result.
    and (
      public.catalog_lifecycle_of(t) <> 'unavailable'
      or lower(t.title) = lower(btrim(p_query))
    )
    and exists (select 1 from public.providers pr where pr.id = t.provider_id and pr.is_active)
  order by
    public.title_search_rank(t.search_document, t.title, t.original_title, p_query, public.catalog_lifecycle_of(t)) desc,
    t.title asc,
    t.id asc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.search_titles(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_titles(text, text, integer, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------------------------

create or replace function public.search_people(
  p_query text,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  name text,
  korean_name text,
  photo_url text,
  follower_count integer,
  known_for_count integer,
  known_for jsonb,
  rank double precision
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    pe.id, pe.name, pe.korean_name, pe.photo_url, pe.follower_count, pe.known_for_count,
    coalesce((
      select jsonb_agg(to_jsonb(k) order by k.popularity desc nulls last)
      from (
        select t.id, t.title, t.media_type, t.year, t.poster_url,
               round(public.catalog_relevance_score(t)::numeric, 4)::double precision as popularity
        from public.title_people tp
        join public.titles t on t.id = tp.title_id
        where tp.person_id = pe.id and public.catalog_lifecycle_of(t) <> 'unavailable'
        order by public.catalog_relevance_score(t) desc, t.id asc
        limit 5
      ) k
    ), '[]'::jsonb) as known_for,
    -- A prefix match on a name is the common case; a substring match still finds a stage name.
    (case when lower(pe.name) like lower(btrim(p_query)) || '%' then 1.0 else 0 end)
      + (case when lower(pe.name) ilike '%' || btrim(p_query) || '%' then 0.4 else 0 end)
      + (case when coalesce(pe.korean_name, '') ilike '%' || btrim(p_query) || '%' then 0.5 else 0 end)
      + least(0.3, (ln(pe.follower_count + 1) / ln(100001)) * 0.3) as rank
  from public.people pe
  where (
      pe.name ilike '%' || btrim(p_query) || '%'
      or coalesce(pe.korean_name, '') ilike '%' || btrim(p_query) || '%'
    )
  order by
    (case when lower(pe.name) like lower(btrim(p_query)) || '%' then 1.0 else 0 end)
      + (case when lower(pe.name) ilike '%' || btrim(p_query) || '%' then 0.4 else 0 end)
      + (case when coalesce(pe.korean_name, '') ilike '%' || btrim(p_query) || '%' then 0.5 else 0 end)
      + least(0.3, (ln(pe.follower_count + 1) / ln(100001)) * 0.3) desc,
    pe.name asc,
    pe.id asc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.search_people(text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_people(text, integer, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Communities
-- ---------------------------------------------------------------------------------------------

create or replace function public.search_communities(
  p_query text,
  p_world text default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  name text,
  description text,
  fandom text,
  cover_tone text,
  cover_url text,
  member_count integer,
  post_count integer,
  is_official boolean,
  joined boolean,
  rank double precision
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    c.id, c.name, c.description, c.fandom, c.cover_tone, c.cover_url, c.member_count, c.post_count, c.is_official,
    exists (select 1 from public.community_members m where m.community_id = c.id and m.user_id = auth.uid() and m.status = 'active') as joined,
    (case when lower(c.name) like lower(btrim(p_query)) || '%' then 1.0 else 0 end)
      + (case when lower(c.name) ilike '%' || btrim(p_query) || '%' then 0.4 else 0 end)
      + (case when c.description ilike '%' || btrim(p_query) || '%' then 0.25 else 0 end)
      + least(0.2, (ln(c.member_count + 1) / ln(10001)) * 0.2) as rank
  from public.communities c
  where (
      c.name ilike '%' || btrim(p_query) || '%'
      or c.description ilike '%' || btrim(p_query) || '%'
    )
    and (p_world is null or c.fandom = p_world)
  order by
    (case when lower(c.name) like lower(btrim(p_query)) || '%' then 1.0 else 0 end)
      + (case when lower(c.name) ilike '%' || btrim(p_query) || '%' then 0.4 else 0 end)
      + (case when c.description ilike '%' || btrim(p_query) || '%' then 0.25 else 0 end)
      + least(0.2, (ln(c.member_count + 1) / ln(10001)) * 0.2) desc,
    c.name asc,
    c.id asc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.search_communities(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_communities(text, text, integer, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Collections and members
-- ---------------------------------------------------------------------------------------------

-- A private collection is visible to its owner and to the people who follow it, and to nobody else.
create or replace function public.search_collections(
  p_query text,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  title text,
  description text,
  visibility public.visibility,
  item_count integer,
  follower_count integer,
  owner_id uuid,
  owner_handle text,
  rank double precision
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    c.id, c.title, c.description, c.visibility, c.item_count, c.follower_count, c.owner_id,
    pr.handle as owner_handle,
    (case when lower(c.title) like lower(btrim(p_query)) || '%' then 1.0 else 0 end)
      + (case when lower(c.title) ilike '%' || btrim(p_query) || '%' then 0.4 else 0 end)
      + least(0.2, (ln(c.item_count + 1) / ln(1001)) * 0.2) as rank
  from public.collections c
  join public.profiles pr on pr.id = c.owner_id
  where (
      c.title ilike '%' || btrim(p_query) || '%'
      or coalesce(c.description, '') ilike '%' || btrim(p_query) || '%'
    )
    and pr.account_status <> 'deleted'
    and (
      c.visibility = 'public'
      or c.owner_id = auth.uid()
      or exists (select 1 from public.collection_follows f where f.collection_id = c.id and f.user_id = auth.uid())
    )
  order by
    (case when lower(c.title) like lower(btrim(p_query)) || '%' then 1.0 else 0 end)
      + (case when lower(c.title) ilike '%' || btrim(p_query) || '%' then 0.4 else 0 end)
      + least(0.2, (ln(c.item_count + 1) / ln(1001)) * 0.2) desc,
    c.title asc,
    c.id asc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.search_collections(text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_collections(text, integer, integer) to authenticated;

-- Members. A private member is returned as a bare profile chip with no counts and no post access,
-- which is what the app renders for "this person follows somebody you follow".
create or replace function public.search_members(
  p_query text,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  handle text,
  display_name text,
  avatar_path text,
  is_private boolean,
  verified boolean,
  worlds text[],
  follower_count integer,
  following_count integer,
  post_count integer,
  rank double precision
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id, p.handle, p.display_name, p.avatar_path, p.is_private, p.verified, p.worlds,
    case when p.is_private then 0 else p.follower_count end as follower_count,
    case when p.is_private then 0 else p.following_count end as following_count,
    case when p.is_private then 0 else p.post_count end as post_count,
    (case when lower(p.handle) like lower(btrim(p_query)) || '%' then 1.0 else 0 end)
      + (case when lower(p.display_name) ilike '%' || btrim(p_query) || '%' then 0.5 else 0 end)
      + least(0.2, (ln(p.follower_count + 1) / ln(100001)) * 0.2) as rank
  from public.profiles p
  where (
      p.handle ilike '%' || btrim(p_query) || '%'
      or p.display_name ilike '%' || btrim(p_query) || '%'
    )
    -- Deleted and suspended accounts never appear. A private one appears as a chip.
    and p.account_status = 'active'
    and not exists (
      select 1 from public.blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = p.id)
         or (b.blocked_id = auth.uid() and b.blocker_id = p.id)
    )
  order by
    (case when lower(p.handle) like lower(btrim(p_query)) || '%' then 1.0 else 0 end)
      + (case when lower(p.display_name) ilike '%' || btrim(p_query) || '%' then 0.5 else 0 end)
      + least(0.2, (ln(p.follower_count + 1) / ln(100001)) * 0.2) desc,
    p.handle asc,
    p.id asc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.search_members(text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_members(text, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- One ranked answer across every entity
-- ---------------------------------------------------------------------------------------------

-- The federated search the Search screen calls. Each entity gets its own slice with its own ordering,
-- and the response carries per-type totals so the UI can say "12 people, 4 rooms" without a second
-- request. Deterministic inside every slice; the slice order itself is fixed, not sorted by size.
create or replace function public.search_all(
  p_query text,
  p_world text default null,
  p_per_type integer default 8
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  trimmed text := btrim(coalesce(p_query, ''));
  per_slice integer := least(greatest(coalesce(p_per_type, 8), 1), 25);
  title_rows jsonb;
  person_rows jsonb;
  community_rows jsonb;
  collection_rows jsonb;
  member_rows jsonb;
begin
  if length(trimmed) < 2 then
    return jsonb_build_object(
      'query', trimmed,
      'titles', '[]'::jsonb, 'people', '[]'::jsonb, 'communities', '[]'::jsonb,
      'collections', '[]'::jsonb, 'members', '[]'::jsonb,
      'counts', jsonb_build_object('titles', 0, 'people', 0, 'communities', 0, 'collections', 0, 'members', 0)
    );
  end if;

  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into title_rows
  from (
    select * from public.search_titles(trimmed, p_world, per_slice, 0) s
  ) s;

  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into person_rows
  from (select * from public.search_people(trimmed, per_slice, 0) s) s;

  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into community_rows
  from (select * from public.search_communities(trimmed, p_world, per_slice, 0) s) s;

  if auth.uid() is not null then
    select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into collection_rows
    from (select * from public.search_collections(trimmed, per_slice, 0) s) s;

    select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) into member_rows
    from (select * from public.search_members(trimmed, per_slice, 0) s) s;
  else
    collection_rows := '[]'::jsonb;
    member_rows := '[]'::jsonb;
  end if;

  -- Totals use the same predicates without the LIMIT, so the counts are the real counts. They are
  -- search result metadata (a product purpose), never a catalog counter shown on the Home screen.
  return jsonb_build_object(
    'query', trimmed,
    'titles', title_rows,
    'people', person_rows,
    'communities', community_rows,
    'collections', collection_rows,
    'members', member_rows,
    'counts', jsonb_build_object(
      'titles', (select count(*) from public.titles t
                  where (t.search_document @@ websearch_to_tsquery('simple', trimmed)
                     or t.title ilike '%' || trimmed || '%')
                    and (p_world is null or t.world = p_world)),
      'people', (select count(*) from public.people pe where pe.name ilike '%' || trimmed || '%'),
      'communities', (select count(*) from public.communities c
                      where c.name ilike '%' || trimmed || '%' and (p_world is null or c.fandom = p_world)),
      'collections', case when auth.uid() is null then 0 else (
        select count(*) from public.collections c
        where c.title ilike '%' || trimmed || '%'
          and (c.visibility = 'public' or c.owner_id = auth.uid())
      ) end,
      'members', case when auth.uid() is null then 0 else (
        select count(*) from public.profiles p
        where (p.handle ilike '%' || trimmed || '%' or p.display_name ilike '%' || trimmed || '%')
          and p.account_status = 'active'
      ) end
    )
  );
end;
$$;

revoke all on function public.search_all(text, text, integer) from public, anon, authenticated;
grant execute on function public.search_all(text, text, integer) to anon, authenticated;

-- Type-ahead for the search bar: a small, cheap, ordered list of suggestions. Bounded at 10 and
-- cached-friendly because it touches only indexed columns.
create or replace function public.search_suggestions(
  p_query text,
  p_limit integer default 10
)
returns table (kind text, id uuid, label text, subtitle text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  trimmed text := btrim(coalesce(p_query, ''));
  cap integer := least(greatest(coalesce(p_limit, 10), 1), 10);
begin
  if length(trimmed) < 2 then
    return;
  end if;

  return query
  select * from (
    (
      select 'title'::text as kind, t.id, t.title as label,
             coalesce(t.genres[1], t.world) as subtitle
      from public.titles t
      where t.title ilike trimmed || '%'
        and public.catalog_lifecycle_of(t) <> 'unavailable'
      order by public.catalog_relevance_score(t) desc, t.id asc
      limit cap
    )

    union all

    (
      select 'person'::text, pe.id, pe.name, coalesce(pe.korean_name, 'Cast & crew')
      from public.people pe
      where pe.name ilike trimmed || '%'
      order by pe.follower_count desc, pe.id asc
      limit 3
    )

    union all

    (
      select 'community'::text, c.id, c.name, c.fandom
      from public.communities c
      where c.name ilike trimmed || '%'
      order by c.member_count desc, c.id asc
      limit 3
    )
  ) suggestions
  limit cap;
end;
$$;

revoke all on function public.search_suggestions(text, integer) from public, anon, authenticated;
grant execute on function public.search_suggestions(text, integer) to anon, authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
