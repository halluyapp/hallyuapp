-- Local reproduction of the failing checks from the live verification suite
-- (run 37188183939, scripts/verify-backend.mjs). Each block prints CHECK <name>: OK/ERROR.
-- Applied to the database built by scripts/localdb/apply.mjs.
--
-- expects: 28 checks
--
-- Run against a freshly applied database (`node scripts/localdb/apply.mjs . && node
-- scripts/localdb/check.mjs .`, which is what `npm run test:db-exec` does). The blocks create
-- members, posts and objects, so a second run over the same database is not a valid signal.
--
-- Role + JWT emulation mirrors PostgREST: `set_config('role', …)` is SET ROLE, and the
-- auth.uid()/auth.role() stubs read request.jwt.claim.* the same way Supabase's do.

\set ON_ERROR_STOP off
\pset pager off

-- ── Setup (superuser): members, titles ───────────────────────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-4111-8111-111111111111', 'alice@verification.test', '{"handle":"alicever","full_name":"Verification Alice"}'),
  ('22222222-2222-4222-8222-222222222222', 'bob@verification.test',   '{"handle":"bobver","full_name":"Verification Bob"}')
on conflict (id) do nothing;

insert into public.titles (id, provider_id, external_id, media_type, world, title, year, status, episode_count, season_count, genres, first_air_date, last_air_date)
values
  ('00000000-0000-4000-8000-000000000001', 'tmdb', 'verify-airing', 'tv', 'kdrama', 'Verification Airing', 2026, 'airing', 16, 1, array['Romance','Drama'], '2026-09-01', null),
  ('00000000-0000-4000-8000-000000000002', 'tmdb', 'verify-classic', 'tv', 'kdrama', 'Verification Classic', 2004, 'completed', 16, 1, array['Romance'], '2004-09-01', '2005-03-01'),
  ('00000000-0000-4000-8000-000000000003', 'tmdb', 'verify-test', 'tv', 'kdrama', 'Verification Title', 2026, 'airing', 16, 1, array['Drama'], null, null)
on conflict (id) do nothing;

-- ── 1. Member creates a post (live: infinite recursion detected in policy for relation posts) ─
do $$
declare v_id uuid;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  insert into public.posts (author_id, type, title, body, kind, spoiler, world, title_id, hashtags)
  values ('11111111-1111-4111-8111-111111111111', 'discussion', 'Verification post',
          'This post exists to prove the database works.', 'general', 'none', 'kdrama',
          '00000000-0000-4000-8000-000000000003', array['verification'])
  returning id into v_id;
  raise notice 'CHECK post-insert: OK (%)', v_id;
exception when others then
  raise notice 'CHECK post-insert: ERROR %', sqlerrm;
end $$;

-- ── 2. Direct reaction inserts (live: violates reactions_exactly_one_target — cascade) ────────
do $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  insert into public.reactions (user_id, kind, post_id)
  select '22222222-2222-4222-8222-222222222222', 'loved', id from public.posts
  where author_id = '11111111-1111-4111-8111-111111111111' and state = 'active' limit 1;
  raise notice 'CHECK reaction-insert: OK';
exception when others then
  raise notice 'CHECK reaction-insert: ERROR %', sqlerrm;
end $$;

-- ── 3. Comment insert ────────────────────────────────────────────────────────────────────────
do $$
declare v_id uuid;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  insert into public.comments (post_id, author_id, body)
  select id, '11111111-1111-4111-8111-111111111111', 'Verification comment.'
  from public.posts where author_id = '11111111-1111-4111-8111-111111111111' and state = 'active' limit 1
  returning id into v_id;
  raise notice 'CHECK comment-insert: OK (%)', v_id;
exception when others then
  raise notice 'CHECK comment-insert: ERROR %', sqlerrm;
end $$;

-- ── 4. toggle_reaction set → swap → clear ────────────────────────────────────────────────────
do $$
declare v_post uuid; v_kind text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  select id into v_post from public.posts where author_id = '11111111-1111-4111-8111-111111111111' and state = 'active' limit 1;
  if v_post is null then raise notice 'CHECK toggle-reaction: ERROR no post to react to'; return; end if;
  perform public.toggle_reaction('post', v_post, 'cried');
  perform public.toggle_reaction('post', v_post, 'laughed');
  perform public.toggle_reaction('post', v_post, 'laughed');
  raise notice 'CHECK toggle-reaction: OK';
