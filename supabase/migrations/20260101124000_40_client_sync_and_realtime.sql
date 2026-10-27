-- Full client hydration, feed/thread/profile/person/collection/pulse read surfaces, favorite titles,
-- episode alert toggles, and Realtime publication wiring.
--
-- Why these functions exist rather than letting the client stitch five tables together in JavaScript:
--   1. One round trip per screen instead of N+1 waterfalls across posts, profiles, post_media, titles,
--      reactions, saves, collections and comments.
--   2. Every visibility invariant (blocks in either direction, mutes, private accounts, deleted or
--      hidden moderation states, unavailable catalog titles) is enforced once, in PostgreSQL, on the
--      same rules `feed_page()` already owns.

set check_function_bodies = off;

-- Reconcile legacy `genres_search_text(genres text[])` parameter naming on upgraded projects so
-- `pg_proc.proargnames` matches `20260101120200_02_entertainment_catalog.sql` (`p_genres text[]`).
do $reconcile$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'genres_search_text'
      and coalesce(p.proargnames, '{}'::text[]) <> array['p_genres']
  ) then
    alter table public.titles drop column if exists search_document;
    alter table public.posts drop column if exists search_document;
    drop function public.genres_search_text(text[]);

    execute $fn$
      /* reconcile */ create or replace function public.genres_search_text(p_genres text[])
      returns text
      language sql
      immutable
      set search_path = public, pg_temp
      as $body$
        select coalesce(array_to_string(p_genres, ' '), '')
      $body$;
    $fn$;

    alter table public.titles
      add column search_document tsvector
      generated always as (
        to_tsvector('simple',
          coalesce(title, '') || ' ' || coalesce(original_title, '') || ' ' ||
          public.genres_search_text(genres) || ' ' || coalesce(network, '')
        )
      ) stored;
    create index if not exists titles_search_gin_idx on public.titles using gin (search_document);

    alter table public.posts
      add column search_document tsvector
      generated always as (
        to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, '') || ' ' || public.genres_search_text(hashtags))
      ) stored;
    create index if not exists posts_search_gin_idx on public.posts using gin (search_document);
  end if;
end
$reconcile$;

-- ---------------------------------------------------------------------------------------------
-- 1. Favorite titles on profiles (persisted across devices and scrubbed on account deletion)
-- ---------------------------------------------------------------------------------------------

alter table public.profiles
  add column if not exists favorite_title_ids uuid[] not null default '{}'::uuid[];

comment on column public.profiles.favorite_title_ids is
  'Up to ten catalog title UUIDs featured on the member''s profile card. Managed through toggle_favorite_title() or profile update.';

-- Keep delete_account() scrubbing favorite_title_ids alongside worlds and genres.
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

  update public.posts set mentions = array_remove(mentions, actor) where actor = any(mentions);

  update public.profiles
     set account_status = 'deleted',
         deleted_at = coalesce(deleted_at, now()),
         display_name = 'Deleted member',
         handle = 'deleted_' || substr(replace(actor::text, '-', ''), 1, 16),
         bio = null,
         avatar_path = null,
         worlds = '{}',
         favorite_genres = '{}',
         favorite_title_ids = '{}',
         onboarding_genres = '{}',
         is_private = true
   where id = actor;

  return jsonb_build_object(
    'deleted', true,
    'media_objects_queued', removed_count,
    'deleted_at', now()
  );
end;
$$;

revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Realtime publication (guarded for vanilla PostgreSQL containers where supabase_realtime is absent)
-- ---------------------------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'posts'
    ) then
      alter publication supabase_realtime add table public.posts;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'comments'
    ) then
      alter publication supabase_realtime add table public.comments;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
    ) then
      alter publication supabase_realtime add table public.notifications;
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Complete single-round-trip bootstrap for signed-in members
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
      where m.user_id = actor
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

revoke all on function public.get_bootstrap() from public, anon;
grant execute on function public.get_bootstrap() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. Favorite titles & per-title alert toggles
-- ---------------------------------------------------------------------------------------------

