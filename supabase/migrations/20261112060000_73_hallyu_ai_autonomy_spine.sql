-- Hallyu AI operator — the autonomy spine.
--
-- The operator could answer questions but could not *do* anything on its own: the live scheduler
-- function calls `action: "schedule.run_due"`, and the operator did not implement it, so nothing
-- ever ran. Publishing had a real primitive (`hallyu_ai_publish` → real `posts`/`comments`/
-- `post_polls` rows authored by the official Hallyu AI profile) but no schedule ever invoked it.
--
-- This migration makes the backend whole and keeps the repo in step with the live project:
--   * the official AI author identity (`hallyu_ai_profile_id`)
--   * the publication ledger, so "attempted" and "actually published" never get confused
--   * the schedule columns the claim function already reads (`prompt`, `next_run_at`, `last_task_id`)
--   * two read-only reporting RPCs the operator uses to report real numbers
--   * the operating schedule itself, seeded idempotently
--
-- Everything here is service-role only. Members never touch these tables; the operator mediates
-- every read/write as service_role after verifying the caller (see hallyu_ai_caller_profile).

set check_function_bodies = off;

-- ── the official Hallyu AI author ─────────────────────────────────────────────────────────────
-- Posts published autonomously are authored by the `hallyu.ai` profile (profiles.is_ai = true),
-- never by a staff member. That profile has no auth_sub: nobody signs in as the AI.

do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'hallyu_ai_profile_id'
  ) then
    create function public.hallyu_ai_profile_id()
    returns uuid
    language sql
    stable
    security definer
    set search_path = public, pg_temp
    as $fn$
      select p.id
        from public.profiles p
       where p.is_ai
         and p.account_status = 'active'
         and p.deleted_at is null
       order by p.created_at
       limit 1;
    $fn$;
  end if;
end
$$;

comment on function public.hallyu_ai_profile_id() is
  'The official Hallyu AI author profile (profiles.is_ai, active). Autonomous publications are attributed to it; there is no login for it.';

revoke all on function public.hallyu_ai_profile_id() from public, anon, authenticated;
grant execute on function public.hallyu_ai_profile_id() to service_role;

-- ── publication ledger ────────────────────────────────────────────────────────────────────────
-- One row per intended publication, keyed by (task_id, action) so a retried task can never create
-- a duplicate post. `status` is only 'published' after the row in posts/comments exists, and
-- `target_id` points at the real row, which is how "verified" is proved.

create table if not exists public.hallyu_ai_publication (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  action text not null,
  title text,
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  status text not null default 'pending',
  target_id uuid,
  error text,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (task_id, action)
);

-- The ledger has existed in more than one shape: migration 72 models it as kind/content/parent_id,
-- while the live operator's publish path records action/body/payload/sources/status. Both are
-- legitimate columns of the same ledger, so the table carries the union and neither path breaks.
alter table public.hallyu_ai_publication add column if not exists action text;
alter table public.hallyu_ai_publication add column if not exists title text;
alter table public.hallyu_ai_publication add column if not exists body text;
alter table public.hallyu_ai_publication add column if not exists payload jsonb;
alter table public.hallyu_ai_publication add column if not exists sources jsonb;
alter table public.hallyu_ai_publication add column if not exists status text;
alter table public.hallyu_ai_publication add column if not exists error text;
alter table public.hallyu_ai_publication add column if not exists published_at timestamptz;

alter table public.hallyu_ai_publication enable row level security;
revoke all on public.hallyu_ai_publication from anon, authenticated;

-- ── schedule columns the claim function already expects ──────────────────────────────────────

alter table public.hallyu_ai_schedule add column if not exists prompt text;
alter table public.hallyu_ai_schedule add column if not exists next_run_at timestamptz;
alter table public.hallyu_ai_schedule add column if not exists last_task_id uuid;

update public.hallyu_ai_schedule
   set prompt = 'Review the live platform and report evidence-based findings.'
 where prompt is null;

alter table public.hallyu_ai_schedule alter column prompt set not null;

create index if not exists hallyu_ai_schedule_due_idx
  on public.hallyu_ai_schedule (coalesce(next_run_at, created_at))
  where enabled;

