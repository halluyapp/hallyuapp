-- =============================================================================================
-- 46 · Hallyu 100% Production Platform
--   1. Explore Catalog Purity, 2026 Bayesian Ranking & `end_year` Correction
--   2. Service-Role Build/Push Vault (`public.ci_build_vault`)
--   3. Play-Store-Free Self-Updating App CDN Registry (`app-releases` bucket + `public.app_releases`)
--   4. Commercial Support & Bug Report Suite (`public.support_tickets` + Admin Triage RPCs)
--   5. Flagship Hallyu Live Events, Watch Parties & Prediction Polls (`public.hallyu_events`)
--   6. 24/7 Alive Notifications: DM Trigger, Creator Post Trigger, CEO Broadcast Megaphone & Handle Change
-- =============================================================================================

set check_function_bodies = off;

-- ---------------------------------------------------------------------------------------------
-- 1. Catalog Purity, 2026 Bayesian Ranking & `end_year` Fix
-- ---------------------------------------------------------------------------------------------

-- Fix historic rows where `end_year` duplicated `year` instead of using `last_air_date`.
update public.titles
   set end_year = extract(year from last_air_date)::integer
 where last_air_date is not null
   and status = 'completed'
   and (end_year is null or end_year = year)
   and extract(year from last_air_date)::integer >= year;

update public.titles
   set end_year = null
 where status in ('airing', 'upcoming')
   and end_year is not null;

-- Helper: true when a row is non-scripted daytime/late-night talk, news, game, or reality TV.
create or replace function public.is_non_scripted_noise(p_title public.titles)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select (
    coalesce(p_title.genres, '{}'::text[]) && array['Talk', 'News', 'Reality', 'Soap']
    or p_title.title ~* '\y(tonight show|watch what happens live|late show|daily show|good morning|jeopardy|wheel of fortune)\y'
  )
$$;

revoke all on function public.is_non_scripted_noise(public.titles) from public, anon, authenticated;
grant execute on function public.is_non_scripted_noise(public.titles) to service_role, anon, authenticated;

-- Upgrade `catalog_lifecycle_of` so non-scripted talk/news/reality noise never enters discovery rails.
create or replace function public.catalog_lifecycle_of(p_title public.titles)
returns public.catalog_lifecycle
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_title.catalog_unavailable_at is not null
      or p_title.catalog_missing_count >= 3 then 'unavailable'::public.catalog_lifecycle
    when p_title.status = 'canceled' then 'unavailable'::public.catalog_lifecycle
    when public.is_non_scripted_noise(p_title) then 'unavailable'::public.catalog_lifecycle
    when p_title.status = 'airing'
      and (p_title.last_air_date is null or p_title.last_air_date >= current_date - 45)
      then 'airing'::public.catalog_lifecycle
    when p_title.status = 'upcoming'
      and (p_title.first_air_date is null or p_title.first_air_date <= current_date + 365)
      then 'upcoming'::public.catalog_lifecycle
    when p_title.status = 'upcoming' then 'unavailable'::public.catalog_lifecycle
    when p_title.status = 'completed'
      and (p_title.last_air_date >= current_date - 365
           or p_title.year >= extract(year from now())::integer - 1)
      then 'recent'::public.catalog_lifecycle
    when p_title.status = 'completed' then 'classic'::public.catalog_lifecycle
    else 'classic'::public.catalog_lifecycle
  end
$$;

revoke all on function public.catalog_lifecycle_of(public.titles) from public, anon, authenticated;
grant execute on function public.catalog_lifecycle_of(public.titles) to service_role;

