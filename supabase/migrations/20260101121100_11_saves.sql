-- Hallyu backend — 11 saves.
-- "Saved posts" is private bookkeeping with one public consequence: the save count on the post card.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create table if not exists public.saves (
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  post_id    uuid        not null references public.posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

comment on table public.saves is 'A member''s saved posts. Nobody else can see this list — it is what the "Saved" tab reads.';

create index if not exists saves_post_idx on public.saves (post_id);

create or replace function public.handle_save_counts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set save_count = save_count + 1 where id = new.post_id;
    return new;
  end if;
  update public.posts set save_count = greatest(0, save_count - 1) where id = old.post_id;
  return old;
end;
$$;

create trigger saves_count_insert after insert on public.saves for each row execute function public.handle_save_counts();
create trigger saves_count_delete after delete on public.saves for each row execute function public.handle_save_counts();

alter table public.saves enable row level security;

create policy saves_owner_select on public.saves
  for select to authenticated
  using (user_id = auth.uid());

create policy saves_owner_insert on public.saves
  for insert to authenticated
  with check (user_id = auth.uid());

create policy saves_owner_delete on public.saves
  for delete to authenticated
  using (user_id = auth.uid());

grant select, insert, delete on public.saves to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
