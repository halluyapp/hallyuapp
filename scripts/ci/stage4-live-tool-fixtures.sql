-- Run with authorized SQL access. Creates only isolated fixtures; no public post.
-- Deploy the digest-pinned operator-acceptance endpoint temporarily, then invoke
-- mode=stage4_tools with returned run_id and Vault worker authentication (never print token).
-- Read the HTTP response AND ledger checks; execute cleanup below even on failure.
do $fixture$
declare actor uuid:=gen_random_uuid();conv uuid:=gen_random_uuid();task uuid:=gen_random_uuid();retry uuid:=gen_random_uuid();post uuid:=gen_random_uuid();comment uuid:=gen_random_uuid();run uuid:=gen_random_uuid();handle text:='s4gw'||substr(replace(actor::text,'-',''),1,12);
begin
 insert into public.profiles(id,handle,display_name,auth_sub,role,account_status) values(actor,handle,'Isolated Stage4 gateway fixture','stage4-gateway-'||actor::text,'admin','active');
 insert into public.operator_conversation(id,channel,member_profile_id) values(conv,'admin_control',actor);
 insert into public.posts(id,author_id,type,body,state,hidden_at) values(post,actor,'post','Hidden Stage4 fixture','hidden',now());
 insert into public.comments(id,post_id,author_id,body) values(comment,post,actor,'Hidden fixture parent');
 insert into public.operator_task(id,task_type,status,requester_profile_id,conversation_id,destination_type,max_attempts,input) values(task,'admin_command','cancelled',actor,conv,'admin_control',1,'{}'),(retry,'admin_command','failed',actor,conv,'admin_control',1,'{"instruction":"Isolated fixture: no tools, messages, or changes."}');
 insert into public.operator_acceptance_run(id,state,report) values(run,'running',jsonb_build_object('kind','stage4_tools','profile_id',actor,'handle',handle,'conversation_id',conv,'task_id',task,'retry_task_id',retry,'post_id',post,'comment_id',comment,'expires_at',now()+interval '15 minutes'));
end;$fixture$;
select id as run_id,report from public.operator_acceptance_run where report->>'kind'='stage4_tools' and state='running' order by created_at desc limit 1;

-- CLEANUP (execute separately, with the actual run UUID from above):
-- select set_config('hallyu.stage4_cleanup_run','ACTUAL_RETURNED_RUN_UUID',false);
-- The guard refuses nonfixture ledgers. Do not run the cleanup without that setting.
/*
do $cleanup$
declare run uuid:=current_setting('hallyu.stage4_cleanup_run')::uuid; f jsonb; passed boolean;
begin
 select report into f from public.operator_acceptance_run where id=run for update;
 if f->>'kind' is distinct from 'stage4_tools' then raise exception 'not a Stage4 fixture';end if;
 passed:=(select count(*)=16 and bool_and(value->>'status'='pass') from jsonb_each(f->'checks'));
 delete from public.operator_moderation_case where task_id=(f->>'task_id')::uuid;
 delete from public.operator_research_item where topic=run::text;
 delete from public.operator_campaign where name='Stage4 '||run::text;
 delete from public.operator_message where conversation_id=(f->>'conversation_id')::uuid;
 delete from public.direct_messages where recipient_id=(f->>'profile_id')::uuid;
 delete from public.comments where post_id=(f->>'post_id')::uuid;
 delete from public.posts where id=(f->>'post_id')::uuid;
 delete from public.operator_task where id in ((f->>'task_id')::uuid,(f->>'retry_task_id')::uuid);
 delete from public.operator_conversation where id=(f->>'conversation_id')::uuid;
 delete from public.profiles where id=(f->>'profile_id')::uuid and auth_sub like 'stage4-gateway-%';
 if exists(select 1 from public.profiles where id=(f->>'profile_id')::uuid) or exists(select 1 from public.posts where id=(f->>'post_id')::uuid) or exists(select 1 from public.operator_task where id in((f->>'task_id')::uuid,(f->>'retry_task_id')::uuid)) or exists(select 1 from public.notifications where recipient_id=(f->>'profile_id')::uuid) then raise exception 'cleanup failed';end if;
 update public.operator_acceptance_run set state=case when passed then 'finished' else 'failed' end,finished_at=now(),report=report||jsonb_build_object('cleanup','pass','acceptance',case when passed then 'pass' else 'failed' end) where id=run;
end;$cleanup$;
*/
