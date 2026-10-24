-- =============================================================================================
-- Migration 54: Book Tracker and Viewing Diary — audit fixes and feature completion.
--   Additive and non-destructive. No existing row is rewritten, no column is dropped.
--
--   Book Tracker
--     * `book_titles` gains member-owned MANUAL books (source 'manual', owner_id, private).
--       Open Library rows stay shared and read-only to members.
--     * `shelf_items.total_pages_override`: a member's own page count for a book whose length is
--       unknown or wrong, without touching the shared catalogue.
--     * Progress and finish rules are enforced in one place (shelf_set_progress, log_reading,
--       shelf_update_details, shelf_delete_reading_log use the same rule).
--     * Finished books refuse new reading logs (the old code let them inflate yearly totals).
--     * RPCs: shelf_add_manual_book, shelf_update_details, shelf_set_progress,
--       shelf_delete_reading_log, shelf_book_logs. shelf_page and log_reading return more fields.
--
--   Viewing Diary
--     * `track_entries.watched_at` uses clock_timestamp(), so rows written in one batch are distinct.
--     * watch_diary_page_keyset: stable keyset pagination on (watched_on, watched_at, id).
--     * log_watch: a movie can only be logged once per day (episodes already were).
--     * update_watch_entry: edit rating, note and date with the same duplicate rules.
--     * tracker_summary and year_review report runtime coverage (entries with unknown runtime).
--     * tracker_export includes titles and book details.
--     * Execute is revoked from anon on every member RPC touched here.
-- =============================================================================================

set check_function_bodies = on;

-- ---------------------------------------------------------------------------------------------
-- 1. Book tables
-- ---------------------------------------------------------------------------------------------

alter table public.book_titles
  add column if not exists owner_id uuid references public.profiles (id) on delete cascade;

alter table public.book_titles
  add column if not exists client_key text check (client_key is null or char_length(client_key) between 8 and 120);

alter table public.book_titles drop constraint if exists book_titles_source_check;
alter table public.book_titles
  add constraint book_titles_source_check check (source in ('openlibrary', 'manual'));

alter table public.book_titles drop constraint if exists book_titles_manual_owner;
alter table public.book_titles
  add constraint book_titles_manual_owner check ((source = 'manual') = (owner_id is not null));

create unique index if not exists book_titles_manual_client_key_uidx
  on public.book_titles (owner_id, client_key)
  where client_key is not null;

-- Catalogue rows are shared; manual rows are visible only to the member who created them.
drop policy if exists book_titles_read_authenticated on public.book_titles;
drop policy if exists book_titles_read_catalogue_or_own on public.book_titles;
create policy book_titles_read_catalogue_or_own
  on public.book_titles
  for select
  to authenticated
  using (source = 'openlibrary' or owner_id = auth.uid());

alter table public.shelf_items
  add column if not exists total_pages_override smallint
  check (total_pages_override is null or total_pages_override between 1 and 20000);

-- ---------------------------------------------------------------------------------------------
-- 2. shelf_add_manual_book — a book that is not in Open Library. Title is required, the rest optional.
-- ---------------------------------------------------------------------------------------------