-- True 2026 Bayesian relevance ranking:
--   * Penalises multi-decade legacy cartoons/procedurals (`year < 2022`) from hijacking `#1`
--   * Requires real audience vote confidence so 9-vote obscure entries cannot take `#1 World Leader`
--   * Keeps live-action C-Dramas ahead of low-vote donghua in `cdrama`
create or replace function public.catalog_relevance_score(
  p_title public.titles,
  p_lifecycle public.catalog_lifecycle default null,
  p_world text default null
)
returns double precision
language sql
immutable
set search_path = public, pg_temp
as $$
  with context as (
    select
      coalesce(p_lifecycle, public.catalog_lifecycle_of(p_title)) as life,
      coalesce(p_title.vote_count, 0)::double precision as votes,
      coalesce(p_title.vote_average, 0)::double precision as rating,
      coalesce(p_title.year, 2000)::integer as release_year,
      extract(year from now())::integer as cur_year,
      (select count(*) from public.title_follows tf where tf.title_id = p_title.id)::double precision as followers,
      (select count(*) from public.posts po where po.title_id = p_title.id and po.state = 'active')::double precision as posts,
      (select count(*) from public.title_episodes e where e.title_id = p_title.id and e.air_date >= current_date - 21)::double precision as recent_episodes,
      (select count(*) from public.community_members cm where cm.community_id in (select c.id from public.communities c where c.drama_id = p_title.id))::double precision as room_members
  )
  select
    case when ctx.life = 'unavailable' then -1.0 else
      -- Lifecycle weight tempered by era so 1990s weekly procedurals/cartoons don't beat 2025/2026 hits
      (case ctx.life
         when 'airing' then case when ctx.release_year >= ctx.cur_year - 2 then 0.44 when ctx.release_year >= ctx.cur_year - 4 then 0.34 else 0.16 end
         when 'upcoming' then 0.35
         when 'recent' then case when ctx.release_year >= ctx.cur_year - 1 then 0.38 else 0.24 end
         when 'classic' then 0.08
         else 0.0
       end)
      -- Bayesian vote-weighted quality (prior = 7.0 across m = 120 votes)
      + (((ctx.votes / (ctx.votes + 120.0)) * ctx.rating + (120.0 / (ctx.votes + 120.0)) * 7.0) / 10.0) * 0.22
      -- Audience vote confidence bonus (rewards titles people have actually watched & rated)
      + least(0.16, (ln(ctx.votes + 1.0) / ln(5001.0)) * 0.16)
      -- Log-compressed TMDB momentum
      + least(0.16, (ln(coalesce(greatest(p_title.popularity, 0), 0) + 1.0) / ln(601.0)) * 0.16)
      -- Recent episode drop bonus
      + least(0.10, ctx.recent_episodes * 0.035)
      -- Real Hallyu community signal
      + least(0.12, (ln(ctx.followers + 1.0) / ln(501.0)) * 0.08)
      + least(0.10, (ln(ctx.posts + 1.0) / ln(201.0)) * 0.06)
      + least(0.05, (ln(ctx.room_members + 1.0) / ln(501.0)) * 0.05)
      -- Keep Western cartoons from taking #1 Hollywood drama/film crown
      - (case when p_title.world = 'hollywood' and p_title.media_type = 'tv' and 'Animation' = any(coalesce(p_title.genres, '{}'::text[])) then 0.22 else 0.0 end)
      -- Keep live-action C-Dramas leading C-Drama ahead of animated donghua
      - (case when p_title.world = 'cdrama' and 'Animation' = any(coalesce(p_title.genres, '{}'::text[])) then 0.18 else 0.0 end)
    end
  from context ctx
$$;

revoke all on function public.catalog_relevance_score(public.titles, public.catalog_lifecycle, text) from public, anon, authenticated;
grant execute on function public.catalog_relevance_score(public.titles, public.catalog_lifecycle, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Service-Role Build & Push Secret Vault (`public.ci_build_vault`)
-- ---------------------------------------------------------------------------------------------

create table if not exists public.ci_build_vault (
  key        text        primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);

alter table public.ci_build_vault enable row level security;

drop policy if exists ci_build_vault_deny_clients on public.ci_build_vault;
create policy ci_build_vault_deny_clients on public.ci_build_vault
  for all
  using (false)
  with check (false);

revoke all on table public.ci_build_vault from public, anon, authenticated;
grant select, insert, update, delete on table public.ci_build_vault to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Public `app-releases` CDN Bucket + Self-Updating App Registry (`public.app_releases`)
-- ---------------------------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'app-releases',
  'app-releases',
  true,
  104857600,
  array['application/vnd.android.package-archive', 'application/octet-stream', 'application/json']
)
on conflict (id) do update
  set public = true,
      file_size_limit = 104857600,
      allowed_mime_types = array['application/vnd.android.package-archive', 'application/octet-stream', 'application/json'];

drop policy if exists app_releases_public_read on storage.objects;
create policy app_releases_public_read on storage.objects
  for select
  using (bucket_id = 'app-releases');

