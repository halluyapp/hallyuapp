-- Human-approved independent campaign announcements. No model calls, service key in client,
-- or Nari-enabled dependency. Each immutable occurrence publishes under its approving admin.
create table public.operator_campaign_action (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.operator_campaign(id) on delete cascade,
  series_id uuid not null,
  occurrence integer not null check(occurrence between 0 and 30),
  repeat_days integer not null check(repeat_days in (0,1,7)),
  body text not null check(length(btrim(body)) between 1 and 5000),
  timezone text not null,
  run_at timestamptz not null,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz not null default now(),
  status text not null default 'scheduled' check(status in ('scheduled','published','cancelled','missed','blocked','failed')),
  post_id uuid references public.posts(id) on delete set null,
  finished_at timestamptz,
  error_code text,
  unique(series_id,occurrence)
);
create index operator_campaign_action_due on public.operator_campaign_action(run_at) where status='scheduled';
create index operator_campaign_action_history on public.operator_campaign_action(campaign_id,run_at desc);
create index operator_campaign_action_actor_pending on public.operator_campaign_action(approved_by) where status='scheduled';
alter table public.operator_campaign_action enable row level security;
revoke all on public.operator_campaign_action from public,anon,authenticated;
grant select on public.operator_campaign_action to authenticated;
grant all on public.operator_campaign_action to service_role;
create policy campaign_action_admin_read on public.operator_campaign_action for select to authenticated using(public.is_admin());

create or replace function public.operator_campaign_schedule(
  p_campaign uuid,p_expected_version integer,p_series uuid,p_body text,p_at timestamptz,
  p_timezone text,p_repeat_days integer default 0,p_count integer default 1
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare actor uuid:=public.current_profile_id(); c public.operator_campaign; first_action public.operator_campaign_action; i integer; due timestamptz; n integer;
begin
  if actor is null or not public.is_admin() then raise exception 'admin role required' using errcode='42501'; end if;
  if p_series is null or p_body is null or length(btrim(p_body)) not between 1 and 5000 or p_at is null
    or p_repeat_days is null or p_repeat_days not in (0,1,7) or p_count is null or p_count not between 1 and 31
    or (p_repeat_days=0 and p_count<>1) or p_timezone is null
    or not exists(select 1 from pg_timezone_names where name=p_timezone) then
    raise exception 'invalid announcement schedule' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text,103));
  select * into c from public.operator_campaign where id=p_campaign for update;
  if c.id is null then raise exception 'campaign not found' using errcode='P0002'; end if;
  select * into first_action from public.operator_campaign_action where series_id=p_series and occurrence=0;
  if first_action.id is not null then
    select count(*) into n from public.operator_campaign_action where series_id=p_series;
    if first_action.campaign_id<>p_campaign or first_action.approved_by is distinct from actor or first_action.body<>p_body
      or first_action.run_at<>p_at or first_action.timezone<>p_timezone or first_action.repeat_days<>p_repeat_days or n<>p_count then
      raise exception 'schedule request key already used for different content' using errcode='23505';
    end if;
    return jsonb_build_object('series_id',p_series,'occurrences',n,'duplicate',true);
  end if;
  if c.version is distinct from p_expected_version or c.status not in ('draft','scheduled','active') then
    raise exception 'campaign changed or is not schedulable; refresh' using errcode='40001';
  end if;
  if (select count(*) from public.operator_campaign_action where campaign_id=p_campaign and status='scheduled')+p_count>100
    or (select count(*) from public.operator_campaign_action where approved_by=actor and status='scheduled')+p_count>500 then
    raise exception 'pending announcement limit exceeded' using errcode='54000';
  end if;
  if p_at<=now() or p_at>now()+interval '90 days' then raise exception 'schedule must be within the next 90 days' using errcode='22023'; end if;
  for i in 0..p_count-1 loop
    -- Keep the supplied first instant even in a DST overlap. Later calendar occurrences use
    -- PostgreSQL timezone rules (standard-time preference for nonexistent/ambiguous wall times).
    due:=case when i=0 then p_at else ((p_at at time zone p_timezone)+make_interval(days=>i*p_repeat_days)) at time zone p_timezone end;
    if due>now()+interval '90 days' then raise exception 'recurrence exceeds 90-day approval horizon' using errcode='22023'; end if;
    insert into public.operator_campaign_action(campaign_id,series_id,occurrence,repeat_days,body,timezone,run_at,approved_by)
    values(c.id,p_series,i,p_repeat_days,p_body,p_timezone,due,actor);
  end loop;
  update public.operator_campaign set status=case when status='active' then 'active' else 'scheduled' end,version=version+1,updated_at=now() where id=c.id;
  perform public.operator_audit_write('campaign.schedule.approved','succeeded',null,actor,'admin','campaign',c.id::text,
    jsonb_build_object('series_id',p_series,'count',p_count,'timezone',p_timezone,'first_run_at',p_at));
  return jsonb_build_object('series_id',p_series,'occurrences',p_count,'duplicate',false);
