-- Behaviour checks for the Book Tracker and Viewing Diary (migrations 52–54).
-- Each block prints `CHECK <name>: OK` or `CHECK <name>: FAIL <detail>`.
-- Run by scripts/localdb/check-book-diary.mjs against a database built by apply.mjs.
--
-- expects: 38 checks
--
-- Role + JWT emulation mirrors PostgREST: members are `authenticated` with request.jwt.claim.sub set.
-- Dates are fixed in the past so the checks do not depend on the wall clock.

\set ON_ERROR_STOP off

insert into auth.users (id, email, raw_user_meta_data) values
  ('c0c0c0c0-0000-4000-8000-00000000000a', 'book-owner@verification.test', '{"handle":"bookowner","full_name":"Book Owner"}'),
  ('d0d0d0d0-0000-4000-8000-00000000000b', 'book-other@verification.test', '{"handle":"bookother","full_name":"Book Other"}')
on conflict (id) do nothing;

insert into public.titles (id, provider_id, external_id, media_type, world, title, year, status, episode_count, season_count, genres)
values
  ('b0b0b0b0-0000-4000-8000-000000000001', 'tmdb', 'bd-series', 'tv', 'kdrama', 'Diary Series', 2026, 'airing', 16, 1, array['Drama']),
  ('b0b0b0b0-0000-4000-8000-000000000002', 'tmdb', 'bd-movie', 'movie', 'kdrama', 'Diary Movie', 2025, 'completed', 1, 1, array['Drama'])
on conflict (id) do nothing;

-- Helpers (session-scoped temp functions)
create or replace function pg_temp.as_user(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, false);
  perform set_config('request.jwt.claim.role', 'authenticated', false);
  perform set_config('role', 'authenticated', false);
end $$;

create or replace function pg_temp.as_super() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', false);
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('request.jwt.claim.role', '', false);
end $$;