drop policy if exists app_releases_service_write on storage.objects;
create policy app_releases_service_write on storage.objects
  for all to service_role
  using (bucket_id = 'app-releases')
  with check (bucket_id = 'app-releases');

create table if not exists public.app_releases (
  id                    uuid        primary key default gen_random_uuid(),
  version_code          integer     not null unique,
  version_name          text        not null,
  apk_url               text        not null,
  universal_apk_url     text,
  sha256                text,
  file_size_bytes       bigint,
  release_notes         text        not null default '',
  is_mandatory          boolean     not null default false,
  min_supported_version integer     not null default 1,
  git_commit            text,
  published_at          timestamptz not null default now()
);

create index if not exists app_releases_version_idx on public.app_releases (version_code desc);

alter table public.app_releases enable row level security;

drop policy if exists app_releases_read_all on public.app_releases;
create policy app_releases_read_all on public.app_releases
  for select
  using (true);

drop policy if exists app_releases_staff_manage on public.app_releases;
create policy app_releases_staff_manage on public.app_releases
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'moderator') and p.account_status = 'active'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'moderator') and p.account_status = 'active'));

grant select on table public.app_releases to anon, authenticated, service_role;
grant insert, update, delete on table public.app_releases to authenticated, service_role;

create or replace function public.get_latest_app_release()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select to_jsonb(r)
      from public.app_releases r
      order by r.version_code desc
      limit 1
    ),
    jsonb_build_object(
      'version_code', 199,
      'version_name', '1.0.199',
      'apk_url', 'https://github.com/macaulay-spec/Grok-hallyu/releases/download/apk-199/hallyu.apk',
      'universal_apk_url', 'https://github.com/macaulay-spec/Grok-hallyu/releases/download/apk-199/hallyu.apk',
      'release_notes', 'Production stability, faster social feed, live notifications & Explore accuracy update.',
      'is_mandatory', false,
      'min_supported_version', 1
    )
  );
$$;

grant execute on function public.get_latest_app_release() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. Native Support, Bug Reports & Show Requests (`public.support_tickets`)
-- ---------------------------------------------------------------------------------------------

create table if not exists public.support_tickets (
  id             uuid        primary key default gen_random_uuid(),
  reporter_id    uuid        references public.profiles (id) on delete set null,
  reporter_email text,
  category       text        not null default 'bug' check (category in ('bug', 'crash', 'missing_title', 'upload', 'account', 'feature')),
  subject        text        not null check (char_length(subject) between 2 and 200),
  description    text        not null check (char_length(description) between 3 and 4000),
  screenshot_url text,
  app_version    text,
  platform       text,
  route_name     text,
  diagnostics    jsonb       not null default '{}'::jsonb,
  status         text        not null default 'open' check (status in ('open', 'investigating', 'resolved', 'closed')),
  staff_note     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists support_tickets_status_created_idx on public.support_tickets (status, created_at desc);
create index if not exists support_tickets_reporter_idx on public.support_tickets (reporter_id, created_at desc);

alter table public.support_tickets enable row level security;

drop policy if exists support_tickets_insert_any on public.support_tickets;
create policy support_tickets_insert_any on public.support_tickets
  for insert
  with check (reporter_id is null or reporter_id = auth.uid());

drop policy if exists support_tickets_select_own_or_staff on public.support_tickets;
create policy support_tickets_select_own_or_staff on public.support_tickets
  for select to authenticated
  using (
    reporter_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'moderator') and p.account_status = 'active')
  );

drop policy if exists support_tickets_update_staff on public.support_tickets;
create policy support_tickets_update_staff on public.support_tickets
  for update to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'moderator') and p.account_status = 'active'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'moderator') and p.account_status = 'active'));

grant insert on table public.support_tickets to anon, authenticated, service_role;
grant select, update on table public.support_tickets to authenticated, service_role;

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
  staff_rec record;
