-- Stage 4: independent, admin-authorized campaign planning. No model/provider dependency.
-- This editor changes campaign records only: it does not publish or send notifications.
alter table public.operator_campaign add column if not exists description text not null default '';
alter table public.operator_campaign add column if not exists objective text not null default '';
alter table public.operator_campaign add column if not exists timezone text not null default 'UTC';
alter table public.operator_campaign add column if not exists version integer not null default 1;

create or replace function public.operator_campaign_save(
  p_id uuid, p_expected_version integer, p_name text, p_kind text,
  p_description text, p_objective text, p_timezone text,
  p_starts_at timestamptz, p_ends_at timestamptz, p_status text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_actor uuid := public.current_profile_id();
  v_row public.operator_campaign;
begin
  if v_actor is null or not public.is_admin() then
    raise exception 'admin role required' using errcode='42501';
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 120
     or p_description is null or length(p_description)>4000
     or p_objective is null or length(p_objective)>1000
     or p_kind is null or p_kind not in ('campaign','event','poll','vote')
     or p_status is null or p_status not in ('draft','cancelled') then
    raise exception 'invalid campaign fields; only draft/cancelled planning states supported' using errcode='22023';
  end if;
  if p_timezone is null or not exists(select 1 from pg_timezone_names where name=p_timezone) then
    raise exception 'valid IANA timezone required' using errcode='22023';
  end if;
  if p_ends_at is not null and (p_starts_at is null or p_ends_at<=p_starts_at) then
    raise exception 'end must be after start' using errcode='22023';
  end if;
  if p_id is null then
    if p_expected_version is distinct from 0 or p_status<>'draft' then
      raise exception 'new campaigns must be draft version zero' using errcode='22023';
    end if;
    insert into public.operator_campaign(name,kind,description,objective,timezone,starts_at,ends_at,status)
    values(btrim(p_name),p_kind,p_description,p_objective,p_timezone,p_starts_at,p_ends_at,p_status)
    returning * into v_row;
  else
    select * into v_row from public.operator_campaign where id=p_id for update;
    if v_row.id is null then raise exception 'campaign not found' using errcode='P0002'; end if;
    if v_row.version is distinct from p_expected_version then
      raise exception 'campaign changed; reload before editing' using errcode='40001';
    end if;
    if v_row.status not in ('draft','cancelled') then
      raise exception 'launched campaigns cannot be edited through draft editor' using errcode='22023';
    end if;
    if v_row.status='cancelled' then raise exception 'cancelled campaign is read only' using errcode='22023'; end if;
    update public.operator_campaign set name=btrim(p_name),kind=p_kind,
      description=p_description,objective=p_objective,timezone=p_timezone,
      starts_at=p_starts_at,ends_at=p_ends_at,status=p_status,
      version=version+1,updated_at=now() where id=p_id returning * into v_row;
  end if;
  perform public.operator_audit_write('campaign.'||case when p_id is null then 'created' else 'updated' end,
    'succeeded',null,v_actor,'admin','campaign',v_row.id::text,
    jsonb_build_object('version',v_row.version,'status',v_row.status));
  return to_jsonb(v_row);
end;
$$;
revoke all on function public.operator_campaign_save(uuid,integer,text,text,text,text,text,timestamptz,timestamptz,text) from public,anon;
grant execute on function public.operator_campaign_save(uuid,integer,text,text,text,text,text,timestamptz,timestamptz,text) to authenticated;
comment on function public.operator_campaign_save(uuid,integer,text,text,text,text,text,timestamptz,timestamptz,text) is
  'Admin-only independent campaign draft editor. UTC instants plus IANA timezone, optimistic locking, audit. Never launches, publishes, or notifies.';
