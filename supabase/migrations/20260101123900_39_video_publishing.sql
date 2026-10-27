-- Hallyu backend — 39 video publishing.
--
-- Video is the one media kind the catalog cannot absorb for free. A 60-second 1080p clip is roughly
-- 45 MB where a photo is a few hundred kilobytes, and bytes are paid for twice: once while they are
-- stored, and again every time somebody watches them. Egress, not storage, is the line that grows
-- with success — so video publishing is not a permission every account gets on day one.
--
-- Three gates, in the order bytes can arrive:
--
--   1. the allowlist   `video_creators` — a moderator grants access; nothing else does
--   2. the budget      a per-creator monthly byte ceiling, enforced when an upload is announced
--                      (`begin_media_upload`), so the refusal happens before the bytes move
--   3. the attachment  `post_media` refuses a video row from a member without access, so a client
--                      that skips the announce step still cannot turn bytes into a post
--
-- Requests are the fourth piece: a member without access can ask for it, and a moderator decides.
-- The request queue is what keeps the gate from being a closed door.
--
-- What this migration deliberately does not do: transcode, cap duration, or police the storage
-- bucket's own upload policy. Bytes can always land inside a member's own folder — the policy in
-- migration 17 is about ownership, not about kind. What they can never do is become a post, and an
-- unreferenced object is exactly what the reconciliation job in migration 30 exists to collect.
--
-- Default budget is 1 GiB a month: about two 45 MB clips a week, with room for a third. It is a
-- ceiling on cost, not a target, and it is raised per member rather than globally.

-- ---------------------------------------------------------------------------------------------
-- Who may publish video
-- ---------------------------------------------------------------------------------------------

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create table if not exists public.video_creators (
  user_id             uuid primary key references public.profiles (id) on delete cascade,
  monthly_byte_budget bigint      not null default 1073741824,
  granted_by          uuid        references public.profiles (id) on delete set null,
  granted_at          timestamptz not null default now(),
  note                text,
  revoked_at          timestamptz,
  revoked_by          uuid        references public.profiles (id) on delete set null,
  revoke_reason       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint video_creators_budget_sane check (monthly_byte_budget between 10485760 and 107374182400),
  constraint video_creators_revoke_order check (revoked_at is null or revoked_at >= granted_at)
);

comment on table public.video_creators is 'Video publishing allowlist. One row per member, kept after revocation so the history survives. Written only by grant_video_access() / revoke_video_access().';
comment on column public.video_creators.monthly_byte_budget is 'Bytes this member may announce per calendar month. Between 10 MiB and 100 GiB; 1 GiB by default.';
comment on column public.video_creators.granted_at is 'When access was last granted. Re-granting a revoked member moves this forward and clears the revocation.';
comment on column public.video_creators.note is 'Why access was granted, in the moderator’s words. Read back by the roster.';

-- The upload path asks one question often — "does this member have access right now?" — and it is
-- always the active rows that answer it.
create index if not exists video_creators_active_idx on public.video_creators (user_id)
  where revoked_at is null;

create trigger video_creators_set_updated_at
  before update on public.video_creators
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------------------------------

create table if not exists public.video_access_requests (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid        not null references public.profiles (id) on delete cascade,
  status         text        not null default 'pending',
  note           text,
  decided_by     uuid        references public.profiles (id) on delete set null,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz not null default now(),
  constraint video_access_requests_status_known check (status in ('pending', 'approved', 'declined')),
  -- A decided request always carries the moment it was decided; a pending one never does.
  constraint video_access_requests_decided_consistent check ((status = 'pending') = (decided_at is null)),
  constraint video_access_requests_note_length check (note is null or char_length(note) <= 500)
);

comment on table public.video_access_requests is 'A member asking to publish video. Members insert their own pending row; only review_video_access_request() moves it.';

-- One open request per member: a second ask is a duplicate, not a queue position.
create unique index if not exists video_access_requests_one_pending on public.video_access_requests (user_id)
  where status = 'pending';

create index if not exists video_access_requests_queue_idx on public.video_access_requests (created_at)
  where status = 'pending';

alter table public.video_creators enable row level security;
alter table public.video_access_requests enable row level security;

