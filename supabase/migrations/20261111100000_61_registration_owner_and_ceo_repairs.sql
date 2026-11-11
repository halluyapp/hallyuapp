-- HallyU Rork registration, singleton owner, and CEO authorization repairs.
-- Apply after recovered live migrations 58-60. No identity subjects are cast to UUID and no rows
-- are deleted or bulk-migrated. The frontend still treats all server authorization as authoritative.
set check_function_bodies = off;

create or replace function public.user_id()
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '{}')::jsonb ->> 'sub',
    nullif(current_setting('request.jwt.claim.sub', true), '')
  )::text;
$$;

grant execute on function public.user_id() to anon, authenticated, service_role;

-- There is one founder/owner. The partial unique index also protects owner initialization outside
-- register_profile(), while the trigger lock serializes concurrent first inserts.
create unique index if not exists profiles_single_founder
  on public.profiles (is_founder) where is_founder;

create or replace function public.promote_first_profile_to_ceo()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('hallyu:first-profile-owner', 0));
  if not exists (select 1 from public.profiles where id <> new.id) then
    new.role := 'ceo';
    new.is_founder := true;
    new.verified := true;
    new.verification_tier := 'red';
    new.exclude_from_competitions := true;
    new.verification_note := 'Founder & Chief Executive Officer — first account on the fresh Hallyu backend';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_first_becomes_ceo on public.profiles;
create trigger profiles_first_becomes_ceo
before insert on public.profiles for each row execute function public.promote_first_profile_to_ceo();

create or replace function public.register_profile(p_handle text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub text := public.user_id();
  v_id uuid;
  v_name text;
begin
  if v_sub is null or btrim(v_sub) = '' then
    raise exception 'sign in required' using errcode = '28000';
  end if;

  -- Serialize retries of the same identity without blocking unrelated registrations.
  perform pg_advisory_xact_lock(hashtextextended('hallyu:register:' || v_sub, 0));
  select id into v_id from public.profiles where auth_sub = v_sub;
  if v_id is not null then return v_id; end if;

  v_id := gen_random_uuid();
  v_name := left(coalesce(nullif(btrim(p_display_name), ''), 'Member'), 40);
  insert into public.profiles (id, auth_sub, handle, display_name)
  values (
    v_id,
    v_sub,
    public.generate_handle(coalesce(nullif(btrim(p_handle), ''), 'member'), v_id),
    v_name
  )
  on conflict (auth_sub) do nothing;

  -- Always read back the canonical row. ON CONFLICT DO NOTHING RETURNING would return NULL to the
  -- losing caller, which previously left the client authenticated without a real profile UUID.
  select id into v_id from public.profiles where auth_sub = v_sub;
  if v_id is null then
    raise exception 'profile provisioning did not produce an application profile' using errcode = 'P0001';
  end if;
  return v_id;
end;
$$;

revoke all on function public.register_profile(text, text) from public, anon;
grant execute on function public.register_profile(text, text) to authenticated, service_role;

-- Restore direct role checks that migration 58 did not cover.

create or replace function public.video_access(p_user uuid default public.current_profile_id())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = p_user
      and p.account_status = 'active'
      and (
        p.role in ('ceo', 'moderator', 'admin')
        or exists (
          select 1
          from public.video_creators vc
          where vc.user_id = p.id
            and vc.revoked_at is null
        )
      )
  );
$$;

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
  uid uuid := public.current_profile_id();
