-- Hallyu backend — 08 posts and media.
-- Post types, spoiler levels and lifecycle state come straight from lib/model.ts. Media bytes never
-- enter Postgres: `post_media` stores the object path inside the `media` storage bucket, and the
-- denormalised counts are maintained by triggers so no client can inflate them.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create type public.post_type as enum ('post', 'reaction', 'discussion', 'review', 'recommendation', 'short');
create type public.discussion_kind as enum ('general', 'theory', 'ending', 'character', 'scene', 'question');
create type public.spoiler_level as enum ('none', 'episode', 'season', 'ending');
create type public.content_state as enum ('active', 'deleted', 'hidden');

create table if not exists public.posts (
  id             uuid primary key default gen_random_uuid(),
  author_id      uuid        not null references public.profiles (id) on delete cascade,
  type           public.post_type not null default 'post',
  title          text,
  body           text        not null,
  kind           public.discussion_kind,
  rating         numeric(3, 1),
  verdict        text,
  spoiler        public.spoiler_level not null default 'none',
  visibility     public.visibility     not null default 'public',
  state          public.content_state  not null default 'active',
  world          text        references public.worlds (id) on delete set null,
  title_id       uuid        references public.titles (id) on delete set null,
  secondary_title_id uuid    references public.titles (id) on delete set null,
  community_id   uuid        references public.communities (id) on delete set null,
  season         smallint,
  episode        smallint,
  hashtags       text[]      not null default '{}',
  mentions       uuid[]      not null default '{}',
  loved_count    integer     not null default 0,
  cried_count    integer     not null default 0,
  screamed_count integer     not null default 0,
  swooned_count  integer     not null default 0,
  laughed_count  integer     not null default 0,
  furious_count  integer     not null default 0,
  comment_count  integer     not null default 0,
  save_count     integer     not null default 0,
  share_count    integer     not null default 0,
  search_document tsvector   generated always as (
                    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, '') || ' ' || public.genres_search_text(hashtags))
                  ) stored,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  edited_at      timestamptz,
  deleted_at     timestamptz,
  hidden_at      timestamptz,
  constraint posts_body_not_blank check (char_length(btrim(body)) between 1 and 5000),
  constraint posts_title_length check (title is null or char_length(title) <= 90),
  constraint posts_verdict_length check (verdict is null or char_length(verdict) <= 120),
  constraint posts_rating_sane check (rating is null or rating between 1 and 10),
  constraint posts_rating_only_for_reviews check ((rating is null and verdict is null) or type = 'review'),
  constraint posts_kind_only_for_discussions check ((kind is null) or type = 'discussion'),
  constraint posts_season_sane check (season is null or season >= 1),
  constraint posts_episode_sane check (episode is null or episode >= 1),
  constraint posts_counts_non_negative check (
    loved_count >= 0 and cried_count >= 0 and screamed_count >= 0 and swooned_count >= 0
    and laughed_count >= 0 and furious_count >= 0 and comment_count >= 0 and save_count >= 0 and share_count >= 0
  ),
  constraint posts_state_matches_timestamps check (
    (state <> 'deleted' or deleted_at is not null) and (state <> 'hidden' or hidden_at is not null)
  ),
  -- A short carries a clip; a text post does not need one, but a short without one is broken.
  constraint posts_short_has_episode_context check (type <> 'short' or episode is not null or season is not null or title_id is not null)
);

comment on table public.posts is 'Social content. Every post belongs to a member and may be pinned to a title, a room, or both.';
comment on column public.posts.hashtags is 'Lower-case tags without the leading #; indexed for trending.';
comment on column public.posts.state is 'active | deleted (author) | hidden (moderation). Deleted/hidden rows keep their id so replies never dangle.';

create index if not exists posts_author_created_idx on public.posts (author_id, created_at desc);
create index if not exists posts_created_idx on public.posts (created_at desc) where state = 'active';
create index if not exists posts_title_created_idx on public.posts (title_id, created_at desc) where state = 'active';
create index if not exists posts_world_created_idx on public.posts (world, created_at desc) where state = 'active';
create index if not exists posts_community_created_idx on public.posts (community_id, created_at desc) where state = 'active';
create index if not exists posts_hashtags_gin_idx on public.posts using gin (hashtags);
create index if not exists posts_search_gin_idx on public.posts using gin (search_document);
create index if not exists posts_live_for_others_idx on public.posts (id) where state = 'active' and visibility = 'public';

