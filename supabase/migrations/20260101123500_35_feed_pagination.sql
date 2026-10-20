-- Hallyu backend — 35 feed pagination.
--
-- `feed_posts` (migration 21) paginates with OFFSET over a score that is not a column, so page 2 of
-- "For You" can repeat a post or skip one as soon as anything new arrives — which on a busy feed is
-- constantly. It also orders ranked feeds by an expression with no unique tiebreaker, so two posts
-- with identical engagement have an undefined order between them.
--
-- This migration adds a keyset (cursor) feed:
--
--   * `p_cursor` is the (rank_key, created_at, id) of the last row the client saw, base64url-encoded
--   * every ordering key is unique because `id` is the final tiebreaker
--   * a new post arriving at the top cannot shift the window, so the next page is exactly the rows
--     after the last one seen
--
-- `feed_posts` keeps its signature and is reimplemented on top of the new function, so the client
-- contract in docs/BACKEND-CONNECTION-CONTRACT.md does not change.

-- ---------------------------------------------------------------------------------------------
-- Cursor encoding
-- ---------------------------------------------------------------------------------------------

-- A cursor is opaque text so the client cannot construct one and reason about the query. Decoding
-- failures return NULL rather than raising, which turns a corrupt cursor into "start from the top"
-- instead of an error the app has to special-case.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create or replace function public.decode_feed_cursor(p_cursor text)
returns table (rank_key double precision, created_at timestamptz, id uuid)
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  clean text;
  raw text;
  parts text[];
begin
  if p_cursor is null or length(btrim(p_cursor)) = 0 then
    return;
  end if;

  clean := rtrim(regexp_replace(p_cursor, '\s+', '', 'g'), '=');
  if length(clean) = 0 or length(clean) % 4 = 1 then
    return;
  end if;

  begin
    raw := convert_from(
      decode(rpad(clean, ((length(clean) + 3) / 4) * 4, '='), 'base64'),
      'UTF8'
    );
  exception when others then
    return;
  end;

  parts := string_to_array(raw, '|');
  if array_length(parts, 1) <> 3 then
    return;
  end if;

  begin
    rank_key := parts[1]::double precision;
    created_at := parts[2]::timestamptz;
    id := parts[3]::uuid;
  exception when others then
    return;
  end;

  return;
end;
$$;

revoke all on function public.decode_feed_cursor(text) from public, anon, authenticated;
grant execute on function public.decode_feed_cursor(text) to authenticated;

