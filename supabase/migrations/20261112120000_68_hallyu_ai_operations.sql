-- Hallyu AI operations: attributable identity, resumable tasks, publishing, reminders and schedules.
-- Every new write surface is service-role only; browser callers remain behind the operator's live
-- profile/role checks and explicit tool/approval registry.
set check_function_bodies = off;

alter table public.profiles add column if not exists is_ai boolean not null default false;
comment on column public.profiles.is_ai is 'Transparent machine identity. Official AI accounts are never presented as human members.';

insert into public.profiles (
  id, handle, display_name, bio, verified, verification_tier, role, account_status,
  onboarding_completed, is_ai
)
values (
  'a1111111-1111-4111-8111-111111111111', 'hallyu.ai', 'Hallyu AI',
  'Official Hallyu AI executive and community assistant. Automated activity is always identified.',
  true, 'blue', 'member', 'active', true, true
)
on conflict (handle) do update set
  display_name = 'Hallyu AI', bio = excluded.bio, verified = true,
  verification_tier = 'blue', is_ai = true, account_status = 'active';

create or replace function public.hallyu_ai_profile_id()
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select id from public.profiles where handle = 'hallyu.ai' and is_ai and account_status = 'active' limit 1;
$$;
revoke all on function public.hallyu_ai_profile_id() from public, anon, authenticated;
grant execute on function public.hallyu_ai_profile_id() to service_role;

alter table public.hallyu_ai_task add column if not exists agent_state jsonb not null default '{}'::jsonb;
alter table public.hallyu_ai_task add column if not exists attempt_count integer not null default 0;
alter table public.hallyu_ai_task add column if not exists max_attempts integer not null default 3;
alter table public.hallyu_ai_task add column if not exists not_before timestamptz not null default now();
alter table public.hallyu_ai_task add column if not exists idempotency_key text;
create unique index if not exists hallyu_ai_task_requester_idempotency_idx
  on public.hallyu_ai_task (requester_profile_id, idempotency_key) nulls not distinct where idempotency_key is not null;
create unique index if not exists hallyu_ai_tool_call_task_seq_idx on public.hallyu_ai_tool_call (task_id, seq);
create index if not exists hallyu_ai_task_work_idx on public.hallyu_ai_task (status, not_before, created_at);

alter table public.hallyu_ai_schedule add column if not exists prompt text not null default '';
alter table public.hallyu_ai_schedule add column if not exists next_run_at timestamptz;
alter table public.hallyu_ai_schedule add column if not exists last_task_id uuid references public.hallyu_ai_task(id) on delete set null;
create index if not exists hallyu_ai_schedule_due_idx on public.hallyu_ai_schedule (enabled, next_run_at);

create table if not exists public.hallyu_ai_publication (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.hallyu_ai_task(id) on delete cascade,
  action text not null,
  title text,
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft','published','failed')),
  target_id uuid,
  error text,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (task_id, action)
);
alter table public.hallyu_ai_publication enable row level security;
revoke all on public.hallyu_ai_publication from anon, authenticated;
create policy hallyu_ai_publication_no_direct_access on public.hallyu_ai_publication
  for all to public using (false) with check (false);

-- Task creation is idempotent for a supplied client key. The operator still checks role and quota.
create or replace function public.hallyu_ai_create_task(
  p_prompt text, p_kind text, p_title text, p_requester uuid, p_role text, p_idempotency_key text default null
) returns public.hallyu_ai_task language plpgsql security definer set search_path = public, pg_temp as $$
declare v_task public.hallyu_ai_task;
begin
  if length(btrim(coalesce(p_prompt,''))) = 0 or length(p_prompt) > 6000 then
    raise exception 'prompt must contain 1–6000 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_idempotency_key is not null then
    select * into v_task from public.hallyu_ai_task
      where requester_profile_id is not distinct from p_requester and idempotency_key = p_idempotency_key;
    if found then return v_task; end if;
  end if;
  insert into public.hallyu_ai_task (prompt,kind,title,requester_profile_id,requester_role,idempotency_key)
  values (p_prompt,left(coalesce(nullif(p_kind,''),'chat'),40),left(coalesce(nullif(p_title,''),left(p_prompt,80)),120),p_requester,p_role,nullif(left(coalesce(p_idempotency_key,''),160),''))
  returning * into v_task;
  return v_task;
exception when unique_violation then
  if p_idempotency_key is not null then
    select * into v_task from public.hallyu_ai_task
      where requester_profile_id is not distinct from p_requester and idempotency_key=p_idempotency_key;
    if found then return v_task; end if;
  end if;
  raise;
