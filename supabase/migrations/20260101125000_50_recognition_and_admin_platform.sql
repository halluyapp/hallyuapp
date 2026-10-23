-- =============================================================================================
-- Migration 50: Hallyu Recognition, Early-Member Awards, Profile Achievements, Two-Tier Account
--               Verification (`blue` / `red`), Immutable Audit Trail & Standard Admin Platform
-- =============================================================================================
-- Launch Clock Baseline: 2026-10-23 21:00:00+01 (Tonight 9:00 PM WAT / 20:00:00 UTC).
-- Existing pre-launch accounts (`@ceohallyu` founder + `@darasimi` second pre-launch account)
-- and synthetic CI accounts (`*@example.invalid`, `pw.*`, `hallyu.verify.*`) are strictly
-- excluded from public competition awards (`First Arrival`, `Founding Ten #1–#10`,
-- `Founding Member`, and `Day One`).
-- =============================================================================================

set check_function_bodies = on;

-- ---------------------------------------------------------------------------------------------
-- 1. Extend `public.profiles` with Verification Tiers, Founder Flag & Pinned Badge Showcase
-- ---------------------------------------------------------------------------------------------

alter table public.profiles
  add column if not exists verification_tier text not null default 'none'
    check (verification_tier in ('none', 'blue', 'red')),
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid references public.profiles (id) on delete set null,
  add column if not exists verification_note text,
  add column if not exists is_founder boolean not null default false,
  add column if not exists exclude_from_competitions boolean not null default false,
  add column if not exists featured_badge_ids text[] not null default '{}';

create index if not exists profiles_verification_tier_idx
  on public.profiles (verification_tier)
  where verification_tier <> 'none';

-- ---------------------------------------------------------------------------------------------
-- 2. Singleton Launch & Early-Member Configuration (`public.recognition_config`)
-- ---------------------------------------------------------------------------------------------

create table if not exists public.recognition_config (
  id                          smallint    primary key default 1 check (id = 1),
  launch_starts_at            timestamptz not null default '2026-10-23 21:00:00+01'::timestamptz,
  day_one_window_hours        integer     not null default 24 check (day_one_window_hours between 1 and 168),
  founding_member_window_days integer     not null default 14 check (founding_member_window_days between 1 and 365),
  founding_member_cap         integer     not null default 250 check (founding_member_cap between 10 and 100000),
  founding_ten_cap            integer     not null default 10 check (founding_ten_cap = 10),
  awards_enabled              boolean     not null default true,
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid        references public.profiles (id) on delete set null
);

alter table public.recognition_config enable row level security;

drop policy if exists recognition_config_select_all on public.recognition_config;
create policy recognition_config_select_all
  on public.recognition_config
  for select
  using (true);

drop policy if exists recognition_config_admin_write on public.recognition_config;
create policy recognition_config_admin_write
  on public.recognition_config
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select on table public.recognition_config to anon, authenticated, service_role;
grant insert, update on table public.recognition_config to authenticated, service_role;

insert into public.recognition_config (
  id,
  launch_starts_at,
  day_one_window_hours,
  founding_member_window_days,
  founding_member_cap,
  founding_ten_cap,
  awards_enabled
)
values (
  1,
  '2026-10-23 21:00:00+01'::timestamptz,
  24,
  14,
  250,
  10,
  true
)
on conflict (id) do update
  set launch_starts_at = '2026-10-23 21:00:00+01'::timestamptz,
      updated_at = now();

-- ---------------------------------------------------------------------------------------------
-- 3. Expandable Server-Backed Badge Catalog (`public.badge_definitions`)
-- ---------------------------------------------------------------------------------------------

create table if not exists public.badge_definitions (
  id              text        primary key check (id ~ '^[a-z0-9_]{3,48}$'),
  name            text        not null check (char_length(name) between 2 and 80),
  subtitle        text        not null default '',
  description     text        not null check (char_length(description) between 6 and 400),
  category        text        not null check (category in ('early_member', 'participation', 'content', 'community', 'executive')),
  rarity          text        not null default 'rare' check (rarity in ('mythic', 'legendary', 'epic', 'rare', 'standard')),
  icon_key        text        not null default 'shield_crest',
  accent_hex      text        not null default '#F59E0B',
  max_supply      integer     check (max_supply is null or max_supply >= 1),
  is_numbered     boolean     not null default false,
  is_automatic    boolean     not null default true,
  is_active       boolean     not null default true,
  threshold_kind  text        not null default 'manual_only',
  threshold_value integer     not null default 1 check (threshold_value >= 1),
  sort_order      integer     not null default 100,
  created_at      timestamptz not null default now()
);

alter table public.badge_definitions enable row level security;

drop policy if exists badge_definitions_select_all on public.badge_definitions;
create policy badge_definitions_select_all
  on public.badge_definitions
  for select
  using (true);

drop policy if exists badge_definitions_admin_manage on public.badge_definitions;
create policy badge_definitions_admin_manage
  on public.badge_definitions
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select on table public.badge_definitions to anon, authenticated, service_role;
grant insert, update, delete on table public.badge_definitions to authenticated, service_role;

insert into public.badge_definitions (
  id, name, subtitle, description, category, rarity, icon_key, accent_hex,
  max_supply, is_numbered, is_automatic, is_active, threshold_kind, threshold_value, sort_order
)
values
  -- Executive (Non-competitive official authority seal)
  (
    'founder_seal',
    'Architect of Hallyu',
    'Founder Crest',
    'Official non-competitive crest of Hallyu leadership. Never occupies community competition slots.',
    'executive',
    'mythic',
    'founder_seal',
    '#E11D48',
    1,
    false,
    false,
    true,
    'manual_only',
    1,
    1
  ),
  -- Early-Member Recognition (Competition slots open strictly at 2026-10-23 21:00 WAT)
  (
    'first_arrival',
    'First Arrival',
    '1 of 1 Sovereign Star',
    'Claimed by the very first eligible community member to cross the threshold after Hallyu launch at 9:00 PM WAT.',
    'early_member',
    'mythic',
    'first_arrival',
    '#FBBF24',
    1,
    true,
    true,
    true,
    'launch_arrival',
    1,
    10
  ),
  (
    'founding_ten',
    'Founding Ten',
    'Numbered #1 – #10',
    'Permanently numbered gold-and-bronze laurel medallion reserved exclusively for the first ten eligible members after launch.',
    'early_member',
    'mythic',
    'founding_ten',
    '#D97706',
    10,
    true,
    true,
    true,
    'launch_arrival',
    10,
    20
  ),
  (
    'founding_member',
    'Founding Member',
    'Charter Cohort',
    'Joined Hallyu inside the inaugural Charter window and helped shape the founding four-world home.',
    'early_member',
    'legendary',
    'founding_member',
    '#C084FC',
    250,
    true,
    true,
    true,
    'launch_window',
    250,
    30
  ),
  (
    'day_one',
    'Day One',
    'Opening 24 Hours',
    'Stepped inside Hallyu during the opening 24-hour premiere night window.',
    'early_member',
    'epic',
    'day_one',
    '#38BDF8',
    null,
    false,
    true,
    true,
    'launch_window',
    24,
    40
  ),
  -- Participation Achievements
  (
    'four_worlds_passport',
    'World Passport',
    'Fandom Identity',
    'Chose your entertainment worlds and locked in your Hallyu viewing identity.',
    'participation',
    'standard',
    'world_passport',
    '#22D3EE',
    null,
    false,
    true,
    true,
    'worlds_selected',
    1,
    110
  ),
  (
    'premiere_night',
    'Premiere Regular',
    'Watch Party Live',
    'Locked in an RSVP for a live Hallyu Premiere or Watch Party event.',
    'participation',
    'rare',
    'premiere_night',
    '#FB7185',
    null,
    false,
    true,
    true,
    'event_rsvps',
    1,
    120
  ),
  (
    'watchlist_curator',
    'Watchlist Curator',
    '5+ Titles Tracked',
    'Organized five or more dramas, anime, or films across your Hallyu watchlist.',
    'participation',
    'rare',
    'watchlist_curator',
    '#34D399',
    null,
    false,
    true,
    true,
    'watchlist_total',
    5,
    130
  ),
  (
    'season_finisher',
    'Season Finisher',
    '3+ Completed Stories',
    'Saw three complete series or films all the way to the final credits on Hallyu.',
    'participation',
    'epic',
    'season_finisher',
    '#A78BFA',
    null,
    false,
    true,
    true,
    'watchlist_completed',
    3,
    140
  ),
  -- Content Achievements (Anti-spam: substantive active posts only)
  (
    'first_voice',
    'First Voice',
    'Debut Thread',
    'Published your first substantive post, scene reaction, or discussion to the Hallyu feed.',
    'content',
    'standard',
    'first_voice',
    '#F472B6',
    null,
    false,
    true,
    true,
    'substantive_posts',
    1,
    210
  ),
  (
    'scene_critic',
    'Scene Critic',
    '3+ Verdicts Published',
    'Authored at least three thoughtful drama, anime, or cinema reviews with verdicts.',
    'content',
    'epic',
    'scene_critic',
    '#FBBF24',
    null,
    false,
    true,
    true,
    'substantive_reviews',
    3,
    220
  ),
  (
    'pulse_maker',
    'Pulse Maker',
    '5+ Member Reactions',
    'Sparked genuine emotional reactions from fellow Hallyu members on your posts.',
    'content',
    'rare',
    'pulse_maker',
    '#F43F5E',
    null,
    false,
    true,
    true,
    'peer_reactions_received',
    5,
    230
  ),
  -- Community Achievements (Anti-spam: distinct active members & rooms only)
  (
    'circle_member',
    'Fandom Circle',
    '2+ Rooms Joined',
    'Stepped into two or more fandom community rooms to talk episodes and theories.',
    'community',
    'standard',
    'circle_member',
    '#60A5FA',
    null,
    false,
    true,
    true,
    'communities_joined',
    2,
    310
  ),
  (
    'rising_voice',
    'Rising Voice',
    '5+ Active Followers',
    'Earned a following of five or more active community members who tune in for your takes.',
    'community',
    'rare',
    'rising_voice',
    '#F59E0B',
    null,
    false,
    true,
    true,
    'active_followers',
    5,
    320
  ),
  (
    'community_pillar',
    'Community Pillar',
    'Trusted Anchor',
    'Built a thriving following of twenty-five active members or contributed ten substantive thread replies.',
    'community',
    'legendary',
    'community_pillar',
    '#EC4899',
    null,
    false,
    true,
    true,
    'pillar_milestone',
    25,
    330
  )
on conflict (id) do update
  set name = excluded.name,
      subtitle = excluded.subtitle,
      description = excluded.description,
      category = excluded.category,
      rarity = excluded.rarity,
      icon_key = excluded.icon_key,
      accent_hex = excluded.accent_hex,
      max_supply = excluded.max_supply,
      is_numbered = excluded.is_numbered,
      is_automatic = excluded.is_automatic,
      threshold_kind = excluded.threshold_kind,
      threshold_value = excluded.threshold_value,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------------------------