create index if not exists hallyu_ai_publication_task_idx
  on public.hallyu_ai_publication (task_id, action);

create index if not exists hallyu_ai_publication_published_idx
  on public.hallyu_ai_publication (published_at desc);

-- ── reporting RPCs (real numbers, no fabrication) ────────────────────────────────────────────

create or replace function public.hallyu_ai_analytics()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with bounds as (
    select now() as at, now() - interval '7 days' as prior
  )
  select jsonb_build_object(
    'measured_at', b.at,
    'profiles', jsonb_build_object(
      'active', (select count(*) from public.profiles p where p.account_status = 'active' and p.deleted_at is null),
      'joined_7d', (select count(*) from public.profiles p where p.created_at >= b.prior),
      'joined_prior_7d', (select count(*) from public.profiles p where p.created_at >= b.prior - interval '7 days' and p.created_at < b.prior),
      'onboarding_complete', (select count(*) from public.profiles p where p.account_status = 'active' and p.onboarding_completed)
    ),
    'content', jsonb_build_object(
      'posts_live', (select count(*) from public.posts p where p.state = 'active' and p.visibility = 'public' and p.deleted_at is null),
      'posts_7d', (select count(*) from public.posts p where p.created_at >= b.prior and p.deleted_at is null),
      'posts_prior_7d', (select count(*) from public.posts p where p.created_at >= b.prior - interval '7 days' and p.created_at < b.prior and p.deleted_at is null),
      'comments_7d', (select count(*) from public.comments c where c.created_at >= b.prior and c.state = 'active'),
      'reactions_7d', (select count(*) from public.reactions r where r.created_at >= b.prior),
      'polls_live', (select count(*) from public.post_polls pp where pp.closes_at is null or pp.closes_at > b.at)
    ),
    'ai', jsonb_build_object(
      'authors', (select count(*) from public.profiles p where p.is_ai),
      'published_total', (select count(*) from public.hallyu_ai_publication pub where pub.status = 'published'),
      'published_7d', (select count(*) from public.hallyu_ai_publication pub where pub.status = 'published' and pub.published_at >= b.prior),
      'failed_7d', (select count(*) from public.hallyu_ai_publication pub where pub.status = 'failed' and pub.created_at >= b.prior),
      'tasks_7d', (select count(*) from public.hallyu_ai_task t where t.created_at >= b.prior),
      'tasks_failed_7d', (select count(*) from public.hallyu_ai_task t where t.created_at >= b.prior and t.status = 'failed')
    ),
    'engagement', jsonb_build_object(
      'reactions_per_post', (
        select case when count(distinct p.id) = 0 then 0
                    else round((count(r.id)::numeric / count(distinct p.id)), 2) end
          from public.posts p
          left join public.reactions r on r.post_id = p.id
         where p.created_at >= b.prior and p.deleted_at is null
      )
    )
  )
  from bounds b;
$$;

comment on function public.hallyu_ai_analytics() is
  'Real, current platform measurements for the AI operator and staff reporting. Every figure is a count over live rows with the period it covers; nothing is estimated.';

revoke all on function public.hallyu_ai_analytics() from public, anon;
grant execute on function public.hallyu_ai_analytics() to authenticated, service_role;

create or replace function public.hallyu_ai_publication_summary()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'today_utc', to_char(now() at time zone 'utc', 'YYYY-MM-DD'),
    'published_today', (
      select count(*) from public.hallyu_ai_publication pub
       where pub.status = 'published' and pub.published_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
    ),
    'target_today', 3,
    'pending', (select count(*) from public.hallyu_ai_publication pub where pub.status = 'pending'),
    'failed', (select count(*) from public.hallyu_ai_publication pub where pub.status = 'failed'),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
               'action', pub.action,
               'status', pub.status,
               'target_id', pub.target_id,
               'at', pub.published_at,
               'error', pub.error
             ) order by pub.created_at desc)
        from (select * from public.hallyu_ai_publication order by created_at desc limit 10) pub
    ), '[]'::jsonb)
  );
$$;

