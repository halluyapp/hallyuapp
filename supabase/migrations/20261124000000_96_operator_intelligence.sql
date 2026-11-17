-- Explicit opt-in preference memory; no model-authored free-text personal memory.
create or replace function public.operator_my_memory(p_key text default null, p_value text default null, p_delete boolean default false)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid := public.current_profile_id(); v_rows jsonb;
begin
  if v_actor is null or not exists (select 1 from public.profiles where id = v_actor and account_status = 'active') then
    raise exception 'active member required' using errcode = '42501';
  end if;
  if p_key is not null then
    if p_key not in ('preferred_language','favorite_genre','spoiler_preference') then raise exception 'unsupported memory key'; end if;
    if p_delete then
      delete from public.operator_memory where scope = 'member' and scope_id = v_actor and key = p_key;
    else
      if p_value is null or not (
        (p_key = 'preferred_language' and p_value in ('en','ko','zh','ja')) or
        (p_key = 'favorite_genre' and p_value in ('romance','thriller','comedy','fantasy','drama','action','animation','historical')) or
        (p_key = 'spoiler_preference' and p_value in ('avoid','allow'))
      ) then raise exception 'unsupported memory value'; end if;
      insert into public.operator_memory(scope,scope_id,key,value,source,confidence,expires_at)
      values ('member',v_actor,p_key,to_jsonb(p_value),'explicit_user_preference',1,now() + interval '90 days')
      on conflict (scope,(coalesce(scope_id,'00000000-0000-0000-0000-000000000000'::uuid)),key)
      do update set value = excluded.value, source = excluded.source, confidence = 1,
        expires_at = excluded.expires_at, updated_at = now();
    end if;
    insert into public.operator_audit(actor_type,actor_profile_id,action,outcome,resource_type,details)
    values ('member',v_actor,case when p_delete then 'memory.delete' else 'memory.save' end,'succeeded','operator_memory',jsonb_build_object('key',p_key));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value,'source',source,'updated_at',updated_at,'expires_at',expires_at) order by key),'[]'::jsonb)
    into v_rows from public.operator_memory
    where scope = 'member' and scope_id = v_actor and source = 'explicit_user_preference'
      and key in ('preferred_language','favorite_genre','spoiler_preference') and expires_at > now();
  return v_rows;
end; $$;
revoke all on function public.operator_my_memory(text,text,boolean) from public,anon;
grant execute on function public.operator_my_memory(text,text,boolean) to authenticated;

-- Replace unsafe broad memory selection: public threads receive NO private memory; admin memory
-- must match the specific executive. Legacy unreviewed free text is never injected automatically.
create or replace function public.operator_conversation_context(p_conversation uuid, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_conv public.operator_conversation; v_messages jsonb; v_memory jsonb;
begin
  select * into v_conv from public.operator_conversation where id = p_conversation;
  if v_conv.id is null then return jsonb_build_object('error','conversation_not_found'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('direction',m.direction,'author_type',m.author_type,'body',m.body,'at',m.created_at) order by m.created_at,m.id),'[]'::jsonb)
  into v_messages from (
    select * from public.operator_message where conversation_id = p_conversation
    order by created_at desc,id desc limit greatest(1,least(coalesce(p_limit,20),60))
  ) m;
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into v_memory
  from public.operator_memory
  where v_conv.channel in ('member_ai','admin_control')
    and scope = 'member' and scope_id = v_conv.member_profile_id
    and source = 'explicit_user_preference' and expires_at > now()
    and key in ('preferred_language','favorite_genre','spoiler_preference');
  return jsonb_build_object('conversation_id',v_conv.id,'channel',v_conv.channel,'member_profile_id',v_conv.member_profile_id,
    'external_thread_id',v_conv.external_thread_id,'messages',v_messages,'memory',v_memory);
end; $$;
revoke all on function public.operator_conversation_context(uuid,integer) from public,anon,authenticated;
grant execute on function public.operator_conversation_context(uuid,integer) to service_role;

