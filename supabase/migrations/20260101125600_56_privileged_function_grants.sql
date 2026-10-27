-- Migration 56: privileged function grants.
--
-- Live audit (kzxlbscfkixnswurpkzb): 96 SECURITY DEFINER functions in `public` were executable by
-- the anon role. Revoking everything would break guest browsing, so this migration is targeted and
-- additive. It only removes EXECUTE; no function body, table, policy or row changes.
--
--   1. Trigger functions. A trigger fires without a privilege check, so no caller needs EXECUTE.
--   2. Internal jobs. ensure_analytics_partition() had no caller check and could create or alter
--      analytics partitions. wire_scheduled_functions() had no caller check and replaced the stored
--      service-role key and cron project URL, so any caller could redirect cron traffic. Neither is
--      callable by anon or authenticated now. It is not in the migrations and exists only on the
--      live project; the revoke applies if it is present and does nothing otherwise.
--   3. Staff and writer functions. Their own guards (is_moderator, admin/moderator role) already
--      refuse anon. Removing anon EXECUTE makes that refusal explicit. authenticated keeps EXECUTE.
--   4. Member-only functions that need auth.uid(). Removing anon EXECUTE is defence in depth; the
--      functions already refused anon. authenticated keeps EXECUTE.
--
-- Deliberately NOT changed: public catalogue reads, feed and profile reads that guests use,
-- handle_is_available (signup), record_event (analytics), submit_support_ticket (guest support form),
-- and is_moderator / author_has_live_post / can_view_author_content (called from RLS policies, so
-- revoking them would break table access). scripts/localdb/security_grants.sql holds the allowlist.

do $$
declare
  r record;
  trigger_and_internal text[] := array[
    'ensure_analytics_partition', 'wire_scheduled_functions'
  ];
  staff_and_writers text[] := array[
    'admin_tracker_overview', 'get_staff_overview', 'staff_grant_video_by_handle',
    'send_ceo_broadcast', 'resolve_support_ticket', 'list_support_tickets',
    'ensure_client_title', 'ensure_client_person'
  ];
  member_only text[] := array[
    'list_conversations', 'list_direct_messages', 'list_follow_requests', 'mark_conversation_read',
    'my_verification_status', 'my_video_access_status', 'merge_preferences', 'change_my_handle',
    'complete_onboarding', 'create_community_room', 'create_hallyu_event', 'create_post_poll',
    'vote_post_poll', 'rate_title', 'report_content', 'set_block', 'set_follow', 'set_mute',
    'toggle_event_rsvp', 'toggle_reaction', 'toggle_save', 'upsert_watchlist_item'
  ];
begin
  -- 1. Trigger functions: no EXECUTE needed by any caller.
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype
  loop
    execute 'revoke all on function ' || r.sig::text || ' from public, anon, authenticated';
  end loop;

  -- 2. Internal jobs: owner and service role only.
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = any(trigger_and_internal)
  loop
    execute 'revoke all on function ' || r.sig::text || ' from public, anon, authenticated';
    execute 'grant execute on function ' || r.sig::text || ' to service_role';
  end loop;

  -- 3 and 4. PUBLIC has EXECUTE by default, and anon inherits it, so revoke both. Then restore
  -- EXECUTE for the roles that legitimately call these: authenticated and service_role.
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = any(staff_and_writers || member_only)
  loop
    execute 'revoke all on function ' || r.sig::text || ' from public, anon';
    execute 'grant execute on function ' || r.sig::text || ' to authenticated, service_role';
  end loop;
end
$$;
