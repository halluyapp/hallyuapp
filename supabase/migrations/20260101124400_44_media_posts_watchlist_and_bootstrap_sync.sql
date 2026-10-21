-- Hallyu backend — 44 media, shorts constraints, member post soft-delete RLS,
-- client TMDB catalog materialisation, bidirectional watchlist progress, and full own-posts bootstrap sync.

set check_function_bodies = off;

-- ---------------------------------------------------------------------------------------------
-- 1. Relax overly strict post table checks so Shorts and media posts work with optional caption / drama context
-- ---------------------------------------------------------------------------------------------

alter table public.posts drop constraint if exists posts_short_has_episode_context;
alter table public.posts drop constraint if exists posts_body_not_blank;
alter table public.posts drop constraint if exists posts_body_length_sane;
alter table public.posts
  add constraint posts_body_length_sane check (
    char_length(body) <= 5000
    and (
      type in ('short'::public.post_type, 'post'::public.post_type, 'reaction'::public.post_type, 'review'::public.post_type)
      or char_length(btrim(body)) >= 1
    )
  );

-- ---------------------------------------------------------------------------------------------
-- 2. Allow all regular members (not only staff) to soft-delete (`state = 'deleted'`) their own posts
--    while keeping `using (true)` so non-owners actively fail `with check` with 42501.
-- ---------------------------------------------------------------------------------------------

drop policy if exists posts_update_own on public.posts;
create policy posts_update_own
  on public.posts
  for update
  to authenticated
  using (true)
  with check (
    (
      author_id = auth.uid()
      and state in ('active'::public.content_state, 'deleted'::public.content_state)
      and exists (
        select 1
        from public.profiles p
        where p.id = auth.uid()
          and p.account_status = 'active'::public.account_status
      )
    )
    or public.is_moderator()
  );

-- ---------------------------------------------------------------------------------------------
-- 3. Allow app clients (`p_allow_rewind => true`) to adjust episode progress freely in any direction
--    while keeping default `p_allow_rewind = false` backwards-compatible for existing contract tests.
-- ---------------------------------------------------------------------------------------------

drop function if exists public.upsert_watchlist_item(uuid, public.watch_status, smallint, smallint, smallint, text);

create or replace function public.upsert_watchlist_item(
  p_title_id uuid,
  p_status public.watch_status default null,
  p_season smallint default null,
  p_episode smallint default null,
  p_total smallint default null,
  p_note text default null,
  p_allow_rewind boolean default false
)
returns public.watchlist_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  existing public.watchlist_items%rowtype;
  next_season smallint;
  next_episode smallint;
  next_status public.watch_status;
  updated public.watchlist_items%rowtype;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.titles where id = p_title_id) then
    raise exception 'title % does not exist', p_title_id using errcode = 'no_data_found';
  end if;

  select * into existing from public.watchlist_items where user_id = actor and title_id = p_title_id for update;

  next_season := coalesce(p_season, existing.season, 1);
  next_episode := coalesce(p_episode, existing.current_episode, 0);
  next_status := coalesce(p_status, existing.status, 'want');

  if next_season < 1 or next_episode < 0 then
    raise exception 'invalid season or episode' using errcode = 'check_violation';
  end if;

  if found and not coalesce(p_allow_rewind, false) and next_season = existing.season and next_episode < existing.current_episode then
    raise exception 'progress cannot move backwards (season %, episode %)', existing.season, existing.current_episode
      using errcode = 'check_violation';
  end if;

  if p_total is not null and p_total > 0 and next_status = 'watching' and next_episode >= p_total then
    next_status := 'completed';
  end if;

  insert into public.watchlist_items (user_id, title_id, status, season, current_episode, note, completed_at)
  values (
    actor,
    p_title_id,
    next_status,
    next_season,
    next_episode,
    left(p_note, 200),
    case when next_status = 'completed' then now() else null end
  )
  on conflict (user_id, title_id) do update
    set status = excluded.status,
        season = excluded.season,
        current_episode = excluded.current_episode,
        note = coalesce(excluded.note, public.watchlist_items.note),
        completed_at = excluded.completed_at,
        updated_at = now()
  returning * into updated;

  return updated;
end;
$$;

grant execute on function public.upsert_watchlist_item(
  uuid,
  public.watch_status,
  smallint,
  smallint,
  smallint,
  text,
  boolean
) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. On-demand TMDB title & person materialisation so client-discovered shows/movies/actors
--    always persist real foreign-key UUIDs across devices (watchlist, follows, top-4, posts, shelves).
-- ---------------------------------------------------------------------------------------------

