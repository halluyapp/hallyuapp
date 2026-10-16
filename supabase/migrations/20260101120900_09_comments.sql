-- Hallyu backend — 09 comments.
-- One level of threading, exactly like the client model (`parentId?` + `replyToUserId`). The rule
-- "a reply must sit under a top-level comment of the same post" is enforced here, not in the app.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create table if not exists public.comments (
  id               uuid primary key default gen_random_uuid(),
  post_id          uuid        not null references public.posts (id) on delete cascade,
  author_id        uuid        not null references public.profiles (id) on delete cascade,
  parent_id        uuid        references public.comments (id) on delete cascade,
  reply_to_user_id uuid        references public.profiles (id) on delete set null,
  body             text        not null,
  spoiler          public.spoiler_level not null default 'none',
  state            public.content_state  not null default 'active',
  loved_count      integer     not null default 0,
  cried_count      integer     not null default 0,
  screamed_count   integer     not null default 0,
  swooned_count    integer     not null default 0,
  laughed_count    integer     not null default 0,
  furious_count    integer     not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  edited_at        timestamptz,
  deleted_at       timestamptz,
  hidden_at        timestamptz,
  constraint comments_body_not_blank check (char_length(btrim(body)) between 1 and 1000),
  constraint comments_no_self_parent check (parent_id is null or parent_id <> id),
  constraint comments_counts_non_negative check (
    loved_count >= 0 and cried_count >= 0 and screamed_count >= 0 and swooned_count >= 0
    and laughed_count >= 0 and furious_count >= 0
  ),
  constraint comments_state_matches_timestamps check (
    (state <> 'deleted' or deleted_at is not null) and (state <> 'hidden' or hidden_at is not null)
  )
);

comment on table public.comments is 'Threaded comments. parent_id points at a top-level comment of the same post (depth is capped at 1).';

create index if not exists comments_post_created_idx on public.comments (post_id, created_at);
create index if not exists comments_parent_idx on public.comments (parent_id) where parent_id is not null;
create index if not exists comments_author_created_idx on public.comments (author_id, created_at desc);

create trigger comments_set_updated_at
  before update on public.comments
  for each row execute function public.set_updated_at();

create or replace function public.handle_comment_state()
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

create trigger comments_state_stamp
  before update of state on public.comments
  for each row execute function public.handle_comment_state();

-- A reply must hang off a top-level comment on the same post. Two statements: one to read the
-- parent, one to run the check as a constraint trigger (so it also fires on updates of parent_id).
create or replace function public.enforce_comment_parent()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  parent_post uuid;
  parent_parent uuid;
begin
  if new.parent_id is null then
    new.reply_to_user_id := null;
    return new;
  end if;

  select c.post_id, c.parent_id into parent_post, parent_parent
  from public.comments c
  where c.id = new.parent_id;

  if parent_post is null then
    raise exception 'parent comment % does not exist', new.parent_id using errcode = 'foreign_key_violation';
  end if;

  if parent_post <> new.post_id then
    raise exception 'reply must belong to the same post as its parent' using errcode = 'check_violation';
  end if;

  if parent_parent is not null then
    raise exception 'reply depth is limited to one level' using errcode = 'check_violation';
  end if;

  if new.reply_to_user_id is null then
    select c.author_id into new.reply_to_user_id from public.comments c where c.id = new.parent_id;
  end if;

  return new;
end;
$$;

create trigger comments_parent_check
  before insert or update of parent_id, post_id on public.comments
  for each row execute function public.enforce_comment_parent();

create or replace function public.handle_comment_counts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set comment_count = comment_count + 1 where id = new.post_id;
    update public.profiles set comment_count = comment_count + 1 where id = new.author_id;
    return new;
  end if;

  update public.posts set comment_count = greatest(0, comment_count - 1) where id = old.post_id;
  update public.profiles set comment_count = greatest(0, comment_count - 1) where id = old.author_id;
  return old;
end;
$$;

create trigger comments_count_insert after insert on public.comments for each row execute function public.handle_comment_counts();
create trigger comments_count_delete after delete on public.comments for each row execute function public.handle_comment_counts();

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------

alter table public.comments enable row level security;

-- You can read a comment when you can read its post (private posts stay private) and no block stands
-- between you and the author.
create policy comments_select_visible on public.comments
  for select to authenticated
  using (
    (
      (
        state = 'active'
        and exists (
          select 1 from public.posts p
          where p.id = comments.post_id
            and (
              p.state = 'active'
              or p.author_id = auth.uid()
              or public.is_moderator()
            )
            and (
              p.visibility = 'public'
              or p.author_id = auth.uid()
              or exists (
                select 1 from public.community_members m
                where m.community_id = p.community_id and m.user_id = auth.uid()
              )
              or public.is_moderator()
            )
        )
      )
      or author_id = auth.uid()
      or public.is_moderator()
    )
    and not exists (
      select 1 from public.blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = comments.author_id)
         or (b.blocked_id = auth.uid() and b.blocker_id = comments.author_id)
    )
  );

create policy comments_select_anonymous on public.comments
  for select to anon
  using (
    state = 'active'
    and exists (
      select 1 from public.posts p
      where p.id = comments.post_id and p.state = 'active' and p.visibility = 'public'
    )
  );

create policy comments_insert_own on public.comments
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and state = 'active'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.account_status = 'active')
  );

create policy comments_update_own on public.comments
  for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

create policy comments_delete_own on public.comments
  for delete to authenticated
  using (author_id = auth.uid() or public.is_moderator());

grant select on public.comments to anon, authenticated;
grant insert, update, delete on public.comments to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