-- 4. Member Awards Ledger (`public.user_awards`) — Race-Free & Non-Silently Reassignable
-- ---------------------------------------------------------------------------------------------

create table if not exists public.user_awards (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references public.profiles (id) on delete cascade,
  badge_id      text        not null references public.badge_definitions (id) on delete restrict,
  serial_number integer     check (serial_number is null or serial_number >= 1),
  status        text        not null default 'active' check (status in ('active', 'revoked')),
  source        text        not null default 'automatic' check (source in ('automatic', 'admin_grant', 'system_seed')),
  awarded_by    uuid        references public.profiles (id) on delete set null,
  award_note    text,
  awarded_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  revoked_by    uuid        references public.profiles (id) on delete set null,
  revoke_reason text,
  metadata      jsonb       not null default '{}'::jsonb,
  constraint user_awards_unique_member_badge unique (user_id, badge_id)
);

-- Deliberately covers BOTH 'active' and 'revoked' rows when `serial_number is not null`:
-- revoking a fraudulent numbered award retires/voids that slot permanently by default rather than
-- silently shifting anyone else's serial number. Releasing a slot back to the pool requires an
-- explicit admin override recorded in `recognition_audit_log`.
create unique index if not exists user_awards_badge_serial_key
  on public.user_awards (badge_id, serial_number)
  where serial_number is not null;

create index if not exists user_awards_user_status_idx
  on public.user_awards (user_id, status, awarded_at desc);

alter table public.user_awards enable row level security;

drop policy if exists user_awards_select_public_active on public.user_awards;
create policy user_awards_select_public_active
  on public.user_awards
  for select
  using (status = 'active' or auth.uid() = user_id or public.is_moderator());

drop policy if exists user_awards_admin_write on public.user_awards;
create policy user_awards_admin_write
  on public.user_awards
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select on table public.user_awards to anon, authenticated, service_role;
grant insert, update, delete on table public.user_awards to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Verification Applications (`public.verification_requests`) & Immutable Audit Log
-- ---------------------------------------------------------------------------------------------

create table if not exists public.verification_requests (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references public.profiles (id) on delete cascade,
  requested_tier  text        not null default 'blue' check (requested_tier in ('blue', 'red')),
  category        text        not null default 'creator' check (category in ('creator', 'journalist', 'community_leader', 'public_figure', 'official_brand', 'staff')),
  evidence_links  text[]      not null default '{}',
  statement       text        not null check (char_length(statement) between 10 and 2000),
  status          text        not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reviewed_by     uuid        references public.profiles (id) on delete set null,
  review_reason   text,
  reviewed_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists verification_requests_one_pending_idx
  on public.verification_requests (user_id)
  where status = 'pending';

create index if not exists verification_requests_status_created_idx
  on public.verification_requests (status, created_at desc);

alter table public.verification_requests enable row level security;

drop policy if exists verification_requests_select_own_or_staff on public.verification_requests;
create policy verification_requests_select_own_or_staff
  on public.verification_requests
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_moderator());

drop policy if exists verification_requests_insert_own on public.verification_requests;
create policy verification_requests_insert_own
  on public.verification_requests
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists verification_requests_admin_update on public.verification_requests;
create policy verification_requests_admin_update
  on public.verification_requests
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select, insert, update on table public.verification_requests to authenticated, service_role;

create table if not exists public.recognition_audit_log (
  id              uuid        primary key default gen_random_uuid(),
  actor_id        uuid        references public.profiles (id) on delete set null,
  target_user_id  uuid        references public.profiles (id) on delete set null,
  domain          text        not null check (domain in ('award', 'verification', 'launch_config', 'user_admin', 'moderation')),
  action          text        not null,
  badge_id        text        references public.badge_definitions (id) on delete set null,
  serial_number   integer,
  previous_state  jsonb       not null default '{}'::jsonb,
  new_state       jsonb       not null default '{}'::jsonb,
  reason          text        not null,
  created_at      timestamptz not null default now()
);

create index if not exists recognition_audit_log_created_idx
  on public.recognition_audit_log (created_at desc);

create index if not exists recognition_audit_log_target_idx
  on public.recognition_audit_log (target_user_id, created_at desc);

alter table public.recognition_audit_log enable row level security;

drop policy if exists recognition_audit_log_staff_select on public.recognition_audit_log;
create policy recognition_audit_log_staff_select
  on public.recognition_audit_log
  for select
  to authenticated
  using (public.is_moderator() or target_user_id = auth.uid());

drop policy if exists recognition_audit_log_admin_insert on public.recognition_audit_log;
create policy recognition_audit_log_admin_insert
  on public.recognition_audit_log
  for insert
  to authenticated
  with check (public.is_admin());

grant select, insert on table public.recognition_audit_log to authenticated, service_role;

-- Append-only guard: audit records can NEVER be updated or deleted once committed, except when a
-- foreign-key SET NULL cascade runs internally upon account purge (`pg_trigger_depth() > 0`).
create or replace function public.guard_recognition_audit_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'recognition_audit_log is append-only and records cannot be deleted'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
       or new.domain is distinct from old.domain
       or new.action is distinct from old.action
       or new.previous_state is distinct from old.previous_state
       or new.new_state is distinct from old.new_state
       or new.reason is distinct from old.reason
       or new.created_at is distinct from old.created_at then
      raise exception 'recognition_audit_log entries are immutable once recorded'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists recognition_audit_immutable_trg on public.recognition_audit_log;
create trigger recognition_audit_immutable_trg
  before update or delete on public.recognition_audit_log
  for each row execute function public.guard_recognition_audit_immutable();

-- ---------------------------------------------------------------------------------------------
-- 6. Strengthen `public.guard_profile_privileges()` Against Self-Verification & Badge Spoofing
-- ---------------------------------------------------------------------------------------------

create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  invalid_pin text;
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if current_user not in ('anon', 'authenticated')
     or auth.role() = 'service_role'
     or public.is_admin() then
    new.verified := (coalesce(new.verification_tier, 'none') <> 'none');
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

-- ---------------------------------------------------------------------------------------------
-- 7. Backfill Founder (`@ceohallyu`) & Pre-Launch Second Account (`@darasimi`) State Cleanly
-- ---------------------------------------------------------------------------------------------

-- All accounts created prior to tonight's 9:00 PM WAT launch clock are pre-launch test/founder
-- accounts and never consume public competition slots (`First Arrival`, `Founding Ten #1–#10`, etc.).
update public.profiles
   set exclude_from_competitions = true,
       verification_tier = case
         when id = 'eed9c671-608c-4866-823e-2fa876508284'::uuid or lower(handle::text) = 'ceohallyu' then 'red'
         when verified and verification_tier = 'none' then 'blue'
         else verification_tier
       end,
       verified = case
         when id = 'eed9c671-608c-4866-823e-2fa876508284'::uuid or lower(handle::text) = 'ceohallyu' then true
         else verified
       end,
       verified_at = case
         when id = 'eed9c671-608c-4866-823e-2fa876508284'::uuid or lower(handle::text) = 'ceohallyu' then coalesce(verified_at, now())
         else verified_at
       end,
       verification_note = case
         when id = 'eed9c671-608c-4866-823e-2fa876508284'::uuid or lower(handle::text) = 'ceohallyu' then 'Founder & Executive Official Authority (@ceohallyu)'
         else verification_note
       end,
       is_founder = case
         when id = 'eed9c671-608c-4866-823e-2fa876508284'::uuid or lower(handle::text) = 'ceohallyu' then true
         else is_founder
       end,
       featured_badge_ids = case
         when id = 'eed9c671-608c-4866-823e-2fa876508284'::uuid or lower(handle::text) = 'ceohallyu' then array['founder_seal']
         else featured_badge_ids
       end
 where created_at < '2026-10-23 21:00:00+01'::timestamptz
    or id in ('eed9c671-608c-4866-823e-2fa876508284'::uuid, 'a2fdf143-8cab-4cd4-af4a-8ad202336fd1'::uuid)
    or lower(handle::text) in ('ceohallyu', 'darasimi');

insert into public.user_awards (user_id, badge_id, status, source, award_note)
select p.id, 'founder_seal', 'active', 'system_seed', 'Official Hallyu Founder Seal (@ceohallyu)'
  from public.profiles p
 where p.id = 'eed9c671-608c-4866-823e-2fa876508284'::uuid
    or lower(p.handle::text) = 'ceohallyu'
on conflict (user_id, badge_id) do nothing;

-- ---------------------------------------------------------------------------------------------
-- 8. Helper: Serialize Member Active Badges JSON + Atomic Early-Member & Achievement Evaluators
-- ---------------------------------------------------------------------------------------------

create or replace function public.profile_awards_json(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_user_id is null then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'award_id', ua.id,
        'badge_id', bd.id,
        'name', bd.name,
        'subtitle', bd.subtitle,
        'description', bd.description,
        'category', bd.category,
        'rarity', bd.rarity,
        'icon_key', bd.icon_key,
        'accent_hex', bd.accent_hex,
        'is_numbered', bd.is_numbered,
        'max_supply', bd.max_supply,
        'serial_number', ua.serial_number,
        'source', ua.source,
        'award_note', ua.award_note,
        'awarded_at', ua.awarded_at
      )
      order by bd.sort_order asc, ua.awarded_at asc
    )
    from public.user_awards ua
    join public.badge_definitions bd on bd.id = ua.badge_id
    where ua.user_id = p_user_id
      and ua.status = 'active'
      and bd.is_active = true
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.profile_awards_json(uuid) to anon, authenticated, service_role;