begin
  if cat not in ('bug', 'crash', 'missing_title', 'upload', 'account', 'feature') then
    cat := 'bug';
  end if;

  insert into public.support_tickets (
    reporter_id, reporter_email, category, subject, description,
    screenshot_url, app_version, platform, route_name, diagnostics
  )
  values (
    uid,
    nullif(btrim(coalesce(p_reporter_email, '')), ''),
    cat,
    left(coalesce(nullif(btrim(p_subject), ''), 'Hallyu Report'), 200),
    left(coalesce(nullif(btrim(p_description), ''), 'Submitted from app'), 4000),
    nullif(btrim(coalesce(p_screenshot_url, '')), ''),
    nullif(btrim(coalesce(p_app_version, '')), ''),
    nullif(btrim(coalesce(p_platform, '')), ''),
    nullif(btrim(coalesce(p_route_name, '')), ''),
    coalesce(p_diagnostics, '{}'::jsonb)
  )
  returning id into tid;

  -- Alert active admins immediately so CEO/staff phones light up when a user submits feedback
  for staff_rec in
    select id from public.profiles
     where role in ('admin', 'moderator')
       and account_status = 'active'
       and (uid is null or id <> uid)
  loop
    perform public.enqueue_notification(
      p_recipient := staff_rec.id,
      p_kind := 'system',
      p_group := 'system',
      p_dedupe_key := 'ticket:' || tid::text,
      p_actor_ids := case when uid is not null then array[uid] else '{}'::uuid[] end,
      p_title := 'New ' || upper(cat) || ' report',
      p_body := left(btrim(p_subject) || ' — ' || btrim(p_description), 160),
      p_deep_link := '/settings/moderation'
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

  if exists (select 1 from public.profiles p where p.id = uid and p.role in ('admin', 'moderator') and p.account_status = 'active') then
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
        where (p_status is null or st.status = p_status)
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
      order by st.created_at desc
      limit 30
    ) t
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.list_support_tickets(text, integer) to authenticated, service_role;

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
  uid uuid := auth.uid();
  rec public.support_tickets%rowtype;
begin
  if uid is null or not exists (select 1 from public.profiles p where p.id = uid and p.role in ('admin', 'moderator') and p.account_status = 'active') then
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

grant execute on function public.resolve_support_ticket(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Flagship Hallyu Live Events, Watch Parties & Prediction Polls (`public.hallyu_events`)
-- ---------------------------------------------------------------------------------------------

create table if not exists public.hallyu_events (
  id                  uuid        primary key default gen_random_uuid(),
  host_id             uuid        references public.profiles (id) on delete set null,
  title               text        not null check (char_length(title) between 3 and 160),
  subtitle            text,
  description         text        not null default '',
  world               text        not null default 'kdrama',
  event_kind          text        not null default 'watch_party' check (event_kind in ('watch_party', 'premiere', 'prediction', 'showdown', 'community_live')),
  title_id            uuid        references public.titles (id) on delete set null,
  season              integer,
  episode             integer,
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  cover_url           text,
  prediction_question text,
  prediction_options  jsonb       not null default '[]'::jsonb,
  is_featured         boolean     not null default false,
  rsvp_count          integer     not null default 0,
  created_at          timestamptz not null default now()
);

create index if not exists hallyu_events_schedule_idx on public.hallyu_events (starts_at asc, is_featured desc);

alter table public.hallyu_events enable row level security;

drop policy if exists hallyu_events_read_all on public.hallyu_events;
create policy hallyu_events_read_all on public.hallyu_events
  for select
  using (true);

drop policy if exists hallyu_events_staff_manage on public.hallyu_events;
create policy hallyu_events_staff_manage on public.hallyu_events
  for all to authenticated
  using (
    host_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'moderator') and p.account_status = 'active')
  )
  with check (
    host_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'moderator') and p.account_status = 'active')
  );

grant select on table public.hallyu_events to anon, authenticated, service_role;
grant insert, update, delete on table public.hallyu_events to authenticated, service_role;

create table if not exists public.hallyu_event_rsvps (
  event_id          uuid        not null references public.hallyu_events (id) on delete cascade,
  user_id           uuid        not null references public.profiles (id) on delete cascade,
  prediction_choice integer,
  created_at        timestamptz not null default now(),
  primary key (event_id, user_id)
);

alter table public.hallyu_event_rsvps enable row level security;

drop policy if exists hallyu_event_rsvps_read_all on public.hallyu_event_rsvps;
create policy hallyu_event_rsvps_read_all on public.hallyu_event_rsvps
  for select
  using (true);