exception when others then
  raise notice 'CHECK toggle-reaction: ERROR %', sqlerrm;
end $$;

-- ── 5. toggle_save ───────────────────────────────────────────────────────────────────────────
do $$
declare v_post uuid; v_on boolean;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  select id into v_post from public.posts where author_id = '11111111-1111-4111-8111-111111111111' and state = 'active' limit 1;
  if v_post is null then raise notice 'CHECK toggle-save: ERROR no post to save'; return; end if;
  v_on := public.toggle_save(v_post);
  v_on := public.toggle_save(v_post);
  raise notice 'CHECK toggle-save: OK (saved=%)', v_on;
exception when others then
  raise notice 'CHECK toggle-save: ERROR %', sqlerrm;
end $$;

-- ── 6. record_share ──────────────────────────────────────────────────────────────────────────
do $$
declare v_post uuid; v_json jsonb;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  select id into v_post from public.posts where author_id = '11111111-1111-4111-8111-111111111111' and state = 'active' limit 1;
  if v_post is null then raise notice 'CHECK record-share: ERROR no post to share'; return; end if;
  v_json := public.record_share(v_post, 'link');
  v_json := public.record_share(v_post, 'link');
  raise notice 'CHECK record-share: OK (%)', v_json;
exception when others then
  raise notice 'CHECK record-share: ERROR %', sqlerrm;
end $$;

-- ── 7. Onboarding then recommended_titles (live: operator does not exist: text[] & text[]) ────
do $$
declare r record; n integer := 0;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform public.complete_onboarding(array['kdrama','anime']::text[], array['Romance']::text[], 4);
  for r in select id from public.recommended_titles(50) loop
    n := n + 1;
  end loop;
  raise notice 'CHECK recommended-titles: OK (% rows)', n;
exception when others then
  raise notice 'CHECK recommended-titles: ERROR %', sqlerrm;
end $$;

-- ── 8. enqueue_notification twice + coalesce (live: invalid input syntax for type integer: t) ─
do $$
declare v1 uuid; v2 uuid; v_rows integer; v_coalesce integer;
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v1 := public.enqueue_notification('11111111-1111-4111-8111-111111111111', 'episode_aired', 'drama',
          'verify-dedupe-local', '{}', null, null, '00000000-0000-4000-8000-000000000001', null, null,
          null, 'Verification show', 'Episode 1 is out.', null, null, null);
  v2 := public.enqueue_notification('11111111-1111-4111-8111-111111111111', 'episode_aired', 'drama',
          'verify-dedupe-local', '{}', null, null, '00000000-0000-4000-8000-000000000001', null, null,
          null, 'Verification show', 'Episode 1 is out.', null, null, null);
  select count(*) into v_rows from public.notifications where dedupe_key = 'verify-dedupe-local';
  select coalesce_count into v_coalesce from public.notifications where dedupe_key = 'verify-dedupe-local';
  raise notice 'CHECK enqueue: OK (same=%, rows=%, coalesce=%)', v1 = v2, v_rows, v_coalesce;
exception when others then
  raise notice 'CHECK enqueue: ERROR %', sqlerrm;
end $$;

-- ── 9. Push token + fanout (live: null notification id cascade) ──────────────────────────────
do $$
declare v_not uuid; v_count integer; v_again integer;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform public.register_push_token('ExponentPushToken[verification-local]', 'android', 'verification device');
  -- service-role calls carry no user claim at all (that is what auth.uid() being null means)
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  select id into v_not from public.notifications where dedupe_key = 'verify-dedupe-local';
  if v_not is null then
    raise notice 'CHECK fanout: ERROR no notification row to fan out';
    return;
  end if;
  v_count := public.fanout_notification(v_not);
  v_again := public.fanout_notification(v_not);
  raise notice 'CHECK fanout: OK (first=%, again=%)', v_count, v_again;
exception when others then
  raise notice 'CHECK fanout: ERROR %', sqlerrm;
end $$;

-- ── 10. Catalog people ingest (live: column reference "external_id" is ambiguous) ────────────
do $$
declare v_written integer;
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_written := public.catalog_upsert_title_people(
    '00000000-0000-4000-8000-000000000003',
    '[{"external_id":"12345","name":"Verification Actor","job":"actor","character":"Lead","order_index":0}]'::jsonb
  );
  raise notice 'CHECK title-people: OK (written=%)', v_written;
