-- =============================================================================================
-- 45 · Profile, Thread & Pulse Profile Field Completeness (`banner_url` + `role`)
-- =============================================================================================
-- Ensures `get_profile_by_handle`, `get_post_thread`, and `get_community_pulse` include
-- `banner_url` and `role` on returned profile JSON objects so hydrating a profile or thread
-- never drops a member's custom cover banner or staff/admin role (`@ceohallyu`).
-- =============================================================================================

create or replace function public.get_profile_by_handle(p_handle text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  viewer uuid := auth.uid();
  target public.profiles%rowtype;
  following_them boolean := false;
  blocked_either boolean := false;
  viewer_blocked boolean := false;
  can_view boolean := false;
begin
  if p_handle is null or btrim(p_handle) = '' then
    return null;
  end if;

  select * into target
    from public.profiles
   where handle = lower(btrim(p_handle))
     and account_status = 'active';

  if target.id is null then
    return null;
  end if;

  if viewer is not null then
    following_them := exists (
      select 1 from public.follows f
      where f.follower_id = viewer and f.target_id = target.id
    );
    viewer_blocked := exists (
      select 1 from public.blocks b
      where b.blocker_id = viewer and b.blocked_id = target.id
    );
    blocked_either := viewer_blocked or exists (
      select 1 from public.blocks b
      where b.blocker_id = target.id and b.blocked_id = viewer
    );
  end if;

  can_view := not blocked_either and (
    not target.is_private
    or viewer = target.id
    or following_them
  );

  return jsonb_build_object(
    'profile', jsonb_build_object(
      'id', target.id,
      'handle', target.handle,
      'display_name', target.display_name,
      'bio', target.bio,
      'avatar_path', target.avatar_path,
      'banner_url', target.banner_url,
      'verified', target.verified,
      'is_private', target.is_private,
      'role', target.role,
      'worlds', target.worlds,
      'favorite_genres', target.favorite_genres,
      'favorite_title_ids', target.favorite_title_ids,
      'follower_count', target.follower_count,
      'following_count', target.following_count,
      'post_count', target.post_count,
      'created_at', target.created_at
    ),
    'is_following', following_them,
    'is_blocked', viewer_blocked,
    'can_view', can_view,
    'completed_count', case
      when can_view then (
        select count(*) from public.watchlist_items w
        where w.user_id = target.id and w.status = 'completed'
      )
      else 0
    end,
    'watching', case
      when can_view then coalesce((
        select jsonb_agg(jsonb_build_object('item', to_jsonb(w), 'title', to_jsonb(t)) order by w.updated_at desc)
        from public.watchlist_items w
        join public.titles t on t.id = w.title_id
        where w.user_id = target.id and w.status = 'watching'
      ), '[]'::jsonb)
      else '[]'::jsonb
    end,
    'favorites', case
      when can_view then coalesce((
        select jsonb_agg(to_jsonb(t))
        from public.titles t
        where t.id = any(target.favorite_title_ids)
      ), '[]'::jsonb)
      else '[]'::jsonb
    end,
    'collections', case
      when can_view then coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'collection', to_jsonb(c),
            'items', coalesce((
              select jsonb_agg(to_jsonb(ci) order by ci.position asc, ci.added_at asc)
              from public.collection_items ci
              where ci.collection_id = c.id
            ), '[]'::jsonb)
          )
          order by c.updated_at desc, c.id asc
        )
        from public.collections c
        where c.owner_id = target.id
          and (c.visibility = 'public' or viewer = target.id)
      ), '[]'::jsonb)
      else '[]'::jsonb
    end,
    'posts', case
      when can_view then coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'post', to_jsonb(p),
            'media', coalesce((
              select jsonb_agg(to_jsonb(pm) order by pm.position asc)
              from public.post_media pm
              where pm.post_id = p.id
            ), '[]'::jsonb),
            'title', (select to_jsonb(t1) from public.titles t1 where t1.id = p.title_id),
            'secondary_title', (select to_jsonb(t2) from public.titles t2 where t2.id = p.secondary_title_id)
          )
          order by p.created_at desc, p.id asc
        )
        from (
          select p.*
          from public.posts p
          where p.author_id = target.id
            and p.state = 'active'
            and (p.visibility = 'public' or viewer = target.id or following_them)
          order by p.created_at desc, p.id asc
          limit 40
        ) p
      ), '[]'::jsonb)
      else '[]'::jsonb
    end
  );