create or replace function pg_temp.report(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin
  raise notice 'CHECK %: %', p_name, case when p_ok then 'OK' else 'FAIL ' || coalesce(p_detail, '') end;
end $$;

-- Returns the error message when the statement raises, or null when it runs cleanly.
create or replace function pg_temp.raises(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlerrm;
end $$;

-- ═════════════════════════════════════════════ BOOK ═══════════════════════════════════════════

select pg_temp.as_user('c0c0c0c0-0000-4000-8000-00000000000a');

-- B1. Manual add needs a title.
select pg_temp.report('manual-title-required',
  pg_temp.raises($q$select public.shelf_add_manual_book('bk-blank-0001', '   ')$q$) is not null);

-- B2. Manual add works without Open Library and stores the optional fields.
do $$
declare b uuid;
begin
  b := public.shelf_add_manual_book('bk-manual-0001', 'Handmade Notebook', array['A. Writer'], 2024, 120,
                                    null, '978-0-306-40615-7', 'reading', 'Lent by a friend');
  perform pg_temp.report('manual-add-ok', exists (
    select 1 from public.shelf_items s join public.book_titles t on t.id = s.book_id
    where s.book_id = b and t.source = 'manual' and s.shelf = 'reading'
      and t.page_count = 120 and t.isbn13 = '9780306406157' and s.note = 'Lent by a friend'
  ));
end $$;

-- B3. Retrying the same manual submission returns the same book and creates no second row.
do $$
declare first_id uuid; second_id uuid;
begin
  first_id := public.shelf_add_manual_book('bk-manual-0001', 'Handmade Notebook', array['A. Writer'], 2024, 120, null, null, 'reading', null);
  second_id := public.shelf_add_manual_book('bk-manual-0001', 'Handmade Notebook', array['A. Writer'], 2024, 120, null, null, 'reading', null);
  perform pg_temp.report('manual-retry-idempotent', first_id = second_id and (
    select count(*) from public.book_titles where client_key = 'bk-manual-0001') = 1);
end $$;

-- B4. Identical titles from separate submissions are separate books (not blocked as duplicates).
do $$
declare a uuid; b uuid;
begin
  a := public.shelf_add_manual_book('bk-manual-0002', 'Handmade Notebook', '{}', null, null, null, null, 'want', null);
  b := public.shelf_add_manual_book('bk-manual-0003', 'Handmade Notebook', '{}', null, null, null, null, 'want', null);
  perform pg_temp.report('manual-identical-titles-allowed', a <> b);
end $$;

-- B5. Invalid manual input is refused with a clear error, nothing is written.
select pg_temp.report('manual-invalid-input-refused', (
  pg_temp.raises($q$select public.shelf_add_manual_book('bk-bad-0001', 'X', '{}', null, 0)$q$) is not null
  and pg_temp.raises($q$select public.shelf_add_manual_book('bk-bad-0002', 'X', '{}', null, null, 'http://insecure.example/c.jpg')$q$) is not null
  and pg_temp.raises($q$select public.shelf_add_manual_book('bk-bad-0003', 'X', '{}', null, null, null, '12345')$q$) is not null
  and pg_temp.raises($q$select public.shelf_add_manual_book('bk-bad-0004', 'X', '{}', 3000)$q$) is not null
  and pg_temp.raises($q$select public.shelf_add_manual_book('bk-bad-0005', 'X', '{}', null, null, null, null, 'want', repeat('n', 281))$q$) is not null
  and not exists (select 1 from public.book_titles where client_key like 'bk-bad-%')
));

-- B6. Open Library book: unknown length accepts a bookmark; the total can be set by the member.
do $$
declare ol uuid;
begin
  ol := public.shelf_add_book('OL-BK-0001', 'Pachinko', array['Min Jin Lee'], 2017, null, null, null, 'want', 'openlibrary');
  perform public.shelf_set_progress(ol, 5);
  perform pg_temp.report('unknown-length-progress', exists (
    select 1 from public.shelf_items where book_id = ol and shelf = 'reading' and current_page = 5));
end $$;

select pg_temp.report('negative-progress-refused',
  pg_temp.raises($q$select public.shelf_set_progress((select id from public.book_titles where external_id = 'OL-BK-0001'), -1)$q$) is not null);

do $$
declare ol uuid;
begin
  select id into ol from public.book_titles where external_id = 'OL-BK-0001';
  perform public.shelf_update_details(ol, '{"total_pages": 40}');
  perform pg_temp.report('total-pages-set-by-member', exists (
    select 1 from public.shelf_items where book_id = ol and total_pages_override = 40));
end $$;

do $$
declare ol uuid;
begin
  select id into ol from public.book_titles where external_id = 'OL-BK-0001';
  perform pg_temp.report('over-total-progress-refused',
    pg_temp.raises(format($q$select public.shelf_set_progress(%L, 41)$q$, ol)) is not null);
  perform public.shelf_set_progress(ol, 40);
  perform pg_temp.report('last-page-finishes', exists (
    select 1 from public.shelf_items where book_id = ol and shelf = 'finished' and finished_on is not null));
end $$;

do $$
declare ol uuid;
begin
  select id into ol from public.book_titles where external_id = 'OL-BK-0001';
  perform pg_temp.report('finished-refuses-logs',
    pg_temp.raises(format($q$select public.log_reading(%L, '2026-10-10', 3, 'bk-fin-0001')$q$, ol)) is not null);
  perform public.shelf_set_progress(ol, 39);
  perform pg_temp.report('going-back-reopens', exists (
    select 1 from public.shelf_items where book_id = ol and shelf = 'reading' and finished_on is null));
  perform public.log_reading(ol, '2026-10-10', 5, 'bk-clip-0001');
  perform pg_temp.report('logged-pages-clipped-to-length', exists (
    select 1 from public.reading_logs where client_key = 'bk-clip-0001' and pages = 1)
    and exists (select 1 from public.shelf_items where book_id = ol and shelf = 'finished' and current_page = 40));
end $$;

-- B7. Double submission of the same log does not inflate totals; bookmark correction does not move totals.
do $$
declare m uuid; before_total integer; after_total integer; dup_flag boolean; log_id uuid;
begin
  select id into m from public.book_titles where source = 'manual' and client_key = 'bk-manual-0001';
  before_total := (public.shelf_page(2026)->>'pages_read_year')::integer;
  perform public.log_reading(m, '2026-10-10', 10, 'bk-dup-0001');
  dup_flag := (public.log_reading(m, '2026-10-10', 10, 'bk-dup-0001')->>'duplicate')::boolean;
  after_total := (public.shelf_page(2026)->>'pages_read_year')::integer;
  perform pg_temp.report('double-submit-no-inflation', dup_flag and after_total - before_total = 10,
    format('before %s after %s dup %s', before_total, after_total, dup_flag));

  before_total := after_total;
  perform public.shelf_set_progress(m, 80);
  after_total := (public.shelf_page(2026)->>'pages_read_year')::integer;
  perform pg_temp.report('bookmark-does-not-change-totals', after_total = before_total,
    format('before %s after %s', before_total, after_total));

  perform pg_temp.report('book-logs-listed', jsonb_array_length(public.shelf_book_logs(m)) = 1);
  select id into log_id from public.reading_logs where client_key = 'bk-dup-0001';
  perform public.shelf_delete_reading_log(log_id);
  perform pg_temp.report('delete-log-lowers-bookmark', exists (
    select 1 from public.shelf_items where book_id = m and current_page = 70));
end $$;

-- B8. Dropped books accept neither logs nor progress; details can be corrected.
do $$
declare m uuid;
begin
  select id into m from public.book_titles where source = 'manual' and client_key = 'bk-manual-0001';
  perform public.shelf_move(m, 'dropped');
  perform pg_temp.report('dropped-refuses-logs',
    pg_temp.raises(format($q$select public.log_reading(%L, '2026-10-10', 2, 'bk-drop-0001')$q$, m)) is not null
    and pg_temp.raises(format($q$select public.shelf_set_progress(%L, 2)$q$, m)) is not null);
  perform public.shelf_move(m, 'reading');
end $$;

do $$
declare m uuid;
begin
  select id into m from public.book_titles where source = 'manual' and client_key = 'bk-manual-0001';
  perform public.shelf_update_details(m, '{"rating": 4, "note": "Lovely paper"}');
  perform public.shelf_update_details(m, '{"rating": null, "note": ""}');
  perform pg_temp.report('rating-and-note-clear', exists (
    select 1 from public.shelf_items where book_id = m and rating is null and note is null));
  perform pg_temp.report('rating-range-enforced',
    pg_temp.raises(format($q$select public.shelf_update_details(%L, '{"rating": 6}')$q$, m)) is not null);
  perform pg_temp.report('unknown-detail-field-refused',
    pg_temp.raises(format($q$select public.shelf_update_details(%L, '{"shelf": "finished"}')$q$, m)) is not null);
  perform pg_temp.report('total-below-current-refused',
    pg_temp.raises(format($q$select public.shelf_update_details(%L, '{"total_pages": 50}')$q$, m)) is not null);
  perform public.shelf_update_details(m, '{"started_on": "2026-10-05"}');
  perform pg_temp.report('dates-save-and-reload', exists (
    select 1 from public.shelf_items where book_id = m and started_on = date '2026-10-05'));
  perform pg_temp.report('open-library-title-locked',
    pg_temp.raises(format($q$select public.shelf_update_details(%L, '{"title": "Renamed"}')$q$,
      (select id from public.book_titles where external_id = 'OL-BK-0001'))) is not null);
end $$;

-- B9. Another member cannot see or change this member's manual books or logs.
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-00000000000b');

do $$
declare m uuid; log_id uuid;
begin
  select id into m from public.book_titles where source = 'manual' and client_key = 'bk-manual-0001';
  select id into log_id from public.reading_logs where book_id = m limit 1;
  perform pg_temp.report('manual-book-private', (select count(*) from public.book_titles where id = m) = 0
    and (select count(*) from public.reading_logs) = 0
    and jsonb_array_length(public.shelf_book_logs(m)) = 0
    and pg_temp.raises(format($q$select public.shelf_set_progress(%L, 1)$q$, m)) is not null
    and public.shelf_delete_reading_log(log_id) ->> 'removed' = 'false');
  perform pg_temp.report('catalogue-readable-to-members', (select count(*) from public.book_titles
    where source = 'openlibrary') >= 1);
end $$;

select pg_temp.as_super();
select pg_temp.report('anon-cannot-run-member-rpcs', not (
  has_function_privilege('anon', 'public.shelf_update_details(uuid, jsonb)', 'execute')
  or has_function_privilege('anon', 'public.shelf_set_progress(uuid, integer)', 'execute')
  or has_function_privilege('anon', 'public.shelf_add_manual_book(text, text, text[], integer, integer, text, text, text, text)', 'execute')
  or has_function_privilege('anon', 'public.shelf_page(integer)', 'execute')
  or has_function_privilege('anon', 'public.log_reading(uuid, date, integer, text)', 'execute')
  or has_function_privilege('anon', 'public.update_watch_entry(uuid, jsonb)', 'execute')
  or has_function_privilege('anon', 'public.watch_diary_page_keyset(integer, date, timestamptz, uuid)', 'execute')
));

-- B10. Removing a manual book deletes it and its logs.
select pg_temp.as_user('c0c0c0c0-0000-4000-8000-00000000000a');
do $$
declare m uuid;
begin
  select id into m from public.book_titles where source = 'manual' and client_key = 'bk-manual-0003';
  perform public.shelf_remove(m);
  perform pg_temp.report('remove-deletes-manual-book',
    not exists (select 1 from public.book_titles where id = m));
end $$;

-- ═════════════════════════════════════════════ DIARY ══════════════════════════════════════════

-- D1. Batch import: each row gets its own timestamp, so same-day rows keep a stable order.
do $$
declare r jsonb; distinct_stamps integer;
begin
  r := public.log_watch_batch(jsonb_build_array(
    jsonb_build_object('title_id', 'b0b0b0b0-0000-4000-8000-000000000001', 'watched_on', '2026-10-01', 'season', 1, 'episode', 1),
    jsonb_build_object('title_id', 'b0b0b0b0-0000-4000-8000-000000000001', 'watched_on', '2026-10-01', 'season', 1, 'episode', 2),
    jsonb_build_object('title_id', 'b0b0b0b0-0000-4000-8000-000000000001', 'watched_on', '2026-10-01', 'season', 1, 'episode', 3)));
  select count(distinct watched_at) into distinct_stamps from public.track_entries
  where user_id = 'c0c0c0c0-0000-4000-8000-00000000000a' and watched_on = '2026-10-01';
  perform pg_temp.report('batch-rows-distinct-timestamps', (r->>'inserted')::integer = 3 and distinct_stamps = 3,
    format('result %s stamps %s', r, distinct_stamps));
end $$;

-- D2. A movie is logged once per day; a retry or double tap does not add a second row.
do $$
declare a jsonb; b jsonb;
begin
  a := public.log_watch('b0b0b0b0-0000-4000-8000-000000000002', '2026-10-02', null, null, 5::smallint, 'great', 'bd-movie-key-0001', 'manual');
  b := public.log_watch('b0b0b0b0-0000-4000-8000-000000000002', '2026-10-02', null, null, 5::smallint, 'great', 'bd-movie-key-0002', 'manual');
  perform pg_temp.report('movie-once-per-day', (b->>'duplicate')::boolean
    and (select count(*) from public.track_entries where user_id = 'c0c0c0c0-0000-4000-8000-00000000000a'
         and title_id = 'b0b0b0b0-0000-4000-8000-000000000002' and watched_on = '2026-10-02') = 1);
end $$;

-- D3. Several rows with identical watched_at still page through every row exactly once.
do $$
declare
  cursor_on date; cursor_at timestamptz; cursor_id uuid; page jsonb; nxt jsonb;
  seen uuid[] := '{}'; total integer; i integer;
begin
  -- Give a few rows the same timestamp on purpose (the bug the keyset fixes).
  perform set_config('role', 'postgres', false);
  update public.track_entries set watched_at = '2026-10-03 10:00:00+00'
  where id in (select id from public.track_entries
               where user_id = 'c0c0c0c0-0000-4000-8000-00000000000a' order by watched_on, id limit 3);
  for i in 1..5 loop
    perform public.log_watch('b0b0b0b0-0000-4000-8000-000000000001', '2026-10-04', 1::smallint, i::smallint, null, null,
      'bd-ep-key-' || i::text, 'manual');
  end loop;
  perform set_config('role', 'authenticated', false);
  perform set_config('request.jwt.claim.sub', 'c0c0c0c0-0000-4000-8000-00000000000a', false);
  select count(*) into total from public.track_entries where user_id = 'c0c0c0c0-0000-4000-8000-00000000000a';

  loop
    page := public.watch_diary_page_keyset(3, cursor_on, cursor_at, cursor_id);
    for i in 0..jsonb_array_length(page->'entries') - 1 loop
      seen := array_append(seen, ((page->'entries')->i ->> 'id')::uuid);
    end loop;
    exit when not (page->>'has_more')::boolean;
    nxt := page->'next';
    cursor_on := (nxt->>'watched_on')::date;
    cursor_at := (nxt->>'watched_at')::timestamptz;
    cursor_id := (nxt->>'id')::uuid;
  end loop;
  perform pg_temp.report('keyset-pages-every-row-once',
    cardinality(seen) = total and (select count(distinct x) from unnest(seen) x) = total,
    format('seen %s total %s', cardinality(seen), total));
end $$;

-- D4. Editing: rating and note save; moving a day onto an existing duplicate is refused.
do $$
declare ep1 uuid; ep2 uuid;
begin
  select id into ep1 from public.track_entries
  where user_id = 'c0c0c0c0-0000-4000-8000-00000000000a' and watched_on = '2026-10-01' and episode = 1;
  perform public.update_watch_entry(ep1, '{"rating": 2, "note": "rewatch soon"}');
  perform pg_temp.report('diary-edit-rating-note', exists (
    select 1 from public.track_entries where id = ep1 and rating = 2 and note = 'rewatch soon'));

  perform public.log_watch('b0b0b0b0-0000-4000-8000-000000000001', '2026-10-06', 1::smallint, 2::smallint, null, null, 'bd-ep2-oct06', 'manual');
  select id into ep2 from public.track_entries
  where user_id = 'c0c0c0c0-0000-4000-8000-00000000000a' and watched_on = '2026-10-01' and episode = 2;
  perform pg_temp.report('diary-edit-date-duplicate-refused',
    pg_temp.raises(format($q$select public.update_watch_entry(%L, '{"watched_on": "2026-10-06"}')$q$, ep2)) is not null);
  perform pg_temp.report('diary-edit-future-date-refused',
    pg_temp.raises(format($q$select public.update_watch_entry(%L, '{"watched_on": "2099-01-01"}')$q$, ep2)) is not null);
end $$;

-- D5. Deleting a diary entry persists.
do $$
declare mv uuid;
begin
  select id into mv from public.track_entries
  where user_id = 'c0c0c0c0-0000-4000-8000-00000000000a' and unit = 'movie' limit 1;
  perform public.delete_watch_entry(mv);
  perform pg_temp.report('diary-delete-persists', not exists (select 1 from public.track_entries where id = mv));
end $$;

-- D6. Summary and year review report runtime coverage; export carries titles.
do $$
declare s jsonb; y jsonb; ex jsonb;
begin
  s := public.tracker_summary(date '2026-10-24');
  y := public.year_review(2026);
  ex := public.tracker_export();
  perform pg_temp.report('runtime-coverage-reported',
    (s->>'runtime_unknown_entries')::integer = (s->>'total_entries')::integer
    and (s->>'runtime_known_entries')::integer = 0
    and (y ? 'runtime_unknown_entries'));
  perform pg_temp.report('export-includes-titles',
    ex->'watch_entries'->0 ? 'title' and (ex->>'schema_version')::integer = 2);
end $$;

-- D7. Another member's diary is private to them.
select pg_temp.as_user('d0d0d0d0-0000-4000-8000-00000000000b');
select pg_temp.report('diary-private-to-member', (
  select count(*) from public.track_entries) = 0
  and jsonb_array_length(public.watch_diary_page_keyset(30, null, null, null)->'entries') = 0);

select pg_temp.as_super();