-- Internal atomic award issuer: guarantees idempotency, auto-pins up to 4 badges on first earn,
-- writes immutable audit trail, and dispatches exactly 1 deduplicated in-app + push notification.
create or replace function public.internal_issue_badge(
  p_user_id uuid,
  p_badge_id text,
  p_serial integer default null,
  p_source text default 'automatic',
  p_actor_id uuid default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  def_row public.badge_definitions%rowtype;
  prof_row public.profiles%rowtype;
  new_award_id uuid;
  display_label text;
  notif_title text;
  notif_body text;
begin
  if p_user_id is null or p_badge_id is null then
    return null;
  end if;

  select * into def_row from public.badge_definitions where id = p_badge_id and is_active = true;
  if def_row.id is null then
    return null;
  end if;

  select * into prof_row from public.profiles where id = p_user_id;
  if prof_row.id is null or prof_row.account_status <> 'active' then
    return null;
  end if;

  insert into public.user_awards (
    user_id,
    badge_id,
    serial_number,
    status,
    source,
    awarded_by,
    award_note
  )
  values (
    p_user_id,
    p_badge_id,
    p_serial,
    'active',
    coalesce(p_source, 'automatic'),
    p_actor_id,
    coalesce(p_note, def_row.subtitle)
  )
  on conflict (user_id, badge_id) do nothing
  returning id into new_award_id;

  if new_award_id is null then
    return null;
  end if;

  if coalesce(cardinality(prof_row.featured_badge_ids), 0) < 4
     and not (p_badge_id = any(coalesce(prof_row.featured_badge_ids, '{}'::text[]))) then
    update public.profiles
       set featured_badge_ids = array_append(coalesce(featured_badge_ids, '{}'::text[]), p_badge_id)
     where id = p_user_id;
  end if;

  display_label := case
    when p_serial is not null and def_row.is_numbered then def_row.name || ' #' || p_serial::text
    else def_row.name
  end;

  insert into public.recognition_audit_log (
    actor_id,
    target_user_id,
    domain,
    action,
    badge_id,
    serial_number,
    previous_state,
    new_state,
    reason
  )
  values (
    p_actor_id,
    p_user_id,
    'award',
    case when p_source = 'admin_grant' then 'badge_manual_grant' else 'badge_awarded' end,
    p_badge_id,
    p_serial,
    '{}'::jsonb,
    jsonb_build_object(
      'award_id', new_award_id,
      'badge_id', p_badge_id,
      'serial_number', p_serial,
      'source', p_source
    ),
    coalesce(nullif(btrim(p_note), ''), 'Earned ' || display_label)
  );

  notif_title := 'New Badge Unlocked: ' || display_label;
  notif_body := def_row.description;

  perform public.enqueue_notification(
    p_recipient := p_user_id,
    p_kind := 'system',
    p_group := 'system',
    p_dedupe_key := 'award:' || p_badge_id || ':' || p_user_id::text,
    p_actor_ids := case when p_actor_id is not null then array[p_actor_id] else '{}'::uuid[] end,
    p_title := notif_title,
    p_body := left(notif_body, 200),
    p_deep_link := '/user/' || prof_row.handle::text
  );

  return new_award_id;
end;
$$;

revoke all on function public.internal_issue_badge(uuid, text, integer, text, uuid, text) from public, anon, authenticated;
grant execute on function public.internal_issue_badge(uuid, text, integer, text, uuid, text) to service_role;

-- Atomic Early-Member Launch Evaluator:
-- Serialized with `pg_advisory_xact_lock(88421001)` so simultaneous signups at 21:00:00.000 WAT
-- can NEVER race, collide, duplicate numbers, or skip slots.
create or replace function public.evaluate_early_member_awards(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cfg public.recognition_config%rowtype;
  prof public.profiles%rowtype;
  auth_email text;
  auth_created timestamptz;
  open_ten_slot integer;
  fm_assigned integer;
  awarded_list text[] := '{}'::text[];
  issued uuid;
begin
  if p_user_id is null then
    return jsonb_build_object('eligible', false, 'reason', 'null_user', 'awarded', '[]'::jsonb);
  end if;

  -- Serialize all early-member slot allocations across concurrent transactions.
  perform pg_advisory_xact_lock(88421001);

  select * into cfg from public.recognition_config where id = 1;
  if cfg.id is null or not cfg.awards_enabled then
    return jsonb_build_object('eligible', false, 'reason', 'awards_disabled', 'awarded', '[]'::jsonb);
  end if;

  select * into prof from public.profiles where id = p_user_id;
  if prof.id is null or prof.account_status <> 'active' then
    return jsonb_build_object('eligible', false, 'reason', 'inactive_or_missing_profile', 'awarded', '[]'::jsonb);
  end if;

  select lower(coalesce(u.email, '')), u.created_at
    into auth_email, auth_created
    from auth.users u
   where u.id = p_user_id;

  auth_created := coalesce(auth_created, prof.created_at);

  -- 1. Exclude founder (`@ceohallyu`), pre-launch accounts (`@darasimi` + any explicit exclusion),
  --    and synthetic CI/verification accounts (`*@example.invalid`, `pw.*`, `hallyu.verify.*`).
  if prof.is_founder
     or prof.exclude_from_competitions
     or lower(prof.handle::text) in ('ceohallyu', 'darasimi')
     or auth_email like '%@example.invalid'
     or auth_email like '%@test.invalid'
     or auth_email like 'pw.%'
     or auth_email like 'hallyu.verify.%' then
    if not prof.exclude_from_competitions then
      update public.profiles set exclude_from_competitions = true where id = p_user_id;
    end if;
    return jsonb_build_object('eligible', false, 'reason', 'excluded_account', 'awarded', '[]'::jsonb);
  end if;

  -- 2. Enforce strict Launch Clock cutoff (`auth_created >= cfg.launch_starts_at`).
  if auth_created < cfg.launch_starts_at then
    return jsonb_build_object('eligible', false, 'reason', 'before_launch_clock', 'awarded', '[]'::jsonb);
  end if;

  -- 3. `first_arrival` (1 of 1 — never reassigned silently once serial_number = 1 exists)
  if not exists (
    select 1 from public.user_awards
     where badge_id = 'first_arrival' and serial_number = 1
  ) then
    issued := public.internal_issue_badge(
      p_user_id,
      'first_arrival',
      1,
      'automatic',
      null,
      'First eligible member across the Hallyu launch threshold'
    );
    if issued is not null then
      awarded_list := array_append(awarded_list, 'first_arrival');
    end if;
  end if;

  -- 4. `founding_ten` (Numbered #1 – #10)
  if not exists (
    select 1 from public.user_awards
     where user_id = p_user_id and badge_id = 'founding_ten'
  ) then
    select s into open_ten_slot
      from generate_series(1, cfg.founding_ten_cap) as s
     where not exists (
       select 1 from public.user_awards ua
        where ua.badge_id = 'founding_ten'
          and ua.serial_number = s
     )
     order by s asc
     limit 1;

    if open_ten_slot is not null then
      issued := public.internal_issue_badge(
        p_user_id,
        'founding_ten',
        open_ten_slot,
        'automatic',
        null,
        'Claimed Founding Ten slot #' || open_ten_slot::text
      );
      if issued is not null then
        awarded_list := array_append(awarded_list, 'founding_ten');
      end if;
    end if;
  end if;

  -- 5. `founding_member` (Charter window + total slot cap)
  if auth_created <= cfg.launch_starts_at + make_interval(days => cfg.founding_member_window_days)
     and not exists (
       select 1 from public.user_awards
        where user_id = p_user_id and badge_id = 'founding_member'
     ) then
    select coalesce(max(serial_number), 0) into fm_assigned
      from public.user_awards
     where badge_id = 'founding_member';

    if fm_assigned < cfg.founding_member_cap then
      issued := public.internal_issue_badge(
        p_user_id,
        'founding_member',
        fm_assigned + 1,
        'automatic',
        null,
        'Joined within the Founding Charter cohort (#' || (fm_assigned + 1)::text || ')'
      );
      if issued is not null then
        awarded_list := array_append(awarded_list, 'founding_member');
      end if;
    end if;
  end if;

  -- 6. `day_one` (Opening 24 hours from `launch_starts_at`)
  if auth_created <= cfg.launch_starts_at + make_interval(hours => cfg.day_one_window_hours)
     and not exists (
       select 1 from public.user_awards
        where user_id = p_user_id and badge_id = 'day_one'
     ) then
    issued := public.internal_issue_badge(
      p_user_id,
      'day_one',
      null,
      'automatic',
      null,
      'Joined during Hallyu Day One opening 24 hours'
    );
    if issued is not null then
      awarded_list := array_append(awarded_list, 'day_one');
    end if;
  end if;

  return jsonb_build_object(
    'eligible', true,
    'awarded', to_jsonb(awarded_list)
  );
end;
$$;

revoke all on function public.evaluate_early_member_awards(uuid) from public, anon;
grant execute on function public.evaluate_early_member_awards(uuid) to authenticated, service_role;

-- Update `public.handle_new_user()` so every genuine signup starting at 21:00 WAT tonight is
-- atomically evaluated inside the exact signup transaction, while synthetic CI bots (`pw.*`,
-- `*@example.invalid`) are flagged `exclude_from_competitions = true` immediately on insert!
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  wanted text;
  lower_email text := lower(coalesce(new.email, ''));
  is_synthetic boolean;
begin
  wanted := coalesce(
    nullif(new.raw_user_meta_data ->> 'handle', ''),
    nullif(new.raw_user_meta_data ->> 'user_name', ''),
    nullif(new.raw_user_meta_data ->> 'preferred_username', ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'member'
  );

  is_synthetic := (
    lower_email like '%@example.invalid'
    or lower_email like '%@test.invalid'
    or lower_email like 'pw.%'
    or lower_email like 'hallyu.verify.%'
  );

  insert into public.profiles (id, handle, display_name, exclude_from_competitions)
  values (
    new.id,
    public.generate_handle(wanted, new.id),
    left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 'Member'), 40),
    is_synthetic
  )
  on conflict (id) do nothing;

  if not is_synthetic then
    perform public.evaluate_early_member_awards(new.id);
  end if;

  return new;
end;
$$;

-- Server-Side Anti-Spam Activity Achievement Evaluator
create or replace function public.evaluate_member_achievements(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  prof public.profiles%rowtype;
  worlds_cnt integer := 0;
  rsvp_cnt integer := 0;
  watch_total integer := 0;
  watch_done integer := 0;
  substantive_posts integer := 0;
  substantive_reviews integer := 0;
  peer_reactions integer := 0;
  rooms_joined integer := 0;
  active_followers integer := 0;
  substantive_comments integer := 0;
  unlocked text[] := '{}'::text[];
begin
  if p_user_id is null then
    return '[]'::jsonb;
  end if;

  select * into prof from public.profiles where id = p_user_id;
  if prof.id is null or prof.account_status <> 'active' then
    return '[]'::jsonb;
  end if;

  -- Skip synthetic CI bots completely so automated health checks never pollute award tables.
  if prof.handle::text like 'pw_adm_%' or prof.handle::text like 'verify_%' then
    return '[]'::jsonb;
  end if;

  -- Re-check early-member eligibility idempotently in case launch config was updated.
  perform public.evaluate_early_member_awards(p_user_id);

  worlds_cnt := coalesce(cardinality(prof.worlds), 0);

  select count(*)::integer into rsvp_cnt
    from public.hallyu_event_rsvps r
   where r.user_id = p_user_id;

  select count(*)::integer,
         count(*) filter (where w.status = 'completed')::integer
    into watch_total, watch_done
    from public.watchlist_items w
   where w.user_id = p_user_id;

  -- Anti-spam: only active posts with >= 20 trimmed characters count toward content milestones.
  select count(*)::integer,
         count(*) filter (where p.type = 'review' and char_length(btrim(p.body)) >= 30)::integer
    into substantive_posts, substantive_reviews
    from public.posts p
   where p.author_id = p_user_id
     and p.state = 'active'
     and char_length(btrim(p.body)) >= 20;

  -- Anti-spam: only reactions from OTHER distinct active members count (self-reactions ignored).
  select count(distinct r.user_id)::integer into peer_reactions
    from public.reactions r
    join public.posts p on p.id = r.post_id
    join public.profiles reactor on reactor.id = r.user_id
   where p.author_id = p_user_id
     and p.state = 'active'
     and r.user_id <> p_user_id
     and reactor.account_status = 'active';

  select count(*)::integer into rooms_joined
    from public.community_members cm
   where cm.user_id = p_user_id
     and cm.status = 'active';

  select count(*)::integer into active_followers
    from public.follows f
    join public.profiles fp on fp.id = f.follower_id
   where f.target_id = p_user_id
     and fp.account_status = 'active';

  select count(*)::integer into substantive_comments
    from public.comments c
   where c.author_id = p_user_id
     and c.state = 'active'
     and char_length(btrim(c.body)) >= 15;

  if worlds_cnt >= 1 and public.internal_issue_badge(p_user_id, 'four_worlds_passport') is not null then
    unlocked := array_append(unlocked, 'four_worlds_passport');
  end if;

  if rsvp_cnt >= 1 and public.internal_issue_badge(p_user_id, 'premiere_night') is not null then
    unlocked := array_append(unlocked, 'premiere_night');
  end if;

  if watch_total >= 5 and public.internal_issue_badge(p_user_id, 'watchlist_curator') is not null then
    unlocked := array_append(unlocked, 'watchlist_curator');
  end if;

  if watch_done >= 3 and public.internal_issue_badge(p_user_id, 'season_finisher') is not null then
    unlocked := array_append(unlocked, 'season_finisher');
  end if;

  if substantive_posts >= 1 and public.internal_issue_badge(p_user_id, 'first_voice') is not null then
    unlocked := array_append(unlocked, 'first_voice');
  end if;

  if substantive_reviews >= 3 and public.internal_issue_badge(p_user_id, 'scene_critic') is not null then
    unlocked := array_append(unlocked, 'scene_critic');
  end if;

  if peer_reactions >= 5 and public.internal_issue_badge(p_user_id, 'pulse_maker') is not null then
    unlocked := array_append(unlocked, 'pulse_maker');
  end if;

  if rooms_joined >= 2 and public.internal_issue_badge(p_user_id, 'circle_member') is not null then
    unlocked := array_append(unlocked, 'circle_member');
  end if;

  if active_followers >= 5 and public.internal_issue_badge(p_user_id, 'rising_voice') is not null then
    unlocked := array_append(unlocked, 'rising_voice');
  end if;

  if (active_followers >= 25 or substantive_comments >= 10)
     and public.internal_issue_badge(p_user_id, 'community_pillar') is not null then
    unlocked := array_append(unlocked, 'community_pillar');
  end if;

  return to_jsonb(unlocked);
end;
$$;

revoke all on function public.evaluate_member_achievements(uuid) from public, anon;
grant execute on function public.evaluate_member_achievements(uuid) to authenticated, service_role;

-- Automatic triggers on genuine user activity tables
create or replace function public.trg_evaluate_recognition_on_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  post_author uuid;
begin
  if tg_table_name = 'posts' then
    perform public.evaluate_member_achievements(new.author_id);
  elsif tg_table_name = 'comments' then
    perform public.evaluate_member_achievements(new.author_id);
  elsif tg_table_name = 'watchlist_items' then
    perform public.evaluate_member_achievements(new.user_id);
  elsif tg_table_name = 'hallyu_event_rsvps' then
    perform public.evaluate_member_achievements(new.user_id);
  elsif tg_table_name = 'community_members' then
    perform public.evaluate_member_achievements(new.user_id);
  elsif tg_table_name = 'follows' then
    perform public.evaluate_member_achievements(new.target_id);
  elsif tg_table_name = 'reactions' and new.post_id is not null then
    select author_id into post_author from public.posts where id = new.post_id;
    if post_author is not null and post_author <> new.user_id then
      perform public.evaluate_member_achievements(post_author);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists posts_recognition_eval_trg on public.posts;
create trigger posts_recognition_eval_trg
  after insert on public.posts
  for each row execute function public.trg_evaluate_recognition_on_activity();

drop trigger if exists comments_recognition_eval_trg on public.comments;
create trigger comments_recognition_eval_trg
  after insert on public.comments
  for each row execute function public.trg_evaluate_recognition_on_activity();

drop trigger if exists watchlist_recognition_eval_trg on public.watchlist_items;
create trigger watchlist_recognition_eval_trg
  after insert or update of status on public.watchlist_items
  for each row execute function public.trg_evaluate_recognition_on_activity();

drop trigger if exists event_rsvps_recognition_eval_trg on public.hallyu_event_rsvps;
create trigger event_rsvps_recognition_eval_trg
  after insert on public.hallyu_event_rsvps
  for each row execute function public.trg_evaluate_recognition_on_activity();

drop trigger if exists community_members_recognition_eval_trg on public.community_members;
create trigger community_members_recognition_eval_trg
  after insert or update of status on public.community_members
  for each row execute function public.trg_evaluate_recognition_on_activity();

drop trigger if exists follows_recognition_eval_trg on public.follows;
create trigger follows_recognition_eval_trg
  after insert on public.follows
  for each row execute function public.trg_evaluate_recognition_on_activity();

drop trigger if exists reactions_recognition_eval_trg on public.reactions;
create trigger reactions_recognition_eval_trg
  after insert on public.reactions
  for each row execute function public.trg_evaluate_recognition_on_activity();

-- ---------------------------------------------------------------------------------------------
-- 9. Member-Facing Recognition & Verification RPCs
-- ---------------------------------------------------------------------------------------------

create or replace function public.get_user_recognition(p_user_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  target_id uuid := coalesce(p_user_id, auth.uid());
  prof public.profiles%rowtype;
  cfg public.recognition_config%rowtype;
begin
  select * into cfg from public.recognition_config where id = 1;

  if target_id is not null then
    select * into prof from public.profiles where id = target_id and account_status = 'active';
  end if;

  return jsonb_build_object(
    'config', jsonb_build_object(
      'launch_starts_at', cfg.launch_starts_at,
      'day_one_window_hours', cfg.day_one_window_hours,
      'founding_member_window_days', cfg.founding_member_window_days,
      'founding_member_cap', cfg.founding_member_cap,
      'founding_ten_cap', cfg.founding_ten_cap,
      'awards_enabled', cfg.awards_enabled
    ),
    'user_id', prof.id,
    'verification_tier', coalesce(prof.verification_tier, 'none'),
    'verification_note', prof.verification_note,
    'verified_at', prof.verified_at,
    'is_founder', coalesce(prof.is_founder, false),
    'featured_badge_ids', coalesce(prof.featured_badge_ids, '{}'::text[]),
    'awards', case when prof.id is not null then public.profile_awards_json(prof.id) else '[]'::jsonb end,
    'catalog', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', bd.id,
          'name', bd.name,
          'subtitle', bd.subtitle,
          'description', bd.description,
          'category', bd.category,
          'rarity', bd.rarity,
          'icon_key', bd.icon_key,
          'accent_hex', bd.accent_hex,
          'max_supply', bd.max_supply,
          'is_numbered', bd.is_numbered,
          'is_automatic', bd.is_automatic,
          'threshold_kind', bd.threshold_kind,
          'threshold_value', bd.threshold_value,
          'sort_order', bd.sort_order,
          'claimed_count', (
            select count(*)::integer
              from public.user_awards ua
             where ua.badge_id = bd.id
               and ua.status = 'active'
          )
        )
        order by bd.sort_order asc, bd.created_at asc
      )
      from public.badge_definitions bd
      where bd.is_active = true
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.get_user_recognition(uuid) to anon, authenticated, service_role;

create or replace function public.sync_my_recognition()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  newly_unlocked jsonb;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  newly_unlocked := public.evaluate_member_achievements(actor);

  return jsonb_build_object(
    'newly_unlocked', newly_unlocked,
    'recognition', public.get_user_recognition(actor)
  );
end;
$$;

revoke all on function public.sync_my_recognition() from public, anon;
grant execute on function public.sync_my_recognition() to authenticated, service_role;

create or replace function public.set_featured_badges(p_badge_ids text[])
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  cleaned text[];
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select coalesce(array_agg(b_id), '{}'::text[])
    into cleaned
    from (
      select distinct on (ord_id) b_id
      from (
        select b_id, row_number() over () as ord_id
        from unnest(coalesce(p_badge_ids, '{}'::text[])) as b_id
      ) raw_ids
      where exists (
        select 1
          from public.user_awards ua
         where ua.user_id = actor
           and ua.badge_id = raw_ids.b_id
           and ua.status = 'active'
      )
      order by ord_id asc
      limit 4
    ) valid_ids;

  update public.profiles
     set featured_badge_ids = cleaned,
         updated_at = now()
   where id = actor;

  return cleaned;
end;
$$;

revoke all on function public.set_featured_badges(text[]) from public, anon;
grant execute on function public.set_featured_badges(text[]) to authenticated, service_role;

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
  actor uuid := auth.uid();
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
     where role = 'admin'
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

revoke all on function public.submit_verification_request(text, text, text, text[]) from public, anon;
grant execute on function public.submit_verification_request(text, text, text, text[]) to authenticated, service_role;

create or replace function public.my_verification_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  prof public.profiles%rowtype;
  latest_req public.verification_requests%rowtype;
begin
  if actor is null then
    return jsonb_build_object('tier', 'none', 'request', null);
  end if;

  select * into prof from public.profiles where id = actor;
  select * into latest_req
    from public.verification_requests
   where user_id = actor
   order by created_at desc
   limit 1;

  return jsonb_build_object(
    'tier', coalesce(prof.verification_tier, 'none'),
    'verified_at', prof.verified_at,
    'verification_note', prof.verification_note,
    'is_founder', coalesce(prof.is_founder, false),
    'request', case when latest_req.id is not null then to_jsonb(latest_req) else null end
  );
end;
$$;

grant execute on function public.my_verification_status() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 10. Commercial Standard Admin Dashboard RPCs (`admin_*`)
-- ---------------------------------------------------------------------------------------------

create or replace function public.admin_dashboard_metrics()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  cfg public.recognition_config%rowtype;
  first_arrival_holder jsonb;
  founding_ten_slots jsonb;
begin
  if not public.is_moderator() then
    raise exception 'staff privilege required' using errcode = 'insufficient_privilege';
  end if;

  select * into cfg from public.recognition_config where id = 1;

  select jsonb_build_object(
    'award_id', ua.id,
    'user_id', p.id,
    'handle', p.handle,
    'display_name', p.display_name,
    'avatar_path', p.avatar_path,
    'verification_tier', p.verification_tier,
    'status', ua.status,
    'awarded_at', ua.awarded_at,
    'revoke_reason', ua.revoke_reason
  )
  into first_arrival_holder
  from public.user_awards ua
  join public.profiles p on p.id = ua.user_id
  where ua.badge_id = 'first_arrival'
    and ua.serial_number = 1
  limit 1;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'slot', s,
      'state', case
        when ua.id is null then 'open'
        when ua.status = 'revoked' then 'retired'
        else 'claimed'
      end,
      'award_id', ua.id,
      'user_id', p.id,
      'handle', p.handle,
      'display_name', p.display_name,
      'avatar_path', p.avatar_path,
      'verification_tier', p.verification_tier,
      'awarded_at', ua.awarded_at,
      'revoke_reason', ua.revoke_reason
    )
    order by s asc
  ), '[]'::jsonb)
  into founding_ten_slots
  from generate_series(1, cfg.founding_ten_cap) as s
  left join public.user_awards ua
    on ua.badge_id = 'founding_ten' and ua.serial_number = s
  left join public.profiles p
    on p.id = ua.user_id;

  return jsonb_build_object(
    'server_now', now(),
    'config', to_jsonb(cfg),
    'kpis', jsonb_build_object(
      'total_members', (
        select count(*)::integer from public.profiles
         where account_status <> 'deleted'
           and handle::text not like 'pw_adm_%'
           and handle::text not like 'verify_%'
      ),
      'eligible_post_launch_members', (
        select count(*)::integer from public.profiles p
         where p.account_status = 'active'
           and not p.is_founder
           and not p.exclude_from_competitions
           and p.created_at >= cfg.launch_starts_at
      ),
      'prelaunch_or_excluded_members', (
        select count(*)::integer from public.profiles p
         where p.account_status <> 'deleted'
           and (p.is_founder or p.exclude_from_competitions)
           and p.handle::text not like 'pw_adm_%'
           and p.handle::text not like 'verify_%'
      ),
      'new_members_24h', (
        select count(*)::integer from public.profiles
         where account_status = 'active'
           and created_at >= now() - interval '24 hours'
           and handle::text not like 'pw_adm_%'
           and handle::text not like 'verify_%'
      ),
      'verified_blue_count', (
        select count(*)::integer from public.profiles
         where account_status = 'active' and verification_tier = 'blue'
      ),
      'verified_red_count', (
        select count(*)::integer from public.profiles
         where account_status = 'active' and verification_tier = 'red'
      ),
      'pending_verifications', (
        select count(*)::integer from public.verification_requests where status = 'pending'
      ),
      'active_awards_total', (
        select count(*)::integer from public.user_awards where status = 'active'
      ),
      'founding_member_claimed', (
        select count(*)::integer from public.user_awards
         where badge_id = 'founding_member' and status = 'active'
      ),
      'day_one_claimed', (
        select count(*)::integer from public.user_awards
         where badge_id = 'day_one' and status = 'active'
      ),
      'active_posts', (
        select count(*)::integer from public.posts where state = 'active'
      ),
      'active_comments', (
        select count(*)::integer from public.comments where state = 'active'
      ),
      'communities_count', (
        select count(*)::integer from public.communities
      ),
      'open_reports', (
        select count(*)::integer from public.reports where status = 'open'
      ),
      'open_tickets', (
        select count(*)::integer from public.support_tickets where status in ('open', 'investigating')
      ),
      'pending_video_requests', (
        select count(*)::integer from public.video_access_requests where status = 'pending'
      )
    ),
    'first_arrival', first_arrival_holder,
    'founding_ten', founding_ten_slots
  );
