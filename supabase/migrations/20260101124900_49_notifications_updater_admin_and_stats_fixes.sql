-- =============================================================================================
-- Migration 49: End-to-End Fixes Across Notification Read Persistence, Push Wake Reliability,
--               Admin Bug & Content Report Alerts, App Update Release Notifications, Watch Party
--               RSVP Integrity, and Soft-Delete Profile Counter Accuracy.
-- =============================================================================================

-- 1. Fix `mark_notifications_read`: empty array (`'{}'::uuid[]`) OR `null` marks all unread rows
--    in scope as read instead of silently matching 0 rows when a client passes `[]`.
create or replace function public.mark_notifications_read(
  p_ids uuid[] default null,
  p_group public.notification_group default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  updated integer;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  update public.notifications
     set read_at = now()
   where recipient_id = actor
     and read_at is null
     and (p_ids is null or cardinality(p_ids) = 0 or id = any(p_ids))
     and (p_group is null or "group" = p_group);

  get diagnostics updated = row_count;
  return updated;
end;
$$;

revoke all on function public.mark_notifications_read(uuid[], public.notification_group) from public, anon;
grant execute on function public.mark_notifications_read(uuid[], public.notification_group) to authenticated, service_role;

-- 2. Notify ALL active admin/moderator accounts whenever ANY user (including staff testing from
--    their own account) submits a bug/support report, deep-linking straight to the `Bugs` tab.
create or replace function public.submit_support_ticket(
  p_category text,
  p_subject text,
  p_description text,
  p_reporter_email text default null,
  p_screenshot_url text default null,
  p_app_version text default null,
  p_platform text default null,
  p_route_name text default null,
  p_diagnostics jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  tid uuid;
  cat text := coalesce(nullif(btrim(p_category), ''), 'bug');
  clean_subject text := btrim(coalesce(p_subject, ''));
  clean_desc text := btrim(coalesce(p_description, ''));
  clean_email text := nullif(btrim(coalesce(p_reporter_email, '')), '');
  reporter_label text := 'guest';
  staff_rec record;
begin
  if char_length(clean_subject) < 2 or char_length(clean_desc) < 3 then
    raise exception 'subject and description are required' using errcode = 'invalid_parameter_value';
  end if;

  if cat not in ('bug', 'crash', 'missing_title', 'upload', 'account', 'feature') then
    cat := 'bug';
  end if;

  if uid is not null then
    select '@' || handle into reporter_label from public.profiles where id = uid;
  end if;
  reporter_label := coalesce(reporter_label, clean_email, 'guest');

  insert into public.support_tickets (
    reporter_id, reporter_email, category, subject, description,
    screenshot_url, app_version, platform, route_name, diagnostics
  )
  values (
    uid,
    clean_email,
    cat,
    left(clean_subject, 200),
    left(clean_desc, 4000),
    nullif(btrim(coalesce(p_screenshot_url, '')), ''),
    nullif(btrim(coalesce(p_app_version, '')), ''),
    nullif(btrim(coalesce(p_platform, '')), ''),
    nullif(btrim(coalesce(p_route_name, '')), ''),
    coalesce(p_diagnostics, '{}'::jsonb)
  )
  returning id into tid;

  for staff_rec in
    select id from public.profiles
     where role in ('admin', 'moderator')
       and account_status = 'active'
  loop
    perform public.enqueue_notification(
      p_recipient := staff_rec.id,
      p_kind := 'system',
      p_group := 'system',
      p_dedupe_key := 'ticket:' || tid::text || ':' || staff_rec.id::text,
      p_actor_ids := case when uid is not null then array[uid] else '{}'::uuid[] end,
      p_title := 'New ' || upper(cat) || ' report from ' || reporter_label,
      p_body := left(clean_subject || ' — ' || clean_desc, 180),
      p_deep_link := '/settings/moderation?tab=support'
    );
  end loop;

  return tid;
end;
$$;

grant execute on function public.submit_support_ticket(text, text, text, text, text, text, text, text, jsonb) to anon, authenticated, service_role;

create or replace function public.list_support_tickets(
  p_status text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    return '[]'::jsonb;
  end if;

  if exists (
    select 1 from public.profiles p
     where p.id = uid and p.role in ('admin', 'moderator') and p.account_status = 'active'
  ) then
    return coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'ticket', to_jsonb(t),
          'reporter', case when pr.id is not null then jsonb_build_object(
            'id', pr.id,
            'handle', pr.handle,
            'display_name', pr.display_name,
            'avatar_path', pr.avatar_path
          ) else null end
        )
        order by t.created_at desc
      )
      from (
        select *
        from public.support_tickets st
        where (p_status is null or p_status = 'all' or st.status = p_status)
        order by st.created_at desc
        limit least(greatest(coalesce(p_limit, 50), 1), 100)
      ) t
      left join public.profiles pr on pr.id = t.reporter_id
    ), '[]'::jsonb);
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object('ticket', to_jsonb(t), 'reporter', null) order by t.created_at desc)
    from (
      select *
      from public.support_tickets st
      where st.reporter_id = uid
        and (p_status is null or p_status = 'all' or st.status = p_status)
      order by st.created_at desc
      limit 30
    ) t
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.list_support_tickets(text, integer) to authenticated, service_role;

