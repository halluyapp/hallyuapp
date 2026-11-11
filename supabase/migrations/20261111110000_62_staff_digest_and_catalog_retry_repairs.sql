-- Remaining CEO recipient/filter repairs, atomic moderation-digest claims, and catalog retry safety.
-- Migration 62 also makes the deployed support-ticket notification text identical to tracked 61.
set check_function_bodies = off;

create or replace function public.resolve_support_ticket(
  p_ticket_id uuid,
  p_status text,
  p_staff_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := public.current_profile_id();
  rec public.support_tickets%rowtype;
begin
  if uid is null or not exists (select 1 from public.profiles p where p.id = uid and p.role in ('ceo', 'admin', 'moderator') and p.account_status = 'active') then
    raise exception 'staff privilege required' using errcode = 'insufficient_privilege';
  end if;

  if p_status not in ('open', 'investigating', 'resolved', 'closed') then
    raise exception 'invalid ticket status' using errcode = 'invalid_parameter_value';
  end if;

  update public.support_tickets
     set status = p_status,
         staff_note = coalesce(nullif(btrim(p_staff_note), ''), staff_note),
         updated_at = now()
   where id = p_ticket_id
   returning * into rec;

  if rec.id is null then
    return false;
  end if;

  if rec.reporter_id is not null and rec.reporter_id <> uid then
    perform public.enqueue_notification(
      p_recipient := rec.reporter_id,
      p_kind := 'system',
      p_group := 'system',
      p_dedupe_key := 'ticket-status:' || rec.id::text || ':' || p_status,
      p_actor_ids := array[uid],
      p_title := 'Update on your Hallyu report (' || p_status || ')',
      p_body := coalesce(nullif(btrim(p_staff_note), ''), rec.subject),
      p_deep_link := '/settings/bug-report'
    );
  end if;

  return true;
end;
$$;

create or replace function public.admin_search_users(
  p_query text default '',
  p_filter text default 'all',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  q text := lower(btrim(regexp_replace(coalesce(p_query, ''), '^@', '')));
  flt text := lower(btrim(coalesce(p_filter, 'all')));
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  ofs integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not public.is_moderator() then
    raise exception 'staff privilege required' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'handle', p.handle,
        'display_name', p.display_name,
        'avatar_path', p.avatar_path,
        'bio', p.bio,
        'email', null,
        'role', p.role,
        'account_status', p.account_status,
        'verified', p.verified,
        'verification_tier', p.verification_tier,
        'verification_note', p.verification_note,
        'verified_at', p.verified_at,
        'is_founder', p.is_founder,
        'exclude_from_competitions', p.exclude_from_competitions,
        'featured_badge_ids', p.featured_badge_ids,
        'follower_count', p.follower_count,
        'following_count', p.following_count,
        'post_count', p.post_count,
        'comment_count', p.comment_count,
        'created_at', p.created_at,
        'awards', public.profile_awards_json(p.id),
        'revoked_awards', coalesce((
          select jsonb_agg(jsonb_build_object(
            'award_id', r_ua.id,
            'badge_id', r_ua.badge_id,
            'serial_number', r_ua.serial_number,
            'revoked_at', r_ua.revoked_at,
            'revoke_reason', r_ua.revoke_reason
          ))
          from public.user_awards r_ua
          where r_ua.user_id = p.id and r_ua.status = 'revoked'
        ), '[]'::jsonb)
      )
      order by p.is_founder desc, p.created_at desc
    )
    from (
      select pr.*
      from public.profiles pr
      where pr.account_status <> 'deleted'
        and pr.handle::text not like 'pw_adm_%'
        and pr.handle::text not like 'verify_%'
        and (
          q = ''
          or lower(pr.handle::text) like '%' || q || '%'
          or lower(pr.display_name) like '%' || q || '%'
        )
        and (
          flt = 'all'
          or (flt = 'verified_blue' and pr.verification_tier = 'blue')
          or (flt = 'verified_red' and pr.verification_tier = 'red')
          or (flt = 'staff' and pr.role in ('ceo', 'admin', 'moderator'))
          or (flt = 'suspended' and pr.account_status = 'suspended')
          or (flt = 'excluded' and (pr.is_founder or pr.exclude_from_competitions))
          or (flt = 'early_awards' and exists (
            select 1 from public.user_awards ua
            join public.badge_definitions bd on bd.id = ua.badge_id
            where ua.user_id = pr.id and ua.status = 'active' and bd.category = 'early_member'
          ))
        )
      order by pr.is_founder desc, pr.created_at desc
      limit lim offset ofs
    ) p
  ), '[]'::jsonb);