end;
$$;

revoke all on function public.admin_dashboard_metrics() from public, anon;
grant execute on function public.admin_dashboard_metrics() to authenticated, service_role;

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
        'email', u.email,
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
      left join auth.users au on au.id = pr.id
      where pr.account_status <> 'deleted'
        and pr.handle::text not like 'pw_adm_%'
        and pr.handle::text not like 'verify_%'
        and (
          q = ''
          or lower(pr.handle::text) like '%' || q || '%'
          or lower(pr.display_name) like '%' || q || '%'
          or lower(coalesce(au.email, '')) like '%' || q || '%'
        )
        and (
          flt = 'all'
          or (flt = 'verified_blue' and pr.verification_tier = 'blue')
          or (flt = 'verified_red' and pr.verification_tier = 'red')
          or (flt = 'staff' and pr.role in ('admin', 'moderator'))
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
    left join auth.users u on u.id = p.id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.admin_search_users(text, text, integer, integer) from public, anon;
grant execute on function public.admin_search_users(text, text, integer, integer) to authenticated, service_role;

create or replace function public.admin_set_verification(
  p_target_user_id uuid,
  p_tier text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  target public.profiles%rowtype;
  clean_tier text := lower(btrim(coalesce(p_tier, 'none')));
  clean_reason text := btrim(coalesce(p_reason, ''));
  prev_tier text;
begin
  if not public.is_admin() then
    raise exception 'admin privilege required to grant or revoke verification' using errcode = 'insufficient_privilege';
  end if;

  if clean_tier not in ('none', 'blue', 'red') then
    raise exception 'invalid verification tier % (expected none, blue, or red)', clean_tier using errcode = 'invalid_parameter_value';
  end if;

  if char_length(clean_reason) < 4 then
    raise exception 'a clear audit reason is required to grant or revoke verification' using errcode = 'invalid_parameter_value';
  end if;

  select * into target from public.profiles where id = p_target_user_id;
  if target.id is null then
    raise exception 'target member not found' using errcode = 'no_data_found';
  end if;

  prev_tier := coalesce(target.verification_tier, 'none');

  update public.profiles
     set verification_tier = clean_tier,
         verified = (clean_tier <> 'none'),
         verified_at = case when clean_tier <> 'none' then now() else null end,
         verified_by = case when clean_tier <> 'none' then actor else null end,
         verification_note = clean_reason,
         updated_at = now()
   where id = p_target_user_id;

  insert into public.recognition_audit_log (
    actor_id,
    target_user_id,
    domain,
    action,
    previous_state,
    new_state,
    reason
  )
  values (
    actor,
    p_target_user_id,
    'verification',
    case when clean_tier = 'none' then 'verification_revoked' else 'verification_granted' end,
    jsonb_build_object('verification_tier', prev_tier, 'verified', target.verified),
    jsonb_build_object('verification_tier', clean_tier, 'verified', clean_tier <> 'none'),
    clean_reason
  );

  if clean_tier <> prev_tier then
    perform public.enqueue_notification(
      p_recipient := p_target_user_id,
      p_kind := 'system',
      p_group := 'system',
      p_dedupe_key := 'verif-change:' || p_target_user_id::text || ':' || clean_tier || ':' || extract(epoch from now())::bigint::text,
      p_actor_ids := case when actor is not null then array[actor] else '{}'::uuid[] end,
      p_title := case
        when clean_tier = 'red' then 'Official Red Authority Verification Granted'
        when clean_tier = 'blue' then 'Authentic Blue Account Verification Granted'
        else 'Account Verification Updated'
      end,
      p_body := left(clean_reason, 200),
      p_deep_link := '/user/' || target.handle::text
    );
  end if;

  return jsonb_build_object(
    'user_id', p_target_user_id,
    'handle', target.handle,
    'previous_tier', prev_tier,
    'verification_tier', clean_tier
  );
end;
$$;

revoke all on function public.admin_set_verification(uuid, text, text) from public, anon;
grant execute on function public.admin_set_verification(uuid, text, text) to authenticated, service_role;

create or replace function public.admin_list_verification_requests(
  p_status text default 'all',
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  clean_status text := lower(btrim(coalesce(p_status, 'all')));
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if not public.is_moderator() then
    raise exception 'staff privilege required' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'request', to_jsonb(vr),
        'applicant', jsonb_build_object(
          'id', p.id,
          'handle', p.handle,
          'display_name', p.display_name,
          'avatar_path', p.avatar_path,
          'verification_tier', p.verification_tier,
          'follower_count', p.follower_count,
          'post_count', p.post_count,
          'created_at', p.created_at
        ),
        'reviewer_handle', rv.handle
      )
      order by (vr.status = 'pending') desc, vr.created_at desc
    )
    from (
      select *
      from public.verification_requests r
      where clean_status = 'all' or r.status = clean_status
      order by (r.status = 'pending') desc, r.created_at desc
      limit lim
    ) vr
    join public.profiles p on p.id = vr.user_id
    left join public.profiles rv on rv.id = vr.reviewed_by
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.admin_list_verification_requests(text, integer) from public, anon;
grant execute on function public.admin_list_verification_requests(text, integer) to authenticated, service_role;

create or replace function public.admin_review_verification_request(
  p_request_id uuid,
  p_decision text,
  p_tier text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  req public.verification_requests%rowtype;
  applicant public.profiles%rowtype;
  dec text := lower(btrim(coalesce(p_decision, '')));
  clean_tier text := lower(btrim(coalesce(p_tier, 'blue')));
  clean_reason text := btrim(coalesce(p_reason, ''));
begin
  if not public.is_admin() then
    raise exception 'admin privilege required' using errcode = 'insufficient_privilege';
  end if;

  if dec not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected' using errcode = 'invalid_parameter_value';
  end if;

  if char_length(clean_reason) < 4 then
    raise exception 'review reason must be at least 4 characters' using errcode = 'invalid_parameter_value';
  end if;

  select * into req from public.verification_requests where id = p_request_id;
  if req.id is null then
    raise exception 'verification request not found' using errcode = 'no_data_found';
  end if;

  select * into applicant from public.profiles where id = req.user_id;

  update public.verification_requests
     set status = dec,
         reviewed_by = actor,
         review_reason = clean_reason,
         reviewed_at = now(),
         updated_at = now()
   where id = p_request_id;

  if dec = 'approved' then
    if clean_tier not in ('blue', 'red') then
      clean_tier := req.requested_tier;
    end if;
    perform public.admin_set_verification(req.user_id, clean_tier, clean_reason);
  else
    insert into public.recognition_audit_log (
      actor_id,
      target_user_id,
      domain,
      action,
      previous_state,
      new_state,
      reason
    )
    values (
      actor,
      req.user_id,
      'verification',
      'verification_request_rejected',
      jsonb_build_object('request_id', req.id, 'requested_tier', req.requested_tier),
      jsonb_build_object('status', 'rejected'),
      clean_reason
    );

    perform public.enqueue_notification(
      p_recipient := req.user_id,
      p_kind := 'system',
      p_group := 'system',
      p_dedupe_key := 'verif-req-rejected:' || req.id::text,
      p_actor_ids := case when actor is not null then array[actor] else '{}'::uuid[] end,
      p_title := 'Update on your Verification Request',
      p_body := left(clean_reason, 200),
      p_deep_link := '/user/' || applicant.handle::text
    );
  end if;

  return jsonb_build_object('request_id', req.id, 'status', dec);
end;
$$;

revoke all on function public.admin_review_verification_request(uuid, text, text, text) from public, anon;
grant execute on function public.admin_review_verification_request(uuid, text, text, text) to authenticated, service_role;

create or replace function public.admin_grant_badge(
  p_target_user_id uuid,
  p_badge_id text,
  p_reason text,
  p_serial_number integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  def_row public.badge_definitions%rowtype;
  chosen_serial integer := p_serial_number;
  award_id uuid;
  clean_reason text := btrim(coalesce(p_reason, ''));
begin
  if not public.is_admin() then
    raise exception 'admin privilege required to grant badges manually' using errcode = 'insufficient_privilege';
  end if;

  if char_length(clean_reason) < 4 then
    raise exception 'a clear audit reason is required to grant a badge' using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(88421001);

  select * into def_row from public.badge_definitions where id = p_badge_id;
  if def_row.id is null then
    raise exception 'badge definition % does not exist', p_badge_id using errcode = 'no_data_found';
  end if;

  if def_row.is_numbered and chosen_serial is null then
    if def_row.max_supply is not null then
      select s into chosen_serial
        from generate_series(1, def_row.max_supply) as s
       where not exists (
         select 1 from public.user_awards ua
          where ua.badge_id = p_badge_id and ua.serial_number = s
       )
       order by s asc
       limit 1;
      if chosen_serial is null then
        raise exception 'all % numbered slots for % have already been allocated or retired', def_row.max_supply, def_row.name
          using errcode = 'check_violation';
      end if;
    else
      select coalesce(max(serial_number), 0) + 1 into chosen_serial
        from public.user_awards where badge_id = p_badge_id;
    end if;
  end if;

  -- If member had a previously revoked copy and admin explicitly re-grants it, reactivate cleanly.
  if exists (
    select 1 from public.user_awards
     where user_id = p_target_user_id and badge_id = p_badge_id and status = 'revoked'
  ) then
    update public.user_awards
       set status = 'active',
           serial_number = coalesce(serial_number, chosen_serial),
           source = 'admin_grant',
           awarded_by = actor,
           award_note = clean_reason,
           awarded_at = now(),
           revoked_at = null,
           revoked_by = null,
           revoke_reason = null
     where user_id = p_target_user_id and badge_id = p_badge_id
     returning id into award_id;

    insert into public.recognition_audit_log (
      actor_id, target_user_id, domain, action, badge_id, serial_number, new_state, reason
    )
    values (
      actor, p_target_user_id, 'award', 'badge_reinstated', p_badge_id, chosen_serial,
      jsonb_build_object('award_id', award_id, 'badge_id', p_badge_id), clean_reason
    );
  else
    award_id := public.internal_issue_badge(
      p_target_user_id,
      p_badge_id,
      chosen_serial,
      'admin_grant',
      actor,
      clean_reason
    );
  end if;

  if award_id is null then
    raise exception 'member already holds active badge %', p_badge_id using errcode = 'unique_violation';
  end if;

  return jsonb_build_object(
    'award_id', award_id,
    'badge_id', p_badge_id,
    'serial_number', chosen_serial
  );
end;
$$;

revoke all on function public.admin_grant_badge(uuid, text, text, integer) from public, anon;
grant execute on function public.admin_grant_badge(uuid, text, text, integer) to authenticated, service_role;

-- Non-silent revocation:
-- By default (`p_release_slot = false`), numbered slots remain permanently retired/voided on the
-- revoked record so NO OTHER MEMBER'S NUMBER EVER SHIFTS SILENTLY. If an admin explicitly sets
-- `p_release_slot = true` (e.g. a bot voided and admin chooses to reopen that exact slot), the
-- voided slot release is explicitly written to `recognition_audit_log`.
create or replace function public.admin_revoke_badge(
  p_award_id uuid,
  p_reason text,
  p_release_slot boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  aw public.user_awards%rowtype;
  def_row public.badge_definitions%rowtype;
  target public.profiles%rowtype;
  clean_reason text := btrim(coalesce(p_reason, ''));
begin
  if not public.is_admin() then
    raise exception 'admin privilege required to revoke badges' using errcode = 'insufficient_privilege';
  end if;

  if char_length(clean_reason) < 4 then
    raise exception 'a clear audit reason is mandatory when revoking an award' using errcode = 'invalid_parameter_value';
  end if;

  select * into aw from public.user_awards where id = p_award_id;
  if aw.id is null then
    raise exception 'award record not found' using errcode = 'no_data_found';
  end if;

  select * into def_row from public.badge_definitions where id = aw.badge_id;
  select * into target from public.profiles where id = aw.user_id;

  update public.user_awards
     set status = 'revoked',
         revoked_at = now(),
         revoked_by = actor,
         revoke_reason = clean_reason,
         serial_number = case when coalesce(p_release_slot, false) then null else serial_number end,
         metadata = metadata || jsonb_build_object(
           'original_serial_number', aw.serial_number,
           'slot_released_by_admin', coalesce(p_release_slot, false)
         )
   where id = p_award_id;

  update public.profiles
     set featured_badge_ids = array_remove(coalesce(featured_badge_ids, '{}'::text[]), aw.badge_id)
   where id = aw.user_id;

  insert into public.recognition_audit_log (
    actor_id,
    target_user_id,
    domain,
    action,
    badge_id,
    serial_number,
    previous_state,
    new_state,
    reason
  )
  values (
    actor,
    aw.user_id,
    'award',
    case when coalesce(p_release_slot, false) then 'badge_revoked_slot_released' else 'badge_revoked_slot_retired' end,
    aw.badge_id,
    aw.serial_number,
    jsonb_build_object('status', aw.status, 'serial_number', aw.serial_number),
    jsonb_build_object('status', 'revoked', 'slot_released', coalesce(p_release_slot, false)),
    clean_reason
  );

  if target.id is not null then
    perform public.enqueue_notification(
      p_recipient := aw.user_id,
      p_kind := 'system',
      p_group := 'system',
      p_dedupe_key := 'award-revoked:' || aw.id::text || ':' || extract(epoch from now())::bigint::text,
      p_actor_ids := case when actor is not null then array[actor] else '{}'::uuid[] end,
      p_title := 'Badge Revoked: ' || coalesce(def_row.name, aw.badge_id),
      p_body := left(clean_reason, 200),
      p_deep_link := '/user/' || target.handle::text
    );
  end if;

  return jsonb_build_object(
    'award_id', aw.id,
    'badge_id', aw.badge_id,
    'previous_serial', aw.serial_number,
    'slot_released', coalesce(p_release_slot, false)
  );
end;
$$;

revoke all on function public.admin_revoke_badge(uuid, text, boolean) from public, anon;
grant execute on function public.admin_revoke_badge(uuid, text, boolean) to authenticated, service_role;

create or replace function public.admin_upsert_badge_definition(
  p_id text,
  p_name text,
  p_subtitle text,
  p_description text,
  p_category text,
  p_rarity text,
  p_icon_key text,
  p_accent_hex text,
  p_max_supply integer default null,
  p_is_numbered boolean default false,
  p_is_automatic boolean default false,
  p_is_active boolean default true,
  p_sort_order integer default 150
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  clean_id text := lower(regexp_replace(btrim(coalesce(p_id, '')), '[^a-z0-9_]+', '_', 'g'));
  saved public.badge_definitions%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privilege required' using errcode = 'insufficient_privilege';
  end if;

  if char_length(clean_id) < 3 then
    raise exception 'badge slug must be at least 3 characters' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.badge_definitions (
    id, name, subtitle, description, category, rarity, icon_key, accent_hex,
    max_supply, is_numbered, is_automatic, is_active, sort_order
  )
  values (
    left(clean_id, 48),
    left(btrim(p_name), 80),
    left(btrim(coalesce(p_subtitle, '')), 80),
    left(btrim(p_description), 400),
    p_category,
    coalesce(p_rarity, 'rare'),
    coalesce(nullif(btrim(p_icon_key), ''), 'shield_crest'),
    coalesce(nullif(btrim(p_accent_hex), ''), '#F59E0B'),
    p_max_supply,
    coalesce(p_is_numbered, false),
    coalesce(p_is_automatic, false),
    coalesce(p_is_active, true),
    coalesce(p_sort_order, 150)
  )
  on conflict (id) do update
    set name = excluded.name,
        subtitle = excluded.subtitle,
        description = excluded.description,
        category = excluded.category,
        rarity = excluded.rarity,
        icon_key = excluded.icon_key,
        accent_hex = excluded.accent_hex,
        max_supply = excluded.max_supply,
        is_numbered = excluded.is_numbered,
        is_automatic = excluded.is_automatic,
        is_active = excluded.is_active,
        sort_order = excluded.sort_order
  returning * into saved;

  insert into public.recognition_audit_log (
    actor_id, domain, action, badge_id, new_state, reason
  )
  values (
    actor, 'award', 'badge_definition_upserted', saved.id, to_jsonb(saved),
    'Catalog definition updated for ' || saved.name
  );

  return to_jsonb(saved);
end;
$$;

revoke all on function public.admin_upsert_badge_definition(text, text, text, text, text, text, text, text, integer, boolean, boolean, boolean, integer) from public, anon;
grant execute on function public.admin_upsert_badge_definition(text, text, text, text, text, text, text, text, integer, boolean, boolean, boolean, integer) to authenticated, service_role;

create or replace function public.admin_update_recognition_config(
  p_launch_starts_at timestamptz,
  p_day_one_window_hours integer,
  p_founding_member_window_days integer,
  p_founding_member_cap integer,
  p_awards_enabled boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  prev_cfg public.recognition_config%rowtype;
  next_cfg public.recognition_config%rowtype;
  clean_reason text := btrim(coalesce(p_reason, ''));
begin
  if not public.is_admin() then
    raise exception 'admin privilege required' using errcode = 'insufficient_privilege';
  end if;

  if char_length(clean_reason) < 4 then
    raise exception 'an audit reason is required when updating launch clock settings' using errcode = 'invalid_parameter_value';
  end if;

  select * into prev_cfg from public.recognition_config where id = 1;

  update public.recognition_config
     set launch_starts_at = coalesce(p_launch_starts_at, launch_starts_at),
         day_one_window_hours = coalesce(p_day_one_window_hours, day_one_window_hours),
         founding_member_window_days = coalesce(p_founding_member_window_days, founding_member_window_days),
         founding_member_cap = coalesce(p_founding_member_cap, founding_member_cap),
         awards_enabled = coalesce(p_awards_enabled, awards_enabled),
         updated_at = now(),
         updated_by = actor
   where id = 1
   returning * into next_cfg;

  insert into public.recognition_audit_log (
    actor_id, domain, action, previous_state, new_state, reason
  )
  values (
    actor,
    'launch_config',
    'launch_config_updated',
    to_jsonb(prev_cfg),
    to_jsonb(next_cfg),
    clean_reason
  );

  return to_jsonb(next_cfg);
end;
$$;

revoke all on function public.admin_update_recognition_config(timestamptz, integer, integer, integer, boolean, text) from public, anon;
grant execute on function public.admin_update_recognition_config(timestamptz, integer, integer, integer, boolean, text) to authenticated, service_role;

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
  actor uuid := auth.uid();
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

  next_role := coalesce(p_role::public.profile_role, target.role);
  next_status := coalesce(p_account_status::public.account_status, target.account_status);
  next_excl := coalesce(p_exclude_from_competitions, target.exclude_from_competitions);

  if target.is_founder and (next_role <> 'admin' or next_status <> 'active') then
    raise exception 'the primary founder account (@ceohallyu) cannot be demoted or suspended' using errcode = 'insufficient_privilege';
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

create or replace function public.admin_list_audit_log(
  p_domain text default null,
  p_limit integer default 80
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  clean_domain text := lower(btrim(coalesce(p_domain, '')));
  lim integer := least(greatest(coalesce(p_limit, 80), 1), 200);
begin
  if not public.is_moderator() then
    raise exception 'staff privilege required' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', l.id,
        'domain', l.domain,
        'action', l.action,
        'badge_id', l.badge_id,
        'serial_number', l.serial_number,
        'previous_state', l.previous_state,
        'new_state', l.new_state,
        'reason', l.reason,
        'created_at', l.created_at,
        'actor_handle', ap.handle,
        'actor_name', ap.display_name,
        'target_handle', tp.handle,
        'target_name', tp.display_name
      )
      order by l.created_at desc
    )
    from (
      select *
      from public.recognition_audit_log al
      where clean_domain = '' or clean_domain = 'all' or al.domain = clean_domain
      order by al.created_at desc
      limit lim
    ) l
    left join public.profiles ap on ap.id = l.actor_id
    left join public.profiles tp on tp.id = l.target_user_id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.admin_list_audit_log(text, integer) from public, anon;
grant execute on function public.admin_list_audit_log(text, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 11. Enrich Core Client Read Surfaces (`get_bootstrap`, `get_profile_by_handle`,
--     `get_post_thread`, `get_community_pulse`, `list_conversations`) with Verification Tiers
--     and Member Badge Payloads
-- ---------------------------------------------------------------------------------------------

create or replace function public.get_bootstrap()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  me public.profiles%rowtype;
  prefs public.user_preferences%rowtype;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  perform public.evaluate_member_achievements(actor);

  select * into me from public.profiles where id = actor;
  if me.id is null then
    raise exception 'profile does not exist for authenticated user' using errcode = 'no_data_found';
  end if;

  insert into public.user_preferences (user_id)
  values (actor)
  on conflict (user_id) do nothing;

  select * into prefs from public.user_preferences where user_id = actor;

  return jsonb_build_object(
    'profile', to_jsonb(me),
    'me', to_jsonb(me),
    'prefs', to_jsonb(prefs),
    'preferences', to_jsonb(prefs),
    'my_awards', public.profile_awards_json(actor),
    'unread_count', (
      select count(*)::integer
      from public.notifications n
      where n.recipient_id = actor and n.read_at is null
    ),
    'my_posts', coalesce((
      select jsonb_agg(to_jsonb(mp) order by mp.created_at desc)
      from (
        select *
        from public.posts
        where author_id = actor
          and state = 'active'
        order by created_at desc
        limit 100
      ) mp
    ), '[]'::jsonb),
    'watchlist', coalesce((
      select jsonb_agg(to_jsonb(w) order by w.updated_at desc)
      from public.watchlist_items w
      where w.user_id = actor
    ), '[]'::jsonb),
    'follows', jsonb_build_object(
      'users', coalesce((select jsonb_agg(target_id) from public.follows where follower_id = actor), '[]'::jsonb),
      'titles', coalesce((select jsonb_agg(title_id) from public.title_follows where user_id = actor), '[]'::jsonb),
      'people', coalesce((select jsonb_agg(person_id) from public.person_follows where user_id = actor), '[]'::jsonb),
      'collections', coalesce((select jsonb_agg(collection_id) from public.collection_follows where user_id = actor), '[]'::jsonb)
    ),
    'communities', coalesce((
      select jsonb_agg(cm.community_id)
      from public.community_members cm
      where cm.user_id = actor and cm.status = 'active'
    ), '[]'::jsonb),
    'saved_post_ids', coalesce((
      select jsonb_agg(s.post_id order by s.created_at desc)
      from public.saves s
      where s.user_id = actor
    ), '[]'::jsonb),
    'reactions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'post_id', r.post_id,
        'comment_id', r.comment_id,
        'kind', r.kind
      ))
      from public.reactions r
      where r.user_id = actor
    ), '[]'::jsonb),
    'collections', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'collection', to_jsonb(c),
          'owner', jsonb_build_object(
            'id', o.id,
            'handle', o.handle,
            'display_name', o.display_name,
            'avatar_path', o.avatar_path,
            'verified', o.verified,
            'verification_tier', o.verification_tier,
            'is_founder', o.is_founder,
            'worlds', o.worlds
          ),
          'items', coalesce((
            select jsonb_agg(to_jsonb(ci) order by ci.position asc, ci.added_at asc)
            from public.collection_items ci
            where ci.collection_id = c.id
          ), '[]'::jsonb)
        )
        order by (c.owner_id = actor) desc, c.updated_at desc, c.id asc
      )
      from (
        select c.*
        from public.collections c
        where c.owner_id = actor
           or c.visibility = 'public'
           or exists (
             select 1 from public.collection_follows cf
             where cf.collection_id = c.id and cf.user_id = actor
           )
        order by (c.owner_id = actor) desc, c.follower_count desc, c.updated_at desc, c.id asc
        limit 80
      ) c
      join public.profiles o on o.id = c.owner_id
    ), '[]'::jsonb),
    'blocks', coalesce((
      select jsonb_agg(b.blocked_id)
      from public.blocks b
      where b.blocker_id = actor
    ), '[]'::jsonb),
    'mutes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'muted_user_id', m.muted_user_id,
        'muted_title_id', m.muted_title_id
      ))
      from public.mutes m
      where user_id = actor
    ), '[]'::jsonb),
    'title_alerts', coalesce((
      select jsonb_agg(ta.title_id)
      from public.title_alerts ta
      where ta.user_id = actor
    ), '[]'::jsonb),
    'notifications', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'notification', to_jsonb(n),
          'actors', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', ap.id,
              'handle', ap.handle,
              'display_name', ap.display_name,
              'avatar_path', ap.avatar_path,
              'verified', ap.verified,
              'verification_tier', ap.verification_tier
            ))
            from public.profiles ap
            where ap.id = any(n.actor_ids)
          ), '[]'::jsonb)
        )
        order by n.created_at desc
      )
      from (
        select *
        from public.notifications
        where recipient_id = actor
          and scheduled_for <= now()
        order by created_at desc
        limit 60
      ) n
    ), '[]'::jsonb),
    'titles', coalesce((
      select jsonb_agg(to_jsonb(t))
      from public.titles t
      where t.id in (
        select w.title_id from public.watchlist_items w where w.user_id = actor
        union
        select tf.title_id from public.title_follows tf where user_id = actor
        union
        select unnest(me.favorite_title_ids)
        union
        select ci.title_id
        from public.collection_items ci
        join public.collections c on c.id = ci.collection_id
        where c.owner_id = actor or c.visibility = 'public'
        union
        select p.title_id
        from public.posts p
        where p.author_id = actor and p.state = 'active' and p.title_id is not null
        union
        select p.secondary_title_id
        from public.posts p
        where p.author_id = actor and p.state = 'active' and p.secondary_title_id is not null
      )
    ), '[]'::jsonb),
    'unread_notifications', (
      select count(*)
      from public.notifications
      where recipient_id = actor
        and read_at is null
        and scheduled_for <= now()
    )
  );
