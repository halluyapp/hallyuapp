-- Hallyu backend — 37 storage removal through the Storage API, and privileged-column guards.
--
-- Two defects, both found by replaying the live behaviour suite against the Rork Cloud project.
--
--   1. Supabase installs `storage.protect_delete()`, a BEFORE DELETE trigger on `storage.objects` and
--      `storage.buckets` that refuses *every* direct DELETE, for every role, with "Direct deletion
--      from storage tables is not allowed. Use the Storage API instead." Migrations 20, 22, 30 and 36
--      all removed bytes with `delete from storage.objects`, so each of them failed at the only
--      moment it mattered: `delete_account()` could not delete an account at all, and the media
--      sweeper could not remove an orphan or a failed upload. Nothing about the schema was wrong —
--      the division of labour was. SQL decides *what* disappears; the Storage API performs the
--      removal, because it is the only writer that is allowed to.
--
--      This migration introduces the durable queue between those two halves: SQL records a path, the
--      Edge Function drains the queue through the Storage API. A queue rather than a returned array,
--      because `purge_deleted_accounts()` hard-deletes the profile rows in the same transaction that
--      identifies the paths — after that commit nothing in the database can rediscover them.
--
--   2. `profiles_update_self` guarded `id` and `account_status`, so it looked closed, but a policy
--      cannot compare the incoming row with the stored one. `update { role: 'admin', verified: true }`
--      on your own profile passed both the USING and the WITH CHECK clause and made you an admin.
--      Column-level privileges would have to be granted per column and revoked from a SECURITY
--      DEFINER function, which breaks every legitimate self-service update; the comparison a policy
--      cannot do is exactly what a trigger is for.

-- ---------------------------------------------------------------------------------------------
-- 1. The removal queue
-- ---------------------------------------------------------------------------------------------

-- `failed_upload` the client reported the upload failed; `orphaned` nothing references the object any
-- more; `stale_catalog` catalog artwork outside the refresh window; `account_deleted` delete_account();
-- `retention_purge` purge_deleted_accounts(), after the retention window.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create type public.media_removal_reason as enum (
  'failed_upload',
  'orphaned',
  'stale_catalog',
  'account_deleted',
  'retention_purge'
);

create table if not exists public.media_removal_queue (
  path         text primary key,
  reason       public.media_removal_reason not null,
  requested_by uuid        references public.profiles (id) on delete set null,
  attempts     integer     not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  constraint media_removal_queue_path_not_blank check (length(btrim(path)) > 0),
  constraint media_removal_queue_attempts_sane check (attempts >= 0)
);

comment on table public.media_removal_queue is 'Objects the database has decided to delete. Drained through the Storage API by media-cleanup and purge-deleted-accounts; no client ever reads or writes this.';
comment on column public.media_removal_queue.path is 'Object path inside the `media` bucket. The primary key, so queueing the same object twice is a no-op rather than a duplicate.';
comment on column public.media_removal_queue.requested_by is 'Who asked for the removal, when it was a member rather than a sweep. Cleared by the retention purge.';

create index if not exists media_removal_queue_oldest_idx on public.media_removal_queue (created_at);

alter table public.media_removal_queue enable row level security;

-- Service-role only, deliberately with no authenticated policy: no client has any business here, and
-- the Storage API calls that empty it are the only reader.
create policy media_removal_queue_service_only on public.media_removal_queue
  for all to service_role using (true) with check (true);

grant select, insert, update, delete on public.media_removal_queue to service_role;

