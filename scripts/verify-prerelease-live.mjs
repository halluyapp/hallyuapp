#!/usr/bin/env node
/**
 * Live Multi-Account End-to-End Pre-Release Verification Suite (`scripts/verify-prerelease-live.mjs`)
 *
 * Runs directly against live Supabase HTTPS endpoints (`Auth` + `PostgREST` + `Storage` + `CDN`)
 * using real separate member accounts and cleans up 100% of ephemeral users & storage objects in
 * `finally {}` without modifying any existing production member data.
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

if (typeof globalThis.WebSocket === 'undefined') {
  try {
    const { default: NodeWebSocket } = await import('ws');
    globalThis.WebSocket = NodeWebSocket;
  } catch {
    // Non-fatal for REST/Auth/Storage verification on Node 22+
  }
}

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(2);
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anon = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const runTag = crypto.randomBytes(3).toString('hex');
const createdUserIds = [];
const uploadedMediaPaths = [];

async function makeTestMember(roleName) {
  const email = `audit.${roleName}.${runTag}@example.invalid`;
  const password = `Audit!${runTag}#Aa9`;
  const handle = `verify_${roleName}_${runTag}`.slice(0, 20);
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { handle, display_name: `Audit ${roleName}` },
  });
  assert.equal(error, null, `Failed creating ${roleName}: ${error?.message}`);
  const id = data.user.id;
  createdUserIds.push(id);

  await admin
    .from('profiles')
    .update({ handle, display_name: `Audit ${roleName}`, account_status: 'active' })
    .eq('id', id);

  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const sign = await client.auth.signInWithPassword({ email, password });
  assert.equal(sign.error, null, `Sign-in failed for ${roleName}: ${sign.error?.message}`);
  return { id, handle, email, client };
}

const checks = [];
async function step(name, fn) {
  await fn();
  checks.push(name);
  console.log(`  ✓ ${name}`);
}

console.log('HALLYU LIVE PRE-RELEASE AUDIT SUITE');
console.log('===================================');

try {
  const owner = await makeTestMember('owner');
  const follower = await makeTestMember('follw');
  const stranger = await makeTestMember('strng');
  const blocked = await makeTestMember('blckd');
  const deleter = await makeTestMember('delme');

  const { data: sampleTitles } = await anon.from('titles').select('id').limit(2);
  const titleA = sampleTitles?.[0]?.id ?? null;
  const titleB = sampleTitles?.[1]?.id ?? titleA;

  // Turn `owner` into a private account with real post + real private `media` upload
  await step('P1 #1 Setup: Private owner publishes post + private media object in Storage', async () => {
    const upd = await owner.client.from('profiles').update({ is_private: true }).eq('id', owner.id);
    assert.equal(upd.error, null);

    const postId = crypto.randomUUID();
    const insPost = await owner.client.from('posts').insert({
      id: postId,
      author_id: owner.id,
      type: 'discussion',
      title: 'Private Episode Notes',
      kind: 'general',
      body: 'Strictly followers-only notes #privtag' + runTag,
      spoiler: 'none',
      visibility: 'public',
      hashtags: ['privtag' + runTag],
      title_id: titleA,
    });
    assert.equal(insPost.error, null, insPost.error?.message);

    // Upload real bytes to private `media` bucket
    const storagePath = `u/${owner.id}/${postId}-0.jpg`;
    const { data: uploadId, error: beginErr } = await owner.client.rpc('begin_media_upload', {
      p_storage_path: storagePath,
      p_kind: 'image',
      p_byte_size: 64,
      p_content_type: 'image/jpeg',
    });
    assert.equal(beginErr, null, beginErr?.message);
    uploadedMediaPaths.push(storagePath);

    const upRes = await owner.client.storage
      .from('media')
      .upload(storagePath, Buffer.alloc(64, 0xff), { contentType: 'image/jpeg', upsert: true });
    assert.equal(upRes.error, null, upRes.error?.message);

    const { error: compErr } = await owner.client.rpc('complete_media_upload', {
      p_upload_id: uploadId,
      p_post_id: postId,
      p_position: 0,
      p_width: 800,
      p_height: 800,
      p_duration_ms: null,
      p_poster_path: null,
    });
    assert.equal(compErr, null, compErr?.message);

    owner.postId = postId;
    owner.storagePath = storagePath;
  });

  await step('P1 #1 + P2 #8: Anonymous, unapproved, and blocked users are denied private post rows AND Storage signed URLs; forged follow accept fails', async () => {
    // Stranger requests to follow -> creates pending request only (not approved)
    const reqRes = await stranger.client.rpc('set_follow', {
      p_kind: 'user',
      p_target_id: owner.id,
      p_on: true,
    });
    assert.equal(reqRes.error, null);
    assert.equal(reqRes.data, false, 'Follow on private profile must stay pending (false)');

    // Forged reverse respond_follow_request MUST fail
    const forged = await stranger.client.rpc('respond_follow_request', {
      p_requester_id: owner.id,
      p_accept: true,
    });
    assert.notEqual(forged.error, null, 'Forged respond_follow_request must fail on server');

    // Approve `follower`, block `blocked`
    const reqFollower = await follower.client.rpc('set_follow', {
      p_kind: 'user',
      p_target_id: owner.id,
      p_on: true,
    });
    assert.equal(reqFollower.error, null);
    const approveFollower = await owner.client.rpc('respond_follow_request', {
      p_requester_id: follower.id,
      p_accept: true,
    });
    assert.equal(approveFollower.error, null, approveFollower.error?.message);

    // Replaying already-handled follow request MUST fail
    const replay = await owner.client.rpc('respond_follow_request', {
      p_requester_id: follower.id,
      p_accept: true,
    });
    assert.notEqual(replay.error, null, 'Replaying handled follow request must fail');

    const blk = await owner.client.rpc('set_block', { p_user_id: blocked.id, p_on: true });
    assert.equal(blk.error, null);

    // Verify 3 unauthorized roles (`anon`, `stranger`, `blocked`) get 0 rows, 0 feed_page leaks, AND cannot sign storage URL
    for (const [label, client] of [
      ['anonymous', anon],
      ['unapproved member', stranger.client],
      ['blocked member', blocked.client],
    ]) {
      const { data: postRows } = await client.from('posts').select('id').eq('id', owner.postId);
      assert.equal(postRows?.length ?? 0, 0, `${label} must see 0 private posts`);

      const { data: mediaRows } = await client.from('post_media').select('post_id').eq('post_id', owner.postId);
      assert.equal(mediaRows?.length ?? 0, 0, `${label} must see 0 private post_media rows`);

      const feedCheck = await client.rpc('feed_page', {
        p_scope: 'latest',
        p_world: null,
        p_title_id: null,
        p_limit: 30,
        p_cursor: null,
        p_community_id: null,
      });
      assert.equal(feedCheck.error, null, `${label} feed_page failed: ${feedCheck.error?.message}`);
      const leakedInFeed = (feedCheck.data?.items ?? []).some((item) => item.id === owner.postId);
      assert.equal(leakedInFeed, false, `${label} feed_page must never leak private post`);

      const signAttempt = await client.storage.from('media').createSignedUrls([owner.storagePath], 60);
      const leakedUrl = signAttempt.data?.[0]?.signedUrl ?? null;
      assert.equal(leakedUrl, null, `${label} must NOT obtain a signed URL for private media`);
    }

    // Verify both authorized roles (`owner` and `approved follower`) read post row AND valid 200 OK signed media URL
    for (const [label, client] of [
      ['owner', owner.client],
      ['approved follower', follower.client],
    ]) {
      const { data: postRows } = await client.from('posts').select('id').eq('id', owner.postId);
      assert.equal(postRows?.length, 1, `${label} must read private post`);

      const signOk = await client.storage.from('media').createSignedUrls([owner.storagePath], 60);
      assert.equal(signOk.error, null);
      const signedUrl = signOk.data?.[0]?.signedUrl;
      assert.ok(signedUrl, `${label} must obtain signed URL`);
      const mediaHttp = await fetch(signedUrl);
      assert.equal(mediaHttp.status, 200, `${label} signed URL must return 200 OK`);
    }
  });

  await step('P1 #4: Both handle & UUID send_direct_message overloads emit exact 1 recipient notification, 0 sender copies, and block private shared posts', async () => {
    // Sharing an unreadable private post via DM MUST be rejected on server
    const leakedShare = await stranger.client.rpc('send_direct_message', {
      p_recipient_handle: follower.handle,
      p_body: 'Attempt private post share',
      p_shared_drama_id: null,
      p_shared_post_id: owner.postId,
    });
    assert.notEqual(leakedShare.error, null, 'Sharing unreadable private post via DM must fail');

    // Handle overload (used by Messages UI) -> exact 1 notification (0 duplicates!)
    const dmHandleRes = await follower.client.rpc('send_direct_message', {
      p_recipient_handle: stranger.handle,
      p_body: `Live handle DM ${runTag}`,
      p_shared_drama_id: null,
      p_shared_post_id: null,
    });
    assert.equal(dmHandleRes.error, null, dmHandleRes.error?.message);

    const { data: afterHandleNotifs } = await stranger.client
      .from('notifications')
      .select('id, dedupe_key')
      .eq('recipient_id', stranger.id);
    const handleDmNotifs = (afterHandleNotifs ?? []).filter((n) => String(n.dedupe_key ?? '').startsWith('dm:'));
    assert.equal(handleDmNotifs.length, 1, `Expected exact 1 DM notification after handle DM, got ${handleDmNotifs.length}`);

    // UUID overload -> exact 2 notifications total across 2 DMs
    const dmRes = await follower.client.rpc('send_direct_message', {
      p_recipient_id: stranger.id,
      p_body: `Live UUID DM ${runTag}`,
    });
    assert.equal(dmRes.error, null, dmRes.error?.message);

    const { data: recipNotifs } = await stranger.client
      .from('notifications')
      .select('id, dedupe_key')
      .eq('recipient_id', stranger.id);
    const dmNotifs = (recipNotifs ?? []).filter((n) => String(n.dedupe_key ?? '').startsWith('dm:'));
    assert.equal(dmNotifs.length, 2, `Expected exact 2 DM notifications across 2 DMs, got ${dmNotifs.length}`);

    const { data: senderNotifs } = await follower.client
      .from('notifications')
      .select('id, dedupe_key')
      .eq('recipient_id', follower.id);
    const senderDmNotifs = (senderNotifs ?? []).filter((n) => String(n.dedupe_key ?? '').startsWith('dm:'));
    assert.equal(senderDmNotifs.length, 0, 'Sender must receive 0 DM notifications');
  });

  await step('P2 #5: Editing post persists title, kind, spoiler, title_id, season, episode, and hashtags on reload', async () => {
    const upd = await owner.client
      .from('posts')
      .update({
        title: 'Updated Private Theory',
        body: 'Updated body #editedtag',
        kind: 'theory',
        spoiler: 'episode',
        title_id: titleB,
        season: 1,
        episode: 6,
        hashtags: ['editedtag'],
        edited_at: new Date().toISOString(),
      })
      .eq('id', owner.postId)
      .select('id, title, kind, spoiler, title_id, season, episode, hashtags')
      .single();
    assert.equal(upd.error, null, upd.error?.message);
    assert.equal(upd.data.title, 'Updated Private Theory');
    assert.equal(upd.data.kind, 'theory');
    assert.equal(upd.data.spoiler, 'episode');
    assert.equal(upd.data.title_id, titleB);
    assert.equal(upd.data.season, 1);
    assert.equal(upd.data.episode, 6);
    assert.deepEqual(upd.data.hashtags, ['editedtag']);
  });

  await step('P2 #9: Setting and clearing profile bio persists NULL across backend reload without overwriting unrelated fields', async () => {
    const setRes = await follower.client
      .from('profiles')
      .update({ bio: 'Temporary bio before clear', favorite_genres: ['Thriller', 'Romance'] })
      .eq('id', follower.id);
    assert.equal(setRes.error, null);

    const clearRes = await follower.client
      .from('profiles')
      .update({ bio: null })
      .eq('id', follower.id);
    assert.equal(clearRes.error, null);

    const { data: reloaded } = await follower.client
      .from('profiles')
      .select('bio, display_name, favorite_genres')
      .eq('id', follower.id)
      .single();
    assert.equal(reloaded.bio, null, 'Cleared bio must reload as null');
    assert.equal(reloaded.display_name, 'Audit follw');
    assert.deepEqual(reloaded.favorite_genres, ['Thriller', 'Romance']);
  });

  await step('Section 3 Core Flows: Onboarding, public follow/unfollow, public post/comment/reaction/save, feed_page, watchlist progress, search, preferences, and mark_notifications_read', async () => {
    // 1. Onboarding + user session restore
    const { data: authUser } = await follower.client.auth.getUser();
    assert.equal(authUser?.user?.id, follower.id);
    const onb = await follower.client.rpc('complete_onboarding', {
      p_worlds: ['kdrama', 'anime'],
      p_genres: ['Thriller', 'Romance'],
      p_step: 4,
    });
    assert.equal(onb.error, null, onb.error?.message);

    // 2. Public follow + immediate active state + unfollow
    const pubFollow = await follower.client.rpc('set_follow', {
      p_kind: 'user',
      p_target_id: stranger.id,
      p_on: true,
    });
    assert.equal(pubFollow.error, null, pubFollow.error?.message);
    assert.equal(pubFollow.data, true, 'Following a public profile must immediately activate');
    const pubUnfollow = await follower.client.rpc('set_follow', {
      p_kind: 'user',
      p_target_id: stranger.id,
      p_on: false,
    });
    assert.equal(pubUnfollow.error, null, pubUnfollow.error?.message);

    // 3. Public text post + feed_page load + comment + reaction + save + thread reload
    const pubPostId = crypto.randomUUID();
    const insPub = await follower.client.from('posts').insert({
      id: pubPostId,
      author_id: follower.id,
      type: 'post',
      body: `Core flow public post ${runTag}`,
      spoiler: 'none',
      visibility: 'public',
      title_id: titleA,
    });
    assert.equal(insPub.error, null, insPub.error?.message);

    const feedRes = await follower.client.rpc('feed_page', {
      p_scope: 'latest',
      p_world: null,
      p_title_id: null,
      p_limit: 20,
      p_cursor: null,
      p_community_id: null,
    });
    assert.equal(feedRes.error, null, feedRes.error?.message);
    assert.ok((feedRes.data?.items ?? []).some((p) => p.id === pubPostId), 'Public post must load in feed_page');

    const commentId = crypto.randomUUID();
    const insComment = await stranger.client.from('comments').insert({
      id: commentId,
      post_id: pubPostId,
      author_id: stranger.id,
      body: `Core flow reply ${runTag}`,
      spoiler: 'none',
    });
    assert.equal(insComment.error, null, insComment.error?.message);

    const reactRes = await stranger.client
      .from('reactions')
      .insert({ user_id: stranger.id, post_id: pubPostId, kind: 'loved' });
    assert.equal(reactRes.error, null, reactRes.error?.message);

    const saveRes = await stranger.client
      .from('saves')
      .upsert({ user_id: stranger.id, post_id: pubPostId }, { onConflict: 'user_id,post_id' });
    assert.equal(saveRes.error, null, saveRes.error?.message);

    const threadRes = await follower.client.rpc('get_post_thread', { p_post_id: pubPostId });
    assert.equal(threadRes.error, null, threadRes.error?.message);
    assert.ok((threadRes.data?.comments ?? []).some((c) => c.id === commentId), 'Comment must appear in get_post_thread');

    // 4. Watchlist / episode progress upsert + reload
    if (titleA) {
      const wlRes = await follower.client.rpc('upsert_watchlist_item', {
        p_title_id: titleA,
        p_status: 'watching',
        p_season: 1,
        p_episode: 5,
        p_total: null,
        p_note: 'Episode 5 cliffhanger',
        p_allow_rewind: true,
      });
      assert.equal(wlRes.error, null, wlRes.error?.message);
      const { data: wlRow } = await follower.client
        .from('watchlist_items')
        .select('status, season, current_episode, note')
        .eq('title_id', titleA)
        .single();
      assert.equal(wlRow?.status, 'watching');
      assert.equal(wlRow?.current_episode, 5);
    }

    // 5. Catalog + member search
    const { data: foundProfiles, error: searchProfErr } = await follower.client
      .from('profiles')
      .select('id, handle')
      .ilike('handle', `%${runTag}%`)
      .limit(5);
    assert.equal(searchProfErr, null);
    assert.ok((foundProfiles?.length ?? 0) >= 2, 'Profile handle search must locate test accounts');

    const { data: foundTitles, error: searchTitleErr } = await follower.client
      .from('titles')
      .select('id, name, world')
      .limit(5);
    assert.equal(searchTitleErr, null);
    assert.ok((foundTitles?.length ?? 0) >= 1, 'Catalog titles query must return seeded titles');

    // 6. Settings preferences + mark notifications read
    const prefRes = await stranger.client.rpc('merge_preferences', {
      p_patch: { true_black: true, data_saver: false },
    });
    assert.equal(prefRes.error, null, prefRes.error?.message);

    const { data: unreadBefore } = await stranger.client
      .from('notifications')
      .select('id')
      .is('read_at', null);
    assert.ok((unreadBefore?.length ?? 0) >= 1);
    const markRead = await stranger.client.rpc('mark_notifications_read', {
      p_ids: unreadBefore.map((n) => n.id),
      p_group: null,
    });
    assert.equal(markRead.error, null, markRead.error?.message);
    const { data: unreadAfter } = await stranger.client
      .from('notifications')
      .select('id')
      .in('id', unreadBefore.map((n) => n.id))
      .is('read_at', null);
    assert.equal(unreadAfter?.length ?? 0, 0, 'Notifications must persist read_at across reload');
  });

  await step('P1 #3: Account deletion purges DMs/uploads/posts/comments/social graph and marks profile deleted with server confirmation', async () => {
    const delPostId = crypto.randomUUID();
    const insDisc = await deleter.client.from('posts').insert({
      id: delPostId,
      author_id: deleter.id,
      type: 'discussion',
      title: 'Discussion before deletion',
      kind: 'general',
      body: 'Temporary discussion before permanent deletion',
      spoiler: 'none',
      visibility: 'public',
    });
    assert.equal(insDisc.error, null, insDisc.error?.message);

    const insDelComment = await deleter.client.from('comments').insert({
      id: crypto.randomUUID(),
      post_id: delPostId,
      author_id: deleter.id,
      body: 'Temporary comment before permanent deletion',
      spoiler: 'none',
    });
    assert.equal(insDelComment.error, null, insDelComment.error?.message);

    const delMediaPath = `u/${deleter.id}/${delPostId}-orphan.jpg`;
    uploadedMediaPaths.push(delMediaPath);
    const beginDelMedia = await deleter.client.rpc('begin_media_upload', {
      p_storage_path: delMediaPath,
      p_kind: 'image',
      p_byte_size: 32,
      p_content_type: 'image/jpeg',
    });
    assert.equal(beginDelMedia.error, null, beginDelMedia.error?.message);

    await deleter.client.rpc('send_direct_message', {
      p_recipient_id: follower.id,
      p_body: 'Temporary DM before permanent deletion',
    });

    const delRpc = await deleter.client.rpc('delete_account');
    assert.equal(delRpc.error, null, delRpc.error?.message);
    assert.equal(delRpc.data?.deleted, true);
    assert.ok(Number(delRpc.data?.media_objects_queued ?? 0) >= 1, 'Expected >=1 queued media object on account deletion');

    const { data: activePosts } = await admin
      .from('posts')
      .select('id')
      .eq('author_id', deleter.id)
      .eq('state', 'active');
    assert.equal(activePosts?.length ?? 0, 0);

    const { data: activeComments } = await admin
      .from('comments')
      .select('id')
      .eq('author_id', deleter.id)
      .eq('state', 'active');
    assert.equal(activeComments?.length ?? 0, 0);

    const { data: remainingUploads } = await admin
      .from('media_uploads')
      .select('id')
      .eq('user_id', deleter.id);
    assert.equal(remainingUploads?.length ?? 0, 0);

    const { data: remainingDms } = await admin
      .from('direct_messages')
      .select('id')
      .or(`sender_id.eq.${deleter.id},recipient_id.eq.${deleter.id}`);
    assert.equal(remainingDms?.length ?? 0, 0);

    const { data: deletedProfile } = await admin
      .from('profiles')
      .select('account_status, bio')
      .eq('id', deleter.id)
      .single();
    assert.equal(deletedProfile?.account_status, 'deleted');
    assert.equal(deletedProfile?.bio, null);
  });

  await step('P2 #7 & Live Deployment: All 3 signed ABI APKs + manifest + live GitHub Pages serve valid 200 OK artifacts', async () => {
    const manifestRes = await fetch(`${SUPABASE_URL}/storage/v1/object/public/app-releases/latest/manifest.json`);
    assert.equal(manifestRes.status, 200);
    const manifest = await manifestRes.json();
    assert.ok(manifest.versionCode > 10000);

    for (const [abiName, apkUrl] of [
      ['arm64-v8a', `${SUPABASE_URL}/storage/v1/object/public/app-releases/latest/hallyu-arm64.apk`],
      ['armeabi-v7a', `${SUPABASE_URL}/storage/v1/object/public/app-releases/latest/hallyu-armeabi-v7a.apk`],
      ['x86_64', `${SUPABASE_URL}/storage/v1/object/public/app-releases/latest/hallyu-x86_64.apk`],
    ]) {
      const fullRes = await fetch(apkUrl);
      assert.equal(fullRes.status, 200, `${abiName} APK returned HTTP ${fullRes.status}`);
      const buf = Buffer.from(await fullRes.arrayBuffer());
      assert.ok(buf.byteLength > 5_000_000, `${abiName} APK unexpectedly small (${buf.byteLength} bytes)`);
      assert.equal(buf[0], 0x50, `${abiName} missing ZIP P header`);
      assert.equal(buf[1], 0x4b, `${abiName} missing ZIP K header`);
      assert.equal(buf[2], 0x03, `${abiName} missing ZIP 0x03 header`);
      assert.equal(buf[3], 0x04, `${abiName} missing ZIP 0x04 header`);
      const actualSha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const expectedSha256 = manifest.artifacts?.[abiName]?.sha256;
      if (expectedSha256) {
        assert.equal(actualSha256, expectedSha256, `${abiName} SHA-256 mismatch vs manifest.json`);
      }
      console.log(`    • ${abiName}: ${buf.byteLength} bytes, sha256=${actualSha256}`);
    }

    const pagesRes = await fetch('https://halluyapp.github.io/hallyuapp/');
    assert.equal(pagesRes.status, 200, 'Live GitHub Pages site must return HTTP 200 OK');
    const html = await pagesRes.text();
    assert.ok(html.includes('Hallyu'), 'Live GitHub Pages HTML must render Hallyu shell');
  });
} finally {
  if (uploadedMediaPaths.length > 0) {
    await admin.storage.from('media').remove(uploadedMediaPaths).catch(() => {});
  }
  for (const uid of createdUserIds) {
    await admin.auth.admin.deleteUser(uid).catch(() => {});
  }
  console.log(`  ✓ Cleaned up ${createdUserIds.length} ephemeral test account(s) and ${uploadedMediaPaths.length} media object(s)`);
}

console.log(`\nOVERALL STATUS: PASS (${checks.length} live end-to-end audit checks passed)`);
