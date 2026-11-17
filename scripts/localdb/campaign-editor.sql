-- Transactional acceptance: writes only generated fixtures and rolls everything back.
begin;
do $$
declare
  v_sub text := gen_random_uuid()::text;
  v_profile uuid;
  v_row jsonb;
  v_id uuid;
  v_denied boolean;
  v_count integer;
begin
  insert into public.profiles(id,auth_sub,handle,display_name,role)
  values(gen_random_uuid(),v_sub,'cmp_'||substr(replace(v_sub,'-',''),1,20),'Campaign test','member') returning id into v_profile;
  update public.profiles set role='member' where id=v_profile;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_sub,'role','authenticated')::text,true);
  v_denied := false;
  begin
    perform public.operator_campaign_save(null,0,'Fixture','event','','','UTC',null,null,'draft');
  exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'member campaign write allowed'; end if;
  update public.profiles set role='admin' where id=v_profile;
  v_row:=public.operator_campaign_save(null,0,'Fixture','event','Description','Objective','Africa/Lagos','2026-12-01T18:00:00+01:00','2026-12-02T18:00:00+01:00','draft');
  v_id:=(v_row->>'id')::uuid;
  if v_row->>'timezone'<>'Africa/Lagos' or (v_row->>'starts_at')::timestamptz<>'2026-12-01T17:00:00Z'::timestamptz then raise exception 'timezone lost'; end if;
  v_row:=public.operator_campaign_save(v_id,1,'Fixture edited','event','','','UTC',null,null,'draft');
  if (v_row->>'version')::integer<>2 then raise exception 'version not incremented'; end if;
  v_denied:=false;
  begin perform public.operator_campaign_save(v_id,1,'Stale','event','','','UTC',null,null,'draft');
  exception when serialization_failure then v_denied:=true; end;
  if not v_denied then raise exception 'stale edit accepted'; end if;
  v_denied:=false;
  begin perform public.operator_campaign_save(v_id,2,'Invalid','event','','','Not/AZone',null,null,'draft');
  exception when invalid_parameter_value then v_denied:=true; end;
  if not v_denied then raise exception 'invalid timezone accepted'; end if;
  v_denied:=false;
  begin perform public.operator_campaign_save(v_id,2,'Invalid','event','','','UTC','2026-12-02T00:00:00Z','2026-12-01T00:00:00Z','draft');
  exception when invalid_parameter_value then v_denied:=true; end;
  if not v_denied then raise exception 'reversed dates accepted'; end if;
  v_denied:=false;
  begin perform public.operator_campaign_save(v_id,2,'Launch','event','','','UTC',null,null,'active');
  exception when invalid_parameter_value then v_denied:=true; end;
  if not v_denied then raise exception 'unapproved launch accepted'; end if;
  v_row:=public.operator_campaign_save(v_id,2,'Fixture edited','event','','','UTC',null,null,'cancelled');
  v_denied:=false;
  begin perform public.operator_campaign_save(v_id,3,'Resurrect','event','','','UTC',null,null,'draft');
  exception when invalid_parameter_value then v_denied:=true; end;
  if not v_denied then raise exception 'cancelled edit accepted'; end if;
  select count(*) into v_count from public.operator_audit where resource_id=v_id::text and action in ('campaign.created','campaign.updated');
  if v_count<>3 then raise exception 'expected 3 campaign audit entries, got %',v_count; end if;
  update public.profiles set account_status='suspended' where id=v_profile;
  v_denied:=false;
  begin perform public.operator_campaign_save(null,0,'Suspended','event','','','UTC',null,null,'draft');
  exception when insufficient_privilege then v_denied:=true; end;
  if not v_denied then raise exception 'suspended admin allowed'; end if;
  raise notice 'campaign editor: member denial, admin CRUD, timezone, conflicts, invalid dates, launch denial, cancellation, audit, suspended denial PASS';
end;
$$;
rollback;