-- Records paths for removal. Idempotent: a path already queued keeps its original reason, because
-- the first decision is the one with context.
create or replace function public.queue_media_removal(
  p_paths text[],
  p_reason public.media_removal_reason,
  p_requested_by uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  queued integer := 0;
begin
  if auth.uid() is not null and p_requested_by is distinct from auth.uid() and not public.is_moderator() then
    raise exception 'a member may only queue their own media' using errcode = 'insufficient_privilege';
  end if;

  if p_paths is null or array_length(p_paths, 1) is null then
    return 0;
  end if;

  insert into public.media_removal_queue (path, reason, requested_by)
  select distinct path, p_reason, p_requested_by
  from unnest(p_paths) as path
  where path is not null and length(btrim(path)) > 0
  on conflict (path) do nothing;

  get diagnostics queued = row_count;

  return queued;
end;
$$;

revoke all on function public.queue_media_removal(text[], public.media_removal_reason, uuid)
  from public, anon, authenticated;
grant execute on function public.queue_media_removal(text[], public.media_removal_reason, uuid) to service_role;

-- Hands a batch to the caller that is about to call the Storage API, oldest first, and counts the
-- attempt so a path that cannot be removed is visible rather than retried forever in silence.
create or replace function public.claim_media_removals(p_limit integer default 100)
returns table (path text, reason public.media_removal_reason, attempts integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  per_page integer := least(greatest(coalesce(p_limit, 100), 1), 1000);
begin
  if auth.uid() is not null then
    raise exception 'media removal is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  return query
  update public.media_removal_queue q
     set attempts = q.attempts + 1
   where q.path in (
     select q2.path from public.media_removal_queue q2 order by q2.created_at asc limit per_page
   )
  returning q.path, q.reason, q.attempts;
end;
$$;

revoke all on function public.claim_media_removals(integer) from public, anon, authenticated;
grant execute on function public.claim_media_removals(integer) to service_role;

-- The two outcomes of a Storage API call: the object is gone (drop the row) or it refused (keep the
-- row with the error, so the next run retries and the report is honest).
create or replace function public.complete_media_removals(p_paths text[], p_error text default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  settled integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'media removal is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  if p_paths is null or array_length(p_paths, 1) is null then
    return 0;
  end if;

  if p_error is null then
    delete from public.media_removal_queue where path = any(p_paths);
  else
    update public.media_removal_queue set last_error = left(p_error, 500) where path = any(p_paths);
  end if;

  get diagnostics settled = row_count;

  return settled;
end;
$$;

revoke all on function public.complete_media_removals(text[], text) from public, anon, authenticated;
grant execute on function public.complete_media_removals(text[], text) to service_role;

comment on function public.queue_media_removal(text[], public.media_removal_reason, uuid) is
  'Records objects for deletion. The removal itself happens through the Storage API, which is the only writer storage.protect_delete() allows.';
comment on function public.claim_media_removals(integer) is 'Service-role only: a batch of paths to remove through the Storage API.';
comment on function public.complete_media_removals(text[], text) is 'Service-role only: drops the paths that are gone, or records why they are still there.';

-- ---------------------------------------------------------------------------------------------
-- 2. The callers, rewritten to queue instead of delete
-- ---------------------------------------------------------------------------------------------

-- A failed upload: the row is marked failed and the object is queued. The client that uploaded it
-- also knows the path and removes it through its own Storage API connection — the storage policy
-- allows the owner — so the queue is the guarantee, not the latency: nothing can leak even if the
-- client dies before it cleans up.
create or replace function public.fail_media_upload(p_upload_id uuid, p_error text default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  failed_path text;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  update public.media_uploads
     set state = 'failed',
         error = left(p_error, 300)
   where id = p_upload_id and user_id = actor and state <> 'attached'
  returning storage_path into failed_path;

  if found and failed_path is not null then
    perform public.queue_media_removal(array[failed_path], 'failed_upload', actor);
  end if;

  return found;
end;
$$;

revoke all on function public.fail_media_upload(uuid, text) from public, anon, authenticated;
grant execute on function public.fail_media_upload(uuid, text) to authenticated;

-- The sweeper's second half. `avatars/` and `catalog/` are managed by the ingest job; `u/<id>/…`
-- is member content with a retention window. Objects are queued, not deleted — see the header.
--
-- `drop function` first: the RETURNS TABLE shape changes, and PostgreSQL will not redefine a
-- function whose row type has changed. The grants below are re-issued for the same reason.
drop function if exists public.media_remove_orphans(interval, interval);

create or replace function public.media_remove_orphans(
  p_older_than interval default interval '7 days',
  p_user_older_than interval default interval '30 days'
)
returns table (objects_queued integer, uploads_purged integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  queued integer := 0;
  purged integer := 0;
  catalog_queued integer := 0;
  candidate_paths text[];
begin
  if auth.uid() is not null then
    raise exception 'media reconciliation is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  -- Member objects nothing references any more, old enough that a late attachment is implausible.
  select coalesce(array_agg(o.name), '{}') into candidate_paths
  from storage.objects o
  where o.bucket_id = 'media'
    and public.storage_owner(o.name) is not null
    and o.created_at < now() - p_user_older_than
    and not exists (select 1 from public.post_media m where m.storage_path = o.name or m.poster_path = o.name)
    and not exists (select 1 from public.profiles p where p.avatar_path = o.name)
    and not exists (select 1 from public.media_uploads u where u.storage_path = o.name and u.state <> 'orphaned');

  queued := public.queue_media_removal(candidate_paths, 'orphaned', null);

  -- Catalog artwork is retained unless it is older than twice the refresh window and unreferenced:
  -- the ingest job re-creates what it still needs, and a stale poster is never shown.
  select coalesce(array_agg(o.name), '{}') into candidate_paths
  from storage.objects o
  where o.bucket_id = 'media'
    and o.name like 'catalog/%'
    and o.created_at < now() - p_older_than
    and not exists (
      select 1 from public.titles t
      where t.poster_url like '%' || o.name || '%' or t.backdrop_url like '%' || o.name || '%'
    )
    and not exists (select 1 from public.post_media m where m.storage_path = o.name or m.poster_path = o.name);

  catalog_queued := public.queue_media_removal(candidate_paths, 'stale_catalog', null);
  queued := queued + catalog_queued;

  -- Finally the bookkeeping rows for uploads whose object no longer exists.
  delete from public.media_uploads u
   where u.state in ('failed', 'orphaned')
     and u.updated_at < now() - interval '7 days'
     and not exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = u.storage_path);

  get diagnostics purged = row_count;

  return query select queued, purged;
end;
$$;

revoke all on function public.media_remove_orphans(interval, interval) from public, anon, authenticated;
grant execute on function public.media_remove_orphans(interval, interval) to service_role;

-- The scheduled job. Every number it returns is auditable afterwards: `broken_rows_removed` and
-- `upload_rows_purged` are rows the database removed, `orphan_objects_queued` is objects the Storage
-- API still has to delete. The Edge Function reports how many of those actually went away.
create or replace function public.job_reconcile_media(
  p_user_retention interval default interval '30 days'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  dropped integer := 0;
  cleanup record;
begin
  dropped := public.media_drop_missing_objects();

  select * into cleanup from public.media_remove_orphans(interval '7 days', p_user_retention);

  return jsonb_build_object(
    'broken_rows_removed', dropped,
    'orphan_objects_queued', cleanup.objects_queued,
    'upload_rows_purged', cleanup.uploads_purged,
    'pending_expired', (select count(*) from public.media_uploads where state = 'orphaned'),
    'attached', (select count(*) from public.media_uploads where state = 'attached'),
    'queue_depth', (select count(*) from public.media_removal_queue)
  );
end;
$$;

revoke all on function public.job_reconcile_media(interval) from public, anon, authenticated;
grant execute on function public.job_reconcile_media(interval) to service_role;

-- Account deletion, unchanged in every respect except that the bytes are queued. The identity itself
-- is still scrubbed into an anonymous tombstone so replies and posts never dangle.
create or replace function public.delete_account()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  removed_paths text[] := '{}';
  removed_count integer := 0;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- Objects this member uploaded, plus the files attached to their posts, plus their avatar.
  select coalesce(array_agg(path), '{}') into removed_paths
  from (
    select m.storage_path as path
    from public.post_media m
    join public.posts p on p.id = m.post_id
    where p.author_id = actor
    union
    select m.poster_path
    from public.post_media m
    join public.posts p on p.id = m.post_id
    where p.author_id = actor and m.poster_path is not null
    union
    select u.storage_path
    from public.media_uploads u
    where u.user_id = actor
    union
    select u.poster_path
    from public.media_uploads u
    where u.user_id = actor and u.poster_path is not null
    union
    select avatar_path from public.profiles where id = actor and avatar_path is not null
    union
    select name from storage.objects where bucket_id = 'media' and public.storage_owner(name) = actor
  ) paths;

  removed_count := public.queue_media_removal(removed_paths, 'account_deleted', actor);

  -- Private and personal data: gone.
  delete from public.notifications where recipient_id = actor;
  delete from public.notification_deliveries d
    where not exists (select 1 from public.notifications n where n.id = d.notification_id);
  delete from public.push_tokens where user_id = actor;
  delete from public.title_alerts where user_id = actor;
  delete from public.watchlist_items where user_id = actor;
  delete from public.saves where user_id = actor;
  delete from public.reactions where user_id = actor;
  delete from public.community_members where user_id = actor;
  delete from public.collection_follows where user_id = actor;
  delete from public.person_follows where user_id = actor;
  delete from public.title_follows where user_id = actor;
  delete from public.follows where follower_id = actor or target_id = actor;
  delete from public.blocks where blocker_id = actor or blocked_id = actor;
  delete from public.mutes where user_id = actor or muted_user_id = actor;
  delete from public.reports where reporter_id = actor;
  delete from public.user_preferences where user_id = actor;
  delete from public.collections where owner_id = actor;
  delete from public.analytics_events where user_id = actor;

  -- Added by migrations 30 and 31. A tombstone is never deleted, so without these the member's
  -- upload records and share history would outlive the account that owns them.
  delete from public.media_uploads where user_id = actor;
  delete from public.post_shares where user_id = actor;

  -- Mentions in other people's posts would otherwise point at a scrubbed account.
  update public.posts set mentions = array_remove(mentions, actor) where actor = any(mentions);

  -- The identity itself: kept as an anonymous tombstone so replies and posts stay readable.
  update public.profiles
     set account_status = 'deleted',
         deleted_at = coalesce(deleted_at, now()),
         display_name = 'Deleted member',
         handle = 'deleted_' || substr(replace(actor::text, '-', ''), 1, 16),
         bio = null,
         avatar_path = null,
         worlds = '{}',
         favorite_genres = '{}',
         onboarding_genres = '{}',
         is_private = true
   where id = actor;

  return jsonb_build_object(
    'deleted', true,
    'media_objects_queued', removed_count,
    'deleted_at', now()
  );
end;
$$;

revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;

-- The retention purge hard-deletes the tombstone. The objects go through the queue rather than a
-- DELETE, because the profile rows that identify them stop existing in this very transaction.
drop function if exists public.purge_deleted_accounts(interval);

create or replace function public.purge_deleted_accounts(retention interval default interval '30 days')
returns table (profiles_purged integer, storage_objects_queued integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cutoff timestamptz := now() - retention;
  doomed uuid[];
  paths text[];
  queued integer := 0;
begin
  if auth.role() not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'retention purge is service-role only' using errcode = 'insufficient_privilege';
  end if;

  select coalesce(array_agg(p.id), '{}') into doomed
  from public.profiles p
  where p.account_status = 'deleted'
    and p.deleted_at is not null
    and p.deleted_at < cutoff;

  if array_length(doomed, 1) is null then
    return query select 0, 0;
    return;
  end if;

  select coalesce(array_agg(name), '{}') into paths
  from storage.objects
  where bucket_id = 'media' and public.storage_owner(name) = any(doomed);

  queued := public.queue_media_removal(paths, 'retention_purge', null);

  -- Cascades clear the member's posts, comments, reactions and everything else that points at them.
  -- The queue rows keep their paths; only the reference to the profile is cleared by the cascade.
  delete from public.profiles where id = any(doomed);

  return query select array_length(doomed, 1), queued;
end;
$$;

revoke all on function public.purge_deleted_accounts(interval) from public, anon, authenticated;
grant execute on function public.purge_deleted_accounts(interval) to service_role;

-- The dispatcher, with the media job reporting what it queued rather than what it deleted.
create or replace function public.run_scheduled_jobs(p_jobs text[] default null)
returns table (job text, status text, run_id uuid, items integer, error text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  entry text;
  run_key_value text;
  claim_row record;
  retention_row record;
  media_result jsonb;
  moderation_result jsonb;
  handled integer := 0;
  job_error text;
  outcome text;
begin
  if auth.uid() is not null then
    raise exception 'scheduled jobs are a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  perform public.job_release_stale();

  foreach entry in array coalesce(
    p_jobs,
    array[
      'catalog.status',
      'catalog.episode_schedule',
      'catalog.prune',
      'catalog.aggregates',
      'catalog.trending',
      'alerts.upcoming_episodes',
      'alerts.new_episodes',
      'alerts.title_updates',
      'notifications.fanout',
      'notifications.retention',
      'media.reconcile',
      'moderation.audit'
    ]
  ) loop
    run_key_value := to_char(date_trunc('hour', now()), 'YYYY-MM-DD') || 'T' || to_char(date_trunc('hour', now()), 'HH24');

    job_error := null;
    outcome := 'skipped';

    for claim_row in select * from public.job_claim(entry, run_key_value) loop
      if claim_row.did_claim then
        begin
          case entry
            when 'catalog.status' then
              handled := public.job_reconcile_catalog_status();
            when 'catalog.episode_schedule' then
              handled := public.job_reconcile_episode_schedule();
            when 'catalog.prune' then
              handled := (select coalesce(titles_parked, 0) + coalesce(titles_available, 0) from public.job_prune_stale_catalog());
            when 'catalog.aggregates' then
              handled := public.job_recompute_community_post_counts();
            when 'catalog.trending' then
              handled := public.refresh_trending(null);
            when 'alerts.upcoming_episodes' then
              handled := public.job_queue_upcoming_episodes();
            when 'alerts.new_episodes' then
              handled := public.job_queue_new_episodes();
            when 'alerts.title_updates' then
              handled := public.job_queue_title_updates();
            when 'notifications.fanout' then
              handled := public.fanout_due_notifications();
            when 'notifications.retention' then
              select * into retention_row from public.job_expire_notifications();
              handled := coalesce(retention_row.notifications_removed, 0)
                       + coalesce(retention_row.deliveries_removed, 0)
                       + coalesce(retention_row.read_removed, 0);
            when 'media.reconcile' then
              media_result := public.job_reconcile_media();
              handled := coalesce((media_result ->> 'orphan_objects_queued')::integer, 0)
                       + coalesce((media_result ->> 'broken_rows_removed')::integer, 0)
                       + coalesce((media_result ->> 'upload_rows_purged')::integer, 0);
            when 'moderation.audit' then
              moderation_result := public.job_reconcile_moderation();
              handled := coalesce((moderation_result ->> 'accounts_reinstated')::integer, 0)
                       + coalesce((moderation_result ->> 'orphan_reports_dismissed')::integer, 0);
            else
              raise exception 'unknown job %', entry using errcode = 'invalid_parameter_value';
          end case;
          outcome := 'succeeded';
        exception when others then
          job_error := left(sqlerrm, 500);
          outcome := 'failed';
        end;

        perform public.job_complete(claim_row.id, outcome, handled, job_error);

        return query select entry, outcome, claim_row.id, handled, job_error;
      end if;
    end loop;
  end loop;

  return;
end;
$$;

revoke all on function public.run_scheduled_jobs(text[]) from public, anon, authenticated;
grant execute on function public.run_scheduled_jobs(text[]) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. A member cannot change their own privileges
-- ---------------------------------------------------------------------------------------------

-- The three columns that decide what a member may do, plus the timestamp that records a deletion.
-- Everything else on the row is the member's own data and stays freely editable.
--
-- The bypass list is short and deliberate. A write that did not arrive from a client is privileged
-- by construction: `current_user` is then the owner of whichever SECURITY DEFINER function ran it
-- (`delete_account()`, `suspend_user()`, the retention purge), the database owner, or cron. A write
-- that *did* arrive from a client arrives as `anon` or `authenticated`, and is checked column by
-- column — which is what turns `update { role: 'admin' }` on your own profile from a successful
-- write into an error. The service role is the dashboard and the Edge Functions; an admin passes
-- `is_admin()`, so the moderation paths keep working through the API.
--
-- This function is deliberately NOT security definer: a definer trigger would run with its owner's
-- `current_user`, which is exactly the privilege the trigger exists to withhold. `is_admin()` is
-- itself security definer, so the one read this trigger needs still sees every profile.
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Nested triggers (a counter guard, a set_updated_at) re-enter with the same privileges.
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if current_user not in ('anon', 'authenticated')
     or auth.role() = 'service_role'
     or public.is_admin() then
    return new;
  end if;

  if new.role is distinct from old.role then
    raise exception 'only a global admin may change a member''s role' using errcode = 'insufficient_privilege';
  end if;

  if new.verified is distinct from old.verified then
    raise exception 'only a moderator may change the verified badge' using errcode = 'insufficient_privilege';
  end if;

  if new.account_status is distinct from old.account_status then
    raise exception 'a member cannot change their account status' using errcode = 'insufficient_privilege';
  end if;

  if new.deleted_at is distinct from old.deleted_at then
    raise exception 'a member cannot delete their account from a profile update; use delete_account()' using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.guard_profile_privileges() is
  'Refuses role, verified, account_status and deleted_at changes to anyone who is not an admin, the service role or the database owner. A row policy cannot compare the stored row with the incoming one; this trigger is the only place that can.';

create trigger profiles_guard_privileges
  before update on public.profiles
  for each row execute function public.guard_profile_privileges();

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