exception when others then
  raise notice 'CHECK title-people: ERROR %', sqlerrm;
end $$;

-- ── 11. join_community (live: column "status" is of type membership_status but expression text) ─
do $$
declare v_comm uuid; v_json jsonb;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  select id into v_comm from public.communities order by id limit 1;
  v_json := public.join_community(v_comm, true);
  v_json := public.join_community(v_comm, true);
  raise notice 'CHECK join-community: OK (%)', v_json;
exception when others then
  raise notice 'CHECK join-community: ERROR %', sqlerrm;
end $$;

-- ── 12. begin_media_upload in own folder (live: column "state" is of type media_state …) ─────
do $$
declare v_id uuid;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  v_id := public.begin_media_upload('u/11111111-1111-4111-8111-111111111111/posts/verification.png', 'image');
  raise notice 'CHECK begin-media-upload: OK (%)', v_id;
exception when others then
  raise notice 'CHECK begin-media-upload: ERROR %', sqlerrm;
end $$;

-- ── 13. feed_page (live: syntax error at or near "if") ───────────────────────────────────────
do $$
declare v jsonb;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  v := public.feed_page('latest', null, null, 20, null, null);
  raise notice 'CHECK feed-page: OK (items=%)', jsonb_array_length(coalesce(v -> 'items', '[]'::jsonb));
exception when others then
  raise notice 'CHECK feed-page: ERROR %', sqlerrm;
end $$;

-- ── 14. search_suggestions (live: syntax error at or near "union") ───────────────────────────
do $$
declare n integer := 0; r record;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  for r in select * from public.search_suggestions('ver', 10) loop
    n := n + 1;
  end loop;
  raise notice 'CHECK search-suggestions: OK (% rows)', n;
exception when others then
  raise notice 'CHECK search-suggestions: ERROR %', sqlerrm;
end $$;

-- ── 15. Trending excludes the long-finished classic ──────────────────────────────────────────
do $$
declare r record; v_ids text[] := '{}'; v_airing text[] := '{}';
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform public.refresh_trending('kdrama');
  for r in select id from public.trending_titles(p_world => 'kdrama', p_limit => 50) loop
    v_ids := v_ids || r.id::text;
  end loop;
  for r in select id from public.airing_titles('kdrama', 50) loop
    v_airing := v_airing || r.id::text;
  end loop;
  if '00000000-0000-4000-8000-000000000002' = any(v_ids) then
    raise notice 'CHECK trending-excludes-classic: FAIL classic in trending (% total)', array_length(v_ids, 1);
  elsif not ('00000000-0000-4000-8000-000000000001' = any(v_airing)) then
    raise notice 'CHECK trending-excludes-classic: FAIL airing title missing from airing_titles';
  else
    raise notice 'CHECK trending-excludes-classic: OK (trending=%, airing=%)', array_length(v_ids, 1), array_length(v_airing, 1);
  end if;
exception when others then
  raise notice 'CHECK trending-excludes-classic: ERROR %', sqlerrm;
end $$;

-- ── 16. job_claim: claimed once, second caller does not re-claim ─────────────────────────────
do $$
declare v_id uuid; v_claimed boolean; v_attempt integer; v_id2 uuid; v_claimed2 boolean;
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  select id, did_claim, attempt into v_id, v_claimed, v_attempt from public.job_claim('verification.probe', 'local-1');
  select id, did_claim into v_id2, v_claimed2 from public.job_claim('verification.probe', 'local-1');
  raise notice 'CHECK job-claim: OK (first id=%, claimed=%, attempt=%; second claimed=%)',
    v_id, v_claimed, v_attempt, v_claimed2;
exception when others then
  raise notice 'CHECK job-claim: ERROR %', sqlerrm;
end $$;

-- ── 17. get_bootstrap for the member (the connection gate RPC) ───────────────────────────────
do $$
declare v jsonb;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  v := public.get_bootstrap();
  raise notice 'CHECK get-bootstrap: OK (profile=%)', v -> 'profile' ->> 'handle';
exception when others then
  raise notice 'CHECK get-bootstrap: ERROR %', sqlerrm;
end $$;