alter table public.operator_knowledge add column if not exists visibility text not null default 'staff' check (visibility in ('public','staff'));
alter table public.operator_knowledge add column if not exists source_url text;
-- Explicitly reviewed public entries only. Internal provider/operations entries remain staff-only.
update public.operator_knowledge set visibility = 'public' where slug in ('platform-overview','tone-guide');
create table public.operator_knowledge_revision (
  id uuid primary key default gen_random_uuid(),
  knowledge_id uuid not null references public.operator_knowledge(id) on delete cascade,
  version integer not null,
  title text not null, body text not null, source_url text, visibility text not null,
  tags text[] not null, is_active boolean not null,
  edited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(), unique(knowledge_id,version)
);
alter table public.operator_knowledge_revision enable row level security;
revoke all on public.operator_knowledge_revision from anon,authenticated;
grant select on public.operator_knowledge_revision to authenticated;
grant all on public.operator_knowledge_revision to service_role;
create policy operator_knowledge_revision_admin_read on public.operator_knowledge_revision for select to authenticated using (public.is_admin());
insert into public.operator_knowledge_revision(knowledge_id,version,title,body,source_url,visibility,tags,is_active,edited_by)
select id,version,title,body,source_url,visibility,tags,is_active,updated_by from public.operator_knowledge;

-- Optimistic version check stops two editors silently overwriting each other.
create or replace function public.operator_knowledge_edit(p_slug text,p_title text,p_body text,p_source_url text,p_visibility text,p_tags text[],p_expected_version integer,p_active boolean default true)
returns integer language plpgsql security definer set search_path = public,pg_temp as $$
declare v_row public.operator_knowledge; v_actor uuid := public.current_profile_id();
begin
  if public.is_admin() is not true then raise exception 'administrator required' using errcode = '42501'; end if;
  if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{0,79}$' or p_title is null or length(btrim(p_title)) not between 1 and 200
    or p_body is null or length(btrim(p_body)) not between 1 and 8000
    or p_visibility is null or p_visibility not in ('public','staff')
    or (p_source_url is not null and (length(p_source_url) > 1000 or p_source_url !~ '^https://'))
    or cardinality(p_tags) > 20 then raise exception 'invalid knowledge entry'; end if;
  perform pg_advisory_xact_lock(hashtextextended('knowledge:' || p_slug,0));
  select * into v_row from public.operator_knowledge where slug = p_slug for update;
  if coalesce(v_row.version,0) is distinct from p_expected_version then raise exception 'knowledge_version_conflict' using errcode = '40001'; end if;
  insert into public.operator_knowledge(slug,title,body,source_url,visibility,tags,is_active,updated_by)
  values (p_slug,p_title,p_body,p_source_url,p_visibility,coalesce(p_tags,'{}'),p_active,v_actor)
  on conflict(slug) do update set title = excluded.title,body = excluded.body,source_url = excluded.source_url,
    visibility = excluded.visibility,tags = excluded.tags,is_active = excluded.is_active,
    version = operator_knowledge.version + 1,updated_by = v_actor,updated_at = now()
  returning * into v_row;
  insert into public.operator_knowledge_revision(knowledge_id,version,title,body,source_url,visibility,tags,is_active,edited_by)
  values(v_row.id,v_row.version,v_row.title,v_row.body,v_row.source_url,v_row.visibility,v_row.tags,v_row.is_active,v_actor);
  insert into public.operator_audit(actor_type,actor_profile_id,action,outcome,resource_type,resource_id,details)
  values('admin',v_actor,'knowledge.edit','succeeded','operator_knowledge',v_row.id::text,jsonb_build_object('version',v_row.version));
  return v_row.version;
end; $$;
revoke all on function public.operator_knowledge_edit(text,text,text,text,text,text[],integer,boolean) from public,anon;
grant execute on function public.operator_knowledge_edit(text,text,text,text,text,text[],integer,boolean) to authenticated;

