-- =============================================================================================
-- Migration 52: Book Shelf & Reading Log (Phase 2 of the Watch Tracker)
--   * `book_titles`: shared public catalogue of books (Open Library ids), readable by members.
--   * `shelf_items`: each member's private shelf (want / reading / finished / dropped) and page.
--   * `reading_logs`: dated pages-read entries, idempotent via client_key, private.
--   * RPCs own every write. Tables are owner-only for reads.
--   * Additive only.
-- =============================================================================================

set check_function_bodies = on;

-- ---------------------------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------------------------

create table if not exists public.book_titles (
  id                  uuid        primary key default gen_random_uuid(),
  source              text        not null default 'openlibrary' check (source in ('openlibrary')),
  external_id         text        not null check (char_length(external_id) between 2 and 60),
  title               text        not null check (char_length(title) between 1 and 300),
  authors             text[]      not null default '{}',
  first_publish_year  smallint    check (first_publish_year is null or first_publish_year between 0 and 3000),
  page_count          smallint    check (page_count is null or page_count between 1 and 20000),
  cover_url           text,
  isbn13              text        check (isbn13 is null or char_length(isbn13) between 10 and 17),
  created_at          timestamptz not null default now(),
  unique (source, external_id)
);

alter table public.book_titles enable row level security;

drop policy if exists book_titles_read_authenticated on public.book_titles;
create policy book_titles_read_authenticated
  on public.book_titles
  for select
  to authenticated
  using (true);

revoke all on public.book_titles from anon, authenticated;
grant select on public.book_titles to authenticated;

create table if not exists public.shelf_items (
  user_id       uuid        not null references public.profiles (id) on delete cascade,
  book_id       uuid        not null references public.book_titles (id) on delete cascade,
  shelf         text        not null default 'want' check (shelf in ('want', 'reading', 'finished', 'dropped')),
  current_page  integer     not null default 0 check (current_page >= 0 and current_page <= 20000),
  rating        smallint    check (rating is null or rating between 1 and 5),
  note          text        check (note is null or char_length(note) <= 280),
  added_at      timestamptz not null default now(),
  started_on    date,
  finished_on   date,
  updated_at    timestamptz not null default now(),
  primary key (user_id, book_id),
  constraint shelf_items_finished_stamp check ((shelf = 'finished') = (finished_on is not null))
);

create index if not exists shelf_items_user_shelf_idx on public.shelf_items (user_id, shelf);

alter table public.shelf_items enable row level security;

drop policy if exists shelf_items_owner_select on public.shelf_items;
create policy shelf_items_owner_select
  on public.shelf_items
  for select
  to authenticated
  using (user_id = auth.uid());

revoke all on public.shelf_items from anon, authenticated;
grant select on public.shelf_items to authenticated;

create table if not exists public.reading_logs (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references public.profiles (id) on delete cascade,
  book_id     uuid        not null references public.book_titles (id) on delete cascade,
  read_on     date        not null,
  pages       integer     not null check (pages between 1 and 2000),
  client_key  text        check (client_key is null or char_length(client_key) between 8 and 120),
  created_at  timestamptz not null default now(),
  constraint reading_logs_no_future check (read_on <= (now() at time zone 'UTC')::date + 1)
);

create unique index if not exists reading_logs_client_key_uidx
  on public.reading_logs (user_id, client_key)
  where client_key is not null;

create index if not exists reading_logs_user_day_idx on public.reading_logs (user_id, read_on desc);

alter table public.reading_logs enable row level security;

drop policy if exists reading_logs_owner_select on public.reading_logs;
create policy reading_logs_owner_select
  on public.reading_logs
  for select
  to authenticated
  using (user_id = auth.uid());

revoke all on public.reading_logs from anon, authenticated;
grant select on public.reading_logs to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. shelf_add_book — catalogue upsert + put on a shelf (idempotent)
-- ---------------------------------------------------------------------------------------------