-- 4. Notify active admin/moderator accounts immediately when content/user reports or video access
--    requests arrive, deep-linking directly to the matching Admin Studio tab.
create or replace function public.handle_notify_report_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  reporter_label text := 'member';
  staff_rec record;
begin
  if new.reporter_id is not null then
    select '@' || handle into reporter_label from public.profiles where id = new.reporter_id;
  end if;

  for staff_rec in
    select id from public.profiles
     where role in ('admin', 'moderator')
       and account_status = 'active'
  loop
    perform public.enqueue_notification(
      p_recipient := staff_rec.id,
      p_kind := 'system',
      p_group := 'system',
      p_dedupe_key := 'report:' || new.id::text || ':' || staff_rec.id::text,
      p_actor_ids := case when new.reporter_id is not null then array[new.reporter_id] else '{}'::uuid[] end,
      p_title := 'Moderation report (' || new.target_type::text || ': ' || new.reason || ')',
      p_body := left('Reported by ' || coalesce(reporter_label, 'member') || case when coalesce(btrim(new.detail), '') <> '' then ' — ' || btrim(new.detail) else '' end, 180),
      p_deep_link := '/settings/moderation?tab=reports'
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists reports_notify_staff_insert on public.reports;
create trigger reports_notify_staff_insert
  after insert on public.reports
  for each row execute function public.handle_notify_report_insert();

create or replace function public.handle_notify_video_request_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requester_label text := 'member';
  staff_rec record;
begin
  if new.status <> 'pending' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'pending' then
    return new;
  end if;

  select '@' || handle into requester_label from public.profiles where id = new.user_id;

  for staff_rec in
    select id from public.profiles
     where role in ('admin', 'moderator')
       and account_status = 'active'
  loop
    perform public.enqueue_notification(
      p_recipient := staff_rec.id,
      p_kind := 'system',
      p_group := 'system',
      p_dedupe_key := 'creator-req:' || new.id::text || ':' || staff_rec.id::text,
      p_actor_ids := array[new.user_id],
      p_title := 'Creator access request from ' || coalesce(requester_label, 'member'),
      p_body := left(coalesce(nullif(btrim(new.note), ''), 'Tap to review in Admin Studio'), 180),
      p_deep_link := '/settings/moderation?tab=creators'
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists video_access_requests_notify_staff on public.video_access_requests;
create trigger video_access_requests_notify_staff
  after insert or update on public.video_access_requests
  for each row execute function public.handle_notify_video_request_insert();

-- 5. Announce new signed app updates to users whose devices are on an older build, waking push
--    delivery so closed Android devices receive high-priority update notifications automatically.
create or replace function public.announce_app_release(
  p_version_code integer,
  p_version_name text,
  p_release_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  jwt_role text := coalesce(current_setting('request.jwt.claim.role', true), '');
  clean_ver text := btrim(coalesce(p_version_name, ''));
  summary text;
  rec record;
  notified integer := 0;
begin
  if current_user not in ('postgres', 'service_role')
     and jwt_role <> 'service_role'
     and not public.is_admin() then
    raise exception 'admin or service_role required' using errcode = 'insufficient_privilege';
  end if;

  if p_version_code is null or p_version_code < 1 or clean_ver = '' then
    raise exception 'version_code and version_name are required' using errcode = 'invalid_parameter_value';
  end if;

  summary := coalesce(
    nullif(btrim(p_release_notes), ''),
    'Hallyu v' || clean_ver || ' is ready to download and install in Settings -> App Updates.'
  );

  for rec in
    select pr.id
      from public.profiles pr
     where pr.account_status = 'active'
       and pr.deleted_at is null
       and pr.handle not like 'verify_%'
       and not exists (
         select 1
           from public.push_tokens pt
          where pt.user_id = pr.id
            and pt.disabled_at is null
            and (
              pt.app_version = clean_ver
              or pt.app_version like clean_ver || ' (%'
            )
       )
  loop
    perform public.enqueue_notification(
      p_recipient := rec.id,
      p_kind := 'system',
      p_group := 'system',
      p_dedupe_key := 'app-release:' || p_version_code::text || ':' || rec.id::text,
      p_actor_ids := '{}'::uuid[],
      p_title := 'Hallyu v' || clean_ver || ' update available',
      p_body := left(summary, 200),
      p_deep_link := '/settings/updates'
    );
    notified := notified + 1;
  end loop;

  return jsonb_build_object(
    'version_code', p_version_code,
    'version_name', clean_ver,
    'recipients_notified', notified
  );
end;
$$;

revoke all on function public.announce_app_release(integer, text, text) from public, anon;
grant execute on function public.announce_app_release(integer, text, text) to authenticated, service_role;

-- 6. Keep profile & post counters accurate across soft-deletes / hides / restores (`UPDATE OF state`).
create or replace function public.handle_post_state_counts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.state = 'active' and new.state <> 'active' then
    update public.profiles
       set post_count = greatest(0, post_count - 1)
     where id = new.author_id;
  elsif old.state <> 'active' and new.state = 'active' then
    update public.profiles
       set post_count = post_count + 1
     where id = new.author_id;
  end if;
  return new;
end;
$$;

drop trigger if exists posts_author_count_state on public.posts;
create trigger posts_author_count_state
  after update of state on public.posts
  for each row execute function public.handle_post_state_counts();

create or replace function public.handle_comment_state_counts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.state = 'active' and new.state <> 'active' then
    update public.posts
       set comment_count = greatest(0, comment_count - 1)
     where id = new.post_id;
    update public.profiles
       set comment_count = greatest(0, comment_count - 1)
     where id = new.author_id;
  elsif old.state <> 'active' and new.state = 'active' then
    update public.posts
       set comment_count = comment_count + 1
     where id = new.post_id;
    update public.profiles
       set comment_count = comment_count + 1
     where id = new.author_id;
  end if;
  return new;
end;
$$;

drop trigger if exists comments_count_state on public.comments;
create trigger comments_count_state
  after update of state on public.comments
  for each row execute function public.handle_comment_state_counts();

-- 7. Reconcile cached counters against actual live rows (zero fake numbers, zero soft-delete drift).
alter table public.profiles disable trigger profiles_guard_counters;

update public.profiles pr
   set follower_count = (select count(*)::integer from public.follows f where f.target_id = pr.id),
       following_count = (select count(*)::integer from public.follows f where f.follower_id = pr.id),
       post_count = (select count(*)::integer from public.posts po where po.author_id = pr.id and po.state = 'active' and po.deleted_at is null),
       comment_count = (select count(*)::integer from public.comments cm where cm.author_id = pr.id and cm.state = 'active' and cm.deleted_at is null);

alter table public.profiles enable trigger profiles_guard_counters;

update public.hallyu_events ev
   set rsvp_count = (select count(*)::integer from public.hallyu_event_rsvps r where r.event_id = ev.id);
