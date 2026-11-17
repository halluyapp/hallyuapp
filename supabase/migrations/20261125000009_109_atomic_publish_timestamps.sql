-- Publishing an approved hidden draft must maintain posts_state_matches_timestamps.
-- Prior acceptance only republished an active row; test hidden -> active explicitly.
do $patch$
declare definition text; old text := 'update public.posts set state=''active'' where id=pid;';
begin
 select pg_get_functiondef('public.operator_execute_approved(uuid,uuid,text,jsonb)'::regprocedure) into definition;
 if strpos(definition,old)=0 then raise exception 'atomic publication implementation drift';end if;
 execute replace(definition,old,'update public.posts set state=''active'', hidden_at=null, deleted_at=null where id=pid;');
end;$patch$;
