-- Migration 48: Pre-release security, privacy, and data-integrity fixes
--
-- Covers:
--   1. Unified author visibility helper `public.can_view_author_content` enforced across:
--      - `public.posts` (anon + authenticated RLS)
--      - `public.post_media` (anon + authenticated RLS)
--      - `public.comments` (anon + authenticated RLS)
--      - `public.collections` & `public.collection_items` (anon + authenticated RLS)
--      - `storage.objects` (`bucket_id = 'media'`, closing permissive public/anon bypass + block bypass)
--      - `public.get_post_polls`, `public.vote_post_poll`, `public.get_public_collections`,
--        `public.search_collections`, and `public.get_community_pulse`
--   2. Strict server-side validation on `public.respond_follow_request`:
--      - Requires authenticated target, rejects blocked pairs, atomically claims an existing
--        `'pending'` row addressed to `auth.uid()`, and raises `P0002` (`no_data_found`) if missing
--        or already handled. Never grants follows or sends notifications without a pending request.
--   3. `public.set_block`: also purges pending `public.follow_requests` in both directions.
--   4. `public.send_direct_message` + `public.on_direct_message_notify`:
--      - Removes duplicate inline notification insert in `send_direct_message` so each DM generates
--        exactly 1 recipient notification via `on_direct_message_notify` (0 duplicates, 0 sender copies,
--        0 notifications across blocks).
--   5. `public.delete_account`:
--      - Purges `direct_messages`, `follow_requests`, `hallyu_event_rsvps`, `title_ratings`,
--        `post_poll_votes`, social graph rows, soft-deletes & scrubs authored `posts` + `comments`,
--        anonymizes `profiles`, and raises `no_data_found` if target profile row is absent.

set check_function_bodies = on;

-- ── 1. Unified Author Visibility Helper ──────────────────────────────────────────────────────────
create or replace function public.can_view_author_content(
  p_author_id uuid,
  p_viewer uuid default auth.uid()
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_private boolean;
begin
  if p_author_id is null then
    return false;
  end if;

  if p_viewer is not null and p_viewer = p_author_id then
    return true;
  end if;

  if p_viewer is not null and public.is_moderator() then
    return true;
  end if;

  if p_viewer is not null and exists (
    select 1
    from public.blocks b
    where (b.blocker_id = p_viewer and b.blocked_id = p_author_id)
       or (b.blocker_id = p_author_id and b.blocked_id = p_viewer)
  ) then
    return false;
  end if;

  select pr.account_status::text, pr.is_private
    into v_status, v_private
  from public.profiles pr
  where pr.id = p_author_id;

  if not found or v_status <> 'active' then
    return false;
  end if;

  if not coalesce(v_private, false) then
    return true;
  end if;

  if p_viewer is null then
    return false;
  end if;

  return exists (
    select 1
    from public.follows f
    where f.follower_id = p_viewer
      and f.target_id = p_author_id
  );
end;
$$;

grant execute on function public.can_view_author_content(uuid, uuid) to anon, authenticated, service_role;

-- ── 2. RLS on `public.posts` ─────────────────────────────────────────────────────────────────────
drop policy if exists posts_select_anonymous on public.posts;
create policy posts_select_anonymous
  on public.posts
  for select
  to anon
  using (
    state = 'active'::public.content_state
    and visibility = 'public'::public.visibility
    and public.can_view_author_content(author_id, null)
  );

drop policy if exists posts_select_visible on public.posts;
create policy posts_select_visible
  on public.posts
  for select
  to authenticated
  using (
    author_id = auth.uid()
    or public.is_moderator()
    or (
      state = 'active'::public.content_state
      and public.can_view_author_content(author_id, auth.uid())
      and (
        visibility = 'public'::public.visibility
        or (
          community_id is not null
          and exists (
            select 1
            from public.community_members cm
            where cm.community_id = posts.community_id
              and cm.user_id = auth.uid()
              and cm.status = 'active'
          )
        )
      )
    )
  );

-- ── 3. RLS on `public.post_media` ────────────────────────────────────────────────────────────────
drop policy if exists post_media_select_anonymous on public.post_media;
create policy post_media_select_anonymous
  on public.post_media
  for select
  to anon
  using (
    exists (
      select 1
      from public.posts p
      where p.id = post_media.post_id
        and p.state = 'active'::public.content_state
        and p.visibility = 'public'::public.visibility
        and public.can_view_author_content(p.author_id, null)
    )
  );

drop policy if exists post_media_select_with_post on public.post_media;
create policy post_media_select_with_post
  on public.post_media
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.posts p
      where p.id = post_media.post_id
    )
  );