-- A member reads their own row; a moderator reads the roster. Neither writes directly — the two
-- security-definer functions below are the only doors, which is what keeps `granted_by` honest.
create policy video_creators_select_self on public.video_creators
  for select to authenticated using (user_id = auth.uid());

create policy video_creators_select_moderator on public.video_creators
  for select to authenticated using (public.is_moderator());

create policy video_creators_service_only on public.video_creators
  for all to service_role using (true) with check (true);

create policy video_access_requests_select_self on public.video_access_requests
  for select to authenticated using (user_id = auth.uid());

create policy video_access_requests_select_moderator on public.video_access_requests
  for select to authenticated using (public.is_moderator());

-- A member may file their own request and nothing else: the status starts pending and the decision
-- columns are the moderator's to fill, so there is no path from here to "approved".
create policy video_access_requests_insert_own on public.video_access_requests
  for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending' and decided_at is null and decided_by is null);

create policy video_access_requests_service_only on public.video_access_requests
  for all to service_role using (true) with check (true);

grant select on public.video_creators to authenticated;
grant select, insert on public.video_access_requests to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Reading the gate
-- ---------------------------------------------------------------------------------------------

-- The single question the upload path and the client both ask. Staff are always allowed: a moderator
-- reviewing video has to be able to publish one, and `role` is not writable by members (migration 03).
create or replace function public.video_access(p_user uuid default auth.uid())
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
        p.role in ('moderator', 'admin')
        or exists (
          select 1
          from public.video_creators vc
          where vc.user_id = p.id
            and vc.revoked_at is null
        )
      )
  );
$$;

comment on function public.video_access(uuid) is 'True when this member may publish video right now: an active grant, or a staff role.';

revoke all on function public.video_access(uuid) from public, anon, authenticated;
grant execute on function public.video_access(uuid) to authenticated;

-- Spent against the calendar month, not against the last 30 days: a budget the member can see
-- resetting on the 1st is a budget they can reason about. Failed and orphaned uploads do not count —
-- they leave no playable bytes behind.
create or replace function public.video_bytes_used_this_month(p_user uuid default auth.uid())
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(u.byte_size), 0)::bigint
  from public.media_uploads u
  where u.user_id = p_user
    and u.kind = 'video'
    and u.state in ('pending', 'attached')
    and u.created_at >= date_trunc('month', now());
$$;

comment on function public.video_bytes_used_this_month(uuid) is 'Video bytes this member announced since the first of the month.';

revoke all on function public.video_bytes_used_this_month(uuid) from public, anon, authenticated;
grant execute on function public.video_bytes_used_this_month(uuid) to authenticated;

-- Everything a screen needs to draw the meter and decide whether to offer the video door at all.
-- `budget` is null when the allowance is not a grant (staff): unlimited, and honestly reported as such.
create or replace function public.video_quota(p_user uuid default auth.uid())
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  allowed boolean;
  budget bigint;
  used bigint;
begin
  if p_user is null then
    return jsonb_build_object('allowed', false, 'budget', null, 'used', 0, 'remaining', null, 'pending_request', false, 'resets_at', null);
  end if;

  allowed := public.video_access(p_user);
  used := public.video_bytes_used_this_month(p_user);

  select vc.monthly_byte_budget into budget
  from public.video_creators vc
  where vc.user_id = p_user and vc.revoked_at is null;

  return jsonb_build_object(
    'allowed', allowed,
    'budget', budget,
    'used', used,
    'remaining', case when budget is null then null else greatest(budget - used, 0) end,
    'pending_request', exists (
      select 1 from public.video_access_requests r
      where r.user_id = p_user and r.status = 'pending'
    ),
    'resets_at', date_trunc('month', now()) + interval '1 month'
  );
end;
$$;

comment on function public.video_quota(uuid) is 'The video allowance as the client reads it: allowed, budget, used, remaining, pending_request, resets_at.';

