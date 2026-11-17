-- Authorized rollback-only acceptance of every mutating atomic branch except notification.send
-- (notification recipients/preferences/caps are covered by stage4-transactional-acceptance.sql).
do $atomic$
declare actor uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); sub text:='stage4-atomic-'||gen_random_uuid()::text;
 task_id uuid; aid uuid; pid uuid; mid uuid; cid uuid; action text; args jsonb; result jsonb;
begin
 begin
  insert into public.profiles(id,handle,display_name,auth_sub,role,account_status) values(actor,'s4at'||substr(replace(actor::text,'-',''),1,12),'Atomic rollback admin',sub,'admin','active'),(member_id,'s4mt'||substr(replace(member_id::text,'-',''),1,12),'Atomic rollback member','atomic-member-'||member_id::text,'member','active');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',sub,'role','service_role')::text,true);
  result:=public.operator_campaign_save(null,0,'Atomic rollback schedule','campaign','','','UTC',null,null,'draft');cid:=(result->>'id')::uuid;
  foreach action in array array['post.create','post.publish','poll.create','post.edit','moderation.remove_content','moderation.restore','post.delete','moderation.suspend','moderation.ban','campaign.schedule'] loop
   args:=case action
    when 'post.create' then jsonb_build_object('body','Rollback-only atomic post','type','post')
    when 'post.publish' then jsonb_build_object('post_id',pid)
    when 'poll.create' then jsonb_build_object('post_id',pid,'question','Rollback poll','options',jsonb_build_array('A','B'))
    when 'post.edit' then jsonb_build_object('post_id',pid,'body','Exact edited rollback body')
    when 'moderation.remove_content' then jsonb_build_object('target_type','post','target_id',pid,'reason','Rollback moderation acceptance','rule_code','test','confidence',1)
    when 'moderation.restore' then jsonb_build_object('moderation_action_id',mid,'reason','Rollback restoration acceptance')
    when 'post.delete' then jsonb_build_object('post_id',pid,'reason','Rollback deletion acceptance')
    when 'moderation.suspend' then jsonb_build_object('profile_id',member_id,'days',1,'reason','Rollback suspension acceptance','rule_code','test','confidence',1)
    when 'moderation.ban' then jsonb_build_object('profile_id',member_id,'reason','Rollback ban acceptance','rule_code','test','confidence',1)
    when 'campaign.schedule' then jsonb_build_object('campaign_id',cid,'version',1,'series_id',gen_random_uuid(),'body','Future rollback announcement','run_at',now()+interval '1 day','timezone','UTC','repeat_days',7,'count',2) end;
   task_id:=gen_random_uuid();aid:=gen_random_uuid();
   insert into public.operator_task(id,task_type,status,requester_profile_id) values(task_id,'admin_command','awaiting_approval',actor);
   insert into public.operator_approval(id,task_id,action,status,payload) values(aid,task_id,action,'pending',jsonb_build_object('tool',action,'arguments',args));
   perform public.operator_decide_approval(aid,'approved','Rollback atomic branch test');
   update public.operator_task set status='executing',lease_owner='rollback-atomic',lease_expires_at=now()+interval '2 minutes' where id=task_id;
   result:=public.operator_execute_approved(aid,task_id,action,args);
   if action='post.create' then pid:=(result->>'post_id')::uuid;end if;
   if action='moderation.remove_content' then mid:=(result->>'moderation_action_id')::uuid;end if;
   if action='campaign.schedule' then
    if (result->>'occurrences')::integer<>2 then raise exception 'schedule branch failed';end if;
   elsif coalesce((result->>'verified')::boolean,false) is not true then raise exception 'unverified atomic branch %: %',action,result;end if;
   if not exists(select 1 from public.operator_approval where id=aid and consumed_at is not null) then raise exception 'grant not consumed';end if;
  end loop;
  if not exists(select 1 from public.profiles where id=member_id and account_status='suspended' and is_banned=true) or not exists(select 1 from public.posts where id=pid and state='deleted') or (select count(*) from public.operator_campaign_action where campaign_id=cid)<>2 then raise exception 'final atomic state not verified';end if;
  raise exception 'successful rollback-only atomic branches' using errcode='ZX105';
 exception when sqlstate 'ZX105' then null;end;
 if exists(select 1 from public.profiles where id in(actor,member_id)) or exists(select 1 from public.posts where id=pid) or exists(select 1 from public.operator_campaign where id=cid) then raise exception 'atomic cleanup failed';end if;
end;$atomic$;
select 'PASS: ten atomic approved-action branches against real schema; all effects rolled back' as acceptance;