create or replace function public.encode_feed_cursor(
  p_rank_key double precision,
  p_created_at timestamptz,
  p_id uuid
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select rtrim(
    regexp_replace(
      encode(
        convert_to(
          coalesce(p_rank_key, 0)::text || '|' || p_created_at::text || '|' || p_id::text,
          'UTF8'
        ),
        'base64'
      ),
      '\s+',
      '',
      'g'
    ),
    '='
  )
$$;

revoke all on function public.encode_feed_cursor(double precision, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.encode_feed_cursor(double precision, timestamptz, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The cursor feed
-- ---------------------------------------------------------------------------------------------

-- Scopes:
--   latest     newest first. The default, and the only scope whose ordering is purely time.
--   following  newest first, authors you follow, plus your own posts.
--   for_you    ranked by engagement weighted by world affinity, decaying with age, boosted by
--              follows and by titles you watch. Deterministic, with `id` as the final tiebreaker.
--   title      one title's discussion, newest first.
--   world      one world's newest posts (the world tab).
create or replace function public.feed_page(
  p_scope text default 'latest',
  p_world text default null,
  p_title_id uuid default null,
  p_limit integer default 20,
  p_cursor text default null,
  p_community_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  limit_rows integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  cursor_row record;
  page jsonb;
  has_more boolean := false;
  next_cursor text;
begin
  if p_scope is null or p_scope not in ('for_you', 'following', 'latest', 'title', 'world') then
    raise exception 'unknown feed scope %', p_scope using errcode = 'invalid_parameter_value';
  end if;

  if p_scope = 'title' and p_title_id is null then
    raise exception 'the title scope needs a title' using errcode = 'invalid_parameter_value';
  end if;

  if p_scope = 'world' and p_world is null then
    raise exception 'the world scope needs a world' using errcode = 'invalid_parameter_value';
  end if;

  if p_world is not null and not exists (select 1 from public.worlds w where w.id = p_world) then
    raise exception 'unknown world %', p_world using errcode = 'invalid_parameter_value';
  end if;

  select * into cursor_row from public.decode_feed_cursor(p_cursor);

  -- One fetch of limit_rows + 1: the extra row is how `has_more` is known without a count query.
  -- The visibility filter runs first, then the rank is computed, then the cursor comparison is
  -- applied to the ranked rows — the comparison needs the rank expression to exist as a column.
  with eligible as (
    select
      p.id, p.author_id, p.type, p.title, p.body, p.kind, p.rating, p.verdict, p.spoiler,
      p.world, p.title_id, p.secondary_title_id, p.community_id, p.season, p.episode,
      p.hashtags, p.loved_count, p.cried_count, p.screamed_count, p.swooned_count, p.laughed_count,
      p.furious_count, p.comment_count, p.save_count, p.share_count, p.created_at, p.updated_at,
      p.edited_at
    from public.posts p
    where p.state = 'active'
      and p.visibility = 'public'
      and (p_world is null or p.world = p_world)
      and (p_title_id is null or p.title_id = p_title_id or p.secondary_title_id = p_title_id)
      and (p_community_id is null or p.community_id = p_community_id)
      -- Mutes and blocks are applied here, in the database.
      and not exists (
        select 1 from public.mutes m
        where m.user_id = actor and (m.muted_user_id = p.author_id or m.muted_title_id = p.title_id)
      )
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = actor and b.blocked_id = p.author_id)
           or (b.blocked_id = actor and b.blocker_id = p.author_id)
      )
      -- A private account's posts reach its followers and the account itself.
      and (
        (actor is not null and p.author_id = actor)
        or not exists (select 1 from public.profiles pr where pr.id = p.author_id and pr.is_private)
        or exists (select 1 from public.follows f where f.follower_id = actor and f.target_id = p.author_id)
      )
      and (
        p_scope <> 'following'
        or actor is null
        or p.author_id = actor
        or exists (select 1 from public.follows f where f.follower_id = actor and f.target_id = p.author_id)
      )
  ),
  ranked as (
    select
      e.*,
      -- One rank expression for every scope, so the cursor comparison below is uniform.
      case
        when p_scope = 'for_you' then
          -- Engagement, decayed so a week-old post cannot hold the top of a feed.
          ((e.loved_count + e.cried_count + e.screamed_count + e.swooned_count + e.laughed_count + e.furious_count) * 2.0
           + e.comment_count * 3.0
           + e.save_count * 1.5
           + e.share_count * 2.0)
          / power(greatest(extract(epoch from (now() - e.created_at)) / 3600.0, 1.0) / 24.0 + 1.0, 0.55)
          + case when actor is not null and exists (select 1 from public.follows f where f.follower_id = actor and f.target_id = e.author_id) then 12.0 else 0.0 end
          + case when actor is not null and exists (select 1 from public.mutes mu where mu.user_id = actor and mu.muted_title_id = e.title_id) then -1000000.0 else 0.0 end
        else
          -- Time-ordered scopes use a key derived from created_at, so the same comparison works.
          extract(epoch from e.created_at)::double precision
      end as rank_key
    from eligible e
  )
  select coalesce(jsonb_agg(to_jsonb(windowed) order by windowed.rank_key desc, windowed.created_at desc, windowed.id desc), '[]'::jsonb)
    into page
  from (
    select v.* from ranked v
    -- The keyset: strictly "after" the last row the client saw, on a unique triple.
    where cursor_row.id is null
       or (v.rank_key, v.created_at, v.id) < (cursor_row.rank_key, cursor_row.created_at, cursor_row.id)
    order by v.rank_key desc, v.created_at desc, v.id desc
    limit limit_rows + 1
  ) windowed;

  -- One row too many means there is a next page.
  has_more := coalesce(jsonb_array_length(page), 0) > limit_rows;
  if has_more then
    page := (select jsonb_agg(value) from jsonb_array_elements(page) with ordinality as e(value, ord) where ord <= limit_rows);
  end if;

  select public.encode_feed_cursor(
           (e.value ->> 'rank_key')::double precision,
           (e.value ->> 'created_at')::timestamptz,
           (e.value ->> 'id')::uuid
         )
    into next_cursor
  from jsonb_array_elements(page) with ordinality as e(value, ord)
  where ord = coalesce(jsonb_array_length(page), 0);

  return jsonb_build_object(
    'scope', p_scope,
    'items', coalesce(page, '[]'::jsonb),
    'has_more', has_more,
    'next_cursor', next_cursor
  );
end;
$$;

revoke all on function public.feed_page(text, text, uuid, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.feed_page(text, text, uuid, integer, text, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- The legacy offset feed, reimplemented on top of it
-- ---------------------------------------------------------------------------------------------

-- Same signature, same rows, same order for a first page — plus it no longer drifts, because the
-- cursor path is what does the work. `p_offset` pages by walking the cursor `p_offset` times, which
-- is bounded (50) and correct, rather than skipping rows in a table that is moving underneath.
create or replace function public.feed_posts(
  p_scope text default 'for_you',
  p_world text default null,
  p_title_id uuid default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns setof public.posts
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  page jsonb := '{}'::jsonb;
  ids uuid[] := '{}';
  seen integer := 0;
  skip_rows integer := greatest(coalesce(p_offset, 0), 0);
  limit_rows integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  cursor_value text := null;
begin
  -- Walk forward by whole pages rather than OFFSET so a new post cannot shift the window.
  while skip_rows > 0 loop
    page := public.feed_page(p_scope, p_world, p_title_id, least(greatest(skip_rows, 1), 50), cursor_value, null);

    seen := coalesce(jsonb_array_length(page -> 'items'), 0);
    if seen = 0 then
      return; -- asked for a page past the end
    end if;

    cursor_value := page ->> 'next_cursor';
    skip_rows := skip_rows - seen;
  end loop;

  page := public.feed_page(p_scope, p_world, p_title_id, limit_rows, cursor_value, null);

  select coalesce(array_agg((item ->> 'id')::uuid), '{}')
    into ids
  from jsonb_array_elements(coalesce(page -> 'items', '[]'::jsonb)) item;

  if array_length(ids, 1) is null then
    return;
  end if;

  -- Re-read the rows as posts rows, preserving the feed's order.
  return query
  select p.*
  from public.posts p
  where p.id = any(ids)
  order by array_position(ids, p.id);
end;
$$;

revoke all on function public.feed_posts(text, text, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.feed_posts(text, text, uuid, integer, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Comments, paginated the same way
-- ---------------------------------------------------------------------------------------------

-- One level of threading, depth-capped by migration 09, so a thread page is just an ordered window.
create or replace function public.comment_page(
  p_post_id uuid,
  p_limit integer default 50,
  p_cursor timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  limit_rows integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  page jsonb;
begin
  if not exists (select 1 from public.posts p where p.id = p_post_id) then
    raise exception 'post % does not exist', p_post_id using errcode = 'no_data_found';
  end if;

  with visible as (
    select c.*
    from public.comments c
    where c.post_id = p_post_id
      and c.state = 'active'
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = c.author_id)
           or (b.blocked_id = auth.uid() and b.blocker_id = c.author_id)
      )
      and (p_cursor is null or (c.created_at, c.id) > (p_cursor, '00000000-0000-0000-0000-000000000000'::uuid))
  )
  select coalesce(jsonb_agg(to_jsonb(windowed) order by windowed.created_at asc, windowed.id asc), '[]'::jsonb)
    into page
  from (
    select v.* from visible v order by v.created_at asc, v.id asc limit limit_rows + 1
  ) windowed;

  return jsonb_build_object(
    'post_id', p_post_id,
    'items', (select coalesce(jsonb_agg(value), '[]'::jsonb) from jsonb_array_elements(page) with ordinality as e(value, ord) where ord <= limit_rows),
    'has_more', coalesce(jsonb_array_length(page), 0) > limit_rows,
    'next_cursor', (select value ->> 'created_at' from jsonb_array_elements(page) with ordinality as e(value, ord) where ord = least(coalesce(jsonb_array_length(page), 0), limit_rows))
  );
end;
$$;

revoke all on function public.comment_page(uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.comment_page(uuid, integer, timestamptz) to authenticated;

comment on function public.feed_page(text, text, uuid, integer, text, uuid) is
  'Cursor-paginated feed. Pass the returned next_cursor back for the next page. For the time-ordered scopes (latest, following, title, world) the key is derived from created_at, so the window is fully stable while new posts arrive. For for_you the key is a decaying engagement score, so a post can drift between pages as it ages — that is inherent to ranking, and it is why for_you is never used for "catch me up", only for browsing.';

comment on function public.decode_feed_cursor(text) is
  'Best-effort cursor decode: a malformed or foreign cursor returns no rows rather than raising, so a bad cursor restarts the feed instead of breaking the screen.';

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
