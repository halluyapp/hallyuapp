-- Hallyu backend — 15 moderation.
-- Reports are how a member asks for help; moderators act on them. The reporter can always see their
-- own report, but never another member's, and the reporter id is not exposed to the person reported.

-- Function bodies in this file may reference objects that later migrations create, so validation
-- is off while it runs and switched back on at the end. Every body is re-created and checked
-- together, against the finished schema, by scripts/localdb/verify-function-bodies.mjs.
set check_function_bodies = off;

create type public.report_status as enum ('open', 'reviewing', 'resolved', 'dismissed');

create table if not exists public.reports (
  id             uuid primary key default gen_random_uuid(),
  reporter_id    uuid        not null references public.profiles (id) on delete cascade,
  target_type    text        not null,
  target_id      uuid        not null,
  reason         text        not null,
  detail         text,
  status         public.report_status not null default 'open',
  resolution     text,
  resolved_by    uuid        references public.profiles (id) on delete set null,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint reports_target_type_known check (target_type in ('post', 'comment', 'user', 'title', 'collection')),
  constraint reports_reason_not_blank check (length(btrim(reason)) > 0),
  constraint reports_reason_length check (char_length(reason) <= 60),
  constraint reports_detail_length check (detail is null or char_length(detail) <= 1000),
  constraint reports_resolution_stamp check (
    (status in ('resolved', 'dismissed')) = (resolved_at is not null)
  )
);

comment on table public.reports is 'Member reports. target_id is intentionally not a foreign key: a report outlives the row it points at.';

create index if not exists reports_status_created_idx on public.reports (status, created_at desc);
create index if not exists reports_reporter_idx on public.reports (reporter_id, created_at desc);
create index if not exists reports_target_idx on public.reports (target_type, target_id);

create trigger reports_set_updated_at
  before update on public.reports
  for each row execute function public.set_updated_at();

alter table public.reports enable row level security;

create policy reports_reporter_select on public.reports
  for select to authenticated
  using (reporter_id = auth.uid());

create policy reports_moderator_select on public.reports
  for select to authenticated
  using (public.is_moderator());

create policy reports_insert_own on public.reports
  for insert to authenticated
  with check (
    reporter_id = auth.uid()
    and status = 'open'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.account_status = 'active')
  );

-- A reporter may withdraw or add context, but only a moderator may resolve.
create policy reports_reporter_update on public.reports
  for update to authenticated
  using (reporter_id = auth.uid())
  with check (reporter_id = auth.uid() and status = 'open');

create policy reports_moderator_update on public.reports
  for update to authenticated
  using (public.is_moderator())
  with check (public.is_moderator());

grant select, insert, update on public.reports to authenticated;

-- Leave the session as it was found: a file applied by hand must not change later behaviour.
reset check_function_bodies;
