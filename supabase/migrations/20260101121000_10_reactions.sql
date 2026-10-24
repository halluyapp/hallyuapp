-- Hallyu backend — 10 reactions.
-- One row per member per target, exactly one target per row, and the six per-kind counters on posts
-- and comments are maintained by triggers. A client can therefore never write a count, and a member
-- can hold at most one reaction on a post and one on a comment.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create type public.reaction_kind as enum ('loved', 'cried', 'screamed', 'swooned', 'laughed', 'furious');

create table if not exists public.reactions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  kind       public.reaction_kind not null default 'loved',
  post_id    uuid        references public.posts (id) on delete cascade,
  comment_id uuid        references public.comments (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint reactions_exactly_one_target check ((post_id is not null)::int + (comment_id is not null)::int = 1)
);

comment on table public.reactions is 'One reaction per member per target. Toggle/swap behaviour lives in public.toggle_reaction().';

-- Partial unique indexes do the real duplicate prevention: a member can only hold one reaction per
-- post, and one per comment, whatever the kind.
create unique index if not exists reactions_one_per_post on public.reactions (post_id, user_id) where post_id is not null;
create unique index if not exists reactions_one_per_comment on public.reactions (comment_id, user_id) where comment_id is not null;
create index if not exists reactions_user_recent_idx on public.reactions (user_id, created_at desc);
create index if not exists reactions_post_kinds_idx on public.reactions (post_id, kind) where post_id is not null;
create index if not exists reactions_comment_kinds_idx on public.reactions (comment_id, kind) where comment_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Counter maintenance
-- ---------------------------------------------------------------------------------------------

-- Counter maintenance. These two helpers are plain static SQL on purpose: the six per-kind columns
-- are written by a CASE on the enum value rather than by building a statement with format(), so
-- there is no dynamic SQL anywhere in this file for a value to be injected into.
create or replace function public.bump_post_reaction_counts(
  p_post_id uuid,
  p_kind public.reaction_kind,
  p_delta integer
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.posts
     set loved_count   = greatest(0, loved_count   + (case when p_kind = 'loved'    then p_delta else 0 end)),
         cried_count   = greatest(0, cried_count   + (case when p_kind = 'cried'    then p_delta else 0 end)),
         screamed_count= greatest(0, screamed_count+ (case when p_kind = 'screamed' then p_delta else 0 end)),
         swooned_count = greatest(0, swooned_count + (case when p_kind = 'swooned'  then p_delta else 0 end)),
         laughed_count = greatest(0, laughed_count + (case when p_kind = 'laughed'  then p_delta else 0 end)),
         furious_count = greatest(0, furious_count + (case when p_kind = 'furious'  then p_delta else 0 end))
   where id = p_post_id;
$$;

create or replace function public.bump_comment_reaction_counts(
  p_comment_id uuid,
  p_kind public.reaction_kind,
  p_delta integer
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.comments
     set loved_count   = greatest(0, loved_count   + (case when p_kind = 'loved'    then p_delta else 0 end)),
         cried_count   = greatest(0, cried_count   + (case when p_kind = 'cried'    then p_delta else 0 end)),
         screamed_count= greatest(0, screamed_count+ (case when p_kind = 'screamed' then p_delta else 0 end)),
         swooned_count = greatest(0, swooned_count + (case when p_kind = 'swooned'  then p_delta else 0 end)),
         laughed_count = greatest(0, laughed_count + (case when p_kind = 'laughed'  then p_delta else 0 end)),
         furious_count = greatest(0, furious_count + (case when p_kind = 'furious'  then p_delta else 0 end))
   where id = p_comment_id;
$$;

revoke all on function public.bump_post_reaction_counts(uuid, public.reaction_kind, integer) from public, anon, authenticated;
revoke all on function public.bump_comment_reaction_counts(uuid, public.reaction_kind, integer) from public, anon, authenticated;

create or replace function public.handle_reaction_counts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    -- Kind swap on the same target: -1 on the old column, +1 on the new one.
    if new.kind = old.kind then
      return new;
    end if;
    if new.post_id is not null then
      perform public.bump_post_reaction_counts(new.post_id, old.kind, -1);
      perform public.bump_post_reaction_counts(new.post_id, new.kind, 1);
    else
      perform public.bump_comment_reaction_counts(new.comment_id, old.kind, -1);
      perform public.bump_comment_reaction_counts(new.comment_id, new.kind, 1);
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.post_id is not null then
      perform public.bump_post_reaction_counts(new.post_id, new.kind, 1);
    else
      perform public.bump_comment_reaction_counts(new.comment_id, new.kind, 1);
    end if;
    return new;
  end if;

  -- DELETE
  if old.post_id is not null then
    perform public.bump_post_reaction_counts(old.post_id, old.kind, -1);
  else
    perform public.bump_comment_reaction_counts(old.comment_id, old.kind, -1);
  end if;
  return old;
end;
$$;

create trigger reactions_counts_insert after insert on public.reactions for each row execute function public.handle_reaction_counts();
create trigger reactions_counts_update after update of kind on public.reactions for each row execute function public.handle_reaction_counts();
create trigger reactions_counts_delete after delete on public.reactions for each row execute function public.handle_reaction_counts();

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------

alter table public.reactions enable row level security;

-- A reaction is a public signal ("who loved this") but the row belongs to its author: only they can
-- add or remove it, nobody else can delete someone else's reaction.
create policy reactions_select_visible on public.reactions
  for select to authenticated
  using (
    exists (select 1 from public.posts p where p.id = reactions.post_id and p.state = 'active')
    or exists (select 1 from public.comments c where c.id = reactions.comment_id and c.state = 'active')
    or user_id = auth.uid()
    or public.is_moderator()
  );

create policy reactions_select_anonymous on public.reactions
  for select to anon
  using (
    exists (select 1 from public.posts p where p.id = reactions.post_id and p.state = 'active' and p.visibility = 'public')
    or exists (select 1 from public.comments c where c.id = reactions.comment_id and c.state = 'active')
  );

create policy reactions_insert_own on public.reactions
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.account_status = 'active')
  );

create policy reactions_update_own on public.reactions
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy reactions_delete_own on public.reactions
  for delete to authenticated
  using (user_id = auth.uid() or public.is_moderator());

grant select on public.reactions to anon, authenticated;
grant insert, update, delete on public.reactions to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