end;
$$;

grant execute on function public.get_bootstrap() to authenticated, service_role;

create or replace function public.get_profile_by_handle(p_handle text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  viewer uuid := auth.uid();
  target public.profiles%rowtype;
  following_them boolean := false;
  blocked_either boolean := false;
  viewer_blocked boolean := false;
  can_view boolean := false;
begin
  if p_handle is null or btrim(p_handle) = '' then
    return null;
  end if;

  select * into target
    from public.profiles
   where handle = lower(btrim(p_handle))
     and account_status = 'active';

  if target.id is null then
    return null;
  end if;

  if viewer is not null then
    following_them := exists (
      select 1 from public.follows f
      where f.follower_id = viewer and f.target_id = target.id
    );
    viewer_blocked := exists (
      select 1 from public.blocks b
      where b.blocker_id = viewer and b.blocked_id = target.id
    );
    blocked_either := viewer_blocked or exists (
      select 1 from public.blocks b
      where b.blocker_id = target.id and b.blocked_id = viewer
    );
  end if;

  can_view := not blocked_either and (
    not target.is_private
    or viewer = target.id
    or following_them
  );

  return jsonb_build_object(
    'profile', jsonb_build_object(
      'id', target.id,
      'handle', target.handle,
      'display_name', target.display_name,
      'bio', target.bio,
      'avatar_path', target.avatar_path,
      'banner_url', target.banner_url,
      'verified', target.verified,
      'verification_tier', target.verification_tier,
      'verification_note', target.verification_note,
      'verified_at', target.verified_at,
      'is_founder', target.is_founder,
      'featured_badge_ids', target.featured_badge_ids,
      'is_private', target.is_private,
      'role', target.role,
      'worlds', target.worlds,
      'favorite_genres', target.favorite_genres,
      'favorite_title_ids', target.favorite_title_ids,
      'follower_count', target.follower_count,
      'following_count', target.following_count,
      'post_count', target.post_count,
      'created_at', target.created_at
    ),
    'awards', case when not blocked_either then public.profile_awards_json(target.id) else '[]'::jsonb end,
    'is_following', following_them,
    'is_blocked', viewer_blocked,
    'can_view', can_view,
    'completed_count', case
      when can_view then (
        select count(*) from public.watchlist_items w
        where w.user_id = target.id and w.status = 'completed'
      )
      else 0
    end,
    'watching', case
      when can_view then coalesce((
        select jsonb_agg(jsonb_build_object('item', to_jsonb(w), 'title', to_jsonb(t)) order by w.updated_at desc)
        from public.watchlist_items w
        join public.titles t on t.id = w.title_id
        where w.user_id = target.id and w.status = 'watching'
      ), '[]'::jsonb)
      else '[]'::jsonb
    end,
    'favorites', case
      when can_view then coalesce((
        select jsonb_agg(to_jsonb(t))
        from public.titles t
        where t.id = any(target.favorite_title_ids)
      ), '[]'::jsonb)
      else '[]'::jsonb
    end,
    'collections', case
      when can_view then coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'collection', to_jsonb(c),
            'items', coalesce((
              select jsonb_agg(to_jsonb(ci) order by ci.position asc, ci.added_at asc)
              from public.collection_items ci
              where ci.collection_id = c.id
            ), '[]'::jsonb)
          )
          order by c.updated_at desc, c.id asc
        )
        from public.collections c
        where c.owner_id = target.id
          and (c.visibility = 'public' or viewer = target.id)
      ), '[]'::jsonb)
      else '[]'::jsonb
    end,
    'posts', case
      when can_view then coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'post', to_jsonb(p),
            'media', coalesce((
              select jsonb_agg(to_jsonb(pm) order by pm.position asc)
              from public.post_media pm
              where pm.post_id = p.id
            ), '[]'::jsonb),
            'title', (select to_jsonb(t1) from public.titles t1 where t1.id = p.title_id),
            'secondary_title', (select to_jsonb(t2) from public.titles t2 where t2.id = p.secondary_title_id)
          )
          order by p.created_at desc, p.id asc
        )
        from (
          select p.*
          from public.posts p
          where p.author_id = target.id
            and p.state = 'active'
            and (p.visibility = 'public' or viewer = target.id or following_them)
          order by p.created_at desc, p.id asc
          limit 40
        ) p
      ), '[]'::jsonb)
      else '[]'::jsonb
    end
  );