drop policy if exists hallyu_event_rsvps_manage_own on public.hallyu_event_rsvps;
create policy hallyu_event_rsvps_manage_own on public.hallyu_event_rsvps
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select on table public.hallyu_event_rsvps to anon, authenticated, service_role;
grant insert, update, delete on table public.hallyu_event_rsvps to authenticated, service_role;

create or replace function public.list_hallyu_events(
  p_world text default null,
  p_limit integer default 24
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  viewer uuid := auth.uid();
  capped integer := least(greatest(coalesce(p_limit, 24), 1), 60);
begin
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'event', to_jsonb(ev),
        'host', case when pr.id is not null then jsonb_build_object(
          'id', pr.id,
          'handle', pr.handle,
          'display_name', pr.display_name,
          'avatar_path', pr.avatar_path,
          'verified', pr.verified,
          'role', pr.role
        ) else null end,
        'title', (select to_jsonb(t) from public.titles t where t.id = ev.title_id),
        'viewer_going', case
          when viewer is null then false
          else exists (select 1 from public.hallyu_event_rsvps r where r.event_id = ev.id and r.user_id = viewer)
        end,
        'viewer_prediction', case
          when viewer is null then null
          else (select r.prediction_choice from public.hallyu_event_rsvps r where r.event_id = ev.id and r.user_id = viewer)
        end,
        'prediction_counts', coalesce((
          select jsonb_object_agg(choice::text, cnt)
          from (
            select prediction_choice as choice, count(*)::integer as cnt
            from public.hallyu_event_rsvps r
            where r.event_id = ev.id and r.prediction_choice is not null
            group by prediction_choice
          ) s
        ), '{}'::jsonb)
      )
      order by
        (now() between ev.starts_at and ev.ends_at) desc,
        ev.is_featured desc,
        ev.starts_at asc
    )
    from (
      select *
      from public.hallyu_events e
      where e.ends_at >= now() - interval '12 hours'
        and (p_world is null or p_world = 'all' or e.world = p_world)
      order by
        (now() between e.starts_at and e.ends_at) desc,
        e.is_featured desc,
        e.starts_at asc
      limit capped
    ) ev
    left join public.profiles pr on pr.id = ev.host_id
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.list_hallyu_events(text, integer) to anon, authenticated, service_role;