-- ── 4. RLS on `public.comments` ──────────────────────────────────────────────────────────────────
drop policy if exists comments_select_anonymous on public.comments;
create policy comments_select_anonymous
  on public.comments
  for select
  to anon
  using (
    state = 'active'::public.content_state
    and public.can_view_author_content(author_id, null)
    and exists (
      select 1
      from public.posts p
      where p.id = comments.post_id
        and p.state = 'active'::public.content_state
        and p.visibility = 'public'::public.visibility
        and public.can_view_author_content(p.author_id, null)
    )
  );

drop policy if exists comments_select_visible on public.comments;
create policy comments_select_visible
  on public.comments
  for select
  to authenticated
  using (
    author_id = auth.uid()
    or public.is_moderator()
    or (
      state = 'active'::public.content_state
      and not exists (
        select 1
        from public.blocks b
        where (b.blocker_id = auth.uid() and b.blocked_id = comments.author_id)
           or (b.blocker_id = comments.author_id and b.blocked_id = auth.uid())
      )
      and exists (
        select 1
        from public.posts p
        where p.id = comments.post_id
      )
    )
  );

-- ── 5. RLS on `public.collections` & `public.collection_items` ───────────────────────────────────
drop policy if exists collections_select_anonymous on public.collections;
create policy collections_select_anonymous
  on public.collections
  for select
  to anon
  using (
    visibility = 'public'::public.visibility
    and public.can_view_author_content(owner_id, null)
  );

drop policy if exists collections_select_visible on public.collections;
create policy collections_select_visible
  on public.collections
  for select
  to authenticated
  using (
    owner_id = auth.uid()
    or public.is_moderator()
    or (
      visibility = 'public'::public.visibility
      and public.can_view_author_content(owner_id, auth.uid())
    )
  );

drop policy if exists collections_select_followed on public.collections;
create policy collections_select_followed
  on public.collections
  for select
  to authenticated
  using (
    public.can_view_author_content(owner_id, auth.uid())
    and exists (
      select 1
      from public.collection_follows f
      where f.collection_id = collections.id
        and f.user_id = auth.uid()
    )
  );

drop policy if exists collection_items_select_anonymous on public.collection_items;
create policy collection_items_select_anonymous
  on public.collection_items
  for select
  to anon
  using (
    exists (
      select 1
      from public.collections c
      where c.id = collection_items.collection_id
        and c.visibility = 'public'::public.visibility
        and public.can_view_author_content(c.owner_id, null)
    )
  );

drop policy if exists collection_items_select_visible on public.collection_items;
create policy collection_items_select_visible
  on public.collection_items
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.collections c
      where c.id = collection_items.collection_id
    )
  );

-- ── 6. Storage RLS (`storage.objects` in `media` bucket) ─────────────────────────────────────────
drop policy if exists media_read_attached_or_avatar_public on storage.objects;
drop policy if exists media_read_own_or_attached on storage.objects;
drop policy if exists media_read_own on storage.objects;
drop policy if exists media_read_authorized on storage.objects;

create policy media_read_own
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'media'
    and public.storage_owner(name) = auth.uid()
  );