end;
$$;

grant execute on function public.get_profile_by_handle(text) to anon, authenticated, service_role;

create or replace function public.list_conversations(p_limit integer default 40)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select auth.uid() as uid
  ),
  latest as (
    select distinct on (
      case when dm.sender_id = (select uid from me) then dm.recipient_id else dm.sender_id end
    )
      case when dm.sender_id = (select uid from me) then dm.recipient_id else dm.sender_id end as peer_id,
      dm.id,
      dm.sender_id,
      dm.body,
      dm.shared_drama_id,
      dm.shared_post_id,
      dm.read_at,
      dm.created_at
    from public.direct_messages dm
    where dm.sender_id = (select uid from me)
       or dm.recipient_id = (select uid from me)
    order by
      case when dm.sender_id = (select uid from me) then dm.recipient_id else dm.sender_id end,
      dm.created_at desc
  ),
  unread as (
    select dm.sender_id as peer_id, count(*)::integer as unread_count
    from public.direct_messages dm
    where dm.recipient_id = (select uid from me)
      and dm.read_at is null
    group by dm.sender_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'peer_id', p.id,
        'handle', p.handle,
        'display_name', p.display_name,
        'avatar_path', p.avatar_path,
        'verified', p.verified,
        'verification_tier', p.verification_tier,
        'last_message_id', l.id,
        'last_sender_id', l.sender_id,
        'last_body', l.body,
        'shared_drama_id', l.shared_drama_id,
        'shared_post_id', l.shared_post_id,
        'last_at', l.created_at,
        'unread_count', coalesce(u.unread_count, 0)
      )
      order by l.created_at desc
    ),
    '[]'::jsonb
  )
  from latest l
  join public.profiles p on p.id = l.peer_id
  left join unread u on u.peer_id = l.peer_id
  where p.account_status = 'active'
  limit least(greatest(coalesce(p_limit, 40), 1), 100);