create or replace function public.toggle_favorite_title(
  p_title_id uuid,
  p_on boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  current_ids uuid[];
  should_enable boolean;
  next_ids uuid[];
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_title_id is null or not exists (select 1 from public.titles where id = p_title_id) then
    raise exception 'title % does not exist', p_title_id using errcode = 'foreign_key_violation';
  end if;

  select coalesce(favorite_title_ids, '{}'::uuid[])
    into current_ids
    from public.profiles
   where id = actor and account_status = 'active';

  if not found then
    raise exception 'active profile required' using errcode = 'insufficient_privilege';
  end if;

  should_enable := coalesce(p_on, not (p_title_id = any(current_ids)));

  if should_enable then
    next_ids := array(
      select distinct u.id
      from unnest(array_prepend(p_title_id, array_remove(current_ids, p_title_id))) with ordinality as u(id, ord)
      order by u.ord
      limit 10
    );
  else
    next_ids := array_remove(current_ids, p_title_id);
  end if;

  update public.profiles
     set favorite_title_ids = next_ids
   where id = actor;

  return jsonb_build_object(
    'title_id', p_title_id,
    'is_favorite', p_title_id = any(next_ids),
    'favorite_title_ids', next_ids
  );
end;
$$;

revoke all on function public.toggle_favorite_title(uuid, boolean) from public, anon;
grant execute on function public.toggle_favorite_title(uuid, boolean) to authenticated;

create or replace function public.set_title_alert(
  p_title_id uuid,
  p_on boolean default true
)
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

  if p_title_id is null or not exists (select 1 from public.titles where id = p_title_id) then
    raise exception 'title % does not exist', p_title_id using errcode = 'foreign_key_violation';
  end if;

  if coalesce(p_on, true) then
    insert into public.title_alerts (user_id, title_id)
    values (actor, p_title_id)
    on conflict (user_id, title_id) do nothing;
    return true;
  else
    delete from public.title_alerts
     where user_id = actor and title_id = p_title_id;
    return false;
  end if;
end;
$$;

revoke all on function public.set_title_alert(uuid, boolean) from public, anon;
grant execute on function public.set_title_alert(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Hydrated feed bundle, post thread, profile card, person filmography, collections & pulse
-- ---------------------------------------------------------------------------------------------

create or replace function public.get_feed_bundle(
  p_scope text default 'for_you',
  p_world text default null,
  p_title_id uuid default null,
  p_community_id uuid default null,
  p_cursor text default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  viewer uuid := auth.uid();
  raw_page jsonb;
  hydrated jsonb;
begin
  raw_page := public.feed_page(
    p_scope => p_scope,
    p_world => p_world,
    p_title_id => p_title_id,
    p_limit => least(greatest(coalesce(p_limit, 25), 1), 50),
    p_cursor => p_cursor,
    p_community_id => p_community_id
  );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'post', to_jsonb(p),
        'author', jsonb_build_object(
          'id', a.id,
          'handle', a.handle,
          'display_name', a.display_name,
          'bio', a.bio,
          'avatar_path', a.avatar_path,
          'verified', a.verified,
          'is_private', a.is_private,
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
        end
      )
      order by item.ord asc
    ),
    '[]'::jsonb
  )
  into hydrated
  from jsonb_array_elements(coalesce(raw_page -> 'items', '[]'::jsonb)) with ordinality as item(doc, ord)
  join public.posts p on p.id = (item.doc ->> 'id')::uuid
  join public.profiles a on a.id = p.author_id;

  return jsonb_build_object(
    'items', hydrated,
    'next_cursor', raw_page -> 'next_cursor'
  );
end;
$$;

revoke all on function public.get_feed_bundle(text, text, uuid, uuid, text, integer) from public;
grant execute on function public.get_feed_bundle(text, text, uuid, uuid, text, integer) to anon, authenticated;

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
      'verified', a.verified,
      'is_private', a.is_private,
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
            'verified', ca.verified,
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

revoke all on function public.get_post_thread(uuid, integer) from public;
grant execute on function public.get_post_thread(uuid, integer) to anon, authenticated;

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
      'verified', target.verified,
      'is_private', target.is_private,
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

revoke all on function public.get_profile_by_handle(text) from public;
grant execute on function public.get_profile_by_handle(text) to anon, authenticated;

create or replace function public.get_person_detail(p_person_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  viewer uuid := auth.uid();
  person_row public.people%rowtype;
begin
  if p_person_id is null then
    return null;
  end if;

  select * into person_row from public.people where id = p_person_id;
  if person_row.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'person', to_jsonb(person_row),
    'is_following', case
      when viewer is null then false
      else exists (
        select 1 from public.person_follows pf
        where pf.user_id = viewer and pf.person_id = p_person_id
      )
    end,
    'credits', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'job', tp.job,
          'character', tp.character,
          'order_index', tp.order_index,
          'title', to_jsonb(t)
        )
        order by tp.order_index asc, coalesce(t.popularity, 0) desc, t.year desc, t.id asc
      )
      from public.title_people tp
      join public.titles t on t.id = tp.title_id
      where tp.person_id = p_person_id
        and public.catalog_lifecycle_of(t) <> 'unavailable'
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_person_detail(uuid) from public;
grant execute on function public.get_person_detail(uuid) to anon, authenticated;

create or replace function public.get_public_collections(p_limit integer default 40)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  capped integer := least(greatest(coalesce(p_limit, 40), 1), 80);
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
      )
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_public_collections(integer) from public;
grant execute on function public.get_public_collections(integer) to anon, authenticated;

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
          'verified', v.verified,
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

revoke all on function public.get_community_pulse(text, integer) from public;
grant execute on function public.get_community_pulse(text, integer) to anon, authenticated;

-- Enforce table-level write revokes on append-only moderation_actions and explicit RLS violation
-- errors when a non-author attempts to update another member's post directly.
revoke insert, update, delete on public.moderation_actions from public, anon, authenticated;

drop policy if exists posts_update_own on public.posts;
create policy posts_update_own on public.posts
  for update to authenticated
  using (true)
  with check (
    (
      author_id = auth.uid()
      and state = 'active'
      and exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.account_status = 'active'
      )
    )
    or public.is_moderator()
  );

reset check_function_bodies;