create policy media_read_authorized
  on storage.objects
  for select
  to anon, authenticated
  using (
    bucket_id = 'media'
    and (
      name like 'catalog/%'
      or exists (
        select 1
        from public.profiles pr
        where pr.avatar_path = objects.name
          and pr.account_status = 'active'
          and (
            auth.uid() is null
            or pr.id = auth.uid()
            or public.is_moderator()
            or not exists (
              select 1
              from public.blocks b
              where (b.blocker_id = auth.uid() and b.blocked_id = pr.id)
                 or (b.blocker_id = pr.id and b.blocked_id = auth.uid())
            )
          )
      )
      or exists (
        select 1
        from public.post_media pm
        join public.posts p on p.id = pm.post_id
        where (pm.storage_path = objects.name or pm.poster_path = objects.name)
          and (
            (auth.uid() is not null and (p.author_id = auth.uid() or public.is_moderator()))
            or (
              p.state = 'active'::public.content_state
              and public.can_view_author_content(p.author_id, auth.uid())
              and (
                p.visibility = 'public'::public.visibility
                or (
                  auth.uid() is not null
                  and p.community_id is not null
                  and exists (
                    select 1
                    from public.community_members cm
                    where cm.community_id = p.community_id
                      and cm.user_id = auth.uid()
                      and cm.status = 'active'
                  )
                )
              )
            )
          )
      )
    )
  );

-- ── 7. Security-Definer RPCs Aligned to Author Privacy & Blocks ─────────────────────────────────
create or replace function public.get_post_polls(p_post_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_object_agg(
      q.post_id::text,
      jsonb_build_object(
        'post_id', q.post_id,
        'question', q.question,
        'options', q.options,
        'counts', q.counts,
        'total_votes', q.total_votes,
        'my_vote', q.my_vote,
        'closes_at', q.closes_at
      )
    ),
    '{}'::jsonb
  )
  from (
    select
      pp.post_id,
      pp.question,
      pp.options,
      pp.closes_at,
      coalesce(
        (
          select array_agg(coalesce(v.cnt, 0) order by idx.i)
          from generate_series(0, cardinality(pp.options) - 1) as idx(i)
          left join (
            select option_index::integer as opt, count(*)::integer as cnt
            from public.post_poll_votes pv
            where pv.post_id = pp.post_id
            group by option_index
          ) v on v.opt = idx.i
        ),
        '{}'::integer[]
      ) as counts,
      (
        select count(*)::integer
        from public.post_poll_votes pv
        where pv.post_id = pp.post_id
      ) as total_votes,
      (
        select pv.option_index::integer
        from public.post_poll_votes pv
        where pv.post_id = pp.post_id
          and pv.user_id = auth.uid()
        limit 1
      ) as my_vote
    from public.post_polls pp
    join public.posts p on p.id = pp.post_id
    where pp.post_id = any(coalesce(p_post_ids, '{}'::uuid[]))
      and (
        (auth.uid() is not null and (p.author_id = auth.uid() or public.is_moderator()))
        or (
          p.state = 'active'::public.content_state
          and public.can_view_author_content(p.author_id, auth.uid())
        )
      )
  ) q;
$$;