$$;

grant execute on function public.list_conversations(integer) to authenticated;

create or replace function public.get_post_thread(
  p_post_id uuid,
  p_comment_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  viewer uuid := auth.uid();
  p public.posts%rowtype;
  a public.profiles%rowtype;
  capped integer := least(greatest(coalesce(p_comment_limit, 100), 1), 200);
begin
  if p_post_id is null then
    return null;
  end if;

  select * into p
    from public.posts
   where id = p_post_id
     and state = 'active';

  if p.id is null then
    return null;
  end if;

  select * into a from public.profiles where id = p.author_id;

  if viewer is not null and exists (
    select 1 from public.blocks b
    where (b.blocker_id = viewer and b.blocked_id = p.author_id)
       or (b.blocker_id = p.author_id and b.blocked_id = viewer)
  ) then
    return null;
  end if;

  if (a.is_private or p.visibility = 'private')
     and (viewer is null or (
       viewer <> p.author_id
       and not exists (
         select 1 from public.follows f
         where f.follower_id = viewer and f.target_id = p.author_id
       )
     )) then
    return null;
  end if;

  return jsonb_build_object(
    'post', to_jsonb(p),
    'author', jsonb_build_object(
      'id', a.id,
      'handle', a.handle,
      'display_name', a.display_name,
      'bio', a.bio,
      'avatar_path', a.avatar_path,
      'banner_url', a.banner_url,
      'verified', a.verified,
      'verification_tier', a.verification_tier,
      'is_founder', a.is_founder,
      'featured_badge_ids', a.featured_badge_ids,
      'is_private', a.is_private,
      'role', a.role,
      'worlds', a.worlds,
      'favorite_genres', a.favorite_genres,
      'favorite_title_ids', a.favorite_title_ids,
      'follower_count', a.follower_count,
      'following_count', a.following_count
    ),
    'media', coalesce((
      select jsonb_agg(to_jsonb(pm) order by pm.position asc)
      from public.post_media pm
      where pm.post_id = p.id
    ), '[]'::jsonb),
    'title', (select to_jsonb(t1) from public.titles t1 where t1.id = p.title_id),
    'secondary_title', (select to_jsonb(t2) from public.titles t2 where t2.id = p.secondary_title_id),
    'viewer_reaction', case
      when viewer is null then null
      else (select r.kind::text from public.reactions r where r.user_id = viewer and r.post_id = p.id limit 1)
    end,
    'viewer_saved', case
      when viewer is null then false
      else exists (select 1 from public.saves s where s.user_id = viewer and s.post_id = p.id)
    end,
    'comments', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'comment', to_jsonb(c),
          'author', jsonb_build_object(
            'id', ca.id,
            'handle', ca.handle,
            'display_name', ca.display_name,
            'avatar_path', ca.avatar_path,
            'banner_url', ca.banner_url,
            'verified', ca.verified,
            'verification_tier', ca.verification_tier,
            'is_founder', ca.is_founder,
            'featured_badge_ids', ca.featured_badge_ids,
            'role', ca.role,
            'worlds', ca.worlds
          ),
          'viewer_reaction', case
            when viewer is null then null
            else (select cr.kind::text from public.reactions cr where cr.user_id = viewer and cr.comment_id = c.id limit 1)
          end
        )
        order by c.created_at asc, c.id asc
      )
      from (
        select c.*
        from public.comments c
        where c.post_id = p.id
          and c.state = 'active'
          and (viewer is null or not exists (
            select 1 from public.blocks b
            where (b.blocker_id = viewer and b.blocked_id = c.author_id)
               or (b.blocker_id = c.author_id and b.blocked_id = viewer)
          ))
        order by c.created_at asc, c.id asc
        limit capped
      ) c
      join public.profiles ca on ca.id = c.author_id
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.get_post_thread(uuid, integer) to anon, authenticated, service_role;

