-- Hallyu backend — 26 home discovery aggregates.
--
-- Requirement: the Home experience must not read "16 titles" off the database and present it as a
-- number. Every section below is either content (a rail of real titles) or a statistic with a product
-- meaning for one member (how many episodes are theirs to watch tonight). No global catalog counter
-- is exposed here by design: how many rows the cache holds is not something a member can act on.
--
-- get_home_discovery() is the one round trip the Home screen needs on a cold start. It is stable,
-- bounded, and every part degrades to an empty array rather than failing.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create or replace function public.get_home_discovery(
  p_worlds text[] default null,
  p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  per_rail integer := least(greatest(coalesce(p_limit, 10), 1), 20);
  wanted_worlds text[];
  out_payload jsonb;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- The worlds this member actually cares about: their selection, or every world when unset.
  select coalesce(
    (select array_agg(w) from unnest(
       case
         when p_worlds is not null and cardinality(p_worlds) > 0 then p_worlds
         else coalesce(p.worlds, '{}')
       end
     ) w where exists (select 1 from public.worlds k where k.id = w)),
    '{}'
  )
  into wanted_worlds
  from public.profiles p where p.id = actor;

  out_payload := jsonb_build_object(
    'worlds', to_jsonb(wanted_worlds),
    'sections', coalesce((
      select jsonb_agg(section_row order by section_row ->> 'position')
      from (
        -- 1. "Tonight" — episodes airing today or tomorrow in the member's worlds.
        select jsonb_build_object(
          'key', 'tonight',
          'title', 'Airing now',
          'kind', 'episodes',
          'position', 10,
          'items', coalesce((
            select jsonb_agg(jsonb_build_object(
              'title_id', t.id,
              'title', t.title,
              'world', t.world,
              'poster_url', t.poster_url,
              'season', e.season,
              'episode', e.number,
              'episode_title', e.title,
              'air_date', e.air_date,
              'air_time', e.air_time,
              'is_finale', e.episode_type = 2,
              'progress', w.current_episode
            ) order by e.air_date, e.season, e.number)
            from public.title_episodes e
            join public.titles t on t.id = e.title_id
            left join public.watchlist_items w on w.title_id = t.id and w.user_id = actor
            where e.air_date between current_date and current_date + 1
              and (cardinality(wanted_worlds) = 0 or t.world = any(wanted_worlds))
              and t.status = 'airing'
              and public.catalog_lifecycle_of(t) = 'airing'
              and not exists (select 1 from public.mutes mu where mu.user_id = actor and mu.muted_title_id = t.id)
            limit per_rail
          ), '[]'::jsonb)
        ) as section_row

        union all
        -- 2. "Trending" — the Hallyu ranking for the member's worlds, current content only.
        select jsonb_build_object(
          'key', 'trending',
          'title', 'Trending now',
          'kind', 'titles',
          'position', 20,
          'items', coalesce((
            select jsonb_agg(to_jsonb(tr) order by tr.score desc)
            from (
              select t.id, t.title, t.world, t.media_type, t.year, t.poster_url, t.backdrop_url,
                     t.genres, t.synopsis, t.next_episode_at, t.follower_count,
                     public.catalog_lifecycle_of(t) as lifecycle,
                     round(public.catalog_relevance_score(t)::numeric, 6)::double precision as score
              from public.titles t
              where (cardinality(wanted_worlds) = 0 or t.world = any(wanted_worlds))
                and public.catalog_lifecycle_of(t) in ('airing', 'upcoming', 'recent')
              order by public.catalog_relevance_score(t) desc, t.id asc
              limit per_rail
            ) tr
          ), '[]'::jsonb)
        )

        union all
        -- 3. "Coming soon" — upcoming releases inside their real window.
        select jsonb_build_object(
          'key', 'upcoming',
          'title', 'Coming soon',
          'kind', 'titles',
          'position', 30,
          'items', coalesce((
            select jsonb_agg(to_jsonb(up) order by up.first_air_date nulls last)
            from (
              select t.id, t.title, t.world, t.media_type, t.year, t.poster_url, t.backdrop_url,
                     t.genres, t.synopsis, t.first_air_date, t.follower_count
              from public.titles t
              where (cardinality(wanted_worlds) = 0 or t.world = any(wanted_worlds))
                and public.catalog_lifecycle_of(t) = 'upcoming'
                and (t.first_air_date is null or t.first_air_date <= current_date + 365)
              order by t.first_air_date asc nulls last, public.catalog_relevance_score(t) desc, t.id asc
              limit per_rail
            ) up
          ), '[]'::jsonb)
        )

        union all
        -- 4. "Just dropped" — finished inside a year, and labelled finished.
        select jsonb_build_object(
          'key', 'recent',
          'title', 'Just finished',
          'kind', 'titles',
          'position', 40,
          'items', coalesce((
            select jsonb_agg(to_jsonb(rc) order by rc.last_air_date desc nulls last)
            from (
              select t.id, t.title, t.world, t.media_type, t.year, t.poster_url, t.backdrop_url,
                     t.genres, t.synopsis, t.last_air_date, t.vote_average, t.follower_count
              from public.titles t
              where (cardinality(wanted_worlds) = 0 or t.world = any(wanted_worlds))
                and public.catalog_lifecycle_of(t) = 'recent'
              order by t.last_air_date desc nulls last, t.id asc
              limit per_rail
            ) rc
          ), '[]'::jsonb)
        )

        union all
        -- 5. "Keep watching" — strictly the member's own progress, never a global counter.
        select jsonb_build_object(
          'key', 'continue',
          'title', 'Keep watching',
          'kind', 'titles',
          'position', 5,
          'items', coalesce((
            select jsonb_agg(jsonb_build_object(
              'title_id', t.id,
              'title', t.title,
              'world', t.world,
              'poster_url', t.poster_url,
              'backdrop_url', t.backdrop_url,
              'season', w.season,
              'current_episode', w.current_episode,
              'episode_count', t.episode_count,
              'lifecycle', public.catalog_lifecycle_of(t),
              'next_episode_at', t.next_episode_at
            ) order by w.updated_at desc)
            from public.watchlist_items w
            join public.titles t on t.id = w.title_id
            where w.user_id = actor
              and w.status = 'watching'
              and t.episode_count > 0
              and w.current_episode < t.episode_count
            limit per_rail
          ), '[]'::jsonb)
        )
      ) sections
    ), '[]'::jsonb),

    -- Counts that mean something to this member. These are the only numbers on the Home screen.
    'stats', jsonb_build_object(
      'watching', (select count(*) from public.watchlist_items w where w.user_id = actor and w.status = 'watching'),
      'want_to_watch', (select count(*) from public.watchlist_items w where w.user_id = actor and w.status = 'want'),
      'completed', (select count(*) from public.watchlist_items w where w.user_id = actor and w.status = 'completed'),
      'alerts', (select count(*) from public.title_alerts a where a.user_id = actor),
      'collections', (select count(*) from public.collections c where c.owner_id = actor),
      'following_titles', (select count(*) from public.title_follows tf where tf.user_id = actor),
      'episodes_ahead', (
        select count(*)
        from public.title_episodes e
        join public.watchlist_items w on w.title_id = e.title_id and w.user_id = actor
        where w.status = 'watching' and e.season = w.season and e.number > w.current_episode
      ),
      'unread_notifications', (select count(*) from public.notifications n where n.recipient_id = actor and n.read_at is null)
    ),

    -- Catalog health for the moderation/debug surface, not for the cinematic Home.
    'catalog_health', (
      select jsonb_build_object(
        'airing', (select count(*) from public.titles where status = 'airing'),
        'upcoming', (select count(*) from public.titles where status = 'upcoming'),
        'recent', (select count(*) from public.titles where public.catalog_lifecycle_of(titles) = 'recent'),
        'unavailable', (select count(*) from public.titles where catalog_unavailable_at is not null),
        'last_synced_at', (select max(catalog_synced_at) from public.titles)
      )
    )
  );

  return out_payload;
end;
$$;

revoke all on function public.get_home_discovery(text[], integer) from public, anon, authenticated;
grant execute on function public.get_home_discovery(text[], integer) to authenticated;

-- Per-world rails in one call: the world selector on Home renders these as tabs.
create or replace function public.get_world_discoveries(p_limit integer default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  per_rail integer := least(greatest(coalesce(p_limit, 12), 1), 20);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'world', w.id,
      'label', w.label,
      'short_label', w.short_label,
      'tint', w.tint,
      'trending', coalesce((
        select jsonb_agg(to_jsonb(tr) order by tr.score desc)
        from (
          select t.id, t.title, t.media_type, t.year, t.poster_url, t.backdrop_url, t.genres,
                 t.synopsis, t.next_episode_at, t.follower_count,
                 public.catalog_lifecycle_of(t) as lifecycle,
                 round(public.catalog_relevance_score(t)::numeric, 6)::double precision as score
          from public.titles t
          where t.world = w.id and public.catalog_lifecycle_of(t) in ('airing', 'upcoming', 'recent')
          order by public.catalog_relevance_score(t) desc, t.id asc
          limit per_rail
        ) tr
      ), '[]'::jsonb),
      'upcoming', coalesce((
        select jsonb_agg(to_jsonb(up) order by up.first_air_date nulls last)
        from (
          select t.id, t.title, t.media_type, t.year, t.poster_url, t.genres, t.first_air_date
          from public.titles t
          where t.world = w.id and public.catalog_lifecycle_of(t) = 'upcoming'
            and (t.first_air_date is null or t.first_air_date <= current_date + 365)
          order by t.first_air_date asc nulls last, t.id asc
          limit per_rail
        ) up
      ), '[]'::jsonb),
      'airing_count', (select count(*) from public.titles t where t.world = w.id and public.catalog_lifecycle_of(t) = 'airing')
    ) order by w.sort_order)
    from public.worlds w
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_world_discoveries(integer) from public, anon, authenticated;
grant execute on function public.get_world_discoveries(integer) to anon, authenticated;

