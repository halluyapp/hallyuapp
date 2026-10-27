-- Hallyu backend — 31 share accounting and counter integrity.
--
-- `posts.share_count` exists (migration 08) but nothing could legitimately move it: RLS lets an
-- author update their own row, which means the author could set the counter to a million by hand.
-- The same hole exists for every other denormalised count on posts and comments.
--
-- This migration closes it at the database level:
--
--   1. `post_shares` — one row per (post, sharer, channel, day), so a share is a real event
--   2. `record_share()` — the only writer of `posts.share_count`
--   3. `guard_engagement_counters()` — a BEFORE UPDATE trigger that rejects any client that tries to
--      write a counter directly, whether through PostgREST, a table update, or a crafted RPC

-- ---------------------------------------------------------------------------------------------
-- Shares
-- ---------------------------------------------------------------------------------------------

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create type public.share_channel as enum ('link', 'inapp', 'system');

create table if not exists public.post_shares (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid        not null references public.posts (id) on delete cascade,
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  channel    public.share_channel not null default 'link',
  share_date date        not null default current_date,
  created_at timestamptz not null default now(),
  -- Idempotency: the same member sharing the same post through the same channel on the same day is
  -- one share. A member who taps the button twice does not inflate the counter.
  constraint post_shares_once_per_day unique (post_id, user_id, channel, share_date)
);

comment on table public.post_shares is 'Real share events. One per member, per post, per channel, per day: the counter cannot be inflated by tapping again.';
comment on column public.post_shares.share_date is 'Local calendar date of the share, used for the per-day idempotency window.';

create index if not exists post_shares_post_idx on public.post_shares (post_id, created_at desc);
create index if not exists post_shares_user_idx on public.post_shares (user_id, created_at desc);

alter table public.post_shares enable row level security;

-- A share is a private act, but the people who shared are public ("N members shared this").
create policy post_shares_select_visible on public.post_shares
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.posts p where p.id = post_shares.post_id and p.state = 'active')
  );

create policy post_shares_select_anonymous on public.post_shares
  for select to anon
  using (exists (select 1 from public.posts p where p.id = post_shares.post_id and p.state = 'active' and p.visibility = 'public'));

grant select on public.post_shares to anon, authenticated;

-- Count maintenance. Written by the trigger, never by a client.
create or replace function public.handle_post_share_counts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set share_count = share_count + 1 where id = new.post_id;
    return new;
  end if;

  update public.posts set share_count = greatest(0, share_count - 1) where id = old.post_id;
  return old;
end;
$$;

create trigger post_shares_count_insert after insert on public.post_shares for each row execute function public.handle_post_share_counts();
create trigger post_shares_count_delete after delete on public.post_shares for each row execute function public.handle_post_share_counts();

-- ---------------------------------------------------------------------------------------------
-- The RPC the client calls
-- ---------------------------------------------------------------------------------------------

-- Records a share and returns the authoritative counter. `counted` is false when the share was
-- already recorded today, which is how the client avoids showing a double increment.
create or replace function public.record_share(
  p_post_id uuid,
  p_channel public.share_channel default 'link'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  recent_shares integer;
  counted boolean := false;
  written integer := 0;
  current_count integer := 0;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_channel is null then
    p_channel := 'link';
  end if;

  -- The post must be one the caller can actually see: no counting shares of hidden or blocked work.
  if not exists (
    select 1 from public.posts p
    where p.id = p_post_id
      and p.state = 'active'
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = actor and b.blocked_id = p.author_id)
           or (b.blocked_id = actor and b.blocker_id = p.author_id)
      )
  ) then
    raise exception 'post % is not available', p_post_id using errcode = 'no_data_found';
  end if;

  -- Rate limit: twenty shares a minute per member is far above any real behaviour and low enough
  -- that a scripted spammer cannot use the share button as an amplification vector.
  select count(*) into recent_shares
  from public.post_shares s
  where s.user_id = actor and s.created_at > now() - interval '1 minute';

  if recent_shares >= 20 then
    raise exception 'too many shares, slow down' using errcode = 'program_limit_exceeded';
  end if;

  insert into public.post_shares (post_id, user_id, channel, share_date)
  values (p_post_id, actor, p_channel, (now() at time zone 'utc')::date)
  on conflict (post_id, user_id, channel, share_date) do nothing;

  get diagnostics written = row_count;
  counted := written > 0;

  select p.share_count into current_count from public.posts p where p.id = p_post_id;

  return jsonb_build_object(
    'post_id', p_post_id,
    'share_count', current_count,
    'counted', counted,
    'your_shares_today', (
      select count(*) from public.post_shares s
      where s.post_id = p_post_id and s.user_id = actor and s.share_date = (now() at time zone 'utc')::date
    )
  );
end;
$$;

revoke all on function public.record_share(uuid, public.share_channel) from public, anon, authenticated;
grant execute on function public.record_share(uuid, public.share_channel) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Counter integrity
-- ---------------------------------------------------------------------------------------------

-- Any direct write to an engagement counter is refused. The database's own trigger functions bump
-- these columns at a nested trigger depth, and they are the only writer allowed to.
--
-- This is what makes the promise "a client can never write a count" true for updates, not only for
-- inserts: RLS cannot express "you may update this row but not this column".
create or replace function public.guard_engagement_counters()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Nested trigger depth > 1 means the write came from one of this schema's own counter triggers.
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if new.loved_count is distinct from old.loved_count
     or new.cried_count is distinct from old.cried_count
     or new.screamed_count is distinct from old.screamed_count
     or new.swooned_count is distinct from old.swooned_count
     or new.laughed_count is distinct from old.laughed_count
     or new.furious_count is distinct from old.furious_count
     or new.comment_count is distinct from old.comment_count
     or new.save_count is distinct from old.save_count
     or new.share_count is distinct from old.share_count then
    raise exception 'engagement counters are maintained by the database and cannot be written directly'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger posts_guard_counters
  before update on public.posts
  for each row execute function public.guard_engagement_counters();

create or replace function public.guard_comment_reaction_counters()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if new.loved_count is distinct from old.loved_count
     or new.cried_count is distinct from old.cried_count
     or new.screamed_count is distinct from old.screamed_count
     or new.swooned_count is distinct from old.swooned_count
     or new.laughed_count is distinct from old.laughed_count
     or new.furious_count is distinct from old.furious_count then
    raise exception 'reaction counters are maintained by the database and cannot be written directly'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger comments_guard_counters
  before update on public.comments
  for each row execute function public.guard_comment_reaction_counters();

-- The same guarantee for the profile and room counters, which are denormalised the same way.
create or replace function public.guard_profile_counters()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if new.follower_count is distinct from old.follower_count
     or new.following_count is distinct from old.following_count
     or new.post_count is distinct from old.post_count
     or new.comment_count is distinct from old.comment_count then
    raise exception 'profile counters are maintained by the database and cannot be written directly'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger profiles_guard_counters
  before update on public.profiles
  for each row execute function public.guard_profile_counters();

create or replace function public.guard_catalog_counters()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if new.follower_count is distinct from old.follower_count then
    raise exception 'title follower counts are maintained by the database and cannot be written directly'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger titles_guard_counters
  before update on public.titles
  for each row execute function public.guard_catalog_counters();

-- Moderators may edit content but they do not get to invent counts either; the guard runs for them
-- too, which is the point of putting it in the database rather than in a policy.

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