create or replace function public.shelf_add_book(
  p_external_id        text,
  p_title              text,
  p_authors            text[] default '{}',
  p_first_publish_year integer default null,
  p_page_count         integer default null,
  p_cover_url          text default null,
  p_isbn13             text default null,
  p_shelf              text default 'want',
  p_source             text default 'openlibrary'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor    uuid := auth.uid();
  book     uuid;
  existing public.shelf_items%rowtype;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if p_shelf not in ('want', 'reading', 'finished', 'dropped') then
    raise exception 'unknown shelf %', p_shelf using errcode = 'check_violation';
  end if;
  if p_source not in ('openlibrary') then
    raise exception 'unknown book source %', p_source using errcode = 'check_violation';
  end if;
  if p_external_id is null or char_length(p_external_id) < 2 then
    raise exception 'external id required' using errcode = 'check_violation';
  end if;
  if p_title is null or char_length(btrim(p_title)) = 0 then
    raise exception 'title required' using errcode = 'check_violation';
  end if;

  insert into public.book_titles (source, external_id, title, authors, first_publish_year, page_count, cover_url, isbn13)
  values (p_source, p_external_id, left(btrim(p_title), 300), coalesce(p_authors, '{}'),
          p_first_publish_year, p_page_count, p_cover_url, p_isbn13)
  on conflict (source, external_id) do update
    set page_count = coalesce(public.book_titles.page_count, excluded.page_count),
        cover_url = coalesce(public.book_titles.cover_url, excluded.cover_url),
        isbn13 = coalesce(public.book_titles.isbn13, excluded.isbn13)
  returning id into book;

  select * into existing from public.shelf_items where user_id = actor and book_id = book;
  if not found then
    insert into public.shelf_items (user_id, book_id, shelf, started_on, finished_on)
    values (actor, book, p_shelf,
            case when p_shelf in ('reading', 'finished') then (now() at time zone 'UTC')::date end,
            case when p_shelf = 'finished' then (now() at time zone 'UTC')::date end);
  end if;

  return book;
end;
$$;

revoke all on function public.shelf_add_book(text, text, text[], integer, integer, text, text, text, text) from public;
grant execute on function public.shelf_add_book(text, text, text[], integer, integer, text, text, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. shelf_move — change shelf, rating or note. Finishing stamps the date and fills the page.
-- ---------------------------------------------------------------------------------------------

create or replace function public.shelf_move(
  p_book_id  uuid,
  p_shelf    text,
  p_rating   smallint default null,
  p_note     text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor  uuid := auth.uid();
  today  date := (now() at time zone 'UTC')::date;
  item   public.shelf_items%rowtype;
  pages  smallint;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if p_shelf not in ('want', 'reading', 'finished', 'dropped') then
    raise exception 'unknown shelf %', p_shelf using errcode = 'check_violation';
  end if;
  if p_rating is not null and (p_rating < 1 or p_rating > 5) then
    raise exception 'rating must be between 1 and 5' using errcode = 'check_violation';
  end if;
  if p_note is not null and char_length(p_note) > 280 then
    raise exception 'note must be 280 characters or fewer' using errcode = 'check_violation';
  end if;

  select * into item from public.shelf_items where user_id = actor and book_id = p_book_id for update;
  if not found then
    return false;
  end if;

  select page_count into pages from public.book_titles where id = p_book_id;

  update public.shelf_items set
    shelf = p_shelf,
    started_on = case when p_shelf in ('reading', 'finished') then coalesce(started_on, today) else started_on end,
    finished_on = case
      when p_shelf = 'finished' then coalesce(finished_on, today)
      else null end,
    current_page = case
      when p_shelf = 'finished' and pages is not null then pages
      else current_page end,
    rating = coalesce(p_rating, rating),
    note = coalesce(nullif(btrim(p_note), ''), note),
    updated_at = now()
  where user_id = actor and book_id = p_book_id;

  return true;
end;
$$;

revoke all on function public.shelf_move(uuid, text, smallint, text) from public;
grant execute on function public.shelf_move(uuid, text, smallint, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. log_reading — a dated pages-read entry. Advances the bookmark; finishing is automatic.
-- ---------------------------------------------------------------------------------------------

create or replace function public.log_reading(
  p_book_id    uuid,
  p_read_on    date,
  p_pages      integer,
  p_client_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor    uuid := auth.uid();
  today    date := (now() at time zone 'UTC')::date;
  item     public.shelf_items%rowtype;
  book_pages smallint;
  next_page integer;
  pages_actual integer;
  finished boolean := false;
  day_count integer;
  dup      boolean := false;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if p_pages is null or p_pages < 1 or p_pages > 2000 then
    raise exception 'pages must be between 1 and 2000' using errcode = 'check_violation';
  end if;
  if p_read_on is null or p_read_on > today + 1 or p_read_on < today - 3650 then
    raise exception 'read date is out of range' using errcode = 'check_violation';
  end if;

  select * into item from public.shelf_items where user_id = actor and book_id = p_book_id for update;
  if not found then
    raise exception 'book is not on your shelf' using errcode = 'no_data_found';
  end if;
  if item.shelf = 'dropped' then
    raise exception 'dropped books cannot be logged' using errcode = 'check_violation';
  end if;

  if p_client_key is not null and exists (
    select 1 from public.reading_logs where user_id = actor and client_key = p_client_key
  ) then
    dup := true;
  end if;

  if not dup then
    select count(*) into day_count from public.reading_logs where user_id = actor and read_on = p_read_on;
    if day_count >= 60 then
      raise exception 'daily reading limit of 60 entries reached' using errcode = 'check_violation';
    end if;

    select page_count into book_pages from public.book_titles where id = p_book_id;

    -- Store only the pages that really advanced the bookmark when the length is known.
    -- Re-reads of a finished book (or books with unknown length) keep the logged amount.
    if book_pages is not null and item.current_page < book_pages then
      pages_actual := least(p_pages, book_pages - item.current_page);
    else
      pages_actual := p_pages;
    end if;

    insert into public.reading_logs (user_id, book_id, read_on, pages, client_key)
    values (actor, p_book_id, p_read_on, pages_actual, p_client_key);

    next_page := item.current_page + pages_actual;
    if book_pages is not null and next_page >= book_pages then
      next_page := book_pages;
      finished := true;
    end if;

    update public.shelf_items set
      current_page = next_page,
      shelf = case when finished then 'finished' when shelf = 'want' then 'reading' else shelf end,
      started_on = coalesce(started_on, p_read_on),
      finished_on = case when finished then coalesce(finished_on, p_read_on) else finished_on end,
      updated_at = now()
    where user_id = actor and book_id = p_book_id;
  end if;

  return jsonb_build_object('duplicate', dup, 'finished', finished);
end;
$$;

revoke all on function public.log_reading(uuid, date, integer, text) from public;
grant execute on function public.log_reading(uuid, date, integer, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. shelf_page — the caller's shelves with book details, plus reading totals for the year
-- ---------------------------------------------------------------------------------------------

create or replace function public.shelf_page(p_year integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  yr    integer := coalesce(p_year, extract(year from (now() at time zone 'UTC'))::integer);
  books jsonb;
  pages_total integer;
  finished_year integer;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select coalesce(jsonb_agg(row_to_json(b) order by b.updated_at desc), '[]'::jsonb) into books
  from (
    select s.book_id, s.shelf, s.current_page, s.rating, s.note, s.started_on, s.finished_on, s.updated_at,
           t.title, t.authors, t.cover_url, t.page_count, t.first_publish_year, t.external_id
    from public.shelf_items s
    join public.book_titles t on t.id = s.book_id
    where s.user_id = actor
  ) b;

  select coalesce(sum(pages), 0)::integer into pages_total
  from public.reading_logs
  where user_id = actor and extract(year from read_on) = yr;

  select count(*)::integer into finished_year
  from public.shelf_items
  where user_id = actor and shelf = 'finished' and extract(year from finished_on) = yr;

  return jsonb_build_object(
    'year', yr,
    'books', books,
    'pages_read_year', pages_total,
    'finished_year', finished_year
  );
end;
$$;

revoke all on function public.shelf_page(integer) from public;
grant execute on function public.shelf_page(integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. shelf_remove — take a book off the caller's shelf (reading logs for it are removed too)
-- ---------------------------------------------------------------------------------------------

create or replace function public.shelf_remove(p_book_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor   uuid := auth.uid();
  removed integer;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  delete from public.reading_logs where user_id = actor and book_id = p_book_id;
  delete from public.shelf_items where user_id = actor and book_id = p_book_id;
  get diagnostics removed = row_count;
  return removed > 0;
end;
$$;

revoke all on function public.shelf_remove(uuid) from public;
grant execute on function public.shelf_remove(uuid) to authenticated, service_role;