create or replace function public.vote_post_poll(p_post_id uuid, p_option_index integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_poll public.post_polls%rowtype;
  v_author uuid;
  v_state public.content_state;
  v_counts integer[];
  v_total integer;
begin
  if v_uid is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select pp.* into v_poll
  from public.post_polls pp
  where pp.post_id = p_post_id;

  if not found then
    raise exception 'poll_not_found' using errcode = 'P0002';
  end if;

  select p.author_id, p.state into v_author, v_state
  from public.posts p
  where p.id = p_post_id;

  if not found or v_state <> 'active'::public.content_state or not public.can_view_author_content(v_author, v_uid) then
    raise exception 'poll_not_visible' using errcode = '42501';
  end if;

  if v_poll.closes_at is not null and v_poll.closes_at <= now() then
    raise exception 'poll_closed' using errcode = '22023';
  end if;

  if p_option_index < 0 or p_option_index >= cardinality(v_poll.options) then
    raise exception 'invalid_poll_option' using errcode = '22023';
  end if;

  insert into public.post_poll_votes (post_id, user_id, option_index)
  values (p_post_id, v_uid, p_option_index::smallint)
  on conflict (post_id, user_id) do update
    set option_index = excluded.option_index,
        created_at = now();

  select
    array_agg(coalesce(v.cnt, 0) order by idx.i),
    coalesce(sum(v.cnt), 0)::integer
  into v_counts, v_total
  from generate_series(0, cardinality(v_poll.options) - 1) as idx(i)
  left join (
    select option_index::integer as opt, count(*)::integer as cnt
    from public.post_poll_votes
    where post_id = p_post_id
    group by option_index
  ) v on v.opt = idx.i;

  return jsonb_build_object(
    'post_id', p_post_id,
    'question', v_poll.question,
    'options', v_poll.options,
    'counts', coalesce(v_counts, '{}'::integer[]),
    'total_votes', coalesce(v_total, 0),
    'my_vote', p_option_index,
    'closes_at', v_poll.closes_at
  );
end;
$$;

create or replace function public.get_public_collections(p_limit integer default 40)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  capped integer := least(greatest(coalesce(p_limit, 40), 1), 80);
  viewer uuid := auth.uid();
begin
  return jsonb_build_object(
    'collections', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'collection', to_jsonb(c),
          'owner', jsonb_build_object(
            'id', o.id,
            'handle', o.handle,
            'display_name', o.display_name,
            'avatar_path', o.avatar_path,
            'verified', o.verified,
            'worlds', o.worlds
          ),
          'items', coalesce((
            select jsonb_agg(to_jsonb(ci) order by ci.position asc, ci.added_at asc)
            from public.collection_items ci
            where ci.collection_id = c.id
          ), '[]'::jsonb)
        )
        order by c.follower_count desc, c.updated_at desc, c.id asc
      )
      from (
        select c.*
        from public.collections c
        join public.profiles po on po.id = c.owner_id
        where c.visibility = 'public'
          and po.account_status = 'active'
          and public.can_view_author_content(c.owner_id, viewer)
        order by c.follower_count desc, c.updated_at desc, c.id asc
        limit capped
      ) c
      join public.profiles o on o.id = c.owner_id
    ), '[]'::jsonb),
    'titles', coalesce((
      select jsonb_agg(to_jsonb(t))
      from public.titles t
      where t.id in (
        select ci.title_id
        from public.collection_items ci
        join public.collections c on c.id = ci.collection_id
        where c.visibility = 'public'
          and public.can_view_author_content(c.owner_id, viewer)
      )
    ), '[]'::jsonb)
  );
end;
$$;