-- Task-bound retrieval derives channel from durable backend state, never a caller-provided label.
-- Token overlap is deliberate: the old whole-question ILIKE usually returned unrelated score=0 rows.
create or replace function public.operator_knowledge_for_task(p_task uuid,p_query text,p_limit integer default 4)
returns table(slug text,title text,body text,version integer,source_url text,updated_at timestamptz,score real)
language sql stable security definer set search_path = public,pg_temp as $$
  with terms as (
    select distinct lower(term) as term from regexp_split_to_table(left(coalesce(p_query,''),1000),'[^[:alnum:]_]+') term
    where length(term) > 2 and lower(term) not in ('the','and','what','how','does','can','you','please','about','this','that','for','with')
  ), ranked as (
    select k.*, (select count(*) from terms t where strpos(lower(k.title || ' ' || array_to_string(k.tags,' ') || ' ' || k.body),t.term) > 0)::real as relevance
    from public.operator_knowledge k join public.operator_task task on task.id = p_task
    left join public.operator_conversation c on c.id = task.conversation_id
    where k.is_active and (k.visibility = 'public' or (coalesce(c.channel,task.destination_type) = 'admin_control'
      and exists(select 1 from public.profiles p where p.id = task.requester_profile_id and p.role in ('admin','ceo') and p.account_status = 'active')))
  ) select r.slug,r.title,r.body,r.version,r.source_url,r.updated_at,r.relevance from ranked r
  where r.relevance > 0 order by r.relevance desc,r.updated_at desc,r.slug limit greatest(1,least(coalesce(p_limit,4),8));
$$;
revoke all on function public.operator_knowledge_for_task(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.operator_knowledge_for_task(uuid,text,integer) to service_role;

-- Constitution versions are immutable content with a single active version; activation is atomic.
create or replace function public.operator_constitution_publish(p_version text,p_body text)
returns uuid language plpgsql security definer set search_path = public,pg_temp as $$
declare v_id uuid;
begin
  if public.is_admin() is not true then raise exception 'administrator required' using errcode = '42501'; end if;
  if p_version is null or length(btrim(p_version)) not between 1 and 80 or p_body is null or length(btrim(p_body)) not between 100 and 12000 then raise exception 'invalid constitution'; end if;
  perform pg_advisory_xact_lock(hashtextextended('operator_constitution_publish',0));
  update public.operator_constitution set is_active = false where is_active;
  insert into public.operator_constitution(version,body,is_active,created_by) values(p_version,p_body,true,public.current_profile_id()) returning id into v_id;
  insert into public.operator_audit(actor_type,actor_profile_id,action,outcome,resource_type,resource_id,details)
  values('admin',public.current_profile_id(),'constitution.publish','succeeded','operator_constitution',v_id::text,jsonb_build_object('version',p_version));
  return v_id;
end; $$;
revoke all on function public.operator_constitution_publish(text,text) from public,anon;
grant execute on function public.operator_constitution_publish(text,text) to authenticated;

-- Daily deletion enforces the declared preference retention. No existing member content touched.
create or replace function public.operator_memory_expire()
returns integer language plpgsql security definer set search_path = public,pg_temp as $$
declare v_count integer;
begin
  delete from public.operator_memory where source = 'explicit_user_preference' and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end; $$;
revoke all on function public.operator_memory_expire() from public,anon,authenticated;
grant execute on function public.operator_memory_expire() to service_role;
do $$ begin
  if exists(select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('operator-memory-retention','17 3 * * *','select public.operator_memory_expire();');
  end if;
end $$;

-- Include the activated version in actual prompt assembly, not just the admin record.
create or replace function public.operator_active_constitution()
returns text language sql stable security definer set search_path = public,pg_temp as $$
  select 'Active constitution version: ' || version || E'\n' || body from public.operator_constitution where is_active limit 1;
$$;
revoke all on function public.operator_active_constitution() from public,anon,authenticated;
grant execute on function public.operator_active_constitution() to service_role;

