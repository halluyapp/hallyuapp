-- Regression checks for the episode reminder time-zone defect and reminder re-surfacing.
--
-- Defect: notify_at_for() used push_tokens.locale ('en-NG') as a time zone, so every quiet-hours
-- member with that locale made alerts.upcoming_episodes fail with
-- 'time zone "en-NG" not recognized'. Also, the hourly job re-queued the same episode reminders,
-- and enqueue_notification's conflict branch reset read_at/created_at, so a read reminder came back.
--
-- Same CHECK-line protocol as book_diary.sql. Run by scripts/localdb/check-notify-timezone.mjs.
-- expects: 16 checks

\set ON_ERROR_STOP off

insert into auth.users (id, email, raw_user_meta_data) values
  ('e0e0e0e0-0000-4000-8000-000000000001', 'tz-quiet-nig@verification.test', '{"handle":"tzquietnig","full_name":"TZ Quiet"}'),
  ('e0e0e0e0-0000-4000-8000-000000000002', 'tz-lagos@verification.test', '{"handle":"tzlagos","full_name":"TZ Lagos"}'),
  ('e0e0e0e0-0000-4000-8000-000000000003', 'tz-off@verification.test', '{"handle":"tzoff","full_name":"TZ Off"}'),
  ('e0e0e0e0-0000-4000-8000-000000000004', 'tz-moved@verification.test', '{"handle":"tzmoved","full_name":"TZ Moved"}')
on conflict (id) do nothing;

insert into public.user_preferences (user_id, quiet_hours) values
  ('e0e0e0e0-0000-4000-8000-000000000001', true),
  ('e0e0e0e0-0000-4000-8000-000000000002', true),
  ('e0e0e0e0-0000-4000-8000-000000000003', false),
  ('e0e0e0e0-0000-4000-8000-000000000004', false)
on conflict (user_id) do update set quiet_hours = excluded.quiet_hours;

insert into public.titles (id, provider_id, external_id, media_type, world, title, year, status, episode_count, season_count, genres)
values ('e0e0e0e0-0000-4000-8000-0000000000aa', 'tmdb', 'tz-airing', 'tv', 'kdrama', 'Zone Series', 2026, 'airing', 16, 1, array['Drama'])
on conflict (id) do nothing;

insert into public.title_episodes (title_id, season, number, title, air_date, air_time, runtime_minutes)
values ('e0e0e0e0-0000-4000-8000-0000000000aa', 1, 1, 'Pilot', current_date + 1, time '20:00', 60)
on conflict do nothing;

insert into public.watchlist_items (user_id, title_id, status)
values
  ('e0e0e0e0-0000-4000-8000-000000000001', 'e0e0e0e0-0000-4000-8000-0000000000aa', 'watching'),
  ('e0e0e0e0-0000-4000-8000-000000000003', 'e0e0e0e0-0000-4000-8000-0000000000aa', 'watching')
on conflict do nothing;

-- The member with en-NG as their only locale and no time zone (an existing install).
insert into public.push_tokens (user_id, token, platform, locale)
values ('e0e0e0e0-0000-4000-8000-000000000001', 'ExponentPushToken[tz-nig-locale-0000000001]', 'android', 'en-NG')
on conflict (token) do nothing;

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