drop function if exists public.search_collections(text, integer, integer);
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
    and pr.account_status = 'active'
    and (
      c.owner_id = auth.uid()
      or (
        public.can_view_author_content(c.owner_id, auth.uid())
        and (
          c.visibility = 'public'
          or exists (
            select 1 from public.collection_follows f
            where f.collection_id = c.id and f.user_id = auth.uid()
          )
        )
      )
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

create or replace function public.get_community_pulse(p_world text default null::text, p_limit integer default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  viewer uuid := auth.uid();
  capped integer := least(greatest(coalesce(p_limit, 12), 1), 30);
begin
  return jsonb_build_object(
    'communities', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'community', to_jsonb(c),
          'is_member', case
            when viewer is null then false
            else exists (
              select 1 from public.community_members cm
              where cm.community_id = c.id and cm.user_id = viewer and cm.status = 'active'
            )
          end
        )
        order by c.member_count desc, c.post_count desc, c.id asc
      )
      from (
        select c.*
        from public.communities c
        where (p_world is null or c.fandom = p_world)
        order by c.member_count desc, c.post_count desc, c.id asc
        limit 24
      ) c
    ), '[]'::jsonb),
    'most_discussed', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'title', to_jsonb(d.t),
          'post_count', d.post_count,
          'watchlist_count', d.watchlist_count
        )
        order by d.score desc, (d.t).id asc
      )
      from (
        select
          t,
          pc.cnt as post_count,
          wc.cnt as watchlist_count,
          (coalesce(pc.cnt, 0) * 12 + coalesce(wc.cnt, 0) * 5 + coalesce(t.follower_count, 0) * 3 + public.catalog_relevance_score(t)) as score
        from public.titles t
        left join lateral (
          select count(*)::integer as cnt
          from public.posts p
          join public.profiles pr on pr.id = p.author_id
          where p.title_id = t.id
            and p.state = 'active'
            and p.visibility = 'public'
            and pr.account_status = 'active'
            and not pr.is_private
        ) pc on true
        left join lateral (
          select count(*)::integer as cnt
          from public.watchlist_items w
          where w.title_id = t.id
        ) wc on true
        where public.catalog_lifecycle_of(t) <> 'unavailable'
          and (p_world is null or t.world = p_world)
        order by score desc, t.id asc
        limit capped
      ) d
    ), '[]'::jsonb),
    'rising_tags', coalesce((
      select jsonb_agg(
        jsonb_build_object('tag', rt.tag, 'post_count', rt.post_count)
        order by rt.post_count desc, rt.tag asc
      )
      from (
        select lower(btrim(tag_raw)) as tag, count(*)::integer as post_count
        from public.posts p
        join public.profiles pr on pr.id = p.author_id,
             lateral unnest(p.hashtags) as tag_raw
        where p.state = 'active'
          and p.visibility = 'public'
          and pr.account_status = 'active'
          and not pr.is_private
          and (p_world is null or p.world = p_world)
          and length(btrim(tag_raw)) > 0
        group by lower(btrim(tag_raw))
        order by count(*) desc, lower(btrim(tag_raw)) asc
        limit capped
      ) rt
    ), '[]'::jsonb),
    'top_voices', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', v.id,
          'handle', v.handle,
          'display_name', v.display_name,
          'bio', v.bio,
          'avatar_path', v.avatar_path,
          'banner_url', v.banner_url,
          'verified', v.verified,
          'role', v.role,
          'worlds', v.worlds,
          'favorite_genres', v.favorite_genres,
          'favorite_title_ids', v.favorite_title_ids,
          'follower_count', v.follower_count,
          'following_count', v.following_count,
          'post_count', v.post_count
        )
        order by v.follower_count desc, v.post_count desc, v.id asc
      )
      from (
        select pr.*
        from public.profiles pr
        where pr.account_status = 'active'
          and not pr.is_private
          and pr.handle not like 'verify_%'
          and (p_world is null or p_world = any(pr.worlds))
          and (viewer is null or not exists (
            select 1 from public.blocks b
            where (b.blocker_id = viewer and b.blocked_id = pr.id)
               or (b.blocker_id = pr.id and b.blocked_id = viewer)
          ))
        order by pr.follower_count desc, pr.post_count desc, pr.id asc
        limit capped
      ) v
    ), '[]'::jsonb)
  );
end;
$$;