-- ── 18. A second member reading the first member's post (RLS select path) ────────────────────
do $$
declare n integer := 0;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  select count(*) into n from public.posts where state = 'active';
  raise notice 'CHECK posts-select-as-other: OK (% visible)', n;
exception when others then
  raise notice 'CHECK posts-select-as-other: ERROR %', sqlerrm;
end $$;

-- ── 19. Profile read by another member (profiles_select_visible → posts path) ────────────────
do $$
declare n integer := 0;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  select count(*) into n from public.profiles;
  raise notice 'CHECK profiles-select: OK (% visible)', n;
exception when others then
  raise notice 'CHECK profiles-select: ERROR %', sqlerrm;
end $$;

-- ── 20. A member cannot promote themselves (live: "a member promoted themselves to admin") ────
do $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  begin
    update public.profiles set role = 'admin', verified = true
     where id = '11111111-1111-4111-8111-111111111111';
  exception when insufficient_privilege then
    raise notice 'CHECK self-promotion: OK (role change refused)';
    return;
  end;

  raise notice 'CHECK self-promotion: FAIL the update succeeded';
exception when others then
  raise notice 'CHECK self-promotion: ERROR %', sqlerrm;
end $$;

-- ── 21. …but the member's own data is still editable, and an admin can still promote ─────────
do $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  update public.profiles set display_name = 'Verification Alice', bio = 'still mine'
   where id = '11111111-1111-4111-8111-111111111111';

  if exists (
    select 1 from public.profiles
     where id = '11111111-1111-4111-8111-111111111111'
       and (role <> 'member' or verified or account_status <> 'active')
  ) then
    raise notice 'CHECK self-edit-allowed: FAIL the refused update left a change behind';
    return;
  end if;

  -- Promotion by the service role, which is how a moderator is actually made.
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  update public.profiles set role = 'admin'
   where id = '11111111-1111-4111-8111-111111111111';

  if not exists (
    select 1 from public.profiles where id = '11111111-1111-4111-8111-111111111111' and role = 'admin'
  ) then
    raise notice 'CHECK self-edit-allowed: FAIL the service role could not promote a member';
    return;
  end if;

  -- …and an admin acting through the API is still allowed to change those columns.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  update public.profiles set verified = true
   where id = '11111111-1111-4111-8111-111111111111';

  if not exists (
    select 1 from public.profiles where id = '11111111-1111-4111-8111-111111111111' and verified
  ) then
    raise notice 'CHECK self-edit-allowed: FAIL an admin could not set the verified badge';
    return;
  end if;

  raise notice 'CHECK self-edit-allowed: OK (own data editable, admin promotion intact)';
exception when others then
  raise notice 'CHECK self-edit-allowed: ERROR %', sqlerrm;
end $$;

-- ── 22. Direct deletion of a storage row is refused, exactly as Supabase refuses it ──────────
do $$
declare refused boolean := false;
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);

  insert into storage.objects (bucket_id, name) values ('media', 'u/11111111-1111-4111-8111-111111111111/probe.png')
  on conflict do nothing;

  begin
    delete from storage.objects where name = 'u/11111111-1111-4111-8111-111111111111/probe.png';
  exception when others then
    refused := true;
  end;

  if not refused then
    raise notice 'CHECK storage-delete-refused: FAIL the harness let a direct storage DELETE through';
    return;
  end if;

  raise notice 'CHECK storage-delete-refused: OK (storage.protect_delete refused the DELETE)';
end $$;