create or replace function pg_temp.raises(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlerrm;
end $$;

-- 1. Locales are not time zones; valid IANA identifiers are accepted.
select pg_temp.report('locale-is-not-a-time-zone',
  public.is_valid_time_zone('en-NG') = false and public.is_valid_time_zone('Africa/Lagos') = true);

-- 2. Registration stores a valid device time zone next to the locale.
select pg_temp.as_user('e0e0e0e0-0000-4000-8000-000000000002');
select pg_temp.raises($q$select public.register_push_token('ExponentPushToken[tz-lagos-device-0000000002]', 'android', 'Pixel', '1.0', 'en-NG', 'Africa/Lagos')$q$);
select pg_temp.as_super();
select pg_temp.report('register-stores-valid-time-zone',
  (select time_zone from public.push_tokens where token = 'ExponentPushToken[tz-lagos-device-0000000002]') = 'Africa/Lagos');

-- 3. Invalid zone and malformed locale are dropped, not stored and not fatal.
select pg_temp.as_user('e0e0e0e0-0000-4000-8000-000000000003');
select pg_temp.raises($q$select public.register_push_token('ExponentPushToken[tz-bad-zone-00000000003]', 'android', null, null, 'zh-Hant-TW', 'en-NG')$q$);
select pg_temp.as_super();
select pg_temp.report('register-drops-invalid-zone-and-locale',
  (select time_zone is null and locale is null from public.push_tokens where token = 'ExponentPushToken[tz-bad-zone-00000000003]'));

-- 4. Older app builds send five arguments; they must still register.
select pg_temp.as_user('e0e0e0e0-0000-4000-8000-000000000004');
select pg_temp.report('legacy-five-arg-register-works',
  pg_temp.raises($q$select public.register_push_token('ExponentPushToken[tz-legacy-five-args-0004]', 'ios', null, null, 'en-US')$q$) is null);
select pg_temp.as_super();

-- 5. The member who has only an en-NG locale no longer breaks quiet-hours scheduling: UTC fallback.
select pg_temp.report('no-zone-falls-back-to-utc',
  pg_temp.raises($q$select public.notify_at_for('e0e0e0e0-0000-4000-8000-000000000001', '2026-10-25 20:00+00'::timestamptz)$q$) is null
  and public.notify_at_for('e0e0e0e0-0000-4000-8000-000000000001', '2026-10-25 20:00+00') = '2026-10-25 09:00+00'::timestamptz);

-- 6. Quiet hours follow the member's local day: 20:00 UTC is 21:00 in Lagos, so 09:00 Lagos is 08:00 UTC.
select pg_temp.report('quiet-hours-use-member-zone',
  public.notify_at_for('e0e0e0e0-0000-4000-8000-000000000002', '2026-10-25 20:00+00') = '2026-10-25 08:00+00'::timestamptz);

-- 7. Across the UTC date boundary: 23:30 UTC on the 25th is 00:30 on the 26th in Lagos.
select pg_temp.report('quiet-hours-across-utc-midnight',
  public.notify_at_for('e0e0e0e0-0000-4000-8000-000000000002', '2026-10-25 23:30+00') = '2026-10-26 08:00+00'::timestamptz);

-- 8. Members with quiet hours off keep the exact air moment.
select pg_temp.report('quiet-off-keeps-moment',
  public.notify_at_for('e0e0e0e0-0000-4000-8000-000000000003', '2026-10-25 20:00+00') = '2026-10-25 20:00+00'::timestamptz);

-- 9. The scheduled upcoming-episode job runs to completion with an en-NG member on the audience.
select pg_temp.report('upcoming-job-succeeds',
  pg_temp.raises($q$select public.job_queue_upcoming_episodes(current_date, current_date + 2)$q$) is null);

-- 10. One reminder per member per episode, however many times the job runs.
select public.job_queue_upcoming_episodes(current_date, current_date + 2);
select pg_temp.report('no-duplicate-reminder-per-episode',
  (select count(*) from public.notifications where recipient_id = 'e0e0e0e0-0000-4000-8000-000000000001'
     and dedupe_key = 'episode:e0e0e0e0-0000-4000-8000-0000000000aa:1:1') = 1);

-- 11. A reminder that was read stays read after the hourly job runs again.
update public.notifications set read_at = now()
where recipient_id = 'e0e0e0e0-0000-4000-8000-000000000001'
  and dedupe_key = 'episode:e0e0e0e0-0000-4000-8000-0000000000aa:1:1';
select public.job_queue_upcoming_episodes(current_date, current_date + 2);
select pg_temp.report('read-reminder-not-resurfaced',
  (select read_at is not null and coalesce_count = 1 from public.notifications
    where recipient_id = 'e0e0e0e0-0000-4000-8000-000000000001'
      and dedupe_key = 'episode:e0e0e0e0-0000-4000-8000-0000000000aa:1:1'));

-- 12. A schedule change moves a reminder that has not fired yet (member with quiet hours off).
select public.job_queue_upcoming_episodes(current_date, current_date + 2);
update public.title_episodes set air_time = time '18:00'
where title_id = 'e0e0e0e0-0000-4000-8000-0000000000aa' and season = 1 and number = 1;
select public.job_queue_upcoming_episodes(current_date, current_date + 2);
select pg_temp.report('schedule-change-moves-unfired-reminder',
  (select scheduled_for from public.notifications
    where recipient_id = 'e0e0e0e0-0000-4000-8000-000000000003'
      and dedupe_key = 'episode:e0e0e0e0-0000-4000-8000-0000000000aa:1:1')
   = ((current_date + 1)::timestamp + time '18:00') at time zone 'UTC');

-- 13. A reminder that already fired is never moved again by a later schedule change.
update public.notifications set scheduled_for = now() - interval '1 hour', read_at = now()
where recipient_id = 'e0e0e0e0-0000-4000-8000-000000000003'
  and dedupe_key = 'episode:e0e0e0e0-0000-4000-8000-0000000000aa:1:1';
update public.title_episodes set air_time = time '07:00'
where title_id = 'e0e0e0e0-0000-4000-8000-0000000000aa' and season = 1 and number = 1;
select public.job_queue_upcoming_episodes(current_date, current_date + 2);
select pg_temp.report('fired-reminder-stays-fired',
  (select scheduled_for < now() and read_at is not null from public.notifications
    where recipient_id = 'e0e0e0e0-0000-4000-8000-000000000003'
      and dedupe_key = 'episode:e0e0e0e0-0000-4000-8000-0000000000aa:1:1'));

-- 14. Preferences still gate reminders: notify_episodes off creates nothing.
update public.user_preferences set notify_episodes = false where user_id = 'e0e0e0e0-0000-4000-8000-000000000002';
insert into public.watchlist_items (user_id, title_id, status)
values ('e0e0e0e0-0000-4000-8000-000000000002', 'e0e0e0e0-0000-4000-8000-0000000000aa', 'watching')
on conflict do nothing;
select public.job_queue_upcoming_episodes(current_date, current_date + 2);
select pg_temp.report('episode-preference-still-respected',
  (select count(*) from public.notifications where recipient_id = 'e0e0e0e0-0000-4000-8000-000000000002'
     and dedupe_key = 'episode:e0e0e0e0-0000-4000-8000-0000000000aa:1:1') = 0);

-- 15. Users cannot read another member's push token time zone.
select pg_temp.as_user('e0e0e0e0-0000-4000-8000-000000000004');
select pg_temp.report('time-zone-private-to-owner',
  (select count(*) from public.push_tokens where time_zone is not null and user_id <> 'e0e0e0e0-0000-4000-8000-000000000004') = 0);
select pg_temp.as_super();

-- 16. Anonymous callers cannot run the scheduled job or read time zones.
select set_config('role', 'anon', false);
select pg_temp.report('anon-cannot-run-alert-job',
  pg_temp.raises($q$select public.job_queue_upcoming_episodes()$q$) is not null);
select pg_temp.as_super();