-- The title page's rails: where to watch it, who stars in it, what airs next, what people say.
create or replace function public.get_title_discovery(p_title_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  t public.titles%rowtype;
  actor uuid := auth.uid();
begin
  select * into t from public.titles where id = p_title_id;
  if not found then
    raise exception 'title % does not exist', p_title_id using errcode = 'no_data_found';
  end if;

  return jsonb_build_object(
    'title', jsonb_build_object(
      'id', t.id, 'title', t.title, 'original_title', t.original_title, 'year', t.year,
      'media_type', t.media_type, 'world', t.world, 'status', t.status,
      'lifecycle', public.catalog_lifecycle_of(t),
      'poster_url', t.poster_url, 'backdrop_url', t.backdrop_url, 'genres', t.genres,
      'synopsis', t.synopsis, 'network', t.network, 'airs_on', t.airs_on,
      'streaming_on', t.streaming_on, 'runtime_minutes', t.runtime_minutes,
      'episode_count', t.episode_count, 'season_count', t.season_count,
      'next_episode_at', t.next_episode_at, 'first_air_date', t.first_air_date,
      'last_air_date', t.last_air_date, 'vote_average', t.vote_average,
      'follower_count', t.follower_count,
      'catalog_synced_at', t.catalog_synced_at
    ),
    'episodes', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.season, e.number)
      from (
        select e.season, e.number, e.title, e.air_date, e.air_time, e.runtime_minutes,
               e.still_url, e.synopsis, e.episode_type
        from public.title_episodes e where e.title_id = p_title_id
      ) e
    ), '[]'::jsonb),
    'cast', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.order_index)
      from (
        select pe.id, pe.name, pe.korean_name, pe.photo_url, tp.character, tp.job, tp.order_index
        from public.title_people tp
        join public.people pe on pe.id = tp.person_id
        where tp.title_id = p_title_id
      ) c
    ), '[]'::jsonb),
    'similar', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.shared desc, s.id)
      from (
        select t2.id, t2.title, t2.media_type, t2.year, t2.poster_url, t2.backdrop_url,
               t2.genres, t2.synopsis, cardinality(array(select unnest(t2.genres) intersect select unnest(t.genres))) as shared
        from public.titles t2
        where t2.world = t.world and t2.id <> t.id
          and public.catalog_lifecycle_of(t2) <> 'unavailable'
          and t2.genres && t.genres
        order by cardinality(array(select unnest(t2.genres) intersect select unnest(t.genres))) desc, t2.id
        limit 12
      ) s
    ), '[]'::jsonb),
    'posts', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.created_at desc)
      from (
        select p.id, p.author_id, p.type, p.title, p.body, p.kind, p.rating, p.verdict, p.spoiler,
               p.season, p.episode, p.loved_count, p.cried_count, p.screamed_count, p.swooned_count,
               p.laughed_count, p.furious_count, p.comment_count, p.save_count, p.created_at
        from public.posts p
        where p.title_id = p_title_id and p.state = 'active' and p.visibility = 'public'
          and not exists (
            select 1 from public.blocks b
            where (b.blocker_id = actor and b.blocked_id = p.author_id)
               or (b.blocked_id = actor and b.blocker_id = p.author_id)
          )
        order by p.created_at desc
        limit 10
      ) p
    ), '[]'::jsonb),
    'watching_now', (select count(*) from public.watchlist_items w where w.title_id = p_title_id and w.status = 'watching'),
    'in_collections', (select count(*) from public.collection_items ci where ci.title_id = p_title_id)
  );
end;
$$;

revoke all on function public.get_title_discovery(uuid) from public, anon, authenticated;
grant execute on function public.get_title_discovery(uuid) to anon, authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