revoke all on function public.video_quota(uuid) from public, anon, authenticated;
grant execute on function public.video_quota(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Changing the gate (moderators)
-- ---------------------------------------------------------------------------------------------

-- Grants are additive and idempotent: granting twice raises the budget rather than failing, and
-- granting a revoked member restores them, which is what a moderator actually means by "let them
-- back in". A pending request from that member is settled in the same transaction.
create or replace function public.grant_video_access(
  p_user uuid,
  p_monthly_byte_budget bigint default null,
  p_note text default null
)
returns public.video_creators
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  budget bigint;
  row_out public.video_creators%rowtype;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not public.is_moderator() then
    raise exception 'moderator role required' using errcode = 'insufficient_privilege';
  end if;

  if p_user is null then
    raise exception 'user is required' using errcode = 'invalid_parameter_value';
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_user) then
    raise exception 'profile % does not exist', p_user using errcode = 'no_data_found';
  end if;

  if p_monthly_byte_budget is not null and (p_monthly_byte_budget < 10485760 or p_monthly_byte_budget > 107374182400) then
    raise exception 'the budget must be between 10 MiB and 100 GiB' using errcode = 'check_violation';
  end if;

  budget := coalesce(p_monthly_byte_budget, 1073741824);

  insert into public.video_creators as vc (user_id, monthly_byte_budget, granted_by, note)
  values (p_user, budget, actor, nullif(left(btrim(coalesce(p_note, '')), 500), ''))
  on conflict (user_id) do update
    set monthly_byte_budget = excluded.monthly_byte_budget,
        granted_by          = excluded.granted_by,
        granted_at          = now(),
        note                = coalesce(excluded.note, vc.note),
        revoked_at          = null,
        revoked_by          = null,
        revoke_reason       = null
  returning * into row_out;

  update public.video_access_requests
     set status        = 'approved',
         decided_by    = actor,
         decided_at    = now(),
         decision_note = nullif(left(btrim(coalesce(p_note, '')), 500), '')
   where user_id = p_user
     and status = 'pending';

  perform public.enqueue_notification(
    p_user,
    'system',
    'system',
    'video_access_granted:' || p_user::text || ':' || to_char(now(), 'YYYY-MM-DD'),
    '{}'::uuid[],
    null, null, null, null, null, null,
    'Video publishing is on',
    'You can post shorts and clips now. Your allowance resets on the 1st.',
    '/create/short'
  );

  return row_out;
end;
$$;