end; $$;
revoke all on function public.hallyu_ai_create_task(text,text,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.hallyu_ai_create_task(text,text,text,uuid,text,text) to service_role;

-- One atomic, idempotent publishing/comment/poll action per task. Retries return the original target.
-- Failures roll back the whole publication; the operator's tool-call audit records the real error.
create or replace function public.hallyu_ai_publish(
  p_task_id uuid, p_action text, p_title text, p_body text, p_payload jsonb default '{}'::jsonb, p_sources jsonb default '[]'::jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_author uuid := public.hallyu_ai_profile_id();
declare v_existing public.hallyu_ai_publication;
declare v_target uuid;
declare v_options text[];
declare v_post_type public.post_type := 'post';
begin
  if v_author is null then raise exception 'official Hallyu AI profile is unavailable' using errcode = 'no_data_found'; end if;
  if p_action not in ('publish_post','reply_comment','create_poll') then
    raise exception 'unsupported AI publication action' using errcode = 'invalid_parameter_value';
  end if;
  if length(btrim(coalesce(p_body,''))) = 0 or length(p_body) > 5000 then
    raise exception 'publication body must contain 1–5000 characters' using errcode = 'invalid_parameter_value';
  end if;
  select * into v_existing from public.hallyu_ai_publication where task_id=p_task_id and action=p_action for update;
  if found and v_existing.status='published' then
    return jsonb_build_object('id',v_existing.id,'target_id',v_existing.target_id,'status','published','duplicate',true);
  end if;
  if not found then
    insert into public.hallyu_ai_publication(task_id,action,title,body,payload,sources)
    values(p_task_id,p_action,left(nullif(p_title,''),90),p_body,coalesce(p_payload,'{}'),coalesce(p_sources,'[]')) returning * into v_existing;
  end if;

  if p_action='reply_comment' then
    if (nullif(p_payload->>'parent_id','') is not null and not exists (
      select 1 from public.comments where id=nullif(p_payload->>'parent_id','')::uuid
        and post_id=nullif(p_payload->>'post_id','')::uuid and state='active'
    )) then
    raise exception 'parent comment must belong to the target post' using errcode='invalid_parameter_value';
  end if;
    if not exists (select 1 from public.posts where id=nullif(p_payload->>'post_id','')::uuid and state='active' and visibility='public') then
      raise exception 'only an active public post can receive an AI reply' using errcode = 'insufficient_privilege';
    end if;
    insert into public.comments(post_id,author_id,parent_id,body)
    values(nullif(p_payload->>'post_id','')::uuid,v_author,nullif(p_payload->>'parent_id','')::uuid,left(p_body,1000)) returning id into v_target;
  else
    v_post_type := case when coalesce((p_payload->>'review')::boolean,false) then 'review'::public.post_type else 'discussion'::public.post_type end;
    insert into public.posts(author_id,type,title,body,kind,world,title_id,hashtags)
    values(v_author,v_post_type,left(nullif(p_title,''),90),p_body,'general',nullif(p_payload->>'world',''),nullif(p_payload->>'title_id','')::uuid,
      coalesce((select array_agg(left(lower(btrim(x)),40)) from jsonb_array_elements_text(coalesce(p_payload->'hashtags','[]'::jsonb)) x),'{}'))
    returning id into v_target;
    if p_action='create_poll' then
      select array_agg(left(btrim(x),80)) into v_options from jsonb_array_elements_text(coalesce(p_payload->'options','[]'::jsonb)) x;
      if coalesce(cardinality(v_options),0)<2 or cardinality(v_options)>4
        or exists(select 1 from unnest(v_options) option where btrim(option)='')
        or (select count(distinct lower(btrim(option))) from unnest(v_options) option)<>cardinality(v_options) then
        raise exception 'a poll requires 2–4 non-empty, distinct options' using errcode='invalid_parameter_value';
      end if;
      insert into public.post_polls(post_id,question,options,closes_at)
      values(v_target,left(coalesce(nullif(p_title,''),'Hallyu AI poll'),240),v_options,now()+make_interval(hours=>least(greatest(coalesce(nullif(p_payload->>'hours','')::integer,168),1),720)));
    end if;
  end if;
  update public.hallyu_ai_publication set status='published',target_id=v_target,published_at=now(),error=null where id=v_existing.id;
  return jsonb_build_object('id',v_existing.id,'target_id',v_target,'status','published','duplicate',false,'author_id',v_author);
end; $$;
revoke all on function public.hallyu_ai_publish(uuid,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.hallyu_ai_publish(uuid,text,text,text,jsonb,jsonb) to service_role;

-- Queue only; push delivery remains owned and confirmed by the existing notification delivery system.
create or replace function public.hallyu_ai_notify(
  p_task_id uuid,p_recipient uuid,p_title text,p_body text,p_scheduled_for timestamptz default null,p_deep_link text default '/'
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_recipient is null or length(btrim(coalesce(p_body,'')))=0 then
    raise exception 'recipient and body are required' using errcode='invalid_parameter_value';
  end if;
  if not exists (select 1 from public.profiles where id=p_recipient and account_status='active' and not is_ai) then
    return jsonb_build_object('notification_id',null,'state','ineligible','delivered',false);
  end if;
  v_id:=public.enqueue_notification(p_recipient,'system','system','hallyu-ai:'||p_task_id::text||':'||p_recipient::text,
    array[public.hallyu_ai_profile_id()],null,null,null,null,null,null,left(p_title,160),left(p_body,500),p_deep_link,p_scheduled_for,null);
  return jsonb_build_object('notification_id',v_id,'state',case when v_id is null then 'suppressed_by_preferences_or_ineligible' else 'queued' end,'delivered',false);
end; $$;
revoke all on function public.hallyu_ai_notify(uuid,uuid,text,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.hallyu_ai_notify(uuid,uuid,text,text,timestamptz,text) to service_role;

-- A bounded broadcast is one database transaction, not hundreds of edge HTTP calls. enqueue_notification
-- supplies dedupe, active/preferences checks and scheduled delivery semantics. Approval is enforced
-- by the operator before this service-only RPC is called.
create or replace function public.hallyu_ai_broadcast(
  p_task_id uuid,p_title text,p_body text,p_deep_link text default '/',p_limit integer default 500
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_recipient record; v_id uuid; v_queued integer:=0; v_suppressed integer:=0; v_total integer;
begin
  if p_task_id is null or length(btrim(coalesce(p_body,'')))=0 then
    raise exception 'task and body are required' using errcode='invalid_parameter_value';
  end if;
  select count(*) into v_total from public.profiles where account_status='active' and not is_ai;
  for v_recipient in select id from public.profiles where account_status='active' and not is_ai order by id limit least(greatest(coalesce(p_limit,500),1),500) loop
    v_id:=public.enqueue_notification(v_recipient.id,'system','system','hallyu-ai:'||p_task_id::text||':'||v_recipient.id::text,
      array[public.hallyu_ai_profile_id()],null,null,null,null,null,null,left(p_title,160),left(p_body,500),p_deep_link,null,null);
    if v_id is null then v_suppressed:=v_suppressed+1; else v_queued:=v_queued+1; end if;
  end loop;
  return jsonb_build_object('queued_or_already_queued',v_queued,'suppressed',v_suppressed,'eligible_members',v_total,
    'truncated',v_total>least(greatest(coalesce(p_limit,500),1),500),'delivered',false);
end; $$;
revoke all on function public.hallyu_ai_broadcast(uuid,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.hallyu_ai_broadcast(uuid,text,text,text,integer) to service_role;

-- Claim due schedules atomically enough for a single dispatcher; repeated ticks cannot claim the same slot.
create or replace function public.hallyu_ai_claim_due_schedules(p_limit integer default 3)
returns setof public.hallyu_ai_schedule language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
    with due as (
      select id from public.hallyu_ai_schedule
      where enabled and coalesce(next_run_at,created_at)<=now()
      order by coalesce(next_run_at,created_at) limit least(greatest(p_limit,1),10) for update skip locked
    ), claimed as (
      update public.hallyu_ai_schedule s set next_run_at=now()+make_interval(mins=>greatest(s.interval_minutes,15)),last_run_at=now(),last_status='running'
      from due where s.id=due.id returning s.*
    ) select * from claimed;
end; $$;
revoke all on function public.hallyu_ai_claim_due_schedules(integer) from public,anon,authenticated;
grant execute on function public.hallyu_ai_claim_due_schedules(integer) to service_role;

create or replace function public.hallyu_ai_admin_schedules()
returns setof public.hallyu_ai_schedule language sql stable security definer set search_path=public,pg_temp as $$
  select * from public.hallyu_ai_schedule where public.hallyu_ai_is_staff() order by created_at;
$$;
create or replace function public.hallyu_ai_admin_publications(p_limit integer default 50)
returns setof public.hallyu_ai_publication language sql stable security definer set search_path=public,pg_temp as $$
  select * from public.hallyu_ai_publication where public.hallyu_ai_is_staff() order by created_at desc limit least(greatest(p_limit,1),200);
$$;
create or replace function public.hallyu_ai_admin_tool_calls(p_task uuid)
returns setof public.hallyu_ai_tool_call language sql stable security definer set search_path=public,pg_temp as $$
  select * from public.hallyu_ai_tool_call where task_id=p_task and public.hallyu_ai_is_staff() order by seq;
$$;
revoke all on function public.hallyu_ai_admin_schedules() from public,anon;
revoke all on function public.hallyu_ai_admin_publications(integer) from public,anon;
revoke all on function public.hallyu_ai_admin_tool_calls(uuid) from public,anon;
grant execute on function public.hallyu_ai_admin_schedules() to authenticated;
grant execute on function public.hallyu_ai_admin_publications(integer) to authenticated;
grant execute on function public.hallyu_ai_admin_tool_calls(uuid) to authenticated;

create or replace function public.hallyu_ai_platform_overview()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'active_members',(select count(*) from public.profiles where account_status='active' and not is_ai),
    'new_members_7d',(select count(*) from public.profiles where account_status='active' and not is_ai and created_at>now()-interval '7 days'),
    'active_public_posts',(select count(*) from public.posts where state='active' and visibility='public'),
    'posts_7d',(select count(*) from public.posts where state='active' and created_at>now()-interval '7 days'),
    'comments_7d',(select count(*) from public.comments where state='active' and created_at>now()-interval '7 days'),
    'unanswered_public_questions',(select count(*) from public.posts where state='active' and visibility='public' and kind='question' and comment_count=0 and created_at>now()-interval '14 days'),
    'failed_catalog_runs_24h',(select count(*) from public.catalog_sync_runs where status='failed' and started_at>now()-interval '24 hours'),
    'failed_jobs_24h',(select count(*) from public.job_runs where status='failed' and started_at>now()-interval '24 hours'),
    'measured_at',now()
  );
$$;
revoke all on function public.hallyu_ai_platform_overview() from public,anon,authenticated;
grant execute on function public.hallyu_ai_platform_overview() to service_role;

-- Service-role mediation for the operator. PostgREST has already validated the user's Rork JWT;
-- this function independently verifies the referenced live staff profile and records
-- that person as decision-maker. It never trusts a role supplied in task content.
create or replace function public.hallyu_ai_operator_decide_approval(
  p_approval uuid,p_approve boolean,p_decider uuid,p_note text default null
) returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare v_task uuid;
begin
  if not exists (select 1 from public.profiles where id=p_decider and account_status='active' and role in ('admin','ceo')) then
    raise exception 'active admin or ceo profile required' using errcode='insufficient_privilege';
  end if;
  update public.hallyu_ai_approval set
    status=case when p_approve then 'approved' else 'rejected' end,
    decided_by=p_decider,decided_at=now(),reason=reason||coalesce(' — '||btrim(p_note),'')
  where id=p_approval and status='pending' returning task_id into v_task;
  if v_task is null then return 'already-decided'; end if;
  update public.hallyu_ai_task set
    status=case when p_approve then 'queued' else 'cancelled' end,
    error=case when p_approve then null else 'approval rejected by staff' end,
    finished_at=case when p_approve then null else now() end
  where id=v_task;
  return case when p_approve then 'approved' else 'rejected' end;
end; $$;
revoke all on function public.hallyu_ai_operator_decide_approval(uuid,boolean,uuid,text) from public,anon,authenticated;
grant execute on function public.hallyu_ai_operator_decide_approval(uuid,boolean,uuid,text) to service_role;

insert into public.hallyu_ai_memory(kind,key,value) values
  ('config','publishing_mode','{"mode":"approval"}'),
  ('config','task_limits','{"member_per_hour":10,"staff_per_hour":30,"max_steps":6}')
on conflict (kind,key) do nothing;
insert into public.hallyu_ai_schedule(name,kind,interval_minutes,enabled,prompt,next_run_at) values
  ('Daily platform intelligence','daily_intelligence',1440,false,'Inspect real platform health, engagement evidence and failed jobs. Prepare an evidence-based executive report. Do not publish or notify.',null),
  ('Community opportunities','community_pulse',360,false,'Review only active public discussions. Identify unanswered questions and community opportunities. Prepare a private staff report; do not reply without approval.',null),
  ('Entertainment intelligence','entertainment_research',720,false,'Review the existing entertainment catalogue and upcoming releases with source links. Draft an intelligence report; do not treat catalogue metadata as breaking news.',null)
on conflict (name) do nothing;

reset check_function_bodies;
