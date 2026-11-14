-- 69: announce every newly published app release, and restore the staff broadcast RPC that the
-- CEO megaphone calls (`send_admin_broadcast` was referenced by the app but never existed on the
-- backend).
--
-- Delivery path: one row per member in public.notifications. The existing
-- `notifications_fanout_and_wake` trigger turns each row into `notification_deliveries` rows for
-- every active push token, so nothing here talks to a push provider directly, and the per-member
-- notification preference is applied exactly once.
set check_function_bodies = off;

-- ── shared fan-out ────────────────────────────────────────────────────────────────────────────
-- Returns how many inbox rows it actually created. `p_dedupe_prefix` makes the fan-out idempotent:
-- a second call for the same release (or broadcast key) inserts nothing.
create or replace function public.notify_all_members(
  p_kind public.notification_kind,
  p_group public.notification_group,
  p_title text,
  p_body text,
  p_deep_link text default '/',
  p_dedupe_prefix text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted integer := 0;
begin
  insert into public.notifications (recipient_id, kind, "group", title, body, deep_link, dedupe_key)
  select
    p.id,
    p_kind,
    p_group,
    left(coalesce(p_title, ''), 120),
    left(coalesce(p_body, ''), 500),
    coalesce(nullif(btrim(p_deep_link), ''), '/'),
    case when p_dedupe_prefix is null then null else p_dedupe_prefix || ':' || p.id::text end
  from public.profiles p
  join public.user_preferences up on up.user_id = p.id
  where p.account_status = 'active'
    and case p_group
          when 'system' then up.notify_system
          when 'social' then up.notify_social
          when 'drama' then up.notify_episodes
          else true
        end
    and (
      p_dedupe_prefix is null
      or not exists (
        select 1
        from public.notifications n
        where n.recipient_id = p.id
          and n.dedupe_key = p_dedupe_prefix || ':' || p.id::text
      )
    );

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke all on function public.notify_all_members(public.notification_kind, public.notification_group, text, text, text, text)
  from public, anon, authenticated;

-- ── staff broadcast (the RPC the CEO megaphone calls) ───────────────────────────────────────────────────────────────────────────
create or replace function public.send_admin_broadcast(
  p_title text,
  p_body text,
  p_path text default '/'
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- A signed-in admin/ceo is verified here from the live profile row; service_role callers are
  -- trusted because they have already authenticated at the server boundary.
  v_service boolean := coalesce(
    auth.role(),
    current_setting('request.jwt.claim.role', true),
    current_user
  ) = 'service_role';
  v_count integer;
begin
  if not v_service and not exists (
    select 1
    from public.profiles
    where id = public.current_profile_id()
      and account_status = 'active'
      and role in ('admin', 'ceo')
  ) then
    raise exception 'admin or ceo role required' using errcode = '42501';
  end if;

  v_count := public.notify_all_members(
    'system',
    'system',
    coalesce(nullif(btrim(p_title), ''), 'Hallyu announcement'),
    coalesce(p_body, ''),
    coalesce(nullif(btrim(p_path), ''), '/')
  );
  return v_count;
end;
$$;

revoke all on function public.send_admin_broadcast(text, text, text) from public, anon;
grant execute on function public.send_admin_broadcast(text, text, text) to authenticated, service_role;

-- ── "a new update is available" for every member ──────────────────────────────────────────────
-- Fires on every registered release, whatever path registers it (CI gateway, manual publish), and
-- is idempotent per version so a re-registration never re-notifies the community.
create or replace function public.handle_app_release_published()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.notify_all_members(
    'system',
    'system',
    'Hallyu ' || new.version_name || ' is ready',
    coalesce(
      nullif(btrim(new.release_notes), ''),
      'A new signed Hallyu build is available. Tap to install it in place — your account and your data stay exactly as they are.'
    ),
    '/settings/updates',
    'app-release:' || new.version_code::text
  );
  return new;
end;
$$;

drop trigger if exists app_releases_notify_publish on public.app_releases;
create trigger app_releases_notify_publish
  after insert on public.app_releases
  for each row execute function public.handle_app_release_published();

reset check_function_bodies;