revoke all on function public.grant_video_access(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.grant_video_access(uuid, bigint, text) to authenticated;

-- Revocation keeps the row. The member's own uploads stay where they are — this closes the door, it
-- does not reach back through it — and the reason is stored so the decision is explainable later.
create or replace function public.revoke_video_access(
  p_user uuid,
  p_reason text default null
)
returns public.video_creators
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  row_out public.video_creators%rowtype;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not public.is_moderator() then
    raise exception 'moderator role required' using errcode = 'insufficient_privilege';
  end if;

  update public.video_creators
     set revoked_at    = now(),
         revoked_by    = actor,
         revoke_reason = nullif(left(btrim(coalesce(p_reason, '')), 500), '')
   where user_id = p_user
     and revoked_at is null
  returning * into row_out;

  if row_out.user_id is null then
    raise exception 'that member does not have video access' using errcode = 'no_data_found';
  end if;

  return row_out;
end;
$$;

revoke all on function public.revoke_video_access(uuid, text) from public, anon, authenticated;
grant execute on function public.revoke_video_access(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Ask, and answer
-- ---------------------------------------------------------------------------------------------

create or replace function public.request_video_access(p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  request_id uuid;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if public.video_access(actor) then
    raise exception 'you can already publish video' using errcode = 'unique_violation';
  end if;

  if exists (select 1 from public.video_access_requests r where r.user_id = actor and r.status = 'pending') then
    raise exception 'you already have a request waiting for review' using errcode = 'unique_violation';
  end if;

  if p_note is not null and char_length(btrim(p_note)) > 500 then
    raise exception 'keep the note under 500 characters' using errcode = 'check_violation';
  end if;

  insert into public.video_access_requests (user_id, note)
  values (actor, nullif(left(btrim(coalesce(p_note, '')), 500), ''))
  returning id into request_id;

  return request_id;
end;
$$;

revoke all on function public.request_video_access(text) from public, anon, authenticated;
grant execute on function public.request_video_access(text) to authenticated;

-- One decision, one transaction: the request is settled, the access row is written, and the member is
-- told. Declining notifies too — silence is the outcome people complain about.
create or replace function public.review_video_access_request(
  p_request_id uuid,
  p_approve boolean,
  p_monthly_byte_budget bigint default null,
  p_note text default null
)
returns public.video_access_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  req public.video_access_requests%rowtype;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not public.is_moderator() then
    raise exception 'moderator role required' using errcode = 'insufficient_privilege';
  end if;

  select * into req from public.video_access_requests where id = p_request_id for update;
  if not found then
    raise exception 'request % does not exist', p_request_id using errcode = 'no_data_found';
  end if;

  if req.status <> 'pending' then
    raise exception 'that request was already %', req.status using errcode = 'check_violation';
  end if;

  update public.video_access_requests
     set status        = case when p_approve then 'approved' else 'declined' end,
         decided_by    = actor,
         decided_at    = now(),
         decision_note = nullif(left(btrim(coalesce(p_note, '')), 500), '')
   where id = p_request_id
  returning * into req;

  if p_approve then
    -- Grants the access, settles any other pending request and sends the "you're in" notification.
    perform public.grant_video_access(req.user_id, p_monthly_byte_budget, p_note);
  else
    perform public.enqueue_notification(
      req.user_id,
      'system',
      'system',
      'video_access_declined:' || p_request_id::text,
      '{}'::uuid[],
      null, null, null, null, null, null,
      'Video publishing request',
      coalesce(nullif(left(btrim(coalesce(p_note, '')), 500), ''), 'Not this time — you can ask again whenever your clips are ready.'),
      '/create/post'
    );
  end if;

  return req;
end;
$$;

revoke all on function public.review_video_access_request(uuid, boolean, bigint, text) from public, anon, authenticated;
grant execute on function public.review_video_access_request(uuid, boolean, bigint, text) to authenticated;

-- The moderator's view: who has access, what they have spent this month, and what is waiting.
create or replace function public.video_creator_roster(p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  out jsonb;
begin
  if not public.is_moderator() then
    raise exception 'moderator role required' using errcode = 'insufficient_privilege';
  end if;

  select coalesce(jsonb_agg(entry), '[]'::jsonb) into out
  from (
    select jsonb_build_object(
      'user_id', vc.user_id,
      'handle', p.handle::text,
      'display_name', p.display_name,
      'budget', vc.monthly_byte_budget,
      'used_this_month', public.video_bytes_used_this_month(vc.user_id),
      'granted_at', vc.granted_at,
      'revoked_at', vc.revoked_at,
      'note', vc.note
    ) as entry
    from public.video_creators vc
    join public.profiles p on p.id = vc.user_id
    order by vc.granted_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  ) rows;

  return coalesce(out, '[]'::jsonb);
end;
$$;

revoke all on function public.video_creator_roster(integer) from public, anon, authenticated;
grant execute on function public.video_creator_roster(integer) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- The upload path, re-stated with the gate in it
-- ---------------------------------------------------------------------------------------------

-- Same signature as migration 30, so this replaces the body without touching any caller. The only
-- change is the video branch: access first (a clear refusal), then the budget (a refusal that says
-- how much is left). Images and audio are untouched, because they are not what costs money.
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
  quota jsonb;
  budget bigint;
  used bigint;
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

  if p_kind = 'video' then
    if not public.video_access(actor) then
      raise exception 'video publishing is limited to approved creators — request access from the create screen'
        using errcode = 'insufficient_privilege';
    end if;

    if p_byte_size is not null then
      quota := public.video_quota(actor);
      budget := (quota ->> 'budget')::bigint;
      used := coalesce((quota ->> 'used')::bigint, 0);

      if budget is not null and used + p_byte_size > budget then
        raise exception 'this upload would pass your monthly video allowance (% of % bytes already used)',
          used, budget
          using errcode = 'check_violation';
      end if;
    end if;
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

-- The third gate, and the one that holds even if a client never calls the RPC above: media may only
-- be attached to your own post, and a video row additionally requires access. The policy is dropped
-- and re-created rather than duplicated, so there is still exactly one insert rule on this table.
drop policy if exists post_media_insert_own on public.post_media;

create policy post_media_insert_own on public.post_media
  for insert to authenticated
  with check (
    exists (select 1 from public.posts p where p.id = post_id and p.author_id = auth.uid())
    and (kind <> 'video' or public.video_access(auth.uid()))
  );


-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