-- ── 23. A failed upload queues its object instead of deleting it ─────────────────────────────
do $$
declare v_upload uuid; v_queued integer;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_upload := public.begin_media_upload('u/11111111-1111-4111-8111-111111111111/queued.png', 'image');

  if not public.fail_media_upload(v_upload, 'verification') then
    raise notice 'CHECK failed-upload-queued: FAIL fail_media_upload did not mark the row';
    return;
  end if;

  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);

  v_queued := (select count(*)::integer from public.media_removal_queue
                where path = 'u/11111111-1111-4111-8111-111111111111/queued.png'
                  and reason = 'failed_upload');

  if v_queued <> 1 then
    raise notice 'CHECK failed-upload-queued: FAIL % queue row(s) for the failed upload', v_queued;
    return;
  end if;

  if not exists (select 1 from public.media_uploads where id = v_upload and state = 'failed') then
    raise notice 'CHECK failed-upload-queued: FAIL the upload row is not marked failed';
    return;
  end if;

  -- The Storage API drains the queue: claim a batch, then settle it.
  if not exists (
    select 1 from public.claim_media_removals(10)
     where path = 'u/11111111-1111-4111-8111-111111111111/queued.png' and attempts >= 1
  ) then
    raise notice 'CHECK failed-upload-queued: FAIL claim_media_removals did not hand the path over';
    return;
  end if;

  perform public.complete_media_removals(array['u/11111111-1111-4111-8111-111111111111/queued.png']);

  if exists (select 1 from public.media_removal_queue
              where path = 'u/11111111-1111-4111-8111-111111111111/queued.png') then
    raise notice 'CHECK failed-upload-queued: FAIL the queue row survived a settled removal';
    return;
  end if;

  raise notice 'CHECK failed-upload-queued: OK (queued, claimed and settled)';
exception when others then
  raise notice 'CHECK failed-upload-queued: ERROR %', sqlerrm;
end $$;

-- ── 24. delete_account() completes: scrubbed identity, no rows left, objects queued ───────────
do $$
declare v_result jsonb; v_queued integer;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- One upload of his own, so there is an object the deletion has to deal with.
  perform public.begin_media_upload('u/22222222-2222-4222-8222-222222222222/removed.png', 'image');

  v_result := public.delete_account();

  if (v_result ->> 'deleted') is distinct from 'true' then
    raise notice 'CHECK delete-account: FAIL the function did not report success';
    return;
  end if;

  -- The queue and the scrubbed profile are service-role reads: no authenticated policy reaches
  -- them, which is itself part of the guarantee.
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);

  if not exists (
    select 1 from public.profiles
     where id = '22222222-2222-4222-8222-222222222222'
       and account_status = 'deleted' and display_name = 'Deleted member'
  ) then
    raise notice 'CHECK delete-account: FAIL the tombstone was not scrubbed';
    return;
  end if;

  if exists (select 1 from public.media_uploads where user_id = '22222222-2222-4222-8222-222222222222') then
    raise notice 'CHECK delete-account: FAIL media_uploads rows outlived the account';
    return;
  end if;

  v_queued := (select count(*)::integer from public.media_removal_queue where requested_by = '22222222-2222-4222-8222-222222222222');

  if v_queued < 1 then
    raise notice 'CHECK delete-account: FAIL no object was queued for removal';
    return;
  end if;

  raise notice 'CHECK delete-account: OK (scrubbed, rows gone, % object(s) queued)', v_queued;
exception when others then
  raise notice 'CHECK delete-account: ERROR %', sqlerrm;
end $$;

-- ── 25. A member may write only their own storage folder ───────────────────────────────────────
do $$
declare refused boolean := false;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  insert into storage.objects (bucket_id, name, owner)
  values ('media', 'u/11111111-1111-4111-8111-111111111111/own.png', '11111111-1111-4111-8111-111111111111');

  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('media', 'u/22222222-2222-4222-8222-222222222222/forged.png', '11111111-1111-4111-8111-111111111111');
  exception when others then
    refused := true;
  end;

  if not refused then
    raise notice 'CHECK storage-upload-own-folder: FAIL a member wrote into somebody else''s folder';
    return;
  end if;

  raise notice 'CHECK storage-upload-own-folder: OK (own folder writable, another''s folder refused)';
exception when others then
  raise notice 'CHECK storage-upload-own-folder: ERROR %', sqlerrm;
end $$;