-- ---------------------------------------------------------------------------------------------
-- Media (storage paths only — never bytes)
-- ---------------------------------------------------------------------------------------------

create table if not exists public.post_media (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid        not null references public.posts (id) on delete cascade,
  kind         text        not null,
  storage_path text        not null,
  position     smallint    not null default 0,
  width        integer,
  height       integer,
  duration_ms  integer,
  poster_path  text,
  created_at   timestamptz not null default now(),
  constraint post_media_kind_known check (kind in ('image', 'video', 'audio')),
  constraint post_media_path_not_blank check (length(btrim(storage_path)) > 0),
  constraint post_media_position_non_negative check (position >= 0),
  constraint post_media_dimensions_sane check (
    (width is null or width > 0) and (height is null or height > 0) and (duration_ms is null or duration_ms >= 0)
  ),
  constraint post_media_post_position_unique unique (post_id, position)
);

comment on table public.post_media is 'Ordered media attached to a post. storage_path is a key inside the `media` bucket.';

create index if not exists post_media_post_idx on public.post_media (post_id, position);

-- ---------------------------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------------------------

create trigger posts_set_updated_at
  before update on public.posts
  for each row execute function public.set_updated_at();

-- The state column is the lifecycle record; the timestamps follow it automatically so a caller can
-- never set `state = 'deleted'` without a deleted_at.
create or replace function public.handle_post_state()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.state = 'deleted' then
    new.deleted_at := coalesce(new.deleted_at, now());
  elsif new.state = 'active' then
    new.deleted_at := null;
    new.hidden_at := null;
  end if;
  if new.state = 'hidden' then
    new.hidden_at := coalesce(new.hidden_at, now());
  end if;
  return new;
end;
$$;

create trigger posts_state_stamp
  before update of state on public.posts
  for each row execute function public.handle_post_state();

create or replace function public.handle_post_author_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.profiles set post_count = post_count + 1 where id = new.author_id;
    return new;
  end if;
  update public.profiles set post_count = greatest(0, post_count - 1) where id = old.author_id;
  return old;
end;
$$;

create trigger posts_author_count_insert after insert on public.posts for each row execute function public.handle_post_author_count();
create trigger posts_author_count_delete after delete on public.posts for each row execute function public.handle_post_author_count();

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------

alter table public.posts enable row level security;
alter table public.post_media enable row level security;

-- You can read a post when it is live and public, when you wrote it, when it is in a room you belong
-- to, or when you moderate. A block in either direction hides it completely.
create policy posts_select_visible on public.posts
  for select to authenticated
  using (
    (
      (
        state = 'active'
        and (
          visibility = 'public'
          or author_id = auth.uid()
          or exists (
            select 1 from public.community_members m
            where m.community_id = posts.community_id and m.user_id = auth.uid()
          )
        )
      )
      or author_id = auth.uid()
      or public.is_moderator()
    )
    and not exists (
      select 1 from public.blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = posts.author_id)
         or (b.blocked_id = auth.uid() and b.blocker_id = posts.author_id)
    )
  );

create policy posts_select_anonymous on public.posts
  for select to anon
  using (state = 'active' and visibility = 'public');

create policy posts_insert_own on public.posts
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and state = 'active'
    and visibility = 'public'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.account_status = 'active')
  );

-- Authors may edit content but never their identity, visibility-by-force or counters.
create policy posts_update_own on public.posts
  for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

create policy posts_delete_own on public.posts
  for delete to authenticated
  using (author_id = auth.uid() or public.is_moderator());

create policy post_media_select_with_post on public.post_media
  for select to authenticated
  using (exists (select 1 from public.posts p where p.id = post_media.post_id));

create policy post_media_select_anonymous on public.post_media
  for select to anon
  using (exists (
    select 1 from public.posts p
    where p.id = post_media.post_id and p.state = 'active' and p.visibility = 'public'
  ));

-- Only the author of the post may attach media to it.
create policy post_media_insert_own on public.post_media
  for insert to authenticated
  with check (exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid()));

create policy post_media_delete_own on public.post_media
  for delete to authenticated
  using (exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid()));

grant select on public.posts to anon, authenticated;
grant insert, update, delete on public.posts to authenticated;
grant select on public.post_media to anon, authenticated;
grant insert, delete on public.post_media to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
