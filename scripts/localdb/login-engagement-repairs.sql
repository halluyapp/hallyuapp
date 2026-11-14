-- Executable behavior checks for migration 66. Run after the complete local migration replay.
\set ON_ERROR_STOP on
\pset pager off

insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'suspended-repair@test.invalid', '{"handle":"suspendedrepair","full_name":"Suspended Repair"}'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'active-repair@test.invalid', '{"handle":"activerepair","full_name":"Active Repair"}');

insert into public.titles (id, provider_id, external_id, media_type, world, title, year, status)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'tmdb', 'repair-episode-ingest', 'tv', 'kdrama', 'Repair episode ingest', 2026, 'airing');

update public.profiles set account_status = 'suspended' where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$ begin
  if public.current_profile_id() is not null then raise exception 'suspended profile unexpectedly resolved'; end if;
  if public.current_account_profile_id() is null then raise exception 'suspended account identity missing'; end if;
end $$;

do $$ begin
  insert into public.posts (author_id, body) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'must not be written');
  raise exception 'suspended direct insert was allowed';
exception when insufficient_privilege then null;
end $$;

do $$ begin
  perform public.toggle_reaction('post', null, 'loved');
  raise exception 'suspended reaction RPC was allowed';
exception when sqlstate 'P0001' then
  if sqlerrm <> 'profile not registered' then raise; end if;
end $$;

do $$ begin
  perform public.catalog_upsert_episodes('aaaaaaaa-0000-4000-8000-000000000001', 1, '[{"number":1}]'::jsonb);
  raise exception 'member catalogue episode ingest was allowed';
exception when insufficient_privilege then null;
end $$;

reset role;
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select case when public.catalog_upsert_episodes('aaaaaaaa-0000-4000-8000-000000000001', 1, '[{"number":1,"name":"First episode"}]'::jsonb) = 1
  then 1 else 1 / 0 end as service_episode_ingest_ok;
select case when public.current_profile_id() is null then 1 else 1 / 0 end as service_has_no_member_identity;

-- Deletion is intentionally still available after suspension. The fixture and all its data are
-- removed by delete_account itself; no production member is involved in this local test.
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select public.delete_account();

reset role;
do $$ begin
  if not exists (select 1 from public.profiles where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' and account_status = 'deleted') then
    raise exception 'suspended account deletion did not complete';
  end if;
end $$;

select 'migration 66 executable checks passed' as result;
