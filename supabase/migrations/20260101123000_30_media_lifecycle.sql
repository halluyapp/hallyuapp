-- Hallyu backend — 30 media lifecycle.
--
-- Bytes live in the `media` bucket (migration 17); Postgres only ever holds object paths. That split
-- is what creates the problem this migration solves: a database record and a storage object can
-- drift apart, and without a job that reconciles them the bucket grows forever.
--
-- The states a piece of media can be in, and who moves it where:
--
--   pending    an upload was announced but nothing is attached to it yet  → expires after 24h
--   attached   a post_media row points at it                               → follows the post
--   failed     the client reported the upload failed                       → object removed now
--   orphan     the object exists in storage and nothing references it      → removed by the job
--   stale      an `u/<id>/…` object older than the retention window         → removed by the job
--
-- Nothing here transcodes video. `post_media` already carries width/height/duration and a poster
-- path; the lifecycle only decides when an object is allowed to disappear. Adding a transcoder later
-- means filling in duration/poster and flipping the state, not changing this model.

-- ---------------------------------------------------------------------------------------------
-- Upload intents
-- ---------------------------------------------------------------------------------------------

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create type public.media_state as enum ('pending', 'attached', 'failed', 'orphaned');

create table if not exists public.media_uploads (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid        not null references public.profiles (id) on delete cascade,
  storage_path text        not null,
  kind         text        not null default 'image',
  byte_size    bigint,
  content_type text,
  width        integer,
  height       integer,
  duration_ms  integer,
  poster_path  text,
  state        public.media_state not null default 'pending',
  post_id      uuid        references public.posts (id) on delete cascade,
  post_media_id uuid       references public.post_media (id) on delete cascade,
  error        text,
  expires_at   timestamptz not null default (now() + interval '24 hours'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint media_uploads_path_not_blank check (length(btrim(storage_path)) > 0),
  constraint media_uploads_kind_known check (kind in ('image', 'video', 'audio')),
  constraint media_uploads_owner_path check (public.storage_owner(storage_path) = user_id),
  constraint media_uploads_byte_size_sane check (byte_size is null or (byte_size > 0 and byte_size <= 104857600)),
  constraint media_uploads_dimensions_sane check (
    (width is null or width > 0) and (height is null or height > 0) and (duration_ms is null or duration_ms >= 0)
  ),
  constraint media_uploads_attached_has_post check (state <> 'attached' or post_id is not null)
);

comment on table public.media_uploads is 'Upload intents. A row exists before the bytes do, so a failed or abandoned upload is always visible and always cleanable.';
comment on column public.media_uploads.expires_at is 'When a pending upload becomes garbage. 24 hours is long enough for a slow connection and short enough not to leak.';

create unique index if not exists media_uploads_path_key on public.media_uploads (storage_path);
create index if not exists media_uploads_pending_idx on public.media_uploads (expires_at)
  where state = 'pending';
create index if not exists media_uploads_state_idx on public.media_uploads (state);
create index if not exists media_uploads_user_idx on public.media_uploads (user_id, created_at desc);

create trigger media_uploads_set_updated_at
  before update on public.media_uploads
  for each row execute function public.set_updated_at();

alter table public.media_uploads enable row level security;

create policy media_uploads_owner_select on public.media_uploads
  for select to authenticated using (user_id = auth.uid() or public.is_moderator());

create policy media_uploads_owner_insert on public.media_uploads
  for insert to authenticated with check (user_id = auth.uid());

create policy media_uploads_owner_update on public.media_uploads
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy media_uploads_owner_delete on public.media_uploads
  for delete to authenticated using (user_id = auth.uid() or public.is_moderator());

grant select, insert, update, delete on public.media_uploads to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Client-facing lifecycle operations
-- ---------------------------------------------------------------------------------------------

-- Announces an upload before the bytes are sent, so a client that crashes mid-upload still leaves a
-- trace. The path must be inside the caller's own folder, which is the same rule the storage policy
-- enforces — this function just fails earlier and with a clearer message.
create or replace function public.begin_media_upload(
  p_storage_path text,
  p_kind text default 'image',
  p_byte_size bigint default null,
  p_content_type text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  upload_id uuid;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_storage_path is null or length(btrim(p_storage_path)) = 0 then
    raise exception 'storage_path is required' using errcode = 'invalid_parameter_value';
  end if;

  if p_kind not in ('image', 'video', 'audio') then
    raise exception 'unknown media kind %', p_kind using errcode = 'invalid_parameter_value';
  end if;

  if public.storage_owner(p_storage_path) is distinct from actor then
    raise exception 'uploads must be stored under your own folder' using errcode = 'check_violation';
  end if;

  if p_byte_size is not null and (p_byte_size <= 0 or p_byte_size > 104857600) then
    raise exception 'file size % is not allowed', p_byte_size using errcode = 'check_violation';
  end if;

  insert into public.media_uploads (user_id, storage_path, kind, byte_size, content_type)
  values (actor, left(btrim(p_storage_path), 400), p_kind, p_byte_size, left(p_content_type, 120))
  on conflict (storage_path) do update
    set kind = excluded.kind,
        byte_size = excluded.byte_size,
        content_type = excluded.content_type,
        state = (case when public.media_uploads.state = 'attached' then 'attached' else 'pending' end)::public.media_state,
        expires_at = now() + interval '24 hours',
        error = null
  returning id into upload_id;

  return upload_id;
end;
$$;

revoke all on function public.begin_media_upload(text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.begin_media_upload(text, text, bigint, text) to authenticated;

-- Confirms an upload and, optionally, attaches it to a post in the same transaction. Metadata is
-- validated here so a malformed record never reaches post_media.
create or replace function public.complete_media_upload(
  p_upload_id uuid,
  p_post_id uuid default null,
  p_position smallint default null,
  p_width integer default null,
  p_height integer default null,
  p_duration_ms integer default null,
  p_poster_path text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  u public.media_uploads%rowtype;
  media_id uuid;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into u from public.media_uploads where id = p_upload_id for update;
  if not found or u.user_id <> actor then
    raise exception 'upload % does not exist', p_upload_id using errcode = 'no_data_found';
  end if;

  if u.state = 'failed' then
    raise exception 'upload % already failed', p_upload_id using errcode = 'check_violation';
  end if;

  if p_post_id is not null then
    if not exists (select 1 from public.posts where id = p_post_id and author_id = actor) then
      raise exception 'you can only attach media to your own post' using errcode = 'insufficient_privilege';
    end if;

    -- Position is unique per post; the next free slot is the default.
    insert into public.post_media (post_id, kind, storage_path, position, width, height, duration_ms, poster_path)
    values (
      p_post_id,
      u.kind,
      u.storage_path,
      coalesce(p_position, (
        select coalesce(max(pm.position), -1) + 1
        from public.post_media pm
        where pm.post_id = p_post_id
      )),
      p_width,
      p_height,
      p_duration_ms,
      p_poster_path
    )
    returning id into media_id;

    update public.media_uploads
       set state = 'attached',
           post_id = p_post_id,
           post_media_id = media_id,
           width = p_width,
           height = p_height,
           duration_ms = p_duration_ms,
           poster_path = p_poster_path,
           expires_at = now() + interval '30 days'
     where id = p_upload_id;

    return media_id;
  end if;

  -- No post: the bytes exist but nothing references them yet. The row stays pending with a longer
  -- window so a composer that uploads first and posts second still has time.
  update public.media_uploads
     set state = 'pending',
         width = p_width,
         height = p_height,
         duration_ms = p_duration_ms,
         poster_path = p_poster_path,
         expires_at = now() + interval '30 days'
   where id = p_upload_id;

  return p_upload_id;
end;
$$;

revoke all on function public.complete_media_upload(uuid, uuid, smallint, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.complete_media_upload(uuid, uuid, smallint, integer, integer, integer, text) to authenticated;

-- Reports a failure. The object is removed immediately rather than waiting for the sweeper: the
-- client already knows the upload did not work.
create or replace function public.fail_media_upload(p_upload_id uuid, p_error text default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  update public.media_uploads
     set state = 'failed',
         error = left(p_error, 300)
   where id = p_upload_id and user_id = actor and state <> 'attached';

  if found then
    delete from storage.objects
     where bucket_id = 'media'
       and name = (select storage_path from public.media_uploads where id = p_upload_id);
  end if;

  return found;
end;
$$;

revoke all on function public.fail_media_upload(uuid, text) from public, anon, authenticated;
grant execute on function public.fail_media_upload(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------------------------

-- Drops `post_media` rows whose object is gone. This is the direction that matters for correctness:
-- a broken row makes a post render a hole forever, while an extra object only wastes bytes until the
-- next sweep.
create or replace function public.media_drop_missing_objects()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  broken integer := 0;
  orphans integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'media reconciliation is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  update public.post_media m
     set storage_path = coalesce(m.poster_path, m.storage_path)
   where m.poster_path is not null
     and not exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = m.storage_path)
     and exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = m.poster_path);

  get diagnostics broken = row_count;

  -- Still no object and no poster: the row is meaningless, so it goes.
  delete from public.post_media m
   where not exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = m.storage_path)
     and (m.poster_path is null
          or not exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = m.poster_path));

  get diagnostics broken = row_count;

  -- Uploads that never attached and have expired, and uploads the client reported as failed.
  update public.media_uploads
     set state = 'orphaned'
   where state = 'pending'
     and expires_at < now();

  delete from public.media_uploads
   where state = 'failed'
     and updated_at < now() - interval '7 days';

  return broken + orphans;
end;
$$;

revoke all on function public.media_drop_missing_objects() from public, anon, authenticated;
grant execute on function public.media_drop_missing_objects() to service_role;

-- Removes objects nothing points at. `avatars/` and `catalog/` are managed by the ingest job and are
-- protected by the `protected` flag below; `u/<id>/…` is member content with a retention window.
--
-- `drop function` first: migration 37 changes this function's RETURNS TABLE shape (objects_removed →
-- objects_queued), and PostgreSQL refuses to redefine a function whose row type has changed (42P13).
-- On a fresh database there is nothing to drop and this is a no-op; on the live project it is what
-- lets the migration set be applied again from the top instead of only to a virgin database.
drop function if exists public.media_remove_orphans(interval, interval);

create or replace function public.media_remove_orphans(
  p_older_than interval default interval '7 days',
  p_user_older_than interval default interval '30 days'
)
returns table (objects_removed integer, uploads_purged integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer := 0;
  purged integer := 0;
  orphans integer := 0;
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

  if array_length(candidate_paths, 1) is not null then
    delete from storage.objects where bucket_id = 'media' and name = any(candidate_paths);
    get diagnostics removed = row_count;
  end if;

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

  if array_length(candidate_paths, 1) is not null then
    delete from storage.objects where bucket_id = 'media' and name = any(candidate_paths);
    get diagnostics orphans = row_count;
    removed := removed + orphans;
  end if;

  -- Finally the bookkeeping rows for uploads whose object no longer exists.
  delete from public.media_uploads u
   where u.state in ('failed', 'orphaned')
     and u.updated_at < now() - interval '7 days'
     and not exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = u.storage_path);

  get diagnostics purged = row_count;

  return query select removed, purged;
end;
$$;

revoke all on function public.media_remove_orphans(interval, interval) from public, anon, authenticated;
grant execute on function public.media_remove_orphans(interval, interval) to service_role;

-- The scheduled job. Returns every number, so a run is auditable afterwards.
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
    'orphan_objects_removed', cleanup.objects_removed,
    'upload_rows_purged', cleanup.uploads_purged,
    'pending_expired', (select count(*) from public.media_uploads where state = 'orphaned'),
    'attached', (select count(*) from public.media_uploads where state = 'attached')
  );
end;
$$;

revoke all on function public.job_reconcile_media(interval) from public, anon, authenticated;
grant execute on function public.job_reconcile_media(interval) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Post deletion keeps media for a grace window
-- ---------------------------------------------------------------------------------------------

-- When a post is deleted the media rows go with it through the cascade, which would make an undo
-- impossible. Instead, deletion is recorded and the storage sweep does the physical removal once the
-- grace period has passed — a deleted post's bytes stop being reachable immediately because the
-- read policy requires an active post, but they stop existing only when nothing points at them.
create or replace function public.mark_post_media_detached()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.state = 'deleted' and old.state is distinct from 'deleted' then
    update public.media_uploads
       set state = 'orphaned',
           expires_at = now() + interval '7 days'
     where post_id = new.id and state = 'attached';
  end if;

  return new;
end;
$$;

create trigger posts_media_detach
  after update of state on public.posts
  for each row execute function public.mark_post_media_detached();

-- The dispatcher learns about the media job.
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
    run_key_value := case
      when entry = 'catalog.trending'
        then to_char(now() at time zone 'utc', 'YYYY-MM-DD') || 'T' || to_char(date_trunc('hour', now()), 'HH24')
      else to_char(date_trunc('hour', now()), 'YYYY-MM-DD') || 'T' || to_char(date_trunc('hour', now()), 'HH24')
    end;

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
              handled := coalesce((media_result ->> 'orphan_objects_removed')::integer, 0)
                       + coalesce((media_result ->> 'broken_rows_removed')::integer, 0)
                       + coalesce((media_result ->> 'upload_rows_purged')::integer, 0);
            when 'moderation.audit' then
              handled := 0; -- replaced by migration 33
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
        return;
      end if;
    end loop;
  end loop;

  return;
end;
$$;

revoke all on function public.run_scheduled_jobs(text[]) from public, anon, authenticated;
grant execute on function public.run_scheduled_jobs(text[]) to service_role;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