begin
  if uid is null then
    return '[]'::jsonb;
  end if;

  if exists (
    select 1 from public.profiles p
     where p.id = uid and p.role in ('ceo', 'admin', 'moderator') and p.account_status = 'active'
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

create or replace function public.create_hallyu_event(
  p_title text,
  p_world text default 'kdrama',
  p_event_kind text default 'watch_party',
  p_subtitle text default null,
  p_description text default '',
  p_title_id uuid default null,
  p_season integer default null,
  p_episode integer default null,
  p_starts_at timestamptz default (now() + interval '1 hour'),
  p_duration_minutes integer default 90,
  p_prediction_question text default null,
  p_prediction_options jsonb default '[]'::jsonb,
  p_is_featured boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := public.current_profile_id();
  ev_id uuid;
begin
  if uid is null or not exists (select 1 from public.profiles p where p.id = uid and p.role in ('ceo', 'admin', 'moderator') and p.account_status = 'active') then
    raise exception 'staff privilege required' using errcode = 'insufficient_privilege';
  end if;

  insert into public.hallyu_events (
    host_id, title, subtitle, description, world, event_kind,
    title_id, season, episode, starts_at, ends_at,
    prediction_question, prediction_options, is_featured
  )
  values (
    uid,
    left(btrim(p_title), 160),
    nullif(btrim(coalesce(p_subtitle, '')), ''),
    coalesce(p_description, ''),
    coalesce(nullif(btrim(p_world), ''), 'kdrama'),
    case when p_event_kind in ('watch_party', 'premiere', 'prediction', 'showdown', 'community_live') then p_event_kind else 'watch_party' end,
    p_title_id,
    p_season,
    p_episode,
    coalesce(p_starts_at, now()),
    coalesce(p_starts_at, now()) + make_interval(mins => greatest(coalesce(p_duration_minutes, 90), 15)),
    nullif(btrim(coalesce(p_prediction_question, '')), ''),
    coalesce(p_prediction_options, '[]'::jsonb),
    coalesce(p_is_featured, true)
  )
  returning id into ev_id;

  return ev_id;
end;
$$;

create or replace function public.send_ceo_broadcast(
  p_title text,
  p_body text,
  p_deep_link text default '/',
  p_world text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := public.current_profile_id();
  rec record;
  sent_count integer := 0;
  batch_key text := 'broadcast:' || extract(epoch from now())::bigint::text;
begin
  if uid is null or not exists (select 1 from public.profiles p where p.id = uid and p.role in ('ceo', 'admin', 'moderator') and p.account_status = 'active') then
    raise exception 'staff privilege required' using errcode = 'insufficient_privilege';
  end if;

  if btrim(coalesce(p_title, '')) = '' or btrim(coalesce(p_body, '')) = '' then
    raise exception 'title and body are required' using errcode = 'invalid_parameter_value';
  end if;

  for rec in
    select id
      from public.profiles
     where account_status = 'active'
       and handle not like 'verify_%'
       and (p_world is null or p_world = 'all' or p_world = any(worlds))
  loop
    perform public.enqueue_notification(
      p_recipient := rec.id,
      p_kind := 'system',
      p_group := 'system',
      p_dedupe_key := batch_key || ':' || rec.id::text,
      p_actor_ids := array[uid],
      p_title := left(btrim(p_title), 120),
      p_body := left(btrim(p_body), 220),
      p_deep_link := coalesce(nullif(btrim(p_deep_link), ''), '/')
    );
    sent_count := sent_count + 1;
  end loop;

  return jsonb_build_object('recipients_count', sent_count);
end;
$$;

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
     where role in ('ceo', 'admin', 'moderator')
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
     where role in ('ceo', 'admin', 'moderator')
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


grant execute on function public.video_access(uuid) to authenticated, service_role;
grant execute on function public.list_support_tickets(text, integer) to authenticated, service_role;
grant execute on function public.resolve_support_ticket(uuid, text, text) to authenticated, service_role;
grant execute on function public.create_hallyu_event(text, text, text, text, text, uuid, integer, integer, timestamptz, integer, text, jsonb, boolean) to authenticated, service_role;
grant execute on function public.send_ceo_broadcast(text, text, text, text) to authenticated, service_role;

drop trigger if exists reports_notify_staff_insert on public.reports;
create trigger reports_notify_staff_insert
  after insert on public.reports
  for each row execute function public.handle_notify_report_insert();

drop trigger if exists video_access_requests_notify_staff on public.video_access_requests;
create trigger video_access_requests_notify_staff
  after insert or update on public.video_access_requests
  for each row execute function public.handle_notify_video_request_insert();


create or replace function public.admin_manage_user_account(
  p_target_user_id uuid,
  p_role text default null,
  p_account_status text default null,
  p_exclude_from_competitions boolean default null,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := public.current_profile_id();
  target public.profiles%rowtype;
  clean_reason text := btrim(coalesce(p_reason, ''));
  next_role public.profile_role;
  next_status public.account_status;
  next_excl boolean;
begin
  if not public.is_admin() then
    raise exception 'admin privilege required' using errcode = 'insufficient_privilege';
  end if;

  if char_length(clean_reason) < 4 then
    raise exception 'an audit reason is required for member account administration' using errcode = 'invalid_parameter_value';
  end if;

  select * into target from public.profiles where id = p_target_user_id;
  if target.id is null then
    raise exception 'member profile not found' using errcode = 'no_data_found';
  end if;

  if p_role is not null and p_role not in ('member', 'moderator', 'admin') then
    raise exception 'CEO ownership is assigned only by first-profile provisioning and cannot be granted through account administration'
      using errcode = 'insufficient_privilege';
  end if;

  next_role := coalesce(p_role::public.profile_role, target.role);
  next_status := coalesce(p_account_status::public.account_status, target.account_status);
  next_excl := coalesce(p_exclude_from_competitions, target.exclude_from_competitions);

  if target.is_founder and (next_role <> 'ceo' or next_status <> 'active') then
    raise exception 'the founder/owner account cannot be demoted or suspended' using errcode = 'insufficient_privilege';
  end if;

  if target.role = 'ceo' and not target.is_founder then
    raise exception 'CEO profile violates the singleton-owner invariant; service-role reconciliation is required'
      using errcode = 'integrity_constraint_violation';
  end if;
  end if;

  update public.profiles
     set role = next_role,
         account_status = next_status,
         exclude_from_competitions = next_excl,
         updated_at = now()
   where id = p_target_user_id;

  insert into public.recognition_audit_log (
    actor_id, target_user_id, domain, action, previous_state, new_state, reason
  )
  values (
    actor,
    p_target_user_id,
    'user_admin',
    'member_account_updated',
    jsonb_build_object(
      'role', target.role,
      'account_status', target.account_status,
      'exclude_from_competitions', target.exclude_from_competitions
    ),
    jsonb_build_object(
      'role', next_role,
      'account_status', next_status,
      'exclude_from_competitions', next_excl
    ),
    clean_reason
  );

  return jsonb_build_object(
    'user_id', p_target_user_id,
    'role', next_role,
    'account_status', next_status,
    'exclude_from_competitions', next_excl
  );
end;
$$;


revoke all on function public.admin_manage_user_account(uuid, text, text, boolean, text) from public, anon;
grant execute on function public.admin_manage_user_account(uuid, text, text, boolean, text) to authenticated, service_role;


create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  invalid_pin text;
  v_service boolean := coalesce(auth.role(), current_setting('request.jwt.claim.role', true), current_user) = 'service_role';
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if current_user in ('anon', 'authenticated') and not v_service then
    if new.is_founder is distinct from old.is_founder then
      raise exception 'founder ownership cannot be changed by a client' using errcode = 'insufficient_privilege';
    end if;
    if new.role is distinct from old.role and (old.role = 'ceo' or new.role = 'ceo') then
      raise exception 'CEO ownership cannot be changed by a client' using errcode = 'insufficient_privilege';
    end if;
    if old.is_founder and (new.role <> 'ceo' or new.account_status <> 'active') then
      raise exception 'the founder/owner must remain an active CEO' using errcode = 'insufficient_privilege';
    end if;
  end if;

  if current_user not in ('anon', 'authenticated')
     or v_service
     or public.is_admin() then
    if new.verification_tier is distinct from old.verification_tier then
      new.verified := (coalesce(new.verification_tier, 'none') <> 'none');
    elsif new.verified is distinct from old.verified then
      if coalesce(new.verified, false) and coalesce(new.verification_tier, 'none') = 'none' then
        new.verification_tier := 'blue';
      elsif not coalesce(new.verified, false) then
        new.verification_tier := 'none';
      end if;
    end if;
    return new;
  end if;

  if new.role is distinct from old.role then
    raise exception 'only a global admin may change a member''s role' using errcode = 'insufficient_privilege';
  end if;

  if new.verified is distinct from old.verified
     or new.verification_tier is distinct from old.verification_tier
     or new.verified_at is distinct from old.verified_at
     or new.verified_by is distinct from old.verified_by
     or new.verification_note is distinct from old.verification_note then
    raise exception 'only authorized staff may modify account verification seals' using errcode = 'insufficient_privilege';
  end if;

  if new.is_founder is distinct from old.is_founder
     or new.exclude_from_competitions is distinct from old.exclude_from_competitions then
    raise exception 'only authorized staff may modify founder or competition eligibility flags' using errcode = 'insufficient_privilege';
  end if;

  if new.account_status is distinct from old.account_status then
    raise exception 'a member cannot change their account status' using errcode = 'insufficient_privilege';
  end if;

  if new.deleted_at is distinct from old.deleted_at then
    raise exception 'a member cannot delete their account from a profile update; use delete_account()' using errcode = 'insufficient_privilege';
  end if;

  if new.featured_badge_ids is distinct from old.featured_badge_ids then
    if coalesce(cardinality(new.featured_badge_ids), 0) > 4 then
      raise exception 'at most 4 badges may be pinned on a profile' using errcode = 'check_violation';
    end if;

    select b_id into invalid_pin
      from unnest(coalesce(new.featured_badge_ids, '{}'::text[])) as b_id
     where not exists (
       select 1
         from public.user_awards ua
        where ua.user_id = new.id
          and ua.badge_id = b_id
          and ua.status = 'active'
     )
     limit 1;

    if invalid_pin is not null then
      raise exception 'cannot pin unearned or revoked badge %', invalid_pin using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;


-- Preserve staff behavior while including the CEO in direct RLS role checks.
drop policy if exists app_releases_staff_manage on public.app_releases;
create policy app_releases_staff_manage on public.app_releases for all to authenticated
  using (public.is_moderator()) with check (public.is_moderator());

drop policy if exists hallyu_events_staff_manage on public.hallyu_events;
create policy hallyu_events_staff_manage on public.hallyu_events for all to authenticated
  using (host_id = public.current_profile_id() or public.is_moderator())
  with check (host_id = public.current_profile_id() or public.is_moderator());

drop policy if exists support_tickets_select_own_or_staff on public.support_tickets;
create policy support_tickets_select_own_or_staff on public.support_tickets for select to authenticated
  using (reporter_id = public.current_profile_id() or public.is_moderator());

drop policy if exists support_tickets_update_staff on public.support_tickets;
create policy support_tickets_update_staff on public.support_tickets for update to authenticated
  using (public.is_moderator()) with check (public.is_moderator());

-- A missing profile is also the anonymous case; it is not proof of service-role authentication.
-- Require the actual signed service_role claim (or a direct service_role database session).

create or replace function public.catalog_upsert_title(
  p_provider_id text,
  p_payload jsonb
)
returns table (id uuid, written boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  target_provider text := coalesce(p_provider_id, 'tmdb');
  v_external_id text;
  kind public.media_type;
  world_id text;
  title_name text;
  release_year integer;
  status_value public.title_status;
  payload_hash text;
  existing_hash text;
  row_id uuid;
  did_write boolean := false;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' and current_user <> 'service_role' then
    raise exception 'catalog ingest is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;

  v_external_id := nullif(btrim(p_payload ->> 'external_id'), '');
  kind := nullif(p_payload ->> 'media_type', '')::public.media_type;
  world_id := nullif(btrim(p_payload ->> 'world'), '');
  title_name := nullif(btrim(p_payload ->> 'title'), '');
  release_year := coalesce(
    nullif(p_payload ->> 'year', '')::integer,
    extract(year from coalesce(nullif(p_payload ->> 'first_air_date', '')::date, current_date))::integer
  );
  status_value := coalesce(nullif(p_payload ->> 'status', '')::public.title_status, 'upcoming');

  if v_external_id is null then
    raise exception 'payload.external_id is required' using errcode = 'invalid_parameter_value';
  end if;
  if kind is null then
    raise exception 'payload.media_type must be tv or movie' using errcode = 'invalid_parameter_value';
  end if;
  if title_name is null then
    raise exception 'payload.title is required' using errcode = 'invalid_parameter_value';
  end if;
  if release_year is null or release_year < 1888 or release_year > 2200 then
    raise exception 'payload.year % is out of range', release_year using errcode = 'invalid_parameter_value';
  end if;
  if world_id is null or not exists (select 1 from public.worlds w where w.id = world_id) then
    raise exception 'payload.world % is not a known world', world_id using errcode = 'no_data_found';
  end if;

  payload_hash := md5(
    coalesce(p_payload ->> 'original_title', '') || '|' ||
    coalesce(p_payload ->> 'status', '') || '|' ||
    coalesce(p_payload -> 'provider_data' ->> 'status', '') || '|' ||
    coalesce(p_payload ->> 'synopsis', p_payload ->> 'overview', '') || '|' ||
    coalesce(p_payload ->> 'poster_url', '') || '|' ||
    coalesce(p_payload ->> 'backdrop_url', '') || '|' ||
    coalesce(p_payload ->> 'trailer_url', '') || '|' ||
    coalesce(p_payload ->> 'runtime_minutes', '') || '|' ||
    coalesce(p_payload ->> 'network', '') || '|' ||
    coalesce(p_payload ->> 'first_air_date', '') || '|' ||
    coalesce(p_payload ->> 'last_air_date', '') || '|' ||
    coalesce(p_payload ->> 'next_episode_at', '') || '|' ||
    coalesce(p_payload ->> 'episode_count', '') || '|' ||
    coalesce(p_payload ->> 'season_count', '') || '|' ||
    coalesce(p_payload ->> 'popularity', '') || '|' ||
    coalesce(p_payload ->> 'vote_average', '') || '|' ||
    coalesce((p_payload -> 'streaming_on')::text, '[]') || '|' ||
    coalesce((p_payload -> 'genres')::text, '[]') || '|' ||
    coalesce((p_payload -> 'tags')::text, '[]') || '|' ||
    coalesce((p_payload -> 'origin_country')::text, '[]')
  );

  select t.id, t.content_hash into row_id, existing_hash
  from public.titles t
  where t.provider_id = target_provider and t.external_id = v_external_id and t.media_type = kind;

  if row_id is not null and existing_hash = payload_hash then
    update public.titles
       set catalog_synced_at = now(),
           catalog_missing_count = 0,
           catalog_unavailable_at = null
     where public.titles.id = row_id;

    perform public.catalog_recompute_title_state(row_id);

    return query select row_id, false;
    return;
  end if;

  insert into public.titles as t (
    provider_id, external_id, media_type, world, title, original_title, year, end_year, status,
    runtime_minutes, original_language, synopsis, poster_url, backdrop_url, trailer_url, tone, genres, tags,
    network, streaming_on, airs_on, episode_count, season_count, popularity, vote_average,
    vote_count, origin_country, first_air_date, last_air_date, next_episode_at, provider_data, content_hash,
    catalog_synced_at, catalog_missing_count, catalog_unavailable_at
  )
  values (
    target_provider, v_external_id, kind, world_id, left(title_name, 200),
    nullif(left(p_payload ->> 'original_title', 200), ''),
    release_year,
    greatest(release_year, coalesce(nullif(p_payload ->> 'end_year', '')::integer, release_year)),
    status_value,
    nullif(nullif(left(p_payload ->> 'runtime_minutes', 4), '')::smallint, 0),
    nullif(left(p_payload ->> 'original_language', 12), ''),
    nullif(left(coalesce(p_payload ->> 'synopsis', p_payload ->> 'overview'), 2000), ''),
    nullif(left(p_payload ->> 'poster_url', 500), ''),
    nullif(left(p_payload ->> 'backdrop_url', 500), ''),
    nullif(left(p_payload ->> 'trailer_url', 500), ''),
    nullif(left(p_payload ->> 'tone', 60), ''),
    coalesce((select array_agg(value #>> '{}') from jsonb_array_elements(coalesce(p_payload -> 'genres', '[]'::jsonb)) value), '{}'),
    coalesce((select array_agg(value #>> '{}') from jsonb_array_elements(coalesce(p_payload -> 'tags', '[]'::jsonb)) value), '{}'),
    nullif(left(p_payload ->> 'network', 120), ''),
    coalesce((select array_agg(value #>> '{}') from jsonb_array_elements(coalesce(p_payload -> 'streaming_on', '[]'::jsonb)) value), '{}'),
    nullif(left(p_payload ->> 'airs_on', 120), ''),
    coalesce(nullif(p_payload ->> 'episode_count', '')::smallint, 0),
    coalesce(nullif(p_payload ->> 'season_count', '')::smallint, 0),
    nullif(left(p_payload ->> 'popularity', 12), '')::numeric,
    nullif(left(p_payload ->> 'vote_average', 4), '')::numeric,
    greatest(coalesce(nullif(p_payload ->> 'vote_count', '')::integer, 0), 0),
    coalesce((select array_agg(value #>> '{}') from jsonb_array_elements(coalesce(p_payload -> 'origin_country', '[]'::jsonb)) value), '{}'),
    nullif(p_payload ->> 'first_air_date', '')::date,
    nullif(p_payload ->> 'last_air_date', '')::date,
    nullif(p_payload ->> 'next_episode_at', '')::timestamptz,
    coalesce(p_payload -> 'provider_data', '{}'::jsonb),
    payload_hash,
    now(),
    0,
    null
  )
  on conflict (provider_id, external_id, media_type) do update
    set world = excluded.world,
        title = excluded.title,
        original_title = coalesce(excluded.original_title, t.original_title),
        year = excluded.year,
        end_year = excluded.end_year,
        status = case
          when coalesce(excluded.provider_data ->> 'status', '') <> '' then excluded.status
          else coalesce(t.status, excluded.status)
        end,
        runtime_minutes = coalesce(excluded.runtime_minutes, t.runtime_minutes),
        original_language = coalesce(excluded.original_language, t.original_language),
        synopsis = coalesce(excluded.synopsis, t.synopsis),
        poster_url = coalesce(excluded.poster_url, t.poster_url),
        backdrop_url = coalesce(excluded.backdrop_url, t.backdrop_url),
        trailer_url = coalesce(excluded.trailer_url, t.trailer_url),
        tone = coalesce(excluded.tone, t.tone),
        genres = case when cardinality(excluded.genres) > 0 then excluded.genres else t.genres end,
        tags = case when cardinality(excluded.tags) > 0 then excluded.tags else t.tags end,
        network = coalesce(excluded.network, t.network),
        streaming_on = case when cardinality(excluded.streaming_on) > 0 then excluded.streaming_on else t.streaming_on end,
        airs_on = coalesce(excluded.airs_on, t.airs_on),
        episode_count = greatest(excluded.episode_count, t.episode_count),
        season_count = greatest(excluded.season_count, t.season_count),
        popularity = coalesce(excluded.popularity, t.popularity),
        vote_average = coalesce(excluded.vote_average, t.vote_average),
        vote_count = greatest(excluded.vote_count, t.vote_count),
        origin_country = case when cardinality(excluded.origin_country) > 0 then excluded.origin_country else t.origin_country end,
        first_air_date = coalesce(excluded.first_air_date, t.first_air_date),
        last_air_date = coalesce(excluded.last_air_date, t.last_air_date),
        next_episode_at = coalesce(excluded.next_episode_at, t.next_episode_at),
        provider_data = case
          when coalesce(excluded.provider_data ->> 'status', '') <> '' then excluded.provider_data
          else coalesce(t.provider_data, '{}'::jsonb) || jsonb_strip_nulls(excluded.provider_data)
        end,
        content_hash = excluded.content_hash,
        catalog_synced_at = now(),
        catalog_missing_count = 0,
        catalog_unavailable_at = null
  returning t.id into row_id;

  did_write := true;

  perform public.catalog_recompute_title_state(row_id);

  return query select row_id, did_write;
end;
$$;

create or replace function public.catalog_upsert_episodes(
  p_title_id uuid,
  p_season integer,
  p_episodes jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item jsonb;
  inserted integer := 0;
  keep_numbers integer[] := '{}';
  ep_number integer;
  ep_runtime smallint;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' and current_user <> 'service_role' then
    raise exception 'catalog ingest is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from public.titles where id = p_title_id) then
    raise exception 'title % does not exist', p_title_id using errcode = 'no_data_found';
  end if;

  if p_episodes is null or jsonb_typeof(p_episodes) <> 'array' then
    raise exception 'p_episodes must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;

  for item in select * from jsonb_array_elements(p_episodes) loop
    ep_number := coalesce(nullif(item ->> 'number', '')::integer, 0);
    if ep_number < 1 then
      continue;
    end if;

    keep_numbers := keep_numbers || ep_number;

    ep_runtime := nullif(left(item ->> 'runtime_minutes', 4), '')::smallint;
    if ep_runtime is not null and (ep_runtime < 1 or ep_runtime > 1200) then
      ep_runtime := null;
    end if;

    insert into public.title_episodes (
      title_id, season, number, title, air_date, air_time, runtime_minutes, synopsis, still_url, episode_type, catalog_synced_at
    )
    values (
      p_title_id,
      coalesce(nullif(item ->> 'season', '')::integer, p_season),
      ep_number,
      nullif(left(item ->> 'title', 200), ''),
      nullif(item ->> 'air_date', '')::date,
      nullif(left(item ->> 'air_time', 8), '')::time,
      ep_runtime,
      left(coalesce(item ->> 'synopsis', item ->> 'overview'), 2000),
      nullif(left(item ->> 'still_url', 500), ''),
      coalesce(nullif(item ->> 'episode_type', '')::smallint, 1),
      now()
    )
    on conflict (title_id, season, number) do update
      set title = coalesce(excluded.title, public.title_episodes.title),
          air_date = excluded.air_date,
          air_time = coalesce(excluded.air_time, public.title_episodes.air_time),
          runtime_minutes = coalesce(excluded.runtime_minutes, public.title_episodes.runtime_minutes),
          synopsis = coalesce(excluded.synopsis, public.title_episodes.synopsis),
          still_url = coalesce(excluded.still_url, public.title_episodes.still_url),
          episode_type = excluded.episode_type,
          catalog_synced_at = now()
    where
      public.title_episodes.title is distinct from excluded.title
      or public.title_episodes.air_date is distinct from excluded.air_date
      or public.title_episodes.air_time is distinct from excluded.air_time
      or public.title_episodes.runtime_minutes is distinct from excluded.runtime_minutes
      or public.title_episodes.synopsis is distinct from excluded.synopsis
      or public.title_episodes.still_url is distinct from excluded.still_url
      or public.title_episodes.episode_type is distinct from excluded.episode_type;

    if found then
      inserted := inserted + 1;
    end if;
  end loop;

  if cardinality(keep_numbers) > 0 then
    update public.title_episodes e
       set air_date = null,
           synopsis = coalesce(e.synopsis, 'Schedule withdrawn by the broadcaster')
     where e.title_id = p_title_id
       and e.season = p_season
       and not (e.number = any(keep_numbers))
       and not exists (
         select 1 from public.posts p
         where p.title_id = e.title_id and p.season = e.season and p.episode = e.number
       );
  end if;

  perform public.catalog_recompute_next_episode(p_title_id);
  perform public.catalog_recompute_title_state(p_title_id);

  return inserted;
end;
$$;


revoke all on function public.catalog_upsert_title(text, jsonb) from public, anon, authenticated;
revoke all on function public.catalog_upsert_episodes(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.catalog_upsert_title(text, jsonb) to service_role;
grant execute on function public.catalog_upsert_episodes(uuid, integer, jsonb) to service_role;

reset check_function_bodies;