-- ── 8. `public.set_block` & `public.respond_follow_request` ──────────────────────────────────────
create or replace function public.set_block(p_user_id uuid, p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_user_id = actor then
    raise exception 'you cannot block yourself' using errcode = 'check_violation';
  end if;

  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'profile % does not exist', p_user_id using errcode = 'no_data_found';
  end if;

  if p_on then
    insert into public.blocks (blocker_id, blocked_id) values (actor, p_user_id) on conflict do nothing;
    delete from public.follows
    where (follower_id = actor and target_id = p_user_id)
       or (follower_id = p_user_id and target_id = actor);
    delete from public.follow_requests
    where (requester_id = actor and target_id = p_user_id)
       or (requester_id = p_user_id and target_id = actor);
    return true;
  end if;

  delete from public.blocks where blocker_id = actor and blocked_id = p_user_id;
  return false;
end;
$$;

create or replace function public.respond_follow_request(p_requester_id uuid, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  v_request_id uuid;
  actor_handle text;
  actor_name text;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_requester_id is null or p_requester_id = actor then
    raise exception 'invalid follow request target' using errcode = 'invalid_parameter_value';
  end if;

  if exists (
    select 1
    from public.blocks b
    where (b.blocker_id = actor and b.blocked_id = p_requester_id)
       or (b.blocker_id = p_requester_id and b.blocked_id = actor)
  ) then
    delete from public.follow_requests
    where (requester_id = p_requester_id and target_id = actor)
       or (requester_id = actor and target_id = p_requester_id);
    raise exception 'cannot respond to blocked member follow request' using errcode = 'insufficient_privilege';
  end if;

  -- Atomically claim an actual pending request addressed specifically to `actor`.
  -- If no pending request exists (never created, already accepted/rejected, or addressed to someone else),
  -- fail immediately with P0002 without mutating `follows` or fabricating notifications.
  delete from public.follow_requests
  where requester_id = p_requester_id
    and target_id = actor
    and status = 'pending'
  returning id into v_request_id;

  if v_request_id is null then
    raise exception 'no pending follow request from %', p_requester_id using errcode = 'no_data_found';
  end if;

  if coalesce(p_accept, false) then
    insert into public.follows (follower_id, target_id)
    values (p_requester_id, actor)
    on conflict do nothing;

    select handle, display_name into actor_handle, actor_name
    from public.profiles
    where id = actor;

    perform public.enqueue_notification(
      p_recipient := p_requester_id,
      p_kind := 'follow',
      p_group := 'social',
      p_dedupe_key := 'follow_accept:' || v_request_id::text,
      p_actor_ids := array[actor],
      p_title := coalesce(actor_name, '@' || actor_handle) || ' accepted your follow request',
      p_deep_link := '/user/' || actor_handle
    );
  end if;

  return jsonb_build_object(
    'request_id', v_request_id,
    'accepted', coalesce(p_accept, false)
  );
end;
$$;

revoke all on function public.respond_follow_request(uuid, boolean) from public, anon;
grant execute on function public.respond_follow_request(uuid, boolean) to authenticated, service_role;

-- ── 9. Direct Message Notification Single-Source Trigger ─────────────────────────────────────────
create or replace function public.on_direct_message_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sender public.profiles%rowtype;
begin
  if new.recipient_id is null or new.recipient_id = new.sender_id then
    return new;
  end if;

  if exists (
    select 1
    from public.blocks b
    where (b.blocker_id = new.recipient_id and b.blocked_id = new.sender_id)
       or (b.blocker_id = new.sender_id and b.blocked_id = new.recipient_id)
  ) then
    return new;
  end if;

  select * into v_sender
  from public.profiles
  where id = new.sender_id;

  perform public.enqueue_notification(
    p_recipient := new.recipient_id,
    p_kind := 'mention',
    p_group := 'social',
    p_dedupe_key := 'dm:' || new.id::text,
    p_actor_ids := array[new.sender_id],
    p_post_id := new.shared_post_id,
    p_title := coalesce(nullif(v_sender.display_name, ''), '@' || coalesce(v_sender.handle, 'member')) || ' sent you a message',
    p_body := left(coalesce(nullif(btrim(new.body), ''), 'Shared something with you on Hallyu'), 140),
    p_deep_link := case
      when v_sender.handle is not null then '/messages/' || v_sender.handle
      else '/messages'
    end
  );

  return new;
end;
$$;

drop trigger if exists direct_messages_notify_after_insert on public.direct_messages;
create trigger direct_messages_notify_after_insert
  after insert on public.direct_messages
  for each row
  execute function public.on_direct_message_notify();

create or replace function public.send_direct_message(
  p_recipient_handle text,
  p_body text,
  p_shared_drama_id text default null,
  p_shared_post_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_peer public.profiles%rowtype;
  v_msg public.direct_messages%rowtype;
  v_clean text := left(btrim(coalesce(p_body, '')), 2000);
  v_drama text := nullif(btrim(coalesce(p_shared_drama_id, '')), '');
begin
  if v_uid is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  if char_length(v_clean) < 1 and v_drama is null and p_shared_post_id is null then
    raise exception 'empty_message' using errcode = '22023';
  end if;

  select * into v_peer
  from public.profiles
  where lower(handle) = lower(regexp_replace(btrim(coalesce(p_recipient_handle, '')), '^@', ''))
    and account_status = 'active';

  if not found then
    raise exception 'recipient_not_found' using errcode = 'P0002';
  end if;

  if v_peer.id = v_uid then
    raise exception 'cannot_message_self' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.blocks b
    where (b.blocker_id = v_uid and b.blocked_id = v_peer.id)
       or (b.blocker_id = v_peer.id and b.blocked_id = v_uid)
  ) then
    raise exception 'blocked_conversation' using errcode = '42501';
  end if;

  if p_shared_post_id is not null and not exists (
    select 1
    from public.posts p
    where p.id = p_shared_post_id
      and (
        p.author_id = v_uid
        or (
          p.state = 'active'::public.content_state
          and public.can_view_author_content(p.author_id, v_uid)
        )
      )
  ) then
    raise exception 'shared_post_not_visible' using errcode = '42501';
  end if;

  -- `direct_messages_notify_after_insert` emits the single deduplicated notification & push delivery.
  insert into public.direct_messages (
    sender_id,
    recipient_id,
    body,
    shared_drama_id,
    shared_post_id
  )
  values (
    v_uid,
    v_peer.id,
    coalesce(nullif(v_clean, ''), 'Shared on Hallyu'),
    v_drama,
    p_shared_post_id
  )
  returning * into v_msg;

  return jsonb_build_object(
    'id', v_msg.id,
    'sender_id', v_msg.sender_id,
    'recipient_id', v_msg.recipient_id,
    'body', v_msg.body,
    'shared_drama_id', v_msg.shared_drama_id,
    'shared_post_id', v_msg.shared_post_id,
    'read_at', v_msg.read_at,
    'created_at', v_msg.created_at
  );
end;
$$;

revoke all on function public.send_direct_message(text, text, text, uuid) from public, anon;
grant execute on function public.send_direct_message(text, text, text, uuid) to authenticated, service_role;

create or replace function public.send_direct_message(p_recipient_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sender uuid := auth.uid();
  v_clean text := trim(coalesce(p_body, ''));
  v_row public.direct_messages;
begin
  if v_sender is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_recipient_id is null or p_recipient_id = v_sender then
    raise exception 'Choose another member to message' using errcode = '22023';
  end if;
  if char_length(v_clean) < 1 or char_length(v_clean) > 2000 then
    raise exception 'Message must be between 1 and 2000 characters' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.profiles
    where id = p_recipient_id
      and account_status = 'active'
  ) then
    raise exception 'Recipient profile is not available' using errcode = 'P0002';
  end if;
  if exists (
    select 1
    from public.blocks b
    where (b.blocker_id = v_sender and b.blocked_id = p_recipient_id)
       or (b.blocker_id = p_recipient_id and b.blocked_id = v_sender)
  ) then
    raise exception 'Cannot message this account' using errcode = '42501';
  end if;

  -- `direct_messages_notify_after_insert` creates the single deduplicated notification & push delivery.
  insert into public.direct_messages (sender_id, recipient_id, body)
  values (v_sender, p_recipient_id, v_clean)
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.send_direct_message(uuid, text) from public, anon;
grant execute on function public.send_direct_message(uuid, text) to authenticated, service_role;

-- ── 10. Honest, Complete `public.delete_account()` ───────────────────────────────────────────────
create or replace function public.delete_account()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  removed_paths text[] := '{}';
  removed_count integer := 0;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.profiles where id = actor) then
    raise exception 'account profile not found' using errcode = 'no_data_found';
  end if;

  -- Queue every member-owned Storage object before removing DB metadata rows so nothing outlives the account.
  select coalesce(array_agg(path), '{}') into removed_paths
  from (
    select m.storage_path as path
    from public.post_media m
    join public.posts p on p.id = m.post_id
    where p.author_id = actor
    union
    select m.poster_path
    from public.post_media m
    join public.posts p on p.id = m.post_id
    where p.author_id = actor and m.poster_path is not null
    union
    select u.storage_path
    from public.media_uploads u
    where u.user_id = actor
    union
    select u.poster_path
    from public.media_uploads u
    where u.user_id = actor and u.poster_path is not null
    union
    select avatar_path from public.profiles where id = actor and avatar_path is not null
    union
    select name from storage.objects where bucket_id = 'media' and public.storage_owner(name) = actor
  ) paths;

  removed_count := public.queue_media_removal(removed_paths, 'account_deleted', actor);

  delete from public.direct_messages where sender_id = actor or recipient_id = actor;
  delete from public.follow_requests where requester_id = actor or target_id = actor;
  delete from public.hallyu_event_rsvps where user_id = actor;
  delete from public.title_ratings where user_id = actor;
  delete from public.post_poll_votes where user_id = actor;
  delete from public.notifications where recipient_id = actor;
  delete from public.notification_deliveries d
    where not exists (select 1 from public.notifications n where n.id = d.notification_id);
  delete from public.push_tokens where user_id = actor;
  delete from public.title_alerts where user_id = actor;
  delete from public.watchlist_items where user_id = actor;
  delete from public.saves where user_id = actor;
  delete from public.reactions where user_id = actor;
  delete from public.community_members where user_id = actor;
  delete from public.collection_follows where user_id = actor;
  delete from public.person_follows where user_id = actor;
  delete from public.title_follows where user_id = actor;
  delete from public.follows where follower_id = actor or target_id = actor;
  delete from public.blocks where blocker_id = actor or blocked_id = actor;
  delete from public.mutes where user_id = actor or muted_user_id = actor;
  delete from public.reports where reporter_id = actor;
  delete from public.user_preferences where user_id = actor;
  delete from public.collections where owner_id = actor;
  delete from public.analytics_events where user_id = actor;
  delete from public.media_uploads where user_id = actor;
  delete from public.post_shares where user_id = actor;
  delete from public.post_media where post_id in (select id from public.posts where author_id = actor);

  update public.comments
     set state = 'deleted'::public.content_state,
         deleted_at = coalesce(deleted_at, now()),
         body = '[deleted]'
   where author_id = actor;

  update public.posts
     set state = 'deleted'::public.content_state,
         deleted_at = coalesce(deleted_at, now()),
         title = null,
         body = '[deleted]',
         verdict = null,
         hashtags = '{}',
         mentions = '{}'
   where author_id = actor;

  update public.posts
     set mentions = array_remove(mentions, actor)
   where actor = any(mentions);

  update public.profiles
     set account_status = 'deleted',
         deleted_at = coalesce(deleted_at, now()),
         handle = 'deleted_' || substr(replace(actor::text, '-', ''), 1, 16),
         display_name = 'Deleted member',
         bio = null,
         avatar_path = null,
         banner_url = null,
         is_private = true,
         worlds = '{}',
         favorite_genres = '{}',
         onboarding_genres = '{}',
         favorite_title_ids = '{}'
   where id = actor;

  if not found then
    raise exception 'account deletion failed to update profile' using errcode = 'no_data_found';
  end if;

  return jsonb_build_object(
    'deleted', true,
    'user_id', actor,
    'media_objects_queued', removed_count,
    'deleted_at', now()
  );
end;
$$;

revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated, service_role;

create or replace function public.get_latest_app_release()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select to_jsonb(r)
      from public.app_releases r
      order by r.version_code desc
      limit 1
    ),
    jsonb_build_object(
      'version_code', 10004,
      'version_name', '1.0.211',
      'apk_url', 'https://kzxlbscfkixnswurpkzb.supabase.co/storage/v1/object/public/app-releases/latest/hallyu-arm64.apk',
      'universal_apk_url', 'https://kzxlbscfkixnswurpkzb.supabase.co/storage/v1/object/public/app-releases/latest/hallyu-armeabi-v7a.apk',
      'release_notes', 'Signed production release.',
      'is_mandatory', false,
      'min_supported_version', 1
    )
  );
$$;

grant execute on function public.get_latest_app_release() to anon, authenticated, service_role;

