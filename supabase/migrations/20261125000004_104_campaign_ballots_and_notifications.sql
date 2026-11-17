-- Independent ballots reuse the existing public post/poll/vote UI and identity rules.
alter table public.operator_campaign add column ballot_month date;
create unique index operator_campaign_monthly_ballot on public.operator_campaign(ballot_month)
 where ballot_month is not null and status<>'cancelled';

create or replace function public.operator_campaign_ballot_launch(p_campaign uuid,p_version integer,p_key uuid,
 p_question text,p_options text[],p_closes timestamptz,p_month date default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare actor uuid:=public.current_profile_id(); c public.operator_campaign; pid uuid; spec jsonb;
begin
 if actor is null or not public.is_admin() then raise exception 'admin role required' using errcode='42501'; end if;
 if p_key is null or p_question is null or length(btrim(p_question)) not between 1 and 240
   or p_options is null or cardinality(p_options) not between 2 and 4
   or exists(select 1 from unnest(p_options) x where x is null or length(btrim(x)) not between 1 and 80)
   or (select count(distinct lower(btrim(x))) from unnest(p_options) x)<>cardinality(p_options)
   or p_closes is null then raise exception 'invalid ballot fields' using errcode='22023'; end if;
 spec:=jsonb_build_object('key',p_key,'question',p_question,'options',p_options,'closes_at',p_closes,'month',p_month,'actor',actor);
 select * into c from public.operator_campaign where id=p_campaign for update;
 if c.id is null then raise exception 'campaign missing' using errcode='P0002'; end if;
 if c.payload->'ballot_approval' is not null then
   if c.payload->'ballot_approval' is distinct from spec then raise exception 'ballot already launched with different approval'; end if;
   return jsonb_build_object('post_id',c.post_id,'duplicate',true,'verified',true);
 end if;
 if c.version is distinct from p_version or c.status<>'draft' or c.kind not in ('poll','vote') then raise exception 'refresh draft poll/vote campaign' using errcode='40001'; end if;
 if p_closes<=now() or p_closes>now()+interval '90 days' or (c.starts_at is not null and c.starts_at>now()) then raise exception 'ballot must open now and close within 90 days' using errcode='22023'; end if;
 if p_month is not null and (c.kind<>'vote' or p_month<>date_trunc('month',p_month)::date or p_month<date_trunc('month',now())::date or p_month>(date_trunc('month',now())+interval '2 months')::date) then raise exception 'monthly voting requires current or next two calendar months' using errcode='22023'; end if;
 insert into public.posts(author_id,type,body,visibility,state) values(actor,'post',p_question,'public','active') returning id into pid;
 insert into public.post_polls(post_id,question,options,closes_at) values(pid,p_question,p_options,p_closes);
 update public.operator_campaign set post_id=pid,status='active',starts_at=coalesce(starts_at,now()),ends_at=p_closes,
   ballot_month=p_month,payload=payload||jsonb_build_object('ballot_approval',spec),version=version+1,updated_at=now() where id=c.id;
 if not exists(select 1 from public.post_polls where post_id=pid and options=p_options and question=p_question) then raise exception 'ballot readback failed'; end if;
 perform public.operator_audit_write('campaign.ballot.launched','succeeded',null,actor,'admin','campaign',c.id::text,jsonb_build_object('post_id',pid,'approval',spec));
 return jsonb_build_object('post_id',pid,'duplicate',false,'verified',true);
end; $$;
revoke all on function public.operator_campaign_ballot_launch(uuid,integer,uuid,text,text[],timestamptz,date) from public,anon;
grant execute on function public.operator_campaign_ballot_launch(uuid,integer,uuid,text,text[],timestamptz,date) to authenticated;

create or replace function public.operator_campaign_finish(p_campaign uuid,p_version integer,p_cancel boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.operator_campaign; actor uuid:=public.current_profile_id();
begin
 if actor is null or not public.is_admin() then raise exception 'admin role required' using errcode='42501'; end if;
 select * into c from public.operator_campaign where id=p_campaign for update;
 if c.id is null or c.version is distinct from p_version or c.status in ('cancelled','completed') then raise exception 'campaign changed; refresh' using errcode='40001'; end if;
 update public.post_polls set closes_at=least(coalesce(closes_at,now()),now()) where post_id=c.post_id;
 update public.operator_campaign_action set status='cancelled',finished_at=now() where campaign_id=c.id and status='scheduled';
 update public.operator_campaign set status=case when p_cancel then 'cancelled' else 'completed' end,version=version+1,updated_at=now() where id=c.id;
 perform public.operator_audit_write('campaign.finished','succeeded',null,actor,'admin','campaign',c.id::text,jsonb_build_object('cancelled',p_cancel));
 return jsonb_build_object('id',c.id,'status',case when p_cancel then 'cancelled' else 'completed' end,'verified',true);
end; $$;
revoke all on function public.operator_campaign_finish(uuid,integer,boolean) from public,anon;
grant execute on function public.operator_campaign_finish(uuid,integer,boolean) to authenticated;

create or replace function public.operator_campaign_report(p_campaign uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.operator_campaign; totals jsonb;
begin
 if not public.is_admin() then raise exception 'admin role required' using errcode='42501'; end if;
 select * into c from public.operator_campaign where id=p_campaign;
 if c.id is null then raise exception 'campaign missing'; end if;
 select coalesce(jsonb_object_agg(status,n),'{}') into totals from (select status,count(*) n from public.operator_campaign_action where campaign_id=c.id group by status) x;
 return jsonb_build_object('campaign_id',c.id,'status',c.status,'announcement_counts',totals,'post_id',c.post_id,
   'ballot_month',c.ballot_month,'closes_at',(select closes_at from public.post_polls where post_id=c.post_id),
   'ballot_options',(select jsonb_agg(jsonb_build_object('option',opt,'votes',(select count(*) from public.post_poll_votes v where v.post_id=c.post_id and v.option_index=idx-1)) order by idx) from public.post_polls pp cross join lateral unnest(pp.options) with ordinality x(opt,idx) where pp.post_id=c.post_id),
   'total_votes',(select count(*) from public.post_poll_votes where post_id=c.post_id),
   'comments',(select count(*) from public.comments where post_id=c.post_id and state='active'),
   'measured_at',now(),'limitation','Persisted votes/comments/publications only; no inferred impressions or conversions');
end; $$;
revoke all on function public.operator_campaign_report(uuid) from public,anon;
grant execute on function public.operator_campaign_report(uuid) to authenticated;

-- Atomic notification audience selection, per-run dedupe/caps and preference-aware enqueue.
-- Zero eligible followers/world members is ZERO, never an implicit all-members broadcast.
create unique index operator_notification_task_once on public.operator_notification_run(task_id) where task_id is not null;
create or replace function public.operator_notify_approved(p_task uuid,p_staff uuid,p_title text,p_body text,p_audience text,p_world text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare cfg jsonb; r public.operator_notification_run; recipient record; nid uuid; queued integer:=0; eligible integer:=0; hour_now integer:=extract(hour from now() at time zone 'UTC'); qs integer; qe integer; due timestamptz; reason text;
begin
 perform public.operator_require_service();
 if p_task is null or p_audience is null or p_audience not in ('all','world','followers') or length(btrim(coalesce(p_title,''))) not between 1 and 120 or length(btrim(coalesce(p_body,''))) not between 1 and 500 or (p_audience='world' and coalesce(p_world,'') not in ('kdrama','cdrama','anime','hollywood')) then raise exception 'invalid notification'; end if;
 -- The gateway already consumed the grant; bind server execution to that exact consumed payload.
 if not exists(select 1 from public.operator_approval a where a.task_id=p_task and a.action='notification.send' and a.status='approved' and a.consumed_at is not null and a.expires_at>now() and exists(select 1 from public.profiles p where p.id=a.decided_by and p.role in ('admin','ceo') and p.account_status='active')) then raise exception 'consumed live approval required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(104,1);
 select * into r from public.operator_notification_run where task_id=p_task;
 if r.id is not null then return jsonb_build_object('run_id',r.id,'queued',r.delivered_count,'duplicate',true,'verified',true); end if;
 select notifications into cfg from public.operator_policy where id=true;
 if cfg is null then raise exception 'notification policy unavailable'; end if;
 qs:=extract(hour from coalesce((cfg->'quiet_hours'->>'start')::time,'00:00'::time));
 qe:=extract(hour from coalesce((cfg->'quiet_hours'->>'end')::time,'07:00'::time));
 if (qs<qe and hour_now>=qs and hour_now<qe) or (qs>qe and (hour_now>=qs or hour_now<qe)) then reason:='global_quiet_hours';
 elsif (select count(*) from public.operator_notification_run where created_at>now()-interval '1 hour')>=greatest(1,coalesce((cfg->>'max_per_hour')::integer,4)) then reason:='hourly_cap';
 elsif (select count(*) from public.operator_notification_run where created_at>now()-interval '24 hours')>=greatest(1,coalesce((cfg->>'max_per_day')::integer,12)) then reason:='daily_cap';
 elsif exists(select 1 from public.operator_notification_run where title=p_title and body=p_body and created_at>now()-make_interval(hours=>greatest(1,coalesce((cfg->>'dedupe_window_hours')::integer,72)))) then reason:='duplicate_content'; end if;
 if reason is not null then return jsonb_build_object('suppressed',true,'reason',reason,'queued',0,'verified',true); end if;
 for recipient in select p.id from public.profiles p where p.account_status='active' and p.id<>p_staff and
   (p_audience='all' or (p_audience='world' and p_world=any(p.worlds)) or (p_audience='followers' and exists(select 1 from public.follows f where f.target_id=p_staff and f.follower_id=p.id))) order by p.id limit 5001
 loop
  eligible:=eligible+1; if eligible>5000 then raise exception 'audience exceeds 5000; narrow audience'; end if;
  perform pg_advisory_xact_lock(hashtextextended(recipient.id::text,104));
  if (select count(*) from public.notifications n where n.recipient_id=recipient.id and n.dedupe_key like 'operator:%' and n.created_at>now()-interval '24 hours')>=3 then continue; end if;
  due:=greatest(now(),public.notify_at_for(recipient.id,now()));
  nid:=public.enqueue_notification(p_recipient=>recipient.id,p_kind=>'system',p_group=>'system',p_dedupe_key=>'operator:'||p_task::text,p_actor_ids=>array[p_staff],p_title=>p_title,p_body=>p_body,p_deep_link=>'/',p_scheduled_for=>due);
  if nid is not null then queued:=queued+1; end if;
 end loop;
 insert into public.operator_notification_run(title,body,audience,audience_filter,kind,status,target_count,delivered_count,failed_count,task_id,finished_at)
 values(p_title,p_body,p_audience,jsonb_build_object('world',p_world,'counts_mean','persisted notification rows, not push delivery'),'system','sent',eligible,queued,0,p_task,now()) returning * into r;
 perform public.operator_audit_write('notification.queued','succeeded',p_task,p_staff,'staff','notification_run',r.id::text,jsonb_build_object('eligible',eligible,'queued',queued));
 return jsonb_build_object('run_id',r.id,'eligible',eligible,'queued',queued,'push_delivery_verified',false,'verified',true);
end; $$;
revoke all on function public.operator_notify_approved(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.operator_notify_approved(uuid,uuid,text,text,text,text) to service_role;

-- Re-evaluate local quiet hours at enqueue AND delivery. Locale is never a timezone.
create or replace function public.notify_at_for(p_user_id uuid,p_moment timestamptz)
returns timestamptz language sql stable security definer set search_path=public,pg_temp as $$
 select case when not coalesce((select quiet_hours from public.user_preferences where user_id=p_user_id),false) then p_moment
 when extract(hour from p_moment at time zone public.member_time_zone(p_user_id))<9 then
   (date_trunc('day',p_moment at time zone public.member_time_zone(p_user_id))+interval '9 hours') at time zone public.member_time_zone(p_user_id)
 when extract(hour from p_moment at time zone public.member_time_zone(p_user_id))>=22 then
   (date_trunc('day',p_moment at time zone public.member_time_zone(p_user_id))+interval '1 day 9 hours') at time zone public.member_time_zone(p_user_id)
 else p_moment end;
$$;
revoke all on function public.notify_at_for(uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.notify_at_for(uuid,timestamptz) to service_role;

-- Surgical forward change to the exact deployed 103 function; fail rather than patch unknown SQL.
do $patch$
declare definition text;
begin
 select pg_get_functiondef('public.operator_campaign_action_sweep()'::regprocedure) into definition;
 if position('where campaign_row.status in' in definition)=0 then raise exception 'unexpected campaign sweep definition'; end if;
 execute replace(definition,'where campaign_row.status in','where campaign_row.payload->''ballot_approval'' is null and campaign_row.status in');
end;
$patch$;

create or replace function public.operator_campaign_ballot_tick()
returns void language sql security definer set search_path=public,pg_temp as $$
 update public.operator_campaign set status='completed',version=version+1,updated_at=now()
 where status='active' and payload->'ballot_approval' is not null and ends_at<=now();
$$;
revoke all on function public.operator_campaign_ballot_tick() from public,anon,authenticated;
grant execute on function public.operator_campaign_ballot_tick() to service_role;
select cron.schedule('hallyu-campaign-announcements','* * * * *','select public.operator_campaign_action_sweep(); select public.operator_campaign_ballot_tick();');