create or replace function public.shelf_add_manual_book(
  p_client_key            text,
  p_title                 text,
  p_authors               text[] default '{}',
  p_first_publish_year    integer default null,
  p_page_count            integer default null,
  p_cover_url             text default null,
  p_isbn13                text default null,
  p_shelf                 text default 'want',
  p_note                  text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor       uuid := auth.uid();
  today       date := (now() at time zone 'UTC')::date;
  title_clean text := left(btrim(coalesce(p_title, '')), 300);
  authors_clean text[];
  isbn_clean  text;
  note_clean  text := nullif(btrim(coalesce(p_note, '')), '');
  cover_clean text := nullif(btrim(coalesce(p_cover_url, '')), '');
  book        uuid;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if char_length(title_clean) = 0 then
    raise exception 'title is required' using errcode = 'check_violation';
  end if;
  if p_shelf not in ('want', 'reading', 'finished', 'dropped') then
    raise exception 'unknown shelf %', p_shelf using errcode = 'check_violation';
  end if;
  if p_page_count is not null and (p_page_count < 1 or p_page_count > 20000) then
    raise exception 'page count must be between 1 and 20000' using errcode = 'check_violation';
  end if;
  if p_first_publish_year is not null and (p_first_publish_year < 0 or p_first_publish_year > extract(year from today)::integer + 1) then
    raise exception 'publication year is out of range' using errcode = 'check_violation';
  end if;
  if cover_clean is not null and cover_clean !~ '^https://' then
    raise exception 'cover must be an https link' using errcode = 'check_violation';
  end if;
  if note_clean is not null and char_length(note_clean) > 280 then
    raise exception 'note must be 280 characters or fewer' using errcode = 'check_violation';
  end if;
  isbn_clean := nullif(regexp_replace(coalesce(p_isbn13, ''), '[^0-9Xx]', '', 'g'), '');
  if isbn_clean is not null and char_length(isbn_clean) not in (10, 13) then
    raise exception 'ISBN must have 10 or 13 digits' using errcode = 'check_violation';
  end if;
  authors_clean := coalesce(
    array(
      select left(btrim(a), 200)
      from unnest(coalesce(p_authors, '{}'::text[])) as a
      where btrim(a) <> ''
      limit 10
    ),
    '{}'::text[]
  );

  -- Retried submissions return the same book; identical titles from different submissions are separate.
  if p_client_key is not null then
    select id into book from public.book_titles where owner_id = actor and client_key = p_client_key;
    if found then
      return book;
    end if;
  end if;

  insert into public.book_titles (
    source, external_id, title, authors, first_publish_year, page_count, cover_url, isbn13, owner_id, client_key
  ) values (
    'manual', 'manual:' || gen_random_uuid()::text, title_clean, authors_clean, p_first_publish_year,
    p_page_count, cover_clean, isbn_clean, actor, p_client_key
  )
  returning id into book;

  insert into public.shelf_items (user_id, book_id, shelf, current_page, note, started_on, finished_on)
  values (
    actor, book, p_shelf,
    case when p_shelf = 'finished' and p_page_count is not null then p_page_count else 0 end,
    note_clean,
    case when p_shelf in ('reading', 'finished') then today end,
    case when p_shelf = 'finished' then today end
  );

  return book;
end;
$$;

revoke all on function public.shelf_add_manual_book(text, text, text[], integer, integer, text, text, text, text) from public;
revoke all on function public.shelf_add_manual_book(text, text, text[], integer, integer, text, text, text, text) from anon;
grant execute on function public.shelf_add_manual_book(text, text, text[], integer, integer, text, text, text, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. shelf_update_details — rating, note, dates and total pages for any shelf book;
--    title, authors, year, cover and ISBN for the member's own manual books.
--    Only keys present in the patch change. An explicit JSON null clears a field.
-- ---------------------------------------------------------------------------------------------

create or replace function public.shelf_update_details(p_book_id uuid, p_patch jsonb)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor      uuid := auth.uid();
  today      date := (now() at time zone 'UTC')::date;
  item       public.shelf_items%rowtype;
  bk         public.book_titles%rowtype;
  bad_key    text;
  v_text     text;
  new_rating smallint;
  new_note   text;
  new_start  date;
  new_finish date;
  new_total  integer;
  new_title  text;
  new_authors text[];
  new_year   integer;
  new_cover  text;
  new_isbn   text;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'patch must be a JSON object' using errcode = 'check_violation';
  end if;

  select key into bad_key
  from jsonb_object_keys(p_patch) as k(key)
  where key not in ('rating', 'note', 'started_on', 'finished_on', 'total_pages',
                    'title', 'authors', 'first_publish_year', 'cover_url', 'isbn13')
  limit 1;
  if bad_key is not null then
    raise exception 'field % cannot be changed here', bad_key using errcode = 'check_violation';
  end if;

  select * into item from public.shelf_items where user_id = actor and book_id = p_book_id for update;
  if not found then
    raise exception 'book is not on your shelf' using errcode = 'no_data_found';
  end if;
  select * into bk from public.book_titles where id = p_book_id;

  if bk.source <> 'manual' and (p_patch ?| array['title', 'authors', 'first_publish_year', 'cover_url', 'isbn13']) then
    raise exception 'book details come from Open Library and cannot be edited; set your own page count instead'
      using errcode = 'check_violation';
  end if;

  -- Rating
  new_rating := item.rating;
  if p_patch ? 'rating' then
    v_text := p_patch->>'rating';
    if v_text is null then
      new_rating := null;
    elsif v_text ~ '^[1-5]$' then
      new_rating := v_text::smallint;
    else
      raise exception 'rating must be a whole number from 1 to 5' using errcode = 'check_violation';
    end if;
  end if;

  -- Note
  new_note := item.note;
  if p_patch ? 'note' then
    new_note := nullif(btrim(coalesce(p_patch->>'note', '')), '');
    if new_note is not null and char_length(new_note) > 280 then
      raise exception 'note must be 280 characters or fewer' using errcode = 'check_violation';
    end if;
  end if;

  -- Dates
  new_start := item.started_on;
  if p_patch ? 'started_on' then
    v_text := p_patch->>'started_on';
    if v_text is null or btrim(v_text) = '' then
      new_start := null;
    elsif v_text ~ '^\d{4}-\d{2}-\d{2}$' then
      new_start := v_text::date;
    else
      raise exception 'start date must look like YYYY-MM-DD' using errcode = 'check_violation';
    end if;
    if new_start is not null and new_start > today + 1 then
      raise exception 'start date cannot be in the future' using errcode = 'check_violation';
    end if;
  end if;

  new_finish := item.finished_on;
  if p_patch ? 'finished_on' then
    v_text := p_patch->>'finished_on';
    if v_text is null or btrim(v_text) = '' then
      new_finish := null;
    elsif v_text ~ '^\d{4}-\d{2}-\d{2}$' then
      new_finish := v_text::date;
    else
      raise exception 'finish date must look like YYYY-MM-DD' using errcode = 'check_violation';
    end if;
    if new_finish is not null and new_finish > today + 1 then
      raise exception 'finish date cannot be in the future' using errcode = 'check_violation';
    end if;
  end if;
  if new_start is not null and new_finish is not null and new_finish < new_start then
    raise exception 'finish date cannot be before start date' using errcode = 'check_violation';
  end if;
  if item.shelf = 'finished' and new_finish is null then
    raise exception 'a finished book needs a finish date' using errcode = 'check_violation';
  end if;
  if item.shelf <> 'finished' and new_finish is not null then
    raise exception 'set the finish date by moving the book to Finished' using errcode = 'check_violation';
  end if;

  -- Total pages: a manual book's own page count, or the member's override for an Open Library book.
  new_total := case when bk.source = 'manual' then bk.page_count else item.total_pages_override::integer end;
  if p_patch ? 'total_pages' then
    v_text := p_patch->>'total_pages';
    if v_text is null or btrim(v_text) = '' then
      new_total := null;
    elsif v_text ~ '^[0-9]{1,5}$' and v_text::integer between 1 and 20000 then
      new_total := v_text::integer;
    else
      raise exception 'page count must be between 1 and 20000' using errcode = 'check_violation';
    end if;
    if new_total is not null and new_total < item.current_page then
      raise exception 'page count cannot be below your current page (%)', item.current_page using errcode = 'check_violation';
    end if;
  end if;

  -- Manual-book fields
  new_title := bk.title;
  new_authors := bk.authors;
  new_year := bk.first_publish_year;
  new_cover := bk.cover_url;
  new_isbn := bk.isbn13;
  if bk.source = 'manual' then
    if p_patch ? 'title' then
      new_title := left(btrim(coalesce(p_patch->>'title', '')), 300);
      if char_length(new_title) = 0 then
        raise exception 'title is required' using errcode = 'check_violation';
      end if;
    end if;
    if p_patch ? 'authors' then
      new_authors := coalesce(
        array(
          select left(btrim(a), 200)
          from jsonb_array_elements_text(case when jsonb_typeof(p_patch->'authors') = 'array' then p_patch->'authors' else '[]'::jsonb end) as a
          where btrim(a) <> ''
          limit 10
        ),
        '{}'::text[]
      );
    end if;
    if p_patch ? 'first_publish_year' then
      v_text := p_patch->>'first_publish_year';
      if v_text is null or btrim(v_text) = '' then
        new_year := null;
      elsif v_text ~ '^[0-9]{1,4}$' and v_text::integer <= extract(year from today)::integer + 1 then
        new_year := v_text::integer;
      else
        raise exception 'publication year is out of range' using errcode = 'check_violation';
      end if;
    end if;
    if p_patch ? 'cover_url' then
      v_text := nullif(btrim(coalesce(p_patch->>'cover_url', '')), '');
      if v_text is not null and v_text !~ '^https://' then
        raise exception 'cover must be an https link' using errcode = 'check_violation';
      end if;
      new_cover := v_text;
    end if;
    if p_patch ? 'isbn13' then
      v_text := nullif(regexp_replace(coalesce(p_patch->>'isbn13', ''), '[^0-9Xx]', '', 'g'), '');
      if v_text is not null and char_length(v_text) not in (10, 13) then
        raise exception 'ISBN must have 10 or 13 digits' using errcode = 'check_violation';
      end if;
      new_isbn := v_text;
    end if;

    update public.book_titles set
      title = new_title,
      authors = new_authors,
      first_publish_year = new_year,
      cover_url = new_cover,
      isbn13 = new_isbn,
      page_count = new_total
    where id = p_book_id and owner_id = actor;
  end if;

  -- Finish rule: a finished book sits on its last page once the length is known.
  if item.shelf = 'finished' and new_total is not null then
    update public.shelf_items set current_page = new_total
    where user_id = actor and book_id = p_book_id;
  end if;

  update public.shelf_items set
    rating = new_rating,
    note = new_note,
    started_on = new_start,
    finished_on = new_finish,
    total_pages_override = case when bk.source = 'manual' then null else new_total::smallint end,
    updated_at = now()
  where user_id = actor and book_id = p_book_id;

  return true;
end;
$$;

revoke all on function public.shelf_update_details(uuid, jsonb) from public;
revoke all on function public.shelf_update_details(uuid, jsonb) from anon;
grant execute on function public.shelf_update_details(uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. shelf_set_progress — correct the bookmark. It does NOT change the pages-read totals, which
--    come only from logged reading. Reaching the last page finishes the book; going back below
--    the last page reopens a finished book.
-- ---------------------------------------------------------------------------------------------

create or replace function public.shelf_set_progress(p_book_id uuid, p_page integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor     uuid := auth.uid();
  today     date := (now() at time zone 'UTC')::date;
  item      public.shelf_items%rowtype;
  eff       integer;
  new_shelf text;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if p_page is null or p_page < 0 then
    raise exception 'page cannot be negative' using errcode = 'check_violation';
  end if;
  if p_page > 20000 then
    raise exception 'page must be 20000 or fewer' using errcode = 'check_violation';
  end if;

  select * into item from public.shelf_items where user_id = actor and book_id = p_book_id for update;
  if not found then
    raise exception 'book is not on your shelf' using errcode = 'no_data_found';
  end if;
  if item.shelf = 'dropped' then
    raise exception 'move the book off Dropped before updating progress' using errcode = 'check_violation';
  end if;

  select coalesce(item.total_pages_override, t.page_count::integer) into eff
  from public.book_titles t where t.id = p_book_id;

  if eff is not null and p_page > eff then
    raise exception 'page cannot be more than the % pages in this book', eff using errcode = 'check_violation';
  end if;

  new_shelf := case
    when eff is not null and p_page = eff then 'finished'
    when item.shelf = 'finished' and eff is not null then 'reading'
    when item.shelf = 'finished' then 'finished'
    when item.shelf = 'want' and p_page > 0 then 'reading'
    else item.shelf
  end;

  update public.shelf_items set
    current_page = p_page,
    shelf = new_shelf,
    started_on = case when new_shelf in ('reading', 'finished') then coalesce(started_on, today) else started_on end,
    finished_on = case when new_shelf = 'finished' then coalesce(finished_on, today) else null end,
    updated_at = now()
  where user_id = actor and book_id = p_book_id;

  return jsonb_build_object('shelf', new_shelf, 'current_page', p_page);
end;
$$;

revoke all on function public.shelf_set_progress(uuid, integer) from public;
revoke all on function public.shelf_set_progress(uuid, integer) from anon;
grant execute on function public.shelf_set_progress(uuid, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. log_reading — replaces the 52 version. Finished and dropped books refuse new logs.
--    The bookmark never passes the last page; the reply says how many pages really counted.
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
  actor        uuid := auth.uid();
  today        date := (now() at time zone 'UTC')::date;
  item         public.shelf_items%rowtype;
  eff          integer;
  next_page    integer;
  pages_actual integer;
  finished     boolean := false;
  day_count    integer;
  dup          boolean := false;
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
    raise exception 'dropped books cannot be logged; move it to another shelf first' using errcode = 'check_violation';
  end if;
  if item.shelf = 'finished' then
    raise exception 'this book is finished; move it back to Reading to log more pages' using errcode = 'check_violation';
  end if;

  -- Idempotent: a retry with the same client key is a no-op.
  if p_client_key is not null and exists (
    select 1 from public.reading_logs where user_id = actor and client_key = p_client_key
  ) then
    dup := true;
  end if;

  if dup then
    return jsonb_build_object('duplicate', true, 'finished', false, 'pages_applied', 0, 'current_page', item.current_page);
  end if;

  select count(*) into day_count from public.reading_logs where user_id = actor and read_on = p_read_on;
  if day_count >= 60 then
    raise exception 'daily reading limit of 60 entries reached' using errcode = 'check_violation';
  end if;

  select coalesce(item.total_pages_override, t.page_count::integer) into eff
  from public.book_titles t where t.id = p_book_id;

  -- Only pages that really advance the bookmark count when the length is known.
  pages_actual := case when eff is not null then least(p_pages, greatest(eff - item.current_page, 0)) else p_pages end;
  if pages_actual < 1 then
    raise exception 'there are no pages left in this book' using errcode = 'check_violation';
  end if;

  insert into public.reading_logs (user_id, book_id, read_on, pages, client_key)
  values (actor, p_book_id, p_read_on, pages_actual, p_client_key);

  next_page := item.current_page + pages_actual;
  if eff is not null and next_page >= eff then
    next_page := eff;
    finished := true;
  end if;

  update public.shelf_items set
    current_page = next_page,
    shelf = case when finished then 'finished' when shelf = 'want' then 'reading' else shelf end,
    started_on = coalesce(started_on, p_read_on),
    finished_on = case when finished then coalesce(finished_on, p_read_on) else null end,
    updated_at = now()
  where user_id = actor and book_id = p_book_id;

  return jsonb_build_object('duplicate', false, 'finished', finished, 'pages_applied', pages_actual, 'current_page', next_page);
end;
$$;

revoke all on function public.log_reading(uuid, date, integer, text) from public;
revoke all on function public.log_reading(uuid, date, integer, text) from anon;
grant execute on function public.log_reading(uuid, date, integer, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. shelf_book_logs and shelf_delete_reading_log — the member's own reading history per book.
-- ---------------------------------------------------------------------------------------------

create or replace function public.shelf_book_logs(p_book_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  rows  jsonb;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  select coalesce(jsonb_agg(row_to_json(l) order by l.read_on desc, l.created_at desc, l.id desc), '[]'::jsonb)
    into rows
  from (
    select r.id, r.read_on, r.pages, r.created_at
    from public.reading_logs r
    where r.user_id = actor and r.book_id = p_book_id
    order by r.read_on desc, r.created_at desc, r.id desc
    limit 200
  ) l;
  return rows;
end;
$$;

revoke all on function public.shelf_book_logs(uuid) from public;
revoke all on function public.shelf_book_logs(uuid) from anon;
grant execute on function public.shelf_book_logs(uuid) to authenticated, service_role;

create or replace function public.shelf_delete_reading_log(p_log_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor    uuid := auth.uid();
  lg       public.reading_logs%rowtype;
  item     public.shelf_items%rowtype;
  eff      integer;
  new_page integer;
  new_shelf text;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into lg from public.reading_logs where id = p_log_id and user_id = actor for update;
  if not found then
    return jsonb_build_object('removed', false);
  end if;

  delete from public.reading_logs where id = p_log_id and user_id = actor;

  select * into item from public.shelf_items where user_id = actor and book_id = lg.book_id for update;
  if found then
    -- The bookmark is the sum of logged pages plus any correction; removing a log lowers it by that amount.
    new_page := greatest(item.current_page - lg.pages, 0);
    select coalesce(item.total_pages_override, t.page_count::integer) into eff
    from public.book_titles t where t.id = lg.book_id;
    new_shelf := case
      when item.shelf = 'finished' and eff is not null and new_page < eff then 'reading'
      else item.shelf
    end;
    update public.shelf_items set
      current_page = new_page,
      shelf = new_shelf,
      finished_on = case when new_shelf = 'finished' then finished_on else null end,
      updated_at = now()
    where user_id = actor and book_id = lg.book_id;
    return jsonb_build_object('removed', true, 'current_page', new_page, 'shelf', new_shelf);
  end if;

  return jsonb_build_object('removed', true);
end;
$$;

revoke all on function public.shelf_delete_reading_log(uuid) from public;
revoke all on function public.shelf_delete_reading_log(uuid) from anon;
grant execute on function public.shelf_delete_reading_log(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. shelf_page — adds effective page count, override and source. Totals unchanged in meaning.
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
           t.title, t.authors, t.cover_url, t.first_publish_year, t.external_id, t.source,
           t.page_count,
           s.total_pages_override,
           coalesce(s.total_pages_override, t.page_count::integer) as total_pages
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
revoke all on function public.shelf_page(integer) from anon;
grant execute on function public.shelf_page(integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 8. shelf_remove — removing a book deletes its reading logs (stated in the UI). A manual book
--    the member created is deleted too, so nothing is left orphaned.
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
  delete from public.book_titles
  where id = p_book_id and owner_id = actor and source = 'manual'
    and not exists (select 1 from public.shelf_items s where s.book_id = p_book_id);
  return removed > 0;
end;
$$;

revoke all on function public.shelf_remove(uuid) from public;
revoke all on function public.shelf_remove(uuid) from anon;
grant execute on function public.shelf_remove(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 9. Viewing Diary — stable ordering and cursors
-- ---------------------------------------------------------------------------------------------

-- Each insert gets its own timestamp, so batch imports do not share one value for every row.
alter table public.track_entries alter column watched_at set default clock_timestamp();

-- A movie is one event per day. Episodes were already limited by track_entries_first_watch_uidx.
create or replace function public.log_watch(
  p_title_id    uuid,
  p_watched_on  date,
  p_season      smallint default null,
  p_episode     smallint default null,
  p_rating      smallint default null,
  p_note        text default null,
  p_client_key  text default null,
  p_source      text default 'manual'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor       uuid := auth.uid();
  today_utc   date := (now() at time zone 'UTC')::date;
  unit_value  text;
  existing    public.track_entries%rowtype;
  inserted    public.track_entries%rowtype;
  day_count   integer;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from public.titles where id = p_title_id) then
    raise exception 'title % does not exist', p_title_id using errcode = 'no_data_found';
  end if;
  if p_watched_on is null or p_watched_on > today_utc + 1 then
    raise exception 'watched_on cannot be in the future' using errcode = 'check_violation';
  end if;
  if p_watched_on < today_utc - 3650 then
    raise exception 'watched_on is too far in the past' using errcode = 'check_violation';
  end if;
  if p_note is not null and char_length(p_note) > 280 then
    raise exception 'note must be 280 characters or fewer' using errcode = 'check_violation';
  end if;
  if p_rating is not null and (p_rating < 1 or p_rating > 5) then
    raise exception 'rating must be between 1 and 5' using errcode = 'check_violation';
  end if;
  if p_source not in ('manual', 'mark_watched', 'import') then
    raise exception 'unknown source %', p_source using errcode = 'check_violation';
  end if;
  -- Idempotency: a retried client request returns the original row.
  if p_client_key is not null then
    select * into existing from public.track_entries
    where user_id = actor and client_key = p_client_key;
    if found then
      return jsonb_build_object('entry_id', existing.id, 'duplicate', true);
    end if;
  end if;
  unit_value := case when p_season is null and p_episode is null then 'movie' else 'episode' end;
  -- Same title, same day, same episode (or same movie): return the existing row, do not double count.
  select * into existing from public.track_entries
  where user_id = actor and title_id = p_title_id
    and unit = unit_value
    and (unit_value = 'movie' or (season = p_season and episode = p_episode))
    and watched_on = p_watched_on and is_rewatch = false
  limit 1;
  if found then
    return jsonb_build_object('entry_id', existing.id, 'duplicate', true);
  end if;
  -- Daily cap keeps accidental loops and bad imports from flooding the diary.
  select count(*) into day_count from public.track_entries
  where user_id = actor and watched_on = p_watched_on;
  if day_count >= 60 then
    raise exception 'daily diary limit of 60 entries reached' using errcode = 'check_violation';
  end if;
  insert into public.track_entries (
    user_id, title_id, watched_on, season, episode, unit, rating, note, source, client_key
  ) values (
    actor, p_title_id, p_watched_on, p_season, p_episode, unit_value, p_rating,
    nullif(btrim(p_note), ''), p_source, p_client_key
  )
  returning * into inserted;
  -- Advance the existing watch pointer in the same transaction (never move it backwards).
  if unit_value = 'episode' then
    insert into public.watchlist_items (user_id, title_id, status, season, current_episode, updated_at)
    values (actor, p_title_id, 'watching', p_season, p_episode, now())
    on conflict (user_id, title_id) do update
      set current_episode = greatest(public.watchlist_items.current_episode, excluded.current_episode),
          season = case when excluded.current_episode >= public.watchlist_items.current_episode
                        then excluded.season else public.watchlist_items.season end,
          status = case when public.watchlist_items.status = 'want' then 'watching'::public.watch_status
                        else public.watchlist_items.status end,
          updated_at = now();
  end if;
  return jsonb_build_object('entry_id', inserted.id, 'duplicate', false);
end;
$$;

revoke all on function public.log_watch(uuid, date, smallint, smallint, smallint, text, text, text) from public;
revoke all on function public.log_watch(uuid, date, smallint, smallint, smallint, text, text, text) from anon;
grant execute on function public.log_watch(uuid, date, smallint, smallint, smallint, text, text, text)
  to authenticated, service_role;

-- Edit an entry: rating, note, or the day it was watched. Same duplicate and cap rules as logging.
create or replace function public.update_watch_entry(p_entry_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor      uuid := auth.uid();
  today_utc  date := (now() at time zone 'UTC')::date;
  e          public.track_entries%rowtype;
  bad_key    text;
  v_text     text;
  new_rating smallint := null;
  new_note   text;
  new_day    date := null;
  day_count  integer;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'patch must be a JSON object' using errcode = 'check_violation';
  end if;
  select key into bad_key
  from jsonb_object_keys(p_patch) as k(key)
  where key not in ('rating', 'note', 'watched_on')
  limit 1;
  if bad_key is not null then
    raise exception 'field % cannot be changed', bad_key using errcode = 'check_violation';
  end if;

  select * into e from public.track_entries where id = p_entry_id and user_id = actor for update;
  if not found then
    raise exception 'diary entry not found' using errcode = 'no_data_found';
  end if;

  new_rating := e.rating;
  if p_patch ? 'rating' then
    v_text := p_patch->>'rating';
    if v_text is null then
      new_rating := null;
    elsif v_text ~ '^[1-5]$' then
      new_rating := v_text::smallint;
    else
      raise exception 'rating must be a whole number from 1 to 5' using errcode = 'check_violation';
    end if;
  end if;

  new_note := e.note;
  if p_patch ? 'note' then
    new_note := nullif(btrim(coalesce(p_patch->>'note', '')), '');
    if new_note is not null and char_length(new_note) > 280 then
      raise exception 'note must be 280 characters or fewer' using errcode = 'check_violation';
    end if;
  end if;

  new_day := e.watched_on;
  if p_patch ? 'watched_on' then
    v_text := p_patch->>'watched_on';
    if v_text is null or v_text !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'watched date must look like YYYY-MM-DD' using errcode = 'check_violation';
    end if;
    new_day := v_text::date;
    if new_day > today_utc + 1 or new_day < today_utc - 3650 then
      raise exception 'watched date is out of range' using errcode = 'check_violation';
    end if;
  end if;

  if new_day is distinct from e.watched_on then
    if exists (
      select 1 from public.track_entries x
      where x.user_id = actor and x.id <> e.id and x.title_id = e.title_id and x.unit = e.unit
        and (e.unit = 'movie' or (x.season = e.season and x.episode = e.episode))
        and x.watched_on = new_day and x.is_rewatch = false
    ) then
      raise exception 'that title is already in your diary for that day' using errcode = 'check_violation';
    end if;
    select count(*) into day_count from public.track_entries where user_id = actor and watched_on = new_day;
    if day_count >= 60 then
      raise exception 'daily diary limit of 60 entries reached' using errcode = 'check_violation';
    end if;
  end if;

  update public.track_entries set
    rating = new_rating,
    note = new_note,
    watched_on = new_day
  where id = e.id and user_id = actor;

  return jsonb_build_object('updated', true, 'entry_id', e.id);
end;
$$;

revoke all on function public.update_watch_entry(uuid, jsonb) from public;
revoke all on function public.update_watch_entry(uuid, jsonb) from anon;
grant execute on function public.update_watch_entry(uuid, jsonb) to authenticated, service_role;

-- Keyset page of the diary, newest day first, then newest watch first, then id. The client
-- groups by watched_on, so every day forms one contiguous run that the cursor never splits badly.
create or replace function public.watch_diary_page_keyset(
  p_limit      integer default 30,
  p_before_on  date default null,
  p_before_at  timestamptz default null,
  p_before_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor     uuid := auth.uid();
  lim       integer := greatest(1, least(coalesce(p_limit, 30), 100));
  rows_json jsonb;
  fetched   integer;
  nxt       jsonb := null;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if (p_before_on is null) <> (p_before_at is null) or (p_before_on is null) <> (p_before_id is null) then
    raise exception 'diary cursor is incomplete' using errcode = 'check_violation';
  end if;

  with page as (
    select e.id, e.title_id, e.watched_on, e.watched_at, e.season, e.episode, e.unit,
           e.rating, e.note, e.source,
           t.title, t.poster_url, t.media_type,
           t.runtime_minutes as title_runtime,
           ep.runtime_minutes as episode_runtime
    from public.track_entries e
    join public.titles t on t.id = e.title_id
    left join public.title_episodes ep
      on ep.title_id = e.title_id and ep.season = e.season and ep.number = e.episode
    where e.user_id = actor
      and (p_before_on is null or (e.watched_on, e.watched_at, e.id) < (p_before_on, p_before_at, p_before_id))
    order by e.watched_on desc, e.watched_at desc, e.id desc
    limit lim + 1
  ), numbered as (
    select page.*, row_number() over (order by page.watched_on desc, page.watched_at desc, page.id desc) as rn
    from page
  )
  select coalesce(jsonb_agg(to_jsonb(n) - 'rn' order by n.rn) filter (where n.rn <= lim), '[]'::jsonb),
         count(*)::integer
    into rows_json, fetched
  from numbered n;

  if fetched > lim then
    nxt := jsonb_build_object(
      'watched_on', rows_json -> (lim - 1) ->> 'watched_on',
      'watched_at', rows_json -> (lim - 1) ->> 'watched_at',
      'id', rows_json -> (lim - 1) ->> 'id'
    );
  end if;

  return jsonb_build_object('entries', rows_json, 'has_more', fetched > lim, 'next', nxt);
end;
$$;

revoke all on function public.watch_diary_page_keyset(integer, date, timestamptz, uuid) from public;
revoke all on function public.watch_diary_page_keyset(integer, date, timestamptz, uuid) from anon;
grant execute on function public.watch_diary_page_keyset(integer, date, timestamptz, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 10. tracker_summary — same keys as before, plus runtime coverage so totals are read honestly.
-- ---------------------------------------------------------------------------------------------

create or replace function public.tracker_summary(p_today date default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  today date := coalesce(p_today, (now() at time zone 'UTC')::date);
  total_entries integer;
  unknown_runtime integer;
  total_minutes integer;
  days_active integer;
  current_streak integer := 0;
  longest_streak integer := 0;
  heatmap jsonb;
  today_count integer;
  run integer := 0;
  prev date := null;
  cursor_day date;
  d record;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if today > (now() at time zone 'UTC')::date + 1 then
    raise exception 'today cannot be in the future' using errcode = 'check_violation';
  end if;
  select count(*)::integer,
         count(*) filter (where coalesce(ep.runtime_minutes, t.runtime_minutes) is null)::integer,
         coalesce(sum(coalesce(ep.runtime_minutes, t.runtime_minutes)), 0)::integer
    into total_entries, unknown_runtime, total_minutes
  from public.track_entries e
  join public.titles t on t.id = e.title_id
  left join public.title_episodes ep
    on ep.title_id = e.title_id and ep.season = e.season and ep.number = e.episode
  where e.user_id = actor;
  select count(distinct watched_on) into days_active from public.track_entries where user_id = actor;
  select count(*) into today_count from public.track_entries
  where user_id = actor and watched_on = today;
  -- Streaks: consecutive distinct watch days, longest ever and the run ending today or yesterday.
  for d in
    select distinct watched_on from public.track_entries
    where user_id = actor order by watched_on
  loop
    if prev is not null and d.watched_on = prev + 1 then
      run := run + 1;
    else
      run := 1;
    end if;
    longest_streak := greatest(longest_streak, run);
    prev := d.watched_on;
  end loop;
  -- Current streak: start from today, or yesterday if today has no entry yet.
  cursor_day := today;
  if not exists (select 1 from public.track_entries where user_id = actor and watched_on = today) then
    cursor_day := today - 1;
  end if;
  loop
    exit when not exists (
      select 1 from public.track_entries where user_id = actor and watched_on = cursor_day
    );
    current_streak := current_streak + 1;
    cursor_day := cursor_day - 1;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('day', x.watched_on, 'count', x.n) order by x.watched_on), '[]'::jsonb)
    into heatmap
  from (
    select watched_on, count(*)::integer as n from public.track_entries
    where user_id = actor and watched_on > today - 365 and watched_on <= today + 1
    group by watched_on
  ) x;
  return jsonb_build_object(
    'today', today,
    'today_count', today_count,
    'total_entries', total_entries,
    'total_minutes', total_minutes,
    'runtime_known_entries', total_entries - unknown_runtime,
    'runtime_unknown_entries', unknown_runtime,
    'days_active', days_active,
    'current_streak', current_streak,
    'longest_streak', longest_streak,
    'heatmap', heatmap
  );
end;
$$;

revoke all on function public.tracker_summary(date) from public;
revoke all on function public.tracker_summary(date) from anon;
grant execute on function public.tracker_summary(date) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 11. year_review — adds runtime coverage. Other keys unchanged.
-- ---------------------------------------------------------------------------------------------

create or replace function public.year_review(p_year integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  yr integer := coalesce(p_year, extract(year from (now() at time zone 'UTC'))::integer);
  entries integer;
  unknown_runtime integer;
  minutes integer;
  days integer;
  best_day date;
  best_count integer;
  top jsonb;
  pages_total integer;
  books integer;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select count(*)::integer,
         count(*) filter (where coalesce(ep.runtime_minutes, t.runtime_minutes) is null)::integer,
         count(distinct e.watched_on)::integer,
         coalesce(sum(coalesce(ep.runtime_minutes, t.runtime_minutes, 0)), 0)::integer
    into entries, unknown_runtime, days, minutes
  from public.track_entries e
  join public.titles t on t.id = e.title_id
  left join public.title_episodes ep
    on ep.title_id = e.title_id and ep.season = e.season and ep.number = e.episode
  where e.user_id = actor and extract(year from e.watched_on) = yr;

  select e.watched_on, count(*)::integer into best_day, best_count
  from public.track_entries e
  where e.user_id = actor and extract(year from e.watched_on) = yr
  group by e.watched_on order by count(*) desc, e.watched_on limit 1;

  select coalesce(jsonb_agg(x order by x.entries desc, x.title), '[]'::jsonb) into top
  from (
    select t.title, t.poster_url, count(*)::integer as entries
    from public.track_entries e join public.titles t on t.id = e.title_id
    where e.user_id = actor and extract(year from e.watched_on) = yr
    group by t.id, t.title, t.poster_url
    order by count(*) desc, t.title limit 5
  ) x;

  select coalesce(sum(r.pages), 0)::integer into pages_total
  from public.reading_logs r where r.user_id = actor and extract(year from r.read_on) = yr;

  select count(*)::integer into books
  from public.shelf_items where user_id = actor and shelf = 'finished' and extract(year from finished_on) = yr;

  return jsonb_build_object(
    'year', yr, 'entries', entries, 'days_watched', days, 'minutes', minutes,
    'runtime_unknown_entries', coalesce(unknown_runtime, 0),
    'best_day', best_day, 'best_day_entries', coalesce(best_count, 0), 'top_titles', top,
    'pages_read', pages_total, 'books_finished', books
  );
end;
$$;

revoke all on function public.year_review(integer) from public;
revoke all on function public.year_review(integer) from anon;
grant execute on function public.year_review(integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 12. tracker_export — now includes titles, so the file is readable on its own.
-- ---------------------------------------------------------------------------------------------

create or replace function public.tracker_export()
returns jsonb
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

  return jsonb_build_object(
    'schema_version', 2,
    'exported_at', now(),
    'watch_entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'title', t.title, 'title_id', e.title_id, 'watched_on', e.watched_on, 'watched_at', e.watched_at,
        'season', e.season, 'episode', e.episode, 'unit', e.unit, 'rating', e.rating,
        'note', e.note, 'source', e.source, 'visibility', e.visibility
      ) order by e.watched_on, e.watched_at, e.id)
      from public.track_entries e join public.titles t on t.id = e.title_id
      where e.user_id = actor
    ), '[]'::jsonb),
    'reading_logs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'title', b.title, 'book_id', r.book_id, 'read_on', r.read_on, 'pages', r.pages
      ) order by r.read_on, r.created_at, r.id)
      from public.reading_logs r join public.book_titles b on b.id = r.book_id
      where r.user_id = actor
    ), '[]'::jsonb),
    'shelf', coalesce((
      select jsonb_agg(jsonb_build_object(
        'title', b.title, 'authors', b.authors, 'source', b.source, 'book_id', s.book_id,
        'shelf', s.shelf, 'current_page', s.current_page, 'total_pages', coalesce(s.total_pages_override, b.page_count::integer),
        'rating', s.rating, 'note', s.note, 'started_on', s.started_on, 'finished_on', s.finished_on
      ) order by s.added_at, s.book_id)
      from public.shelf_items s join public.book_titles b on b.id = s.book_id
      where s.user_id = actor
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.tracker_export() from public;
revoke all on function public.tracker_export() from anon;
grant execute on function public.tracker_export() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 13. Anonymous callers never execute member RPCs (defence in depth; RLS already blocks the data).
-- ---------------------------------------------------------------------------------------------

revoke execute on function public.shelf_add_book(text, text, text[], integer, integer, text, text, text, text) from anon;
revoke execute on function public.shelf_move(uuid, text, smallint, text) from anon;
revoke execute on function public.shelf_page(integer) from anon;
revoke execute on function public.shelf_remove(uuid) from anon;
revoke execute on function public.delete_watch_entry(uuid) from anon;
revoke execute on function public.watch_diary_page(timestamptz, integer) from anon;
revoke execute on function public.tracker_import_match(jsonb) from anon;
revoke execute on function public.log_watch_batch(jsonb) from anon;
revoke execute on function public.tracker_badges() from anon;
