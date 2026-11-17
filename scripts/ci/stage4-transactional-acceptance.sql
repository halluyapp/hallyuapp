-- Run only through an authorized database administrator. Every fixture/effect rolls back.
-- No external provider/push calls. Uses real public RPCs, policies and post triggers.
do $acceptance$
declare admin_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); campaign_id uuid; ballot_post uuid;
 staff_id uuid:=public.operator_staff_profile_id(); test_post uuid; task_id uuid; approval_id uuid; args jsonb; r jsonb;
 admin_sub text:='stage4-admin-'||gen_random_uuid()::text; member_sub text:='stage4-member-'||gen_random_uuid()::text;
 notification_title text; iteration integer; first_close timestamptz:=now()+interval '1 day'; ballot_key uuid:=gen_random_uuid();
begin
 begin
  insert into public.profiles(id,handle,display_name,auth_sub,role,account_status) values
   (admin_id,'s4a'||substr(replace(admin_id::text,'-',''),1,12),'Stage4 rollback admin',admin_sub,'admin','active'),
   (member_id,'s4m'||substr(replace(member_id::text,'-',''),1,12),'Stage4 rollback member',member_sub,'member','active');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_sub,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  r:=public.operator_campaign_save(null,0,'Stage4 rollback ballot','vote','','','Africa/Lagos',null,null,'draft');
  campaign_id:=(r->>'id')::uuid;
  r:=public.operator_campaign_ballot_launch(campaign_id,1,ballot_key,'Rollback-only drama ballot',array['Drama A','Drama B'],first_close,date_trunc('month',now())::date);
  ballot_post:=(r->>'post_id')::uuid;
  r:=public.operator_campaign_ballot_launch(campaign_id,1,ballot_key,'Rollback-only drama ballot',array['Drama A','Drama B'],first_close,date_trunc('month',now())::date);
  if not (r->>'duplicate')::boolean then raise exception 'ballot replay failed'; end if;
  perform public.vote_post_poll(ballot_post,0);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',member_sub,'role','authenticated')::text,true);
  perform public.vote_post_poll(ballot_post,0); perform public.vote_post_poll(ballot_post,1);
  if (select count(*) from public.post_poll_votes where post_id=ballot_post)<>1 then raise exception 'voter identity privacy failed'; end if;
  begin perform public.operator_stage4_status();raise exception 'member status allowed';exception when insufficient_privilege then null;end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_sub,'role','authenticated')::text,true);
  r:=public.operator_campaign_report(campaign_id);
  if (r->>'total_votes')::integer<>2 or (r->'ballot_options'->1->>'votes')::integer<>1 or r::text like '%'||member_id::text||'%' then raise exception 'aggregate vote report failed'; end if;
  perform public.operator_campaign_finish(campaign_id,2,false);
  begin perform public.vote_post_poll(ballot_post,1);raise exception 'closed ballot allowed vote';exception when invalid_parameter_value then null;end;
  r:=public.operator_stage4_status();
  if not r ? 'scheduler' or not r ? 'specialist_activity' or not r ? 'usage_24h' then raise exception 'status missing backend sections'; end if;
  execute 'reset role';
  begin update public.post_polls set options=array['Changed','Ballot'] where post_id=ballot_post;raise exception 'ballot mutation allowed' using errcode='ZX999';exception when sqlstate 'P0001' then null;end;
  insert into public.posts(author_id,type,body,visibility,state) values(staff_id,'post','Original rollback body','public','active') returning id into test_post;
  task_id:=gen_random_uuid(); approval_id:=gen_random_uuid(); args:=jsonb_build_object('post_id',test_post,'body','Approved rollback replacement');
  insert into public.operator_task(id,task_type,status,requester_profile_id) values(task_id,'admin_command','awaiting_approval',admin_id);
  insert into public.operator_approval(id,task_id,action,status,payload) values(approval_id,task_id,'post.edit','pending',jsonb_build_object('tool','post.edit','arguments',args));
  perform public.operator_decide_approval(approval_id,'approved','Rollback-only acceptance');
  update public.operator_task set status='executing',lease_owner='stage4-rollback',lease_expires_at=now()+interval '2 minutes' where id=task_id;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_sub,'role','service_role')::text,true);
  update public.posts set body='Changed after proposal' where id=test_post;
  begin perform public.operator_execute_approved(approval_id,task_id,'post.edit',args);raise exception 'stale target allowed';exception when insufficient_privilege then null;end;
  if exists(select 1 from public.operator_approval where id=approval_id and consumed_at is not null) then raise exception 'rejected target consumed grant'; end if;
  update public.posts set body='Original rollback body' where id=test_post;
  r:=public.operator_execute_approved(approval_id,task_id,'post.edit',args);
  if not (r->>'verified')::boolean or not exists(select 1 from public.posts where id=test_post and body='Approved rollback replacement') then raise exception 'atomic replacement failed'; end if;
  begin perform public.operator_execute_approved(approval_id,task_id,'post.edit',args);raise exception 'approval reused';exception when insufficient_privilege then null;end;
  -- Isolate notification recipients to the fixture admin's own follower relation only.
  update public.operator_policy set notifications=notifications||'{"quiet_hours":{"start":"00:00","end":"00:00"},"max_per_hour":999,"max_per_day":999}'::jsonb where id=true;
  insert into public.user_preferences(user_id,notify_system,quiet_hours) values(member_id,false,true) on conflict(user_id) do update set notify_system=false,quiet_hours=true;
  insert into public.follows(follower_id,target_id) values(member_id,admin_id);
  for iteration in 0..3 loop
   task_id:=gen_random_uuid();approval_id:=gen_random_uuid();notification_title:='Stage4 rollback '||task_id::text;
   args:=jsonb_build_object('title',notification_title,'body','Rollback only','audience','followers');
   insert into public.operator_task(id,task_type,status,requester_profile_id) values(task_id,'admin_command','awaiting_approval',admin_id);
   insert into public.operator_approval(id,task_id,action,status,payload) values(approval_id,task_id,'notification.send','pending',jsonb_build_object('tool','notification.send','arguments',args));
   perform public.operator_decide_approval(approval_id,'approved','Rollback-only notification acceptance');
   update public.operator_task set status='executing',lease_owner='stage4-rollback',lease_expires_at=now()+interval '2 minutes' where id=task_id;
   perform set_config('hallyu.approved_executor','on',true);
   if not public.operator_consume_approval(approval_id,task_id,'notification.send',args) then raise exception 'notification grant failed'; end if;
   if iteration=1 then update public.user_preferences set notify_system=true where user_id=member_id;end if;
   if iteration=2 then insert into public.blocks(blocker_id,blocked_id) values(member_id,admin_id);end if;
   if iteration=3 then
    delete from public.blocks where blocker_id=member_id and blocked_id=admin_id;
    insert into public.notifications(recipient_id,kind,"group",title,body,dedupe_key) values(member_id,'system','system','Fixture','Fixture','operator:fixture-a'),(member_id,'system','system','Fixture','Fixture','operator:fixture-b');
   end if;
   r:=public.operator_notify_approved(task_id,admin_id,notification_title,'Rollback only','followers',null);
   if (iteration=1 and (r->>'queued')::integer<>1) or (iteration<>1 and (r->>'queued')::integer<>0) then raise exception 'preference/block/cap notification check failed: %',r;end if;
   r:=public.operator_notify_approved(task_id,admin_id,notification_title,'Rollback only','followers',null);
   if not (r->>'duplicate')::boolean then raise exception 'notification replay failed';end if;
  end loop;
  if public.notify_at_for(member_id,'2026-11-17T23:00:00Z')<='2026-11-17T23:00:00Z' then raise exception 'overnight quiet hours not deferred';end if;
  raise exception 'successful rollback-only acceptance' using errcode='ZX104';
 exception when sqlstate 'ZX104' then null;
 end;
 if exists(select 1 from public.profiles where id in (admin_id,member_id)) or exists(select 1 from public.operator_campaign where id=campaign_id) or exists(select 1 from public.posts where id in (test_post,ballot_post)) then raise exception 'fixture rollback failed';end if;
end;
$acceptance$;
select 'PASS: independent monthly ballot/replay/vote/privacy/closure/report/status; atomic approval stale-target/replay; notification preference/block/cap/dedupe/quiet-hours; all fixtures rolled back' as stage4_acceptance;