end;
$$;

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
  uid uuid := public.current_profile_id();
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
     where role in ('ceo', 'admin', 'moderator')
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

create or replace function public.submit_verification_request(
  p_requested_tier text default 'blue',
  p_category text default 'creator',
  p_statement text default '',
  p_evidence_links text[] default '{}'::text[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := public.current_profile_id();
  prof public.profiles%rowtype;
  clean_tier text := lower(btrim(coalesce(p_requested_tier, 'blue')));
  clean_cat text := lower(btrim(coalesce(p_category, 'creator')));
  clean_stmt text := btrim(coalesce(p_statement, ''));
  req_id uuid;
  staff_rec record;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into prof from public.profiles where id = actor and account_status = 'active';
  if prof.id is null then
    raise exception 'active member profile required' using errcode = 'insufficient_privilege';
  end if;

  if clean_tier not in ('blue', 'red') then
    clean_tier := 'blue';
  end if;

  if clean_cat not in ('creator', 'journalist', 'community_leader', 'public_figure', 'official_brand', 'staff') then
    clean_cat := 'creator';
  end if;

  if char_length(clean_stmt) < 10 then
    raise exception 'verification statement must be at least 10 characters' using errcode = 'invalid_parameter_value';
  end if;

  if exists (
    select 1 from public.verification_requests vr
     where vr.user_id = actor and vr.status = 'pending'
  ) then
    raise exception 'you already have a verification request pending review' using errcode = 'unique_violation';
  end if;

  insert into public.verification_requests (
    user_id,
    requested_tier,
    category,
    evidence_links,
    statement
  )
  values (
    actor,
    clean_tier,
    clean_cat,
    (coalesce(p_evidence_links, '{}'::text[]))[1:5],
    left(clean_stmt, 2000)
  )
  returning id into req_id;

  for staff_rec in
    select id from public.profiles
     where role in ('ceo', 'admin')
       and account_status = 'active'
  loop
    perform public.enqueue_notification(
      p_recipient := staff_rec.id,
      p_kind := 'system',
      p_group := 'system',
      p_dedupe_key := 'verif-req:' || req_id::text || ':' || staff_rec.id::text,
      p_actor_ids := array[actor],
      p_title := upper(clean_tier) || ' verification request from @' || prof.handle::text,
      p_body := left(clean_stmt, 180),
      p_deep_link := '/admin?section=verification'
    );
  end loop;

  return req_id;
end;
$$;


-- Atomically claim a digest batch. FOR UPDATE SKIP LOCKED makes concurrent workers disjoint; the
-- status transition and row return are one statement, so no worker reports an unclaimed open row.
create or replace function public.claim_moderation_reports(
  p_limit integer default 200,
  p_stale_before timestamptz default (now() - interval '48 hours')
)
returns setof public.reports
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'moderation digest is service-role only' using errcode = 'insufficient_privilege';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'digest limit must be between 1 and 500' using errcode = 'invalid_parameter_value';
  end if;

  update public.reports
     set status = 'open', updated_at = now()
   where status = 'reviewing' and updated_at < p_stale_before;

  return query
    with candidates as (
      select r.id from public.reports r
       where r.status = 'open'
       order by r.created_at
       limit p_limit
       for update skip locked
    ), claimed as (
      update public.reports r
         set status = 'reviewing', updated_at = now()
        from candidates c where r.id = c.id
        returning r.*
    )
    select * from claimed order by created_at;
end;
$$;

revoke all on function public.claim_moderation_reports(integer, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_moderation_reports(integer, timestamptz) to service_role;


create or replace function public.catalog_begin_run(
  p_job text,
  p_provider_id text default 'tmdb',
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  run_id uuid;
  run_row public.catalog_sync_runs%rowtype;
  key text;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'catalog ingest is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  if p_job is null or btrim(p_job) = '' then
    raise exception 'catalog job is required' using errcode = 'invalid_parameter_value';
  end if;
  if p_provider_id is null or not exists (select 1 from public.providers pr where pr.id = p_provider_id and pr.is_active) then
    raise exception 'catalog provider % is not active', p_provider_id using errcode = 'no_data_found';
  end if;

  key := coalesce(nullif(btrim(p_idempotency_key), ''), p_job || ':' || to_char(now() at time zone 'utc', 'YYYYMMDDHH24'));
  if char_length(key) > 180 then
    raise exception 'catalog idempotency key is too long' using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('catalog-run:' || p_provider_id || ':' || key, 0));
  select * into run_row from public.catalog_sync_runs r
   where r.provider_id = p_provider_id and r.idempotency_key = key for update;

  if run_row.id is not null then
    if run_row.status = 'succeeded' then
      return run_row.id; -- the Edge worker reads this state and returns the original result without fetching
    end if;
    if run_row.status = 'running' and run_row.started_at > now() - interval '15 minutes' then
      raise exception 'catalog run % is already running', run_row.id using errcode = 'lock_not_available';
    end if;

    -- Failed and abandoned runs are retryable under the same key and retain one audit row.
    update public.catalog_sync_runs
       set status = 'running', items_seen = 0, items_written = 0, items_unchanged = 0,
           items_missing = 0, provider_requests = 0, error = null,
           started_at = now(), finished_at = null
     where id = run_row.id;
    run_id := run_row.id;
  else
    insert into public.catalog_sync_runs (job, provider_id, idempotency_key, status)
    values (p_job, p_provider_id, key, 'running') returning id into run_id;
  end if;

  insert into public.catalog_provider_state (provider_id, last_attempt_at)
  values (p_provider_id, now())
  on conflict (provider_id) do update
    set last_attempt_at = now(), total_requests = public.catalog_provider_state.total_requests + 1;
  return run_id;
end;
$$;

create or replace function public.catalog_finish_run(
  p_run_id uuid,
  p_status text,
  p_items_seen integer default 0,
  p_items_written integer default 0,
  p_items_unchanged integer default 0,
  p_items_missing integer default 0,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  run_row public.catalog_sync_runs%rowtype;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'catalog ingest is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  if p_status not in ('succeeded', 'failed', 'skipped') then
    raise exception 'invalid run status %', p_status using errcode = 'invalid_parameter_value';
  end if;

  select * into run_row from public.catalog_sync_runs where id = p_run_id for update;
  if not found then
    raise exception 'catalog sync run % does not exist', p_run_id using errcode = 'no_data_found';
  end if;

  -- A finished run is never re-finished: the numbers belong to the attempt that ran.
  if run_row.finished_at is not null then
    return;
  end if;

  update public.catalog_sync_runs
     set status = p_status,
         items_seen = greatest(items_seen, coalesce(p_items_seen, 0)),
         items_written = greatest(items_written, coalesce(p_items_written, 0)),
         items_unchanged = greatest(items_unchanged, coalesce(p_items_unchanged, 0)),
         items_missing = greatest(items_missing, coalesce(p_items_missing, 0)),
         error = left(p_error, 500),
         finished_at = now()
   where id = p_run_id;

  -- Provider health: a success clears the failure streak, a failure grows it and records the reason.
  if p_status = 'succeeded' then
    update public.catalog_provider_state
       set last_success_at = now(),
           consecutive_failures = 0,
           rate_limited_until = null,
           disabled_reason = null,
           total_items_written = public.catalog_provider_state.total_items_written + coalesce(p_items_written, 0)
     where provider_id = run_row.provider_id;
  elsif p_status = 'failed' then
    update public.catalog_provider_state
       set last_failure_at = now(),
           consecutive_failures = public.catalog_provider_state.consecutive_failures + 1,
           disabled_reason = case when public.catalog_provider_state.consecutive_failures + 1 >= 10
                                  then 'ingest failing repeatedly' else public.catalog_provider_state.disabled_reason end
     where provider_id = run_row.provider_id;
  end if;
end;
$$;


revoke all on function public.catalog_begin_run(text, text, text) from public, anon, authenticated;
revoke all on function public.catalog_finish_run(uuid, text, integer, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.catalog_begin_run(text, text, text) to service_role;
grant execute on function public.catalog_finish_run(uuid, text, integer, integer, integer, integer, text) to service_role;

reset check_function_bodies;