end;
$$;

grant execute on function public.get_profile_by_handle(text) to anon, authenticated, service_role;

create or replace function public.get_post_thread(
  p_post_id uuid,
  p_comment_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  viewer uuid := auth.uid();
  p public.posts%rowtype;
  a public.profiles%rowtype;
  capped integer := least(greatest(coalesce(p_comment_limit, 100), 1), 200);
begin
  if p_post_id is null then
    return null;
  end if;

  select * into p
    from public.posts
   where id = p_post_id
     and state = 'active';

  if p.id is null then
    return null;
  end if;

  select * into a from public.profiles where id = p.author_id;

  if viewer is not null and exists (
    select 1 from public.blocks b
    where (b.blocker_id = viewer and b.blocked_id = p.author_id)
       or (b.blocker_id = p.author_id and b.blocked_id = viewer)
  ) then
    return null;
  end if;

  if (a.is_private or p.visibility = 'private')
     and (viewer is null or (
       viewer <> p.author_id
       and not exists (
         select 1 from public.follows f
         where f.follower_id = viewer and f.target_id = p.author_id
       )
     )) then
    return null;
  end if;

  return jsonb_build_object(
    'post', to_jsonb(p),
    'author', jsonb_build_object(
      'id', a.id,
      'handle', a.handle,
      'display_name', a.display_name,
      'bio', a.bio,
      'avatar_path', a.avatar_path,
      'banner_url', a.banner_url,
      'verified', a.verified,
      'is_private', a.is_private,
      'role', a.role,
      'worlds', a.worlds,
      'favorite_genres', a.favorite_genres,
      'favorite_title_ids', a.favorite_title_ids,
      'follower_count', a.follower_count,
      'following_count', a.following_count
    ),
    'media', coalesce((
      select jsonb_agg(to_jsonb(pm) order by pm.position asc)
      from public.post_media pm
      where pm.post_id = p.id
    ), '[]'::jsonb),
    'title', (select to_jsonb(t1) from public.titles t1 where t1.id = p.title_id),
    'secondary_title', (select to_jsonb(t2) from public.titles t2 where t2.id = p.secondary_title_id),
    'viewer_reaction', case
      when viewer is null then null
      else (select r.kind::text from public.reactions r where r.user_id = viewer and r.post_id = p.id limit 1)
    end,
    'viewer_saved', case
      when viewer is null then false
      else exists (select 1 from public.saves s where s.user_id = viewer and s.post_id = p.id)
    end,
    'comments', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'comment', to_jsonb(c),
          'author', jsonb_build_object(
            'id', ca.id,
            'handle', ca.handle,
            'display_name', ca.display_name,
            'avatar_path', ca.avatar_path,
            'banner_url', ca.banner_url,
            'verified', ca.verified,
            'role', ca.role,
            'worlds', ca.worlds
          ),
          'viewer_reaction', case
            when viewer is null then null
            else (select cr.kind::text from public.reactions cr where cr.user_id = viewer and cr.comment_id = c.id limit 1)
          end
        )
        order by c.created_at asc, c.id asc
      )
      from (
        select c.*
        from public.comments c
        where c.post_id = p.id
          and c.state = 'active'
          and (viewer is null or not exists (
            select 1 from public.blocks b
            where (b.blocker_id = viewer and b.blocked_id = c.author_id)
               or (b.blocker_id = c.author_id and b.blocked_id = viewer)
          ))
        order by c.created_at asc, c.id asc
        limit capped
      ) c
      join public.profiles ca on ca.id = c.author_id
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.get_post_thread(uuid, integer) to anon, authenticated, service_role;

create or replace function public.get_community_pulse(
  p_world text default null,
  p_limit integer default 12
)
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
          where p.title_id = t.id and p.state = 'active'
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
        from public.posts p,
             lateral unnest(p.hashtags) as tag_raw
        where p.state = 'active'
          and p.visibility = 'public'
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

grant execute on function public.get_community_pulse(text, integer) to anon, authenticated, service_role;
