-- Member-only mutations must not be exposed as anonymous PostgREST RPCs. Their existing
-- current_profile_id()/staff guards remain the authorization boundary. Anonymous analytics and
-- anonymous support-ticket submission are intentionally unchanged.
revoke all on function public.mark_conversation_read(text) from public, anon;
revoke all on function public.rate_title(uuid, numeric) from public, anon;
revoke all on function public.report_content(text, uuid, text, text) from public, anon;
revoke all on function public.resolve_support_ticket(uuid, text, text) from public, anon;
revoke all on function public.set_block(uuid, boolean) from public, anon;
revoke all on function public.set_mute(text, uuid, boolean) from public, anon;
revoke all on function public.toggle_event_rsvp(uuid, boolean, integer) from public, anon;
revoke all on function public.toggle_reaction(text, uuid, public.reaction_kind) from public, anon;
revoke all on function public.toggle_save(uuid) from public, anon;

grant execute on function public.mark_conversation_read(text) to authenticated, service_role;
grant execute on function public.rate_title(uuid, numeric) to authenticated, service_role;
grant execute on function public.report_content(text, uuid, text, text) to authenticated, service_role;
grant execute on function public.resolve_support_ticket(uuid, text, text) to authenticated, service_role;
grant execute on function public.set_block(uuid, boolean) to authenticated, service_role;
grant execute on function public.set_mute(text, uuid, boolean) to authenticated, service_role;
grant execute on function public.toggle_event_rsvp(uuid, boolean, integer) to authenticated, service_role;
grant execute on function public.toggle_reaction(text, uuid, public.reaction_kind) to authenticated, service_role;
grant execute on function public.toggle_save(uuid) to authenticated, service_role;