-- ── 26. Reads follow the same rule; the public prefixes are the only anonymous read ───────────
do $$
declare v_mine integer; v_theirs integer; v_public integer;
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);

  insert into storage.objects (bucket_id, name) values ('media', 'catalog/poster.png')
  on conflict do nothing;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  select count(*) into v_mine from storage.objects
   where name = 'u/11111111-1111-4111-8111-111111111111/own.png';
  select count(*) into v_public from storage.objects where name = 'catalog/poster.png';

  perform set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
  select count(*) into v_theirs from storage.objects
   where name = 'u/11111111-1111-4111-8111-111111111111/own.png';

  if v_mine <> 1 then
    raise notice 'CHECK storage-read-scope: FAIL the owner cannot read their own object (% row)', v_mine;
    return;
  end if;

  if v_theirs <> 0 then
    raise notice 'CHECK storage-read-scope: FAIL another member read a private object (% row(s))', v_theirs;
    return;
  end if;

  if v_public <> 1 then
    raise notice 'CHECK storage-read-scope: FAIL the public catalog prefix is not readable (% row)', v_public;
    return;
  end if;

  -- Anonymous readers get the public prefixes and nothing else.
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'anon', true);

  if exists (select 1 from storage.objects where name = 'u/11111111-1111-4111-8111-111111111111/own.png') then
    raise notice 'CHECK storage-read-scope: FAIL an anonymous reader saw a member''s object';
    return;
  end if;

  raise notice 'CHECK storage-read-scope: OK (owner reads own, others cannot, catalog/ is public)';
exception when others then
  raise notice 'CHECK storage-read-scope: ERROR %', sqlerrm;
end $$;

-- ── 27. The delete policy is scoped to the owner ──────────────────────────────────────────────
-- A DELETE cannot be exercised here at all: storage.protect_delete() refuses every one of them, for
-- every role. The policy is therefore asserted structurally — it must exist, and it must name the
-- folder owner rather than admit anyone.
do $$
declare v_qual text;
begin
  select qual into v_qual from pg_policies
   where schemaname = 'storage' and tablename = 'objects' and policyname = 'media_delete_own_folder';

  if v_qual is null then
    raise notice 'CHECK storage-delete-policy: FAIL storage.objects has no media_delete_own_folder policy';
    return;
  end if;

  if v_qual !~ 'storage_owner' or v_qual !~ 'auth\.uid\(\)' then
    raise notice 'CHECK storage-delete-policy: FAIL the delete policy is not scoped to the owner: %', v_qual;
    return;
  end if;

  raise notice 'CHECK storage-delete-policy: OK (scoped to storage_owner(name) = auth.uid())';
exception when others then
  raise notice 'CHECK storage-delete-policy: ERROR %', sqlerrm;
end $$;


-- ── 28. Claim/report behavior is tested only in disposable PostgreSQL, never against the live global queue ──
do $$
declare
  v_notification uuid;
  v_token uuid;
  v_delivery uuid;
  v_claimed_notification uuid;
  v_status text;
  v_sent_at timestamptz;
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);

  -- Isolate this local behavior check from any fixtures created by earlier blocks.
  update public.notification_deliveries
     set status = 'failed', sent_at = null, attempt = 0, next_attempt_at = now() + interval '1 day';
  update public.push_tokens set disabled_at = now();
  update public.user_preferences set notify_system = true
   where user_id = '11111111-1111-4111-8111-111111111111';

  insert into public.push_tokens (user_id, token, platform, device_name, disabled_at)
  values ('11111111-1111-4111-8111-111111111111', 'verification-local-claim-123456789', 'android', 'isolated claim test', null)
  on conflict (token) do update set disabled_at = null
  returning id into v_token;

  insert into public.notifications (recipient_id, kind, "group", dedupe_key, title, scheduled_for, expires_at)
  values ('11111111-1111-4111-8111-111111111111', 'system', 'system', 'verify-local-claim-report', 'Local delivery', now(), now() + interval '1 day')
  returning id into v_notification;

  insert into public.notification_deliveries (notification_id, push_token_id, next_attempt_at)
  values (v_notification, v_token, now()) on conflict (notification_id, push_token_id) do nothing;

  select c.delivery_id, c.notification_id
    into v_delivery, v_claimed_notification
    from public.claim_notification_deliveries(1, 5) c;
  if v_delivery is null or v_claimed_notification <> v_notification then
    raise notice 'CHECK notification-claim-report: FAIL claim did not return the isolated row';
    return;
  end if;

  perform public.report_delivery(v_delivery, true, null, false, 'verification-local-provider-id');
  select status::text, sent_at into v_status, v_sent_at
    from public.notification_deliveries where id = v_delivery;
  if v_status <> 'sent' or v_sent_at is null then
    raise notice 'CHECK notification-claim-report: FAIL report did not persist sent state';
    return;
  end if;

  raise notice 'CHECK notification-claim-report: OK (isolated delivery claimed and reported sent)';
exception when others then
  raise notice 'CHECK notification-claim-report: ERROR %', sqlerrm;
end $$;