comment on function public.hallyu_ai_publication_summary() is
  'How many publications were actually published today against the three-per-day target, plus the last ten attempts and their real outcome.';

revoke all on function public.hallyu_ai_publication_summary() from public, anon;
grant execute on function public.hallyu_ai_publication_summary() to authenticated, service_role;

-- ── the owner ───────────────────────────────────────────────────────────────────────────────
-- The operator reports to the CEO profile, resolved server-side. Never to an address supplied by
-- the caller, and never to a hard-coded id.

create or replace function public.hallyu_ai_owner_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id
    from public.profiles p
   where p.role = 'ceo'
     and p.account_status = 'active'
     and p.deleted_at is null
   order by p.created_at
   limit 1;
$$;

comment on function public.hallyu_ai_owner_id() is
  'The Hallyu owner (CEO) profile the AI reports to. Resolved server-side so a caller can never redirect a report.';

revoke all on function public.hallyu_ai_owner_id() from public, anon;
grant execute on function public.hallyu_ai_owner_id() to service_role;

-- ── the operating schedule ───────────────────────────────────────────────────────────────────
-- Seeded idempotently by name. Intervals are minutes; `hallyu_ai_claim_due_schedules` claims due
-- rows (SKIP LOCKED) and pushes next_run_at forward, so a slow or failed run is retried next tick
-- and two workers can never run the same schedule twice.

create or replace function public.hallyu_ai_seed_schedules()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  seeded integer := 0;
  entry record;
begin
  for entry in
    select * from (values
      ('Daily platform intelligence', 'daily_intelligence', 1440,
       'Inspect the real platform: call platform_overview and analytics_snapshot. Report member growth, content volume, engagement and any failing operation. Use only the numbers the tools return, name the period each covers, and say plainly when something cannot be measured. Do not publish and do not notify members.'),
      ('Entertainment intelligence', 'entertainment_research', 720,
       'Review the real Hallyu catalogue with catalog_digest. Summarise which titles and worlds are actually present and discussion-worthy. Catalogue metadata is not breaking news: never present it as new reporting, and never invent release dates or announcements.'),
      ('Community opportunities', 'community_pulse', 360,
       'Read community_pulse for posts and comments. Identify unanswered questions, quiet discussions worth reviving and anything needing moderation. Then publish one useful reply or discussion using reply_comment or publish_post when you have real evidence for it; otherwise record what you found with remember and report it.'),
      ('Daily content publishing', 'content_publishing', 240,
       'Publish quality Hallyu content. First call publishing_status to see how many items were really published today (target: three). If fewer than three, ground yourself in real data with catalog_digest and community_pulse, then publish one item: an entertainment discussion (publish_post), a poll (create_poll), or a reply to a real unanswered post (reply_comment). Write original text about real titles in the catalogue, never fabricate news, sources or quotes. After publishing, call publishing_status again to confirm the row exists.'),
      ('Mention replies', 'mention_replies', 30,
       'Answer any member who addressed @hallyu.ai in a real comment. Read the actual comment and its post first, reply only when you genuinely have something useful and accurate to say, and never claim an issue is fixed without verifying it.'),
      ('Growth watch', 'growth_watch', 10080,
       'Review analytics_snapshot over the last week. Identify the single most credible growth opportunity supported by the numbers, and record it with remember as a recommendation for the owner. Do not invent audience or revenue figures.')
    ) as t(name, kind, interval_minutes, prompt)
  loop
    insert into public.hallyu_ai_schedule (name, kind, interval_minutes, enabled, prompt, next_run_at)
    values (entry.name, entry.kind, entry.interval_minutes, true, entry.prompt, now())
    on conflict (name) do update
      set kind = excluded.kind,
          interval_minutes = excluded.interval_minutes,
          prompt = excluded.prompt,
          enabled = true,
          next_run_at = coalesce(public.hallyu_ai_schedule.next_run_at, now());
    seeded := seeded + 1;
  end loop;

  return seeded;
end;
$$;

revoke all on function public.hallyu_ai_seed_schedules() from public, anon, authenticated;
grant execute on function public.hallyu_ai_seed_schedules() to service_role;

select public.hallyu_ai_seed_schedules();
