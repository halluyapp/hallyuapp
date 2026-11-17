-- Old APKs send two arguments; two defaulted overloads made PostgREST resolution ambiguous.
-- Preserve both signatures, but only the legacy array-returning signature has defaults.
do $repair$
declare definition text;
begin
 select pg_get_functiondef('public.list_direct_messages(text,integer,timestamptz)'::regprocedure) into definition;
 definition:=replace(definition,'p_limit integer DEFAULT 60, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone','p_limit integer, p_before timestamp with time zone');
 definition:=replace(definition,'v_peer.avatar_url','v_peer.avatar_path');
 drop function public.list_direct_messages(text,integer,timestamptz);
 execute definition;
 revoke all on function public.list_direct_messages(text,integer,timestamptz) from public,anon;
 grant execute on function public.list_direct_messages(text,integer,timestamptz) to authenticated,service_role;
end;$repair$;
notify pgrst,'reload schema';
-- Keep the durable handle stable for existing DM links; change the public name only.
update public.profiles set display_name='Nari',verified=true,verification_tier='blue' where id in(select profile_id from public.operator_staff where active) and is_ai=true;
update public.operator_staff set display_name='Nari' where active;