create or replace function public.toggle_event_rsvp(
  p_event_id uuid,
  p_going boolean default null,
  p_prediction integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  currently_going boolean;
  next_going boolean;
  cnt integer;
begin
  if uid is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  currently_going := exists (
    select 1 from public.hallyu_event_rsvps where event_id = p_event_id and user_id = uid
  );
  next_going := coalesce(p_going, not currently_going);

  if p_prediction is not null then
    next_going := true;
  end if;

  if next_going then
    insert into public.hallyu_event_rsvps (event_id, user_id, prediction_choice)
    values (p_event_id, uid, p_prediction)
    on conflict (event_id, user_id) do update
      set prediction_choice = coalesce(p_prediction, public.hallyu_event_rsvps.prediction_choice);
  else
    delete from public.hallyu_event_rsvps where event_id = p_event_id and user_id = uid;
  end if;

  select count(*)::integer into cnt from public.hallyu_event_rsvps where event_id = p_event_id;
  update public.hallyu_events set rsvp_count = cnt where id = p_event_id;

  return jsonb_build_object(
    'going', next_going,
    'rsvp_count', cnt,
    'prediction_choice', (select prediction_choice from public.hallyu_event_rsvps where event_id = p_event_id and user_id = uid)
  );
end;
$$;

grant execute on function public.toggle_event_rsvp(uuid, boolean, integer) to authenticated, service_role;

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
  uid uuid := auth.uid();
  ev_id uuid;
begin
  if uid is null or not exists (select 1 from public.profiles p where p.id = uid and p.role in ('admin', 'moderator') and p.account_status = 'active') then
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

grant execute on function public.create_hallyu_event(text, text, text, text, text, uuid, integer, integer, timestamptz, integer, text, jsonb, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. 24/7 Alive Notifications: Direct Messages, Creator Drops, CEO Megaphone & Handle Change
-- ---------------------------------------------------------------------------------------------

-- Direct Message Push Trigger: immediately alerts the other member of a conversation!
create or replace function public.on_direct_message_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  conv public.conversations%rowtype;
  recipient uuid;
  sender public.profiles%rowtype;
begin
  select * into conv from public.conversations where id = new.conversation_id;
  if conv.id is null then
    return new;
  end if;

  recipient := case when conv.user_a = new.sender_id then conv.user_b else conv.user_a end;
  if recipient is null or recipient = new.sender_id then
    return new;
  end if;

  select * into sender from public.profiles where id = new.sender_id;

  perform public.enqueue_notification(
    p_recipient := recipient,
    p_kind := 'mention',
    p_group := 'social',
    p_dedupe_key := 'dm:' || new.id::text,
    p_actor_ids := array[new.sender_id],
    p_title := coalesce(sender.display_name, '@' || coalesce(sender.handle, 'member')) || ' sent you a message',
    p_body := left(coalesce(new.body, 'Shared a post with you'), 140),
    p_deep_link := '/messages/' || new.conversation_id::text
  );

  return new;
end;
$$;

drop trigger if exists direct_messages_notify_after_insert on public.direct_messages;
create trigger direct_messages_notify_after_insert
  after insert on public.direct_messages
  for each row execute function public.on_direct_message_notify();

-- Creator / Followed Member Post Drop Trigger: pings followers when someone they follow posts!
create or replace function public.on_post_follower_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  author_rec public.profiles%rowtype;
  f_rec record;
  kind_label text;
begin
  if new.state <> 'active' or new.visibility <> 'public' then
    return new;
  end if;

  select * into author_rec from public.profiles where id = new.author_id;
  if author_rec.id is null then
    return new;
  end if;

  kind_label := case new.type
    when 'short' then 'dropped a new Short'
    when 'review' then 'published a new review'
    when 'recommendation' then 'shared a recommendation'
    else 'posted on Hallyu'
  end;

  for f_rec in
    select follower_id
      from public.follows
     where target_id = new.author_id
       and follower_id <> new.author_id
     limit 500
  loop
    perform public.enqueue_notification(
      p_recipient := f_rec.follower_id,
      p_kind := 'mention',
      p_group := 'social',
      p_dedupe_key := 'post-drop:' || new.id::text || ':' || f_rec.follower_id::text,
      p_actor_ids := array[new.author_id],
      p_post_id := new.id,
      p_title_id := new.title_id,
      p_title := coalesce(author_rec.display_name, '@' || author_rec.handle) || ' ' || kind_label,
      p_body := left(coalesce(nullif(btrim(new.title), ''), new.body), 140),
      p_deep_link := '/post/' || new.id::text
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists posts_follower_notify_after_insert on public.posts;
create trigger posts_follower_notify_after_insert
  after insert on public.posts
  for each row execute function public.on_post_follower_notify();

-- CEO / Staff Megaphone: broadcast live push alerts to all active members (or one world)
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
  uid uuid := auth.uid();
  rec record;
  sent_count integer := 0;
  batch_key text := 'broadcast:' || extract(epoch from now())::bigint::text;
begin
  if uid is null or not exists (select 1 from public.profiles p where p.id = uid and p.role in ('admin', 'moderator') and p.account_status = 'active') then
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

grant execute on function public.send_ceo_broadcast(text, text, text, text) to authenticated, service_role;

-- Real Cloud Handle Update RPC (`Settings -> Account`)
create or replace function public.change_my_handle(p_new_handle text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  clean text := lower(regexp_replace(btrim(coalesce(p_new_handle, '')), '^@+', ''));
begin
  if uid is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if clean !~ '^[a-z0-9_.]{3,24}$' then
    raise exception 'Handle must be 3–24 lowercase letters, numbers, underscores, or dots' using errcode = 'invalid_parameter_value';
  end if;

  if exists (select 1 from public.profiles where handle = clean and id <> uid) then
    raise exception 'That handle is already taken' using errcode = 'unique_violation';
  end if;

  update public.profiles
     set handle = clean,
         updated_at = now()
   where id = uid;

  return clean;
end;
$$;

grant execute on function public.change_my_handle(text) to authenticated, service_role;

-- Note: sub-second pg_net wake trigger + pg_cron dispatcher schedules are provisioned outside
-- relational migrations so offline Postgres verification and notification creation stay cleanly separated.

set check_function_bodies = on;
