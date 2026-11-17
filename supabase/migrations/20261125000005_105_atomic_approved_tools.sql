-- Snapshot the actual target at proposal time, display it in the existing exact-action queue,
-- then lock/revalidate/consume/execute atomically. No network gap between grant and mutation.
create or replace function public.operator_action_target(p_action text,p_args jsonb,p_lock boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare row_data jsonb; target uuid;
begin
 if p_action in ('post.publish','post.delete','post.edit','poll.create') then
  target:=(p_args->>'post_id')::uuid;
  if p_lock then perform 1 from public.posts where id=target for update; end if;
  select jsonb_build_object('id',id,'author_id',author_id,'body',body,'title',title,'state',state,'visibility',visibility,'type',type) into row_data from public.posts where id=target;
 elsif p_action in ('moderation.suspend','moderation.ban') then
  target:=(p_args->>'profile_id')::uuid;
  if p_lock then perform 1 from public.profiles where id=target for update; end if;
  select jsonb_build_object('id',id,'role',role,'account_status',account_status,'is_ai',is_ai,'is_banned',is_banned,'suspended_until',suspended_until) into row_data from public.profiles where id=target;
 elsif p_action='moderation.remove_content' then
  target:=(p_args->>'target_id')::uuid;
  if p_args->>'target_type'='post' then
   if p_lock then perform 1 from public.posts where id=target for update; end if;
   select jsonb_build_object('id',id,'body',body,'author_id',author_id,'state',state) into row_data from public.posts where id=target;
  elsif p_args->>'target_type'='comment' then
   if p_lock then perform 1 from public.comments where id=target for update; end if;
   select jsonb_build_object('id',id,'body',body,'author_id',author_id,'post_id',post_id,'state',state) into row_data from public.comments where id=target;
  end if;
 elsif p_action='moderation.restore' then
  select jsonb_build_object('action',m.action,'target',public.operator_action_target('moderation.remove_content',jsonb_build_object('target_type',m.target_type,'target_id',m.target_id),p_lock)) into row_data
   from public.moderation_actions m where m.id=(p_args->>'moderation_action_id')::uuid;
 elsif p_action='campaign.schedule' then
  target:=(p_args->>'campaign_id')::uuid;
  if p_lock then perform 1 from public.operator_campaign where id=target for update; end if;
  select jsonb_build_object('id',id,'version',version,'status',status,'name',name,'timezone',timezone) into row_data from public.operator_campaign where id=target;
 else return jsonb_build_object('target','new_or_audience_defined_by_exact_arguments');
 end if;
 if row_data is null then raise exception 'approval target missing or unsupported'; end if;
 return row_data;
end; $$;
revoke all on function public.operator_action_target(text,jsonb,boolean) from public,anon,authenticated,service_role;

create or replace function public.operator_approval_snapshot()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare args jsonb;
begin
 if tg_op='UPDATE' then
  if new.payload is distinct from old.payload or new.action is distinct from old.action or new.task_id is distinct from old.task_id then raise exception 'approval proposal is immutable'; end if;
  return new;
 end if;
 args:=case jsonb_typeof(new.payload->'arguments') when 'string' then (new.payload->>'arguments')::jsonb else new.payload->'arguments' end;
 if jsonb_typeof(args)='object' then
  new.payload:=new.payload||jsonb_build_object('target_snapshot',public.operator_action_target(new.action,args,false),'risk','Human approval required for public, destructive or sensitive action');
 end if;
 return new;
end; $$;
create trigger operator_approval_snapshot_before before insert or update on public.operator_approval for each row execute function public.operator_approval_snapshot();

alter function public.operator_consume_approval(uuid,uuid,text,jsonb) rename to operator_consume_approval_lease_v102;
revoke all on function public.operator_consume_approval_lease_v102(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
create or replace function public.operator_consume_approval(p_approval uuid,p_task uuid,p_action text,p_arguments jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare snapshot jsonb; current_target jsonb;
begin
 perform public.operator_require_service();
 if p_action in ('post.create','post.edit','post.publish','post.delete','poll.create','notification.send','moderation.remove_content','moderation.restore','moderation.suspend','moderation.ban','campaign.schedule') and current_setting('hallyu.approved_executor',true) is distinct from 'on' then return false; end if;
 select payload->'target_snapshot' into snapshot from public.operator_approval where id=p_approval for update;
 current_target:=public.operator_action_target(p_action,p_arguments,true);
 if snapshot is distinct from current_target then return false; end if;
 return public.operator_consume_approval_lease_v102(p_approval,p_task,p_action,p_arguments);
end; $$;
revoke all on function public.operator_consume_approval(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.operator_consume_approval(uuid,uuid,text,jsonb) to service_role;

create or replace function public.operator_execute_approved(p_approval uuid,p_task uuid,p_action text,p_arguments jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare staff uuid:=public.operator_staff_profile_id(); result jsonb; pid uuid; actor uuid; author uuid; cid uuid; target_type text;
begin
 perform public.operator_require_service();
 if p_action='campaign.schedule' then
  select decided_by into actor from public.operator_approval where id=p_approval;
  perform pg_advisory_xact_lock(hashtextextended(actor::text,103));
 end if;
 perform set_config('hallyu.approved_executor','on',true);
 if not public.operator_consume_approval(p_approval,p_task,p_action,p_arguments) then raise exception 'approval changed, expired, revoked or consumed' using errcode='42501'; end if;
 if p_action='post.create' then
  result:=public.operator_create_post(p_arguments->>'title',p_arguments->>'body',coalesce(p_arguments->>'type','post'),p_arguments->>'world',null,'none','public','{}');
 elsif p_action in ('post.publish','post.delete','post.edit','poll.create') then
  pid:=(p_arguments->>'post_id')::uuid;
  select author_id into author from public.posts where id=pid;
  if staff is null or author is distinct from staff then raise exception 'only operator-authored posts may be changed' using errcode='42501'; end if;
  if p_action='post.delete' then result:=public.operator_moderate_content('post',pid,'remove',coalesce(p_arguments->>'reason','Removed after approval'),null);
  elsif p_action='poll.create' then
   if jsonb_typeof(p_arguments->'options') is distinct from 'array' or jsonb_array_length(p_arguments->'options') not between 2 and 4 then raise exception '2-4 poll options required'; end if;
   if exists(select 1 from jsonb_array_elements_text(p_arguments->'options') x where x is null or length(btrim(x)) not between 1 and 80) or (select count(distinct lower(btrim(x))) from jsonb_array_elements_text(p_arguments->'options') x)<>jsonb_array_length(p_arguments->'options') then raise exception 'invalid poll options'; end if;
   insert into public.post_polls(post_id,question,options,closes_at) values(pid,coalesce(p_arguments->>'question','Vote'),array(select jsonb_array_elements_text(p_arguments->'options')),now()+interval '7 days');
   result:=jsonb_build_object('post_id',pid,'verified',exists(select 1 from public.post_polls where post_id=pid));
  elsif p_action='post.edit' then
   if length(btrim(coalesce(p_arguments->>'body',''))) not between 1 and 4000 then raise exception 'invalid body'; end if;
   update public.posts set body=p_arguments->>'body' where id=pid;
   result:=jsonb_build_object('post_id',pid,'verified',exists(select 1 from public.posts where id=pid and body=p_arguments->>'body'));
  else
   update public.posts set state='active' where id=pid;
   result:=jsonb_build_object('post_id',pid,'state','active','verified',exists(select 1 from public.posts where id=pid and state='active'));
  end if;
 elsif p_action='notification.send' then
  result:=public.operator_notify_approved(p_task,staff,p_arguments->>'title',p_arguments->>'body',coalesce(p_arguments->>'audience','all'),p_arguments->>'world');
 elsif p_action='moderation.remove_content' then
  result:=public.operator_moderate_content(p_arguments->>'target_type',(p_arguments->>'target_id')::uuid,'remove',coalesce(p_arguments->>'reason','Reviewed policy violation'),null);
 elsif p_action='moderation.restore' then
  select m.target_id,m.target_type into pid,target_type from public.moderation_actions m where id=(p_arguments->>'moderation_action_id')::uuid;
  result:=public.operator_moderate_content(target_type,pid,'restore',coalesce(p_arguments->>'reason','Restored after review'),null);
 elsif p_action='moderation.suspend' then
  result:=public.operator_suspend_member((p_arguments->>'profile_id')::uuid,p_arguments->>'reason',coalesce((p_arguments->>'days')::integer,7));
 elsif p_action='moderation.ban' then
  result:=public.operator_ban_member((p_arguments->>'profile_id')::uuid,p_arguments->>'reason');
 elsif p_action='campaign.schedule' then
  select decided_by into actor from public.operator_approval where id=p_approval;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',(select auth_sub from public.profiles where id=actor),'role','service_role')::text,true);
  result:=public.operator_campaign_schedule((p_arguments->>'campaign_id')::uuid,(p_arguments->>'version')::integer,(p_arguments->>'series_id')::uuid,p_arguments->>'body',(p_arguments->>'run_at')::timestamptz,p_arguments->>'timezone',coalesce((p_arguments->>'repeat_days')::integer,0),coalesce((p_arguments->>'count')::integer,1));
 else raise exception 'unsupported atomic action'; end if;
 if result is null then raise exception 'action returned no verified result'; end if;
 perform public.operator_audit_write('approved_action.executed','succeeded',p_task,staff,'staff','approval',p_approval::text,jsonb_build_object('action',p_action,'result',result));
 return result;
end; $$;
revoke all on function public.operator_execute_approved(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.operator_execute_approved(uuid,uuid,text,jsonb) to service_role;

insert into public.operator_tool(name,description,family,input_schema,permission,read_only,approval_required,rate_limit_per_min,timeout_ms) values
 ('post.edit','Edit exact body of an operator-authored post after snapshot-bound human approval.','content','{"type":"object","properties":{"post_id":{"type":"string","format":"uuid"},"body":{"type":"string","minLength":1,"maxLength":4000}},"required":["post_id","body"],"additionalProperties":false}','content.write',false,true,10,15000),
 ('campaign.schedule','Propose exact announcement occurrences for an existing versioned campaign; publishes under the approving admin.','campaign','{"type":"object","properties":{"campaign_id":{"type":"string","format":"uuid"},"version":{"type":"integer","minimum":1},"series_id":{"type":"string","format":"uuid"},"body":{"type":"string","minLength":1,"maxLength":5000},"run_at":{"type":"string"},"timezone":{"type":"string"},"repeat_days":{"type":"integer","enum":[0,1,7]},"count":{"type":"integer","minimum":1,"maximum":31}},"required":["campaign_id","version","series_id","body","run_at","timezone"],"additionalProperties":false}','campaign.write',false,true,10,15000);
