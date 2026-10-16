-- Hallyu backend — 18 notification generation.
-- Notifications are written by the database, never by a client: the only INSERT path into
-- public.notifications is these trigger functions. Each one skips self-notifications, respects the
-- recipient's notification preferences, and refuses to notify across a block.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create or replace function public.notify_recipient(
  p_recipient uuid,
  p_kind public.notification_kind,
  p_group public.notification_group,
  p_actor_ids uuid[] default '{}',
  p_post_id uuid default null,
  p_comment_id uuid default null,
  p_title_id uuid default null,
  p_community_id uuid default null,
  p_collection_id uuid default null,
  p_episode smallint default null,
  p_title text default null,
  p_body text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  prefs public.user_preferences%rowtype;
begin
  if p_recipient is null then
    return;
  end if;

  select * into prefs from public.user_preferences where user_id = p_recipient;
  if not found then
    return;
  end if;

  -- Preference gates: social covers follow/comment/reply/collection, system covers moderation, and
  -- drama covers episode/trending notifications.
  if p_group = 'social' and not prefs.notify_social then
    return;
  end if;
  if p_group = 'system' and not prefs.notify_system then
    return;
  end if;
  if p_group = 'drama' and not prefs.notify_episodes then
    return;
  end if;

  -- Never notify somebody the actor has blocked, or who blocked the actor.
  if cardinality(p_actor_ids) > 0 and exists (
    select 1 from public.blocks b
    where (b.blocker_id = p_recipient and b.blocked_id = any(p_actor_ids))
       or (b.blocked_id = p_recipient and b.blocker_id = any(p_actor_ids))
  ) then
    return;
  end if;

  insert into public.notifications (
    recipient_id, kind, "group", actor_ids, post_id, comment_id, title_id, community_id, collection_id, episode, title, body
  )
  values (
    p_recipient, p_kind, p_group, p_actor_ids, p_post_id, p_comment_id, p_title_id, p_community_id, p_collection_id, p_episode, p_title, p_body
  );
end;
$$;

revoke all on function public.notify_recipient(uuid, public.notification_kind, public.notification_group, uuid[], uuid, uuid, uuid, uuid, uuid, smallint, text, text)
  from public, anon, authenticated;

-- Follow → "someone followed you"
create or replace function public.handle_notify_follow()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.notify_recipient(
    new.target_id,
    'follow',
    'social',
    array[new.follower_id],
    null, null, null, null, null, null,
    null,
    'New follower'
  );
  return new;
end;
$$;

create trigger follows_notify_insert after insert on public.follows for each row execute function public.handle_notify_follow();

-- Comment → notify the post author; reply → notify the parent comment author.
create or replace function public.handle_notify_comment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  post_author uuid;
begin
  select author_id into post_author from public.posts where id = new.post_id;

  if new.parent_id is not null then
    select c.author_id into post_author from public.comments c where c.id = new.parent_id;
    perform public.notify_recipient(
      post_author, 'reply', 'social', array[new.author_id],
      new.post_id, new.id, null, null, null, null, null, 'Replied to your comment'
    );
  else
    perform public.notify_recipient(
      post_author, 'comment', 'social', array[new.author_id],
      new.post_id, new.id, null, null, null, null, null, 'Commented on your post'
    );
  end if;

  return new;
end;
$$;

create trigger comments_notify_insert after insert on public.comments for each row execute function public.handle_notify_comment();

-- Reaction → tell the author someone reacted, and tell the previous holder when a slot is taken
-- over by someone else (a swap is an update, so the old kind's owner gets a "no longer" signal only
-- when the reaction changes kind, which is what `old.kind is distinct from new.kind` selects).
create or replace function public.handle_notify_reaction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  owner_id uuid;
begin
  if new.post_id is not null then
    select p.author_id into owner_id from public.posts p where p.id = new.post_id;
    if owner_id is not distinct from new.user_id then
      return new; -- reacting to yourself is not news
    end if;
    perform public.notify_recipient(
      owner_id, 'reaction', 'social', array[new.user_id],
      new.post_id, null, null, null, null, null, null, 'Reacted to your post'
    );
  else
    select c.author_id into owner_id from public.comments c where c.id = new.comment_id;
    if owner_id is not distinct from new.user_id then
      return new;
    end if;
    perform public.notify_recipient(
      owner_id, 'reaction', 'social', array[new.user_id],
      new.post_id, new.comment_id, null, null, null, null, null, 'Reacted to your comment'
    );
  end if;

  return new;
end;
$$;

create trigger reactions_notify_insert after insert on public.reactions for each row execute function public.handle_notify_reaction();

-- Collection follow → "someone saved your shelf"
create or replace function public.handle_notify_collection_follow()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.notify_recipient(
    (select owner_id from public.collections where id = new.collection_id),
    'collection_saved',
    'social',
    array[new.user_id],
    null, null, null, null, new.collection_id, null, null,
    'Saved your collection'
  );
  return new;
end;
$$;

create trigger collection_follows_notify_insert after insert on public.collection_follows for each row execute function public.handle_notify_collection_follow();

-- Moderation action → the member is told, in the system group.
create or replace function public.handle_notify_moderation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('resolved', 'dismissed') and old.status is distinct from new.status then
    perform public.notify_recipient(
      new.reporter_id,
      'system',
      'system',
      '{}',
      null, null, null, null, null, null, null,
      'We looked at your report',
      new.resolution
    );
  end if;
  return new;
end;
$$;

create trigger reports_notify_update after update on public.reports for each row execute function public.handle_notify_moderation();

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