create or replace function public.get_community_pulse(
  p_world text default null,
  p_limit integer default 12
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  viewer uuid := auth.uid();
  capped integer := least(greatest(coalesce(p_limit, 12), 1), 30);
begin
  return jsonb_build_object(
    'communities', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'community', to_jsonb(c),
          'is_member', case
            when viewer is null then false
            else exists (
              select 1 from public.community_members cm
              where cm.community_id = c.id and cm.user_id = viewer and cm.status = 'active'
            )
          end
        )
        order by c.member_count desc, c.post_count desc, c.id asc
      )
      from (
        select c.*
        from public.communities c
        where (p_world is null or c.fandom = p_world)
        order by c.member_count desc, c.post_count desc, c.id asc
        limit 24
      ) c
    ), '[]'::jsonb),
    'most_discussed', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'title', to_jsonb(d.t),
          'post_count', d.post_count,
          'watchlist_count', d.watchlist_count
        )
        order by d.score desc, (d.t).id asc
      )
      from (
        select
          t,
          pc.cnt as post_count,
          wc.cnt as watchlist_count,
          (coalesce(pc.cnt, 0) * 12 + coalesce(wc.cnt, 0) * 5 + coalesce(t.follower_count, 0) * 3 + public.catalog_relevance_score(t)) as score
        from public.titles t
        left join lateral (
          select count(*)::integer as cnt
          from public.posts p
          join public.profiles pr on pr.id = p.author_id
          where p.title_id = t.id
            and p.state = 'active'
            and p.visibility = 'public'
            and pr.account_status = 'active'
            and not pr.is_private
        ) pc on true
        left join lateral (
          select count(*)::integer as cnt
          from public.watchlist_items w
          where w.title_id = t.id
        ) wc on true
        where public.catalog_lifecycle_of(t) <> 'unavailable'
          and (p_world is null or t.world = p_world)
        order by score desc, t.id asc
        limit capped
      ) d
    ), '[]'::jsonb),
    'rising_tags', coalesce((
      select jsonb_agg(
        jsonb_build_object('tag', rt.tag, 'post_count', rt.post_count)
        order by rt.post_count desc, rt.tag asc
      )
      from (
        select lower(btrim(tag_raw)) as tag, count(*)::integer as post_count
        from public.posts p
        join public.profiles pr on pr.id = p.author_id,
             lateral unnest(p.hashtags) as tag_raw
        where p.state = 'active'
          and p.visibility = 'public'
          and pr.account_status = 'active'
          and not pr.is_private
          and (p_world is null or p.world = p_world)
          and length(btrim(tag_raw)) > 0
        group by lower(btrim(tag_raw))
        order by count(*) desc, lower(btrim(tag_raw)) asc
        limit capped
      ) rt
    ), '[]'::jsonb),
    'top_voices', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', v.id,
          'handle', v.handle,
          'display_name', v.display_name,
          'bio', v.bio,
          'avatar_path', v.avatar_path,
          'banner_url', v.banner_url,
          'verified', v.verified,
          'verification_tier', v.verification_tier,
          'is_founder', v.is_founder,
          'featured_badge_ids', v.featured_badge_ids,
          'role', v.role,
          'worlds', v.worlds,
          'favorite_genres', v.favorite_genres,
          'favorite_title_ids', v.favorite_title_ids,
          'follower_count', v.follower_count,
          'following_count', v.following_count,
          'post_count', v.post_count
        )
        order by v.follower_count desc, v.post_count desc, v.id asc
      )
      from (
        select pr.*
        from public.profiles pr
        where pr.account_status = 'active'
          and not pr.is_private
          and pr.handle not like 'verify_%'
          and (p_world is null or p_world = any(pr.worlds))
          and (viewer is null or not exists (
            select 1 from public.blocks b
            where (b.blocker_id = viewer and b.blocked_id = pr.id)
               or (b.blocker_id = pr.id and b.blocked_id = viewer)
          ))
        order by pr.follower_count desc, pr.post_count desc, pr.id asc
        limit capped
      ) v
    ), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.get_community_pulse(text, integer) to anon, authenticated, service_role;


