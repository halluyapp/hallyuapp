-- SECURITY DEFINER grant review: trigger handlers are not RPCs and require no client EXECUTE grant.
-- Public read-only discovery RPCs remain available. Mutating member/staff RPCs retain their internal
-- authorization checks but are not exposed to anonymous callers. Operational/quota data is scoped.
set check_function_bodies = off;

revoke all on function public.enforce_comment_parent() from public, anon, authenticated;
revoke all on function public.guard_catalog_counters() from public, anon, authenticated;
revoke all on function public.guard_comment_reaction_counters() from public, anon, authenticated;
revoke all on function public.guard_engagement_counters() from public, anon, authenticated;
revoke all on function public.guard_profile_counters() from public, anon, authenticated;
revoke all on function public.guard_profile_privileges() from public, anon, authenticated;
revoke all on function public.guard_recognition_audit_immutable() from public, anon, authenticated;
revoke all on function public.handle_collection_follow_counts() from public, anon, authenticated;
revoke all on function public.handle_collection_item_count() from public, anon, authenticated;
revoke all on function public.handle_comment_counts() from public, anon, authenticated;
revoke all on function public.handle_comment_state() from public, anon, authenticated;
revoke all on function public.handle_comment_state_counts() from public, anon, authenticated;
revoke all on function public.handle_community_member_count() from public, anon, authenticated;
revoke all on function public.handle_community_role_change() from public, anon, authenticated;
revoke all on function public.handle_follow_counts() from public, anon, authenticated;
revoke all on function public.handle_new_profile() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.handle_notification_fanout_and_wake() from public, anon, authenticated;
revoke all on function public.handle_notify_collection_follow() from public, anon, authenticated;
revoke all on function public.handle_notify_comment() from public, anon, authenticated;
revoke all on function public.handle_notify_follow() from public, anon, authenticated;
revoke all on function public.handle_notify_moderation() from public, anon, authenticated;
revoke all on function public.handle_notify_reaction() from public, anon, authenticated;
revoke all on function public.handle_notify_report_insert() from public, anon, authenticated;
revoke all on function public.handle_notify_video_request_insert() from public, anon, authenticated;
revoke all on function public.handle_person_follow_counts() from public, anon, authenticated;
revoke all on function public.handle_post_author_count() from public, anon, authenticated;
revoke all on function public.handle_post_share_counts() from public, anon, authenticated;
revoke all on function public.handle_post_state() from public, anon, authenticated;
revoke all on function public.handle_post_state_counts() from public, anon, authenticated;
revoke all on function public.handle_reaction_counts() from public, anon, authenticated;
revoke all on function public.handle_save_counts() from public, anon, authenticated;
revoke all on function public.handle_title_follow_counts() from public, anon, authenticated;
revoke all on function public.mark_post_media_detached() from public, anon, authenticated;
revoke all on function public.on_direct_message_notify() from public, anon, authenticated;
revoke all on function public.on_post_follower_notify() from public, anon, authenticated;
revoke all on function public.promote_first_profile_to_ceo() from public, anon, authenticated;
revoke all on function public.prune_app_release_objects() from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.trg_evaluate_recognition_on_activity() from public, anon, authenticated;

revoke all on function public.change_my_handle(text) from public, anon;
revoke all on function public.create_hallyu_event(text, text, text, text, text, uuid, integer, integer, timestamptz, integer, text, jsonb, boolean) from public, anon;
revoke all on function public.create_post_poll(uuid, text, text[], integer) from public, anon;
revoke all on function public.vote_post_poll(uuid, integer) from public, anon;
grant execute on function public.change_my_handle(text) to authenticated, service_role;
grant execute on function public.create_hallyu_event(text, text, text, text, text, uuid, integer, integer, timestamptz, integer, text, jsonb, boolean) to authenticated, service_role;
grant execute on function public.create_post_poll(uuid, text, text[], integer) to authenticated, service_role;
grant execute on function public.vote_post_poll(uuid, integer) to authenticated, service_role;

-- Recognition is evaluated by profile/activity RPCs and triggers, not by letting a member request
-- badge issuance for an arbitrary profile. Internal SECURITY DEFINER callers retain owner execution.
revoke all on function public.evaluate_early_member_awards(uuid) from public, anon, authenticated;
revoke all on function public.evaluate_member_achievements(uuid) from public, anon, authenticated;
grant execute on function public.evaluate_early_member_awards(uuid) to service_role;
grant execute on function public.evaluate_member_achievements(uuid) to service_role;

create or replace function public.catalog_provider_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_moderator() then
    raise exception 'staff privilege required' using errcode = 'insufficient_privilege';
  end if;
  return coalesce((
    select jsonb_object_agg(
      s.provider_id,
      jsonb_build_object(
        'last_success_at', s.last_success_at, 'last_attempt_at', s.last_attempt_at,
        'last_failure_at', s.last_failure_at, 'consecutive_failures', s.consecutive_failures,
        'rate_limited_until', s.rate_limited_until, 'disabled_reason', s.disabled_reason,
        'total_items_written', s.total_items_written, 'total_requests', s.total_requests,
        'usable', s.consecutive_failures < 10 and (s.rate_limited_until is null or s.rate_limited_until < now())
      )
    ) from public.catalog_provider_state s
  ), '{}'::jsonb);
end;
$$;

create or replace function public.video_bytes_used_this_month(p_user uuid default public.current_profile_id())
returns bigint
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_user is null or (p_user <> public.current_profile_id() and not public.is_moderator()) then
    raise exception 'only the member or staff may read this video allowance' using errcode = 'insufficient_privilege';
  end if;
  return coalesce((
    select sum(u.byte_size) from public.media_uploads u
    where u.user_id = p_user and u.kind = 'video' and u.state in ('pending', 'attached')
      and u.created_at >= date_trunc('month', now())
  ), 0)::bigint;
end;
$$;

create or replace function public.video_quota(p_user uuid default public.current_profile_id())
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
  if p_user <> public.current_profile_id() and not public.is_moderator() then
    raise exception 'only the member or staff may read this video allowance' using errcode = 'insufficient_privilege';
  end if;
  allowed := public.video_access(p_user);
  used := public.video_bytes_used_this_month(p_user);
  select vc.monthly_byte_budget into budget from public.video_creators vc
   where vc.user_id = p_user and vc.revoked_at is null;
  return jsonb_build_object(
    'allowed', allowed, 'budget', budget, 'used', used,
    'remaining', case when budget is null then null else greatest(budget - used, 0) end,
    'pending_request', exists (select 1 from public.video_access_requests r where r.user_id = p_user and r.status = 'pending'),
    'resets_at', date_trunc('month', now()) + interval '1 month'
  );
end;
$$;

revoke all on function public.catalog_provider_health() from public, anon;
revoke all on function public.video_bytes_used_this_month(uuid) from public, anon;
revoke all on function public.video_quota(uuid) from public, anon;
grant execute on function public.catalog_provider_health() to authenticated, service_role;
grant execute on function public.video_bytes_used_this_month(uuid) to authenticated, service_role;
grant execute on function public.video_quota(uuid) to authenticated, service_role;
reset check_function_bodies;
