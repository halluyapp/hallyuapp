-- Regression checks for privileged function grants (migration 56).
--
-- The strongest durable check here is the allowlist: every SECURITY DEFINER function in `public`
-- that the anon role can execute must be listed below. A new anon-callable privileged function
-- therefore fails the gate until someone decides it belongs on the list.
--
-- Same CHECK-line protocol as book_diary.sql. Run by scripts/localdb/check-security-grants.mjs.
-- expects: 9 checks

\set ON_ERROR_STOP off

create or replace function pg_temp.report(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin
  raise notice 'CHECK %: %', p_name, case when p_ok then 'OK' else 'FAIL ' || coalesce(p_detail, '') end;
end $$;

create or replace function pg_temp.raises(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlerrm;
end $$;

-- 1. No trigger function is executable by anon or authenticated.
select pg_temp.report('trigger-functions-not-callable',
  (select count(*) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) = 0);

-- 2. Anonymous callers can execute no privileged function outside the allowlist.
create temporary table if not exists allowed_anon (name text primary key);
insert into allowed_anon (name) values
  -- Public catalogue and discovery reads (guests browse).
  ('airing_titles'), ('browse_titles'), ('feed_page'), ('feed_posts'), ('get_community_detail'),
  ('get_community_pulse'), ('get_feed_bundle'), ('get_home_discovery'), ('get_latest_app_release'),
  ('get_person_detail'), ('get_post_polls'), ('get_post_thread'), ('get_profile_by_handle'),
  ('get_public_collections'), ('get_title_discovery'), ('get_user_recognition'),
  ('get_world_discoveries'), ('list_hallyu_events'), ('profile_awards_json'), ('recently_released_titles'),
  ('search_all'), ('search_collections'), ('search_communities'), ('search_people'), ('search_suggestions'), ('search_titles'),
  ('top_rated_titles'), ('trending_titles'), ('upcoming_titles'), ('world_leaders'),
  -- Needed by policies, signup, analytics and the guest support form.
  ('is_moderator'), ('author_has_live_post'), ('can_view_author_content'), ('handle_is_available'),
  ('record_event'), ('submit_support_ticket');

select pg_temp.report('anon-definer-functions-on-allowlist',
  (select count(*) = 0 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and has_function_privilege('anon', p.oid, 'execute')
      and p.proname not in (select name from allowed_anon)),
  (select string_agg(p.proname, ', ') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and has_function_privilege('anon', p.oid, 'execute')
      and p.proname not in (select name from allowed_anon)));

-- 3. Internal jobs are not callable by anon or authenticated.
select pg_temp.report('internal-jobs-owner-only',
  (select count(*) = 0 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('ensure_analytics_partition', 'wire_scheduled_functions')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))));

-- 4. Member RPCs: anon refused, authenticated still allowed.
select pg_temp.report('member-rpcs-refuse-anon',
  (select count(*) = 0 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('toggle_save', 'toggle_reaction', 'set_follow', 'set_block', 'upsert_watchlist_item',
                        'list_conversations', 'list_direct_messages', 'my_video_access_status', 'report_content')
      and has_function_privilege('anon', p.oid, 'execute')));

select pg_temp.report('member-rpcs-still-open-to-members',
  (select count(*) = 9 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('toggle_save', 'toggle_reaction', 'set_follow', 'set_block', 'upsert_watchlist_item',
                        'list_conversations', 'list_direct_messages', 'my_video_access_status', 'report_content')
      and has_function_privilege('authenticated', p.oid, 'execute')));

-- 5. Staff and writer functions: anon refused, authenticated allowed.
select pg_temp.report('staff-functions-refuse-anon',
  (select count(*) = 0 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('admin_tracker_overview', 'get_staff_overview', 'send_ceo_broadcast', 'resolve_support_ticket',
                        'list_support_tickets', 'staff_grant_video_by_handle', 'ensure_client_title', 'ensure_client_person')
      and has_function_privilege('anon', p.oid, 'execute')));

-- 6. Guest browsing and signup keep working: catalogue reads and the availability check stay open.
select pg_temp.report('guest-reads-stay-open',
  (select count(*) = 4 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('search_titles', 'browse_titles', 'handle_is_available', 'get_profile_by_handle')
      and has_function_privilege('anon', p.oid, 'execute')));

-- 7. Behaviour: an anonymous call to a member write is refused by the database, not just by the app.
set role anon;
select pg_temp.report('anon-write-refused-at-runtime',
  coalesce(pg_temp.raises($q$select public.toggle_save('00000000-0000-4000-8000-000000000001')$q$), '') like '%permission denied%');
reset role;

-- 8. Row-level security stays on for the private tables: the grant change is not the only protection.
select pg_temp.report('rls-still-on-for-private-tables',
  (select count(*) = 2 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relrowsecurity
      and c.relname in ('direct_messages', 'push_tokens')));