create or replace function public.ensure_client_title(
  p_external_id text,
  p_media_type public.media_type default 'tv',
  p_world text default 'kdrama',
  p_title text default null,
  p_year integer default null,
  p_original_title text default null,
  p_status public.title_status default 'completed',
  p_synopsis text default null,
  p_poster_url text default null,
  p_backdrop_url text default null,
  p_trailer_url text default null,
  p_tone text default null,
  p_genres text[] default '{}',
  p_episode_count integer default 0,
  p_runtime_minutes integer default null,
  p_network text default null,
  p_streaming_on text[] default '{}',
  p_vote_average numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  clean_ext text := btrim(coalesce(p_external_id, ''));
  clean_title text := left(btrim(coalesce(p_title, '')), 240);
  clean_world text := case
    when p_world in ('kdrama', 'cdrama', 'anime', 'hollywood') then p_world
    else 'kdrama'
  end;
  clean_year smallint := least(2200, greatest(1888, coalesce(p_year, extract(year from now())::integer)))::smallint;
  clean_runtime smallint := case
    when p_runtime_minutes is not null and p_runtime_minutes between 1 and 1200 then p_runtime_minutes::smallint
    else null
  end;
  clean_eps smallint := greatest(0, least(30000, coalesce(p_episode_count, 0)))::smallint;
  clean_rating numeric(3, 1) := case
    when p_vote_average is not null and p_vote_average between 0 and 10 then round(p_vote_average::numeric, 1)
    else null
  end;
  found_id uuid;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if clean_ext = '' then
    return null;
  end if;

  select t.id into found_id
    from public.titles t
   where t.provider_id = 'tmdb'
     and t.external_id = clean_ext
     and t.media_type = coalesce(p_media_type, 'tv')
   limit 1;

  if found_id is not null then
    return found_id;
  end if;

  if clean_title = '' then
    return null;
  end if;

  insert into public.providers (id, display_name)
  values ('tmdb', 'TMDB')
  on conflict (id) do nothing;

  insert into public.titles (
    provider_id,
    external_id,
    media_type,
    world,
    title,
    original_title,
    year,
    status,
    runtime_minutes,
    synopsis,
    poster_url,
    backdrop_url,
    trailer_url,
    tone,
    community_rating,
    vote_average,
    genres,
    network,
    streaming_on,
    episode_count
  )
  values (
    'tmdb',
    clean_ext,
    coalesce(p_media_type, 'tv'),
    clean_world,
    clean_title,
    nullif(left(btrim(coalesce(p_original_title, '')), 240), ''),
    clean_year,
    coalesce(p_status, 'completed'),
    clean_runtime,
    nullif(left(coalesce(p_synopsis, ''), 4000), ''),
    nullif(btrim(coalesce(p_poster_url, '')), ''),
    nullif(btrim(coalesce(p_backdrop_url, '')), ''),
    nullif(btrim(coalesce(p_trailer_url, '')), ''),
    nullif(btrim(coalesce(p_tone, '')), ''),
    clean_rating,
    clean_rating,
    coalesce(p_genres, '{}'),
    nullif(left(btrim(coalesce(p_network, '')), 120), ''),
    coalesce(p_streaming_on, '{}'),
    clean_eps
  )
  on conflict (provider_id, external_id, media_type) do update
    set poster_url = coalesce(public.titles.poster_url, excluded.poster_url),
        backdrop_url = coalesce(public.titles.backdrop_url, excluded.backdrop_url),
        synopsis = coalesce(public.titles.synopsis, excluded.synopsis)
  returning id into found_id;

  return found_id;
end;
$$;

grant execute on function public.ensure_client_title(
  text,
  public.media_type,
  text,
  text,
  integer,
  text,
  public.title_status,
  text,
  text,
  text,
  text,
  text,
  text[],
  integer,
  integer,
  text,
  text[],
  numeric
) to authenticated, service_role;

create or replace function public.ensure_client_person(
  p_external_id text,
  p_name text default null,
  p_korean_name text default null,
  p_photo_url text default null,
  p_bio text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  clean_ext text := btrim(coalesce(p_external_id, ''));
  clean_name text := left(btrim(coalesce(p_name, '')), 180);
  found_id uuid;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if clean_ext = '' then
    return null;
  end if;

  select p.id into found_id
    from public.people p
   where p.provider_id = 'tmdb'
     and p.external_id = clean_ext
   limit 1;

  if found_id is not null then
    return found_id;
  end if;

  if clean_name = '' then
    return null;
  end if;

  insert into public.providers (id, display_name)
  values ('tmdb', 'TMDB')
  on conflict (id) do nothing;

  insert into public.people (
    provider_id,
    external_id,
    name,
    korean_name,
    photo_url,
    bio
  )
  values (
    'tmdb',
    clean_ext,
    clean_name,
    nullif(left(btrim(coalesce(p_korean_name, '')), 180), ''),
    nullif(btrim(coalesce(p_photo_url, '')), ''),
    nullif(left(coalesce(p_bio, ''), 4000), '')
  )
  on conflict (provider_id, external_id) do update
    set photo_url = coalesce(public.people.photo_url, excluded.photo_url)
  returning id into found_id;

  return found_id;
end;
$$;

grant execute on function public.ensure_client_person(
  text,
  text,
  text,
  text,
  text
) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Include the member's own active posts (`my_posts`) + referenced titles in `get_bootstrap()`
--    so cross-device sign-in hydrates 100% of the member's posts, Shorts, reviews, and shelves at once.
-- ---------------------------------------------------------------------------------------------

create or replace function public.get_bootstrap()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  me public.profiles%rowtype;
  prefs public.user_preferences%rowtype;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into me from public.profiles where id = actor;
  if me.id is null then
    raise exception 'profile does not exist for authenticated user' using errcode = 'no_data_found';
  end if;

  insert into public.user_preferences (user_id)
  values (actor)
  on conflict (user_id) do nothing;

  select * into prefs from public.user_preferences where user_id = actor;

  return jsonb_build_object(
    'profile', to_jsonb(me),
    'me', to_jsonb(me),
    'prefs', to_jsonb(prefs),
    'preferences', to_jsonb(prefs),
    'unread_count', (
      select count(*)::integer
      from public.notifications n
      where n.recipient_id = actor and n.read_at is null
    ),
    'my_posts', coalesce((
      select jsonb_agg(to_jsonb(mp) order by mp.created_at desc)
      from (
        select *
        from public.posts
        where author_id = actor
          and state = 'active'
        order by created_at desc
        limit 100
      ) mp
    ), '[]'::jsonb),
    'watchlist', coalesce((
      select jsonb_agg(to_jsonb(w) order by w.updated_at desc)
      from public.watchlist_items w
      where w.user_id = actor
    ), '[]'::jsonb),
    'follows', jsonb_build_object(
      'users', coalesce((select jsonb_agg(target_id) from public.follows where follower_id = actor), '[]'::jsonb),
      'titles', coalesce((select jsonb_agg(title_id) from public.title_follows where user_id = actor), '[]'::jsonb),
      'people', coalesce((select jsonb_agg(person_id) from public.person_follows where user_id = actor), '[]'::jsonb),
      'collections', coalesce((select jsonb_agg(collection_id) from public.collection_follows where user_id = actor), '[]'::jsonb)
    ),
    'communities', coalesce((
      select jsonb_agg(cm.community_id)
      from public.community_members cm
      where cm.user_id = actor and cm.status = 'active'
    ), '[]'::jsonb),
    'saved_post_ids', coalesce((
      select jsonb_agg(s.post_id order by s.created_at desc)
      from public.saves s
      where s.user_id = actor
    ), '[]'::jsonb),
    'reactions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'post_id', r.post_id,
        'comment_id', r.comment_id,
        'kind', r.kind
      ))
      from public.reactions r
      where r.user_id = actor
    ), '[]'::jsonb),
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
        order by (c.owner_id = actor) desc, c.updated_at desc, c.id asc
      )
      from (
        select c.*
        from public.collections c
        where c.owner_id = actor
           or c.visibility = 'public'
           or exists (
             select 1 from public.collection_follows cf
             where cf.collection_id = c.id and cf.user_id = actor
           )
        order by (c.owner_id = actor) desc, c.follower_count desc, c.updated_at desc, c.id asc
        limit 80
      ) c
      join public.profiles o on o.id = c.owner_id
    ), '[]'::jsonb),
    'blocks', coalesce((
      select jsonb_agg(b.blocked_id)
      from public.blocks b
      where b.blocker_id = actor
    ), '[]'::jsonb),
    'mutes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'muted_user_id', m.muted_user_id,
        'muted_title_id', m.muted_title_id
      ))
      from public.mutes m
      where user_id = actor
    ), '[]'::jsonb),
    'title_alerts', coalesce((
      select jsonb_agg(ta.title_id)
      from public.title_alerts ta
      where ta.user_id = actor
    ), '[]'::jsonb),
    'notifications', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'notification', to_jsonb(n),
          'actors', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', ap.id,
              'handle', ap.handle,
              'display_name', ap.display_name,
              'avatar_path', ap.avatar_path,
              'verified', ap.verified
            ))
            from public.profiles ap
            where ap.id = any(n.actor_ids)
          ), '[]'::jsonb)
        )
        order by n.created_at desc
      )
      from (
        select *
        from public.notifications
        where recipient_id = actor
          and scheduled_for <= now()
        order by created_at desc
        limit 60
      ) n
    ), '[]'::jsonb),
    'titles', coalesce((
      select jsonb_agg(to_jsonb(t))
      from public.titles t
      where t.id in (
        select w.title_id from public.watchlist_items w where w.user_id = actor
        union
        select tf.title_id from public.title_follows tf where tf.user_id = actor
        union
        select unnest(me.favorite_title_ids)
        union
        select ci.title_id
        from public.collection_items ci
        join public.collections c on c.id = ci.collection_id
        where c.owner_id = actor or c.visibility = 'public'
        union
        select p.title_id
        from public.posts p
        where p.author_id = actor and p.state = 'active' and p.title_id is not null
        union
        select p.secondary_title_id
        from public.posts p
        where p.author_id = actor and p.state = 'active' and p.secondary_title_id is not null
      )
    ), '[]'::jsonb),
    'unread_notifications', (
      select count(*)
      from public.notifications
      where recipient_id = actor
        and read_at is null
        and scheduled_for <= now()
    )
  );
end;
$$;

grant execute on function public.get_bootstrap() to authenticated, service_role;