end;
$$;
revoke all on function public.operator_campaign_schedule(uuid,integer,uuid,text,timestamptz,text,integer,integer) from public,anon;
grant execute on function public.operator_campaign_schedule(uuid,integer,uuid,text,timestamptz,text,integer,integer) to authenticated;

create or replace function public.operator_campaign_action_cancel(p_action uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare actor uuid:=public.current_profile_id(); a public.operator_campaign_action;
begin
  if actor is null or not public.is_admin() then raise exception 'admin role required' using errcode='42501'; end if;
  select * into a from public.operator_campaign_action where id=p_action for update;
  if a.id is null then raise exception 'scheduled action not found' using errcode='P0002'; end if;
  if a.status='cancelled' then return jsonb_build_object('id',a.id,'status','cancelled'); end if;
  if a.status<>'scheduled' then raise exception 'action already processed; cannot cancel' using errcode='23514'; end if;
  update public.operator_campaign_action set status='cancelled',finished_at=now() where id=a.id;
  perform public.operator_audit_write('campaign.schedule.cancelled','succeeded',null,actor,'admin','campaign_action',a.id::text,'{}'::jsonb);
  return jsonb_build_object('id',a.id,'status','cancelled');
end;
$$;
revoke all on function public.operator_campaign_action_cancel(uuid) from public,anon;
grant execute on function public.operator_campaign_action_cancel(uuid) to authenticated;

create or replace function public.operator_campaign_action_sweep()
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.operator_campaign_action; c public.operator_campaign; published_id uuid; processed integer:=0;
begin
  if not pg_try_advisory_xact_lock(103,1) then return 0; end if;
  -- Callable by the existing database's cron owner and service role only (grants below).
  -- Locking each immutable occurrence and publishing in the same transaction prevents duplicates.
  for a in select * from public.operator_campaign_action where status='scheduled' and run_at<=now()
    order by run_at,id limit 50
  loop
    begin
      -- Same campaign-before-action lock order as scheduling; recheck after waiting.
      select * into c from public.operator_campaign where id=a.campaign_id for update;
      select * into a from public.operator_campaign_action where id=a.id for update;
      if a.status<>'scheduled' then continue; end if;
      perform 1 from public.profiles where id=a.approved_by for share;
      if c.status not in ('scheduled','active') or not exists(select 1 from public.profiles where id=a.approved_by and role in ('admin','ceo') and account_status='active') then
        update public.operator_campaign_action set status='blocked',error_code='approval_or_campaign_revoked',finished_at=now() where id=a.id;
      elsif a.run_at<now()-interval '24 hours' then
        update public.operator_campaign_action set status='missed',error_code='missed_grace_window',finished_at=now() where id=a.id;
      else
        insert into public.posts(author_id,type,body,visibility,state)
        values(a.approved_by,'post',a.body,'public','active') returning id into published_id;
        if not exists(select 1 from public.posts where id=published_id and author_id=a.approved_by and body=a.body and state='active') then
          raise exception 'post verification failed';
        end if;
        update public.operator_campaign_action set status='published',post_id=published_id,finished_at=now() where id=a.id;
        perform public.operator_audit_write('campaign.announcement.published','succeeded',null,a.approved_by,'admin','campaign_action',a.id::text,jsonb_build_object('post_id',published_id));
      end if;
    exception when others then
      -- Subtransaction rolls back post and downstream DB effects before recording a failure.
      update public.operator_campaign_action set status='failed',error_code=sqlstate,finished_at=now() where id=a.id;
    end;
    processed:=processed+1;
  end loop;
  -- Reconcile lifecycle even after cancelling the last future occurrence. No model dependency.
  update public.operator_campaign campaign_row set status=case
    when exists(select 1 from public.operator_campaign_action action_row where action_row.campaign_id=campaign_row.id and action_row.status='scheduled') then
      case when exists(select 1 from public.operator_campaign_action action_row where action_row.campaign_id=campaign_row.id and action_row.status='published') then 'active' else 'scheduled' end
    when exists(select 1 from public.operator_campaign_action action_row where action_row.campaign_id=campaign_row.id and action_row.status='published') then 'completed'
    else 'draft' end,version=version+1,updated_at=now()
  where campaign_row.status in ('scheduled','active') and exists(select 1 from public.operator_campaign_action action_row where action_row.campaign_id=campaign_row.id)
    and campaign_row.status is distinct from case
      when exists(select 1 from public.operator_campaign_action action_row where action_row.campaign_id=campaign_row.id and action_row.status='scheduled') then
        case when exists(select 1 from public.operator_campaign_action action_row where action_row.campaign_id=campaign_row.id and action_row.status='published') then 'active' else 'scheduled' end
      when exists(select 1 from public.operator_campaign_action action_row where action_row.campaign_id=campaign_row.id and action_row.status='published') then 'completed' else 'draft' end;
  return processed;
end;
$$;
revoke all on function public.operator_campaign_action_sweep() from public,anon,authenticated;
grant execute on function public.operator_campaign_action_sweep() to service_role;
-- Independent of operator enabled/provider/worker health. Reuses the existing database cron.
select cron.schedule('hallyu-campaign-announcements','* * * * *','select public.operator_campaign_action_sweep();');
