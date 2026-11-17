-- Voter identities are private; public/member poll RPCs expose aggregates and one's own vote.
drop policy if exists post_poll_votes_select_all on public.post_poll_votes;
create policy post_poll_votes_private_read on public.post_poll_votes for select to authenticated
 using(user_id=public.current_profile_id() or public.is_admin());

create or replace function public.operator_ballot_immutable()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if exists(select 1 from public.operator_campaign where post_id=old.post_id and payload->'ballot_approval' is not null) and
  (new.options is distinct from old.options or new.question is distinct from old.question or new.post_id is distinct from old.post_id or new.closes_at is null or new.closes_at>old.closes_at) then
   raise exception 'Launched campaign ballot is immutable; close or cancel it instead';
 end if;
 return new;
end; $$;
create trigger operator_campaign_ballot_immutable before update on public.post_polls for each row execute function public.operator_ballot_immutable();

create or replace function public.operator_stage4_status()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.is_admin() then raise exception 'admin role required' using errcode='42501'; end if;
 return jsonb_build_object('checked_at',now(),
 'policy',(select jsonb_build_object('autonomy',autonomy,'notifications',notifications,'providers',providers,'approval_required',approval_required) from public.operator_policy where id=true),
 'providers',(select coalesce(jsonb_agg(jsonb_build_object('provider',provider,'model',model_id,'enabled',enabled,'default',is_default,'health',health,'last_ok',last_ok_at,'last_error',last_error_code)),'[]') from public.operator_provider),
 'workers',(select coalesce(jsonb_agg(to_jsonb(w)),'[]') from (select worker_id,last_seen_at,version,tasks_processed,last_error from public.operator_worker_health order by last_seen_at desc limit 5) w),
 'scheduler',(select coalesce(jsonb_agg(to_jsonb(j)),'[]') from (select jobname,active,schedule,(select jsonb_build_object('status',r.status,'started',r.start_time,'finished',r.end_time,'detail',r.return_message) from cron.job_run_details r where r.jobid=c.jobid order by start_time desc limit 1) as last_run from cron.job c where jobname in ('hallyu-operator-tick','hallyu-campaign-announcements')) j),
 'tasks',(select coalesce(jsonb_object_agg(status,n),'{}') from (select status,count(*) n from public.operator_task group by status) t),
 'pending_approvals',(select count(*) from public.operator_approval where status='pending' and expires_at>now()),
 'campaigns',(select coalesce(jsonb_object_agg(status,n),'{}') from (select status,count(*) n from public.operator_campaign group by status) c),
 'usage_24h',(select coalesce(jsonb_agg(to_jsonb(u)),'[]') from (select provider,model,count(*) requests,sum(total_tokens) tokens,sum(estimated_cost_usd) estimated_usd from public.operator_provider_usage where created_at>now()-interval '24 hours' group by provider,model) u),
 'recent_actions',(select coalesce(jsonb_agg(to_jsonb(a)),'[]') from (select id,action,outcome,resource_type,resource_id,created_at from public.operator_audit order by created_at desc limit 20) a),
 'specialist_activity',(select coalesce(jsonb_agg(to_jsonb(a)),'[]') from (select task_id,action,outcome,details,created_at from public.operator_audit where action like 'specialist.%' order by created_at desc limit 20) a),
 'actionable_errors',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from (select id,task_type,status,error_code,left(error_detail,300) as detail,updated_at from public.operator_task where status in ('failed','dead') order by updated_at desc limit 20) t),
 'unanswered_conversations',(select count(*) from public.operator_conversation c where exists(select 1 from public.operator_message m where m.conversation_id=c.id and m.direction='inbound' and m.created_at<now()-interval '1 hour' and not exists(select 1 from public.operator_message reply where reply.conversation_id=c.id and reply.direction='outbound' and reply.created_at>m.created_at))),
 'limitation','Observed timestamps/counts, not a synthetic healthy flag. Usage cost is estimated; absent heartbeat or scheduler evidence is unknown. Specialist passes are draft-only and inherit the same provider/budget/constitution.');
end; $$;
revoke all on function public.operator_stage4_status() from public,anon;
grant execute on function public.operator_stage4_status() to authenticated;

insert into public.operator_tool(name,description,family,input_schema,permission,read_only,approval_required,rate_limit_per_min,timeout_ms) values
 ('moderation.flag','Escalate a concern for human review without removing content or restricting an account.','moderation','{"type":"object","properties":{"target_type":{"type":"string","enum":["post","comment","user"]},"target_id":{"type":"string","format":"uuid"},"reason":{"type":"string","minLength":3,"maxLength":500},"confidence":{"type":"number","minimum":0,"maximum":1}},"required":["target_type","target_id","reason"],"additionalProperties":false}','ops.write',false,false,10,10000);

-- Revalidate preferences, account, device ownership and quiet hours at delivery, not just enqueue.
create or replace function public.claim_notification_deliveries(
  p_limit integer default 100,
  p_max_attempts integer default 5
)
returns table (
  delivery_id uuid,
  notification_id uuid,
  push_token_id uuid,
  token text,
  platform public.push_platform,
  attempt integer,
  title text,
  body text,
  deep_link text,
  payload jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  batch_size integer := least(greatest(coalesce(p_limit, 100), 1), 1000);
  attempts_allowed integer := least(greatest(coalesce(p_max_attempts, 5), 1), 10);
begin
  if public.current_profile_id() is not null then
    raise exception 'push delivery is a service-role operation' using errcode = 'insufficient_privilege';
  end if;

  return query
  with due as (
    select d.id
    from public.notification_deliveries d
    join public.notifications n on n.id = d.notification_id
    join public.push_tokens t on t.id = d.push_token_id and t.user_id=n.recipient_id
    join public.profiles recipient on recipient.id=n.recipient_id and recipient.account_status='active'
    join public.user_preferences prefs on prefs.user_id=n.recipient_id
    where d.status in ('queued', 'failed')
      and d.next_attempt_at <= now()
      and d.attempt < attempts_allowed
      and t.disabled_at is null
      and n.scheduled_for <= now()
      and public.notify_at_for(n.recipient_id,now()) <= now()
      and ((n."group"='social' and prefs.notify_social) or (n."group"='system' and prefs.notify_system) or (n."group"='drama' and prefs.notify_episodes))
      and (n.expires_at is null or n.expires_at > now())
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = n.recipient_id and b.blocked_id = any(n.actor_ids))
           or (b.blocked_id = n.recipient_id and b.blocker_id = any(n.actor_ids))
      )
    order by d.next_attempt_at asc, d.created_at asc
    -- `for update skip locked` is what makes two workers at once safe.
    for update of d skip locked
    limit batch_size
  )
  update public.notification_deliveries d
     set status = 'sending',
         attempt = d.attempt + 1,
         updated_at = now()
    from due, public.notifications n, public.push_tokens t
   where d.id = due.id
     and n.id = d.notification_id
     and t.id = d.push_token_id
  returning
    d.id,
    d.notification_id,
    d.push_token_id,
    t.token,
    t.platform,
    d.attempt,
    left(n.title, 160),
    left(n.body, 500),
    left(n.deep_link, 300),
    jsonb_build_object(
      'notification_id', n.id,
      'kind', n.kind,
      'group', n."group",
      'coalesce_count', n.coalesce_count,
      'episode', n.episode,
      'title_id', n.title_id,
      'post_id', n.post_id,
      'comment_id', n.comment_id,
      'community_id', n.community_id,
      'collection_id', n.collection_id
    );
end;
$$;

revoke all on function public.claim_notification_deliveries(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_notification_deliveries(integer, integer) to service_role;
