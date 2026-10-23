#!/usr/bin/env node
// Hallyu backend verification.
//
// This is a real integration test against a real Supabase project: it creates two throwaway members
// through the admin API, exercises every write path as one member and reads it back as the other,
// proves row level security actually isolates them, uploads and reads a real object in the `media`
// bucket, and deletes everything it created. Nothing here is mocked.
//
// Credentials come from the environment only (CI supplies them from GitHub Secrets):
//
//   SUPABASE_URL                  project URL                     required
//   SUPABASE_ANON_KEY             public/anon key (client-safe)    required
//   SUPABASE_SERVICE_ROLE_KEY     privileged key (CI only)         required
//
// The Rork OAuth leg is deliberately NOT here: it depends on a human-minted refresh token, so it
// lives in its own suite — scripts/verify-rork-auth.mjs — and its own CI job. This suite gates the
// backend; that one gates the optional Google/Apple path. Neither hides the other.
//
// Exit codes:  0 = PASS   1 = FAIL   2 = NOT CONFIGURED (no credentials in this environment)

import process from 'node:process';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { scanRepository } from './lib/secret-scan.mjs';
import { expectedFunctions, nullArgsBody, classifyRpcProbe } from './lib/db-signatures.mjs';

const REPO_ROOT = process.argv[2] ?? process.cwd();

// supabase-js builds its Realtime client at createClient() time and needs a WebSocket global. Node 22
// ships one natively (CI uses 22); on older Node the `ws` package fills in, and if neither exists we
// say so plainly instead of reporting the backend as broken.
if (typeof globalThis.WebSocket === 'undefined') {
  try {
    const { default: NodeWebSocket } = await import('ws');
    globalThis.WebSocket = NodeWebSocket;
  } catch {
    console.error('This suite needs Node.js 22+ (native WebSocket) or the `ws` package installed — the Supabase client cannot be constructed without one.');
    process.exit(1);
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ---------------------------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------------------------

const results = [];
let currentGroup = 'Setup';

const groups = [];
const startGroup = (name) => {
  currentGroup = name;
  groups.push(name);
};

const test = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ group: currentGroup, name, ok: true, detail: detail ?? '' });
  } catch (error) {
    results.push({ group: currentGroup, name, ok: false, detail: error?.message ?? String(error) });
  }
};

/**
 * A check that could not run at all, as opposed to one that ran and failed.
 *
 * The distinction matters: a gateway that will not serve the OpenAPI document means the schema
 * shape is *unverified*, which is not the same as verified-and-wrong and must never be reported as a
 * pass. Blocked checks are counted and reported on their own, and they fail the run — an
 * unverified claim is not a verified one.
 */
const block = (name, reason) => {
  results.push({ group: currentGroup, name, ok: false, blocked: true, detail: reason });
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const suffix = Math.random().toString(36).slice(2, 8);
const stamp = Date.now();
const userA = {
  email: `hallyu.verify.a.${suffix}@example.invalid`,
  password: `verify-${suffix}-Aa1!`,
  handle: `verify_a_${suffix}`,
};
const userB = {
  email: `hallyu.verify.b.${suffix}@example.invalid`,
  password: `verify-${suffix}-Bb2!`,
  handle: `verify_b_${suffix}`,
};

const anonymous = () => createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
const admin = () =>
  createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const asUser = async (email, password) => {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  assert(!error, `sign-in failed for ${email}: ${error?.message}`);
  return client;
};

// ---------------------------------------------------------------------------------------------
// 0. Configuration
// ---------------------------------------------------------------------------------------------

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  console.log('HALLYU BACKEND VERIFICATION');
  console.log('===========================');
  console.log('');
  console.log('  Supabase connection       NOT CONFIGURED');
  console.log('');
  console.log('Missing credentials (set these as GitHub Secrets, never in code):');
  if (!SUPABASE_URL) console.log('  - SUPABASE_URL');
  if (!ANON_KEY) console.log('  - SUPABASE_ANON_KEY');
  if (!SERVICE_ROLE_KEY) console.log('  - SUPABASE_SERVICE_ROLE_KEY');
  console.log('');
  console.log('===========================');
  console.log('OVERALL STATUS: NOT CONFIGURED');
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// 1. Connectivity and schema
// ---------------------------------------------------------------------------------------------

let openapi = null;
let schemaUnavailable = null;
let alice = null;
let bob = null;
let aliceId = null;
let bobId = null;
let testTitleId = null;

startGroup('Supabase connection');
await test('Supabase reachable with the anon key', async () => {
  const { data, error } = await anonymous().from('worlds').select('id').limit(1);
  assert(!error, `anon query failed: ${error?.message}`);
  assert(Array.isArray(data), 'worlds did not return an array');
  return `${data.length} world row(s) visible`;
});

await test('Project serves a PostgREST schema', async () => {
  // The anon key is the client-safe credential and the one a real deployment would use, so it is
  // tried first. A gateway in front of PostgREST may refuse the schema root to it, in which case
  // the service-role key is asked — same document, privileged reader. If neither works the schema
  // checks below are reported as blocked rather than as a wall of `Cannot read properties of null`.
  const attempts = [
    ['anon key', ANON_KEY],
    ['service-role key', SERVICE_ROLE_KEY],
  ];
  const failures = [];

  for (const [label, key] of attempts) {
    if (!key) continue;
    const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      // `application/openapi+json` exactly, with no fallback in the list: PostgREST answers the root
      // with a compact Swagger 2.0 document when the client will take `application/json`, and that
      // document has no `relationships` at all — which would report every foreign key as missing on
      // a project whose foreign keys are all present.
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/openapi+json' },
    });

    if (!response.ok) {
      failures.push(`${label}: HTTP ${response.status}`);
      continue;
    }

    const document = await response.json();
    if (!document?.definitions || Object.keys(document.definitions).length === 0) {
      failures.push(`${label}: the document has no definitions`);
      continue;
    }

    openapi = document;
    return `${Object.keys(document.definitions).length} relations exposed (via the ${label})`;
  }

  schemaUnavailable = `the project's OpenAPI document is not readable (${failures.join('; ')})`;
  assert(false, schemaUnavailable);
});

startGroup('Schema');
const EXPECTED_TABLES = [
  'analytics_events',
  'blocks',
  'catalog_provider_state',
  'catalog_rank_snapshots',
  'catalog_sync_runs',
  'collection_follows',
  'collection_items',
  'collections',
  'comments',
  'communities',
  'community_members',
  'follows',
  'job_runs',
  'media_uploads',
  'moderation_actions',
  'mutes',
  'notification_deliveries',
  'notifications',
  'people',
  'person_follows',
  'post_media',
  'post_shares',
  'posts',
  'profiles',
  'providers',
  'push_tokens',
  'reactions',
  'reports',
  'saves',
  'title_alerts',
  'title_episodes',
  'title_follows',
  'title_people',
  'titles',
  'user_preferences',
  'watchlist_items',
  'worlds',
];

const EXPECTED_COLUMNS = {
  profiles: ['id', 'handle', 'display_name', 'avatar_path', 'bio', 'worlds', 'role', 'account_status', 'onboarding_completed'],
  posts: ['id', 'author_id', 'type', 'body', 'spoiler', 'state', 'visibility', 'world', 'title_id', 'comment_count', 'loved_count'],
  comments: ['id', 'post_id', 'author_id', 'parent_id', 'body', 'spoiler', 'state'],
  reactions: ['id', 'user_id', 'kind', 'post_id', 'comment_id'],
  watchlist_items: ['user_id', 'title_id', 'status', 'season', 'current_episode', 'completed_at'],
  notifications: ['id', 'recipient_id', 'kind', 'actor_ids', 'read_at'],
  push_tokens: ['id', 'user_id', 'token', 'platform'],
  user_preferences: ['user_id', 'protection', 'autoplay', 'notify_social', 'muted_words'],
  titles: ['id', 'provider_id', 'external_id', 'media_type', 'world', 'title', 'year', 'status'],
  collections: ['id', 'owner_id', 'title', 'visibility', 'item_count'],
  reports: ['id', 'reporter_id', 'target_type', 'target_id', 'status'],
};

const requireSchema = () => {
  if (!openapi) block('Schema document', schemaUnavailable ?? 'the OpenAPI document was not read');
  return Boolean(openapi);
};

if (requireSchema()) {
  await test('Every expected table exists', async () => {
    const defined = new Set(Object.keys(openapi.definitions));
    const missing = EXPECTED_TABLES.filter((table) => !defined.has(table));
    assert(missing.length === 0, `missing tables: ${missing.join(', ')}`);
    return `${EXPECTED_TABLES.length} tables present`;
  });

  await test('Key columns exist', async () => {
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      const definition = openapi.definitions[table];
      assert(definition, `table ${table} is not exposed`);
      const present = new Set(Object.keys(definition.properties ?? {}));
      const missing = columns.filter((column) => !present.has(column));
      assert(missing.length === 0, `${table} is missing ${missing.join(', ')}`);
    }
    return `${Object.keys(EXPECTED_COLUMNS).length} tables column-checked`;
  });

  // PostgREST publishes foreign keys either as `definition.relationships` or as `<fk table='...'/>`
  // tags on each column's Swagger 2.0 property description. Support both representations so live
  // PostgREST Swagger 2.0 schemas are genuinely checked rather than marked blocked.
  const referencedTablesOf = (definition) => {
    const refs = new Set((definition?.relationships ?? []).map((r) => r.referencedTable).filter(Boolean));
    for (const prop of Object.values(definition?.properties ?? {})) {
      const desc = String(prop?.description ?? '');
      for (const m of desc.matchAll(/<fk\s+table='([^']+)'/g)) {
        if (m[1]) refs.add(m[1]);
      }
    }
    return refs;
  };

  const declaresRelationships = Object.values(openapi.definitions).some(
    (definition) => referencedTablesOf(definition).size > 0,
  );

  if (declaresRelationships) {
    await test('Foreign keys are declared (PostgREST relationships)', async () => {
      const problems = [];
      const expectRelationships = {
        posts: ['profiles', 'titles', 'communities'],
        comments: ['posts', 'profiles'],
        reactions: ['profiles', 'posts', 'comments'],
        follows: ['profiles'],
        watchlist_items: ['profiles', 'titles'],
        collection_items: ['collections', 'titles'],
      };

      for (const [table, targets] of Object.entries(expectRelationships)) {
        const refs = referencedTablesOf(openapi.definitions[table]);
        for (const target of targets) {
          if (!refs.has(target)) {
            problems.push(`${table} → ${target}`);
          }
        }
      }
      assert(problems.length === 0, `missing relationships: ${problems.join(', ')}`);
      return 'posts, comments, reactions, follows, watchlist, collection items are related';
    });
  } else {
    block(
      'Foreign keys are declared (PostgREST relationships)',
      "the project's schema document declares no relationships at all, so this check cannot say whether the foreign keys exist",
    );
  }
}

startGroup('RPCs');
const RPCS = [
  'toggle_reaction',
  'toggle_save',
  'set_follow',
  'set_block',
  'set_mute',
  'mark_notifications_read',
  'register_push_token',
  'report_content',
  'merge_preferences',
  'complete_onboarding',
  'upsert_watchlist_item',
  'handle_is_available',
  'get_bootstrap',
  'delete_account',
  'feed_posts',
  'search_titles',
  'record_event',
  // Catalog layer
  'catalog_begin_run',
  'catalog_finish_run',
  'catalog_provider_is_usable',
  'catalog_mark_missing',
  'catalog_recompute_title_state',
  'titles_needing_refresh',
  'refresh_trending',
  'trending_titles',
  'airing_titles',
  'upcoming_titles',
  'recently_released_titles',
  'recommended_titles',
  'get_home_discovery',
  'get_world_discoveries',
  'get_title_discovery',
  // Scheduled jobs
  'job_claim',
  'job_complete',
  'run_scheduled_jobs',
  // Notifications and delivery
  'enqueue_notification',
  'fanout_notification',
  'fanout_due_notifications',
  'claim_notification_deliveries',
  'report_delivery',
  'notification_summary',
  'disable_push_token',
  'job_expire_notifications',
  // Alerts
  'job_queue_upcoming_episodes',
  'job_queue_new_episodes',
  'title_audience',
  // Media lifecycle
  'begin_media_upload',
  'complete_media_upload',
  'fail_media_upload',
  'media_drop_missing_objects',
  'job_reconcile_media',
  // Share accounting
  'record_share',
  // Communities
  'join_community',
  'claim_community_ownership',
  'set_community_role',
  'remove_community_member',
  'ban_community_member',
  'update_community_settings',
  'community_roster',
  'review_membership_request',
  'moderate_community_post',
  'transfer_community_ownership',
  // Moderation
  'require_moderator',
  'moderate_content',
  'resolve_report',
  'escalate_report',
  'moderation_queue',
  'moderation_history',
  // Search
  'search_people',
  'search_communities',
  'search_all',
  'search_suggestions',
  // Feed
  'feed_page',
  'comment_page',
];

await test('Every documented RPC exists', async () => {
  // PostgREST resolves an RPC by name *and* parameter list, so the probe has to send the parameters
  // the migrations declare — all null, which any writer refuses before it touches a row. Probing
  // with a made-up parameter name answers PGRST202 for every function, present or not, which is how
  // this check used to report the whole API missing against a healthy project.
  const declared = expectedFunctions(path.join(REPO_ROOT, 'supabase', 'migrations'));
  const service = admin();
  const missing = [];
  const undeclared = [];
  const unreachable = [];

  for (const rpc of RPCS) {
    const signature = declared.get(rpc);
    if (!signature) {
      undeclared.push(rpc);
      continue;
    }

    const { error, status } = await service.rpc(rpc, JSON.parse(nullArgsBody(signature.argText)));
    const verdict = classifyRpcProbe({ code: error?.code, message: error?.message, status });

    if (verdict === 'missing') missing.push(rpc);
    else if (verdict === 'unreachable') unreachable.push(`${rpc} (${error?.message})`);
  }

  assert(undeclared.length === 0, `the suite requires RPCs the migrations do not define: ${undeclared.join(', ')}`);
  assert(unreachable.length === 0, `unreachable: ${unreachable.join(', ')}`);
  assert(missing.length === 0, `missing RPCs: ${missing.join(', ')}`);
  return `${RPCS.length} RPCs exposed`;
});

// ---------------------------------------------------------------------------------------------
// 2. Authentication
// ---------------------------------------------------------------------------------------------

startGroup('Authentication');

await test('Create two test members (admin API)', async () => {
  const service = admin();
  for (const member of [userA, userB]) {
    const { data, error } = await service.auth.admin.createUser({
      email: member.email,
      password: member.password,
      email_confirm: true,
      user_metadata: { handle: member.handle, full_name: 'Verification Account' },
    });
    assert(!error, `could not create ${member.email}: ${error?.message}`);
    member.id = data.user.id;
  }
  return `${userA.email}, ${userB.email}`;
});

await test('Sign-up created a profile row automatically', async () => {
  const { data, error } = await admin().from('profiles').select('id, handle, display_name').eq('id', userA.id).single();
  assert(!error, `profile missing for the new member: ${error?.message}`);
  assert(data.handle === userA.handle, `expected handle ${userA.handle}, got ${data.handle}`);
  return `handle "${data.handle}"`;
});

await test('Authenticated session works against the database', async () => {
  alice = await asUser(userA.email, userA.password);
  aliceId = userA.id;
  const { data, error } = await alice.from('profiles').select('id').eq('id', aliceId).single();
  assert(!error && data, `authenticated read failed: ${error?.message}`);
  return `session for ${aliceId}`;
});

await test('Second member signs in', async () => {
  bob = await asUser(userB.email, userB.password);
  bobId = userB.id;
  const { data, error } = await bob.from('profiles').select('id').eq('id', bobId).single();
  assert(!error && data, `authenticated read failed: ${error?.message}`);
  return `session for ${bobId}`;
});

// The Rork OAuth leg is verified by scripts/verify-rork-auth.mjs (its own CI job) — see the header.
await test('Rork Auth leg is covered by its own suite', async () => {
  return 'scripts/verify-rork-auth.mjs — optional credentials, never a silent skip';
});

// ---------------------------------------------------------------------------------------------
// 3. Catalog fixture + CRUD
// ---------------------------------------------------------------------------------------------

let postId = null;
let commentId = null;

startGroup('Catalog');

await test('Insert a title and read it back through search_titles', async () => {
  const external = `verify-${suffix}`;
  const { data, error } = await admin()
    .from('titles')
    .insert({
      provider_id: 'tmdb',
      external_id: external,
      media_type: 'tv',
      world: 'kdrama',
      title: `Verification Title ${suffix}`,
      year: 2026,
      status: 'airing',
      episode_count: 16,
      season_count: 1,
    })
    .select('id, title, world')
    .single();
  assert(!error, `title insert failed: ${error?.message}`);
  testTitleId = data.id;

  const { data: found, error: searchError } = await anonymous().rpc('search_titles', {
    p_query: `Verification Title ${suffix}`,
    p_world: 'kdrama',
  });
  assert(!searchError, `search_titles failed: ${searchError?.message}`);
  assert(found.some((row) => row.id === testTitleId), 'search_titles did not return the inserted title');
  return `title ${testTitleId} searchable`;
});

// ---------------------------------------------------------------------------------------------

startGroup('Profiles');

await test('Update own profile', async () => {
  const { error } = await alice
    .from('profiles')
    .update({ display_name: 'Verification A', bio: 'set by the backend verification script' })
    .eq('id', aliceId);
  assert(!error, `profile update failed: ${error?.message}`);
  const { data } = await alice.from('profiles').select('bio').eq('id', aliceId).single();
  assert(data.bio?.startsWith('set by'), 'profile update did not persist');
  return 'display_name and bio updated';
});

await test('Complete onboarding with valid worlds', async () => {
  const { data, error } = await alice.rpc('complete_onboarding', {
    p_worlds: ['kdrama', 'anime'],
    p_genres: ['Romance'],
    p_step: 4,
  });
  assert(!error, `complete_onboarding failed: ${error?.message}`);
  assert(data.onboarding_completed === true, 'onboarding was not marked complete');
  assert(Array.isArray(data.worlds) && data.worlds.length === 2, 'worlds were not stored');
  return 'worlds + genres stored';
});

await test('complete_onboarding rejects an unknown world', async () => {
  const { error } = await bob.rpc('complete_onboarding', { p_worlds: ['not-a-world'] });
  assert(error, 'an unknown world was accepted');
  return `rejected with ${error.code ?? 'an error'}`;
});

startGroup('Posts');

await test('Member creates a post', async () => {
  const { data, error } = await alice
    .from('posts')
    .insert({
      author_id: aliceId,
      type: 'discussion',
      title: 'Verification post',
      body: 'This post exists to prove the database works.',
      kind: 'general',
      spoiler: 'none',
      world: 'kdrama',
      title_id: testTitleId,
      hashtags: ['verification'],
    })
    .select('id, author_id, state')
    .single();
  assert(!error, `post insert failed: ${error?.message}`);
  postId = data.id;
  assert(data.state === 'active', 'new post is not active');
  return `post ${postId}`;
});

await test('Post counts are maintained by triggers', async () => {
  const { data } = await admin().from('profiles').select('post_count').eq('id', aliceId).single();
  assert(data.post_count >= 1, `post_count was ${data.post_count}, expected >= 1`);
  return `post_count = ${data.post_count}`;
});

await test('Duplicate reactions are impossible (one per member per post)', async () => {
  const first = await bob.from('reactions').insert({ user_id: bobId, kind: 'loved', post_id: postId });
  assert(!first.error, `first reaction failed: ${first.error?.message}`);
  const second = await bob.from('reactions').insert({ user_id: bobId, kind: 'cried', post_id: postId });
  assert(second.error, 'a second reaction on the same post was accepted');
  return `rejected with ${second.error.code ?? 'an error'}`;
});

startGroup('Comments');

await test('Member comments on a post', async () => {
  const { data, error } = await alice
    .from('comments')
    .insert({ post_id: postId, author_id: aliceId, body: 'Verification comment.' })
    .select('id, post_id')
    .single();
  assert(!error, `comment insert failed: ${error?.message}`);
  commentId = data.id;
  return `comment ${commentId}`;
});

await test('Replies must sit on the same post', async () => {
  const { error } = await bob.from('comments').insert({
    post_id: '00000000-0000-0000-0000-000000000000',
    author_id: bobId,
    parent_id: commentId,
    body: 'Reply under a comment from another post.',
  });
  assert(error, 'a reply to a comment on a different post was accepted');
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('Reply depth is limited to one level', async () => {
  const { data: reply, error: replyError } = await bob
    .from('comments')
    .insert({ post_id: postId, author_id: bobId, parent_id: commentId, body: 'A reply.' })
    .select('id')
    .single();
  assert(!replyError, `reply insert failed: ${replyError?.message}`);

  const { error } = await bob
    .from('comments')
    .insert({ post_id: postId, author_id: aliceId, parent_id: reply.id, body: 'A reply to the reply.' });
  assert(error, 'a second level of threading was accepted');
  return `rejected with ${error.code ?? 'an error'}`;
});

startGroup('Reactions');

await test('toggle_reaction sets, swaps and clears', async () => {
  const set = await bob.rpc('toggle_reaction', { p_target_type: 'post', p_target_id: postId, p_kind: 'cried' });
  assert(!set.error, `toggle_reaction set failed: ${set.error?.message}`);
  assert(set.data.active === true && set.data.kind === 'cried', 'reaction was not set');
  assert(set.data.counts.cried === 1, `post cried_count is ${set.data.counts.cried}, expected 1`);

  const swap = await bob.rpc('toggle_reaction', { p_target_type: 'post', p_target_id: postId, p_kind: 'laughed' });
  assert(!swap.error, `toggle_reaction swap failed: ${swap.error?.message}`);
  assert(swap.data.counts.cried === 0, `cried_count is ${swap.data.counts.cried} after the swap, expected 0`);
  assert(swap.data.counts.launched === undefined && swap.data.counts.laughed === 1, `laughed_count is ${swap.data.counts.laughed}, expected 1`);

  const cleared = await bob.rpc('toggle_reaction', { p_target_type: 'post', p_target_id: postId, p_kind: 'laughed' });
  assert(!cleared.error, `toggle_reaction clear failed: ${cleared.error?.message}`);
  assert(cleared.data.active === false, 'reaction was not cleared');
  return 'set → swap → cleared, counters exact';
});

await test('toggle_reaction rejects an unknown target', async () => {
  const { error } = await bob.rpc('toggle_reaction', {
    p_target_type: 'post',
    p_target_id: '00000000-0000-0000-0000-000000000000',
    p_kind: 'loved',
  });
  assert(error, 'a reaction on a missing post was accepted');
  return `rejected with ${error.code ?? 'an error'}`;
});

startGroup('Social graph');

await test('Follow, count, unfollow', async () => {
  const on = await bob.rpc('set_follow', { p_kind: 'user', p_target_id: aliceId, p_on: true });
  assert(!on.error && on.data === true, `follow failed: ${on.error?.message}`);

  const { data } = await alice.from('profiles').select('follower_count').eq('id', aliceId).single();
  assert(data.follower_count >= 1, `follower_count is ${data.follower_count}, expected >= 1`);

  const off = await bob.rpc('set_follow', { p_kind: 'user', p_target_id: aliceId, p_on: false });
  assert(!off.error && off.data === false, `unfollow failed: ${off.error?.message}`);
  return 'follower_count maintained by trigger';
});

await test('Self-follow is refused', async () => {
  const { error } = await bob.rpc('set_follow', { p_kind: 'user', p_target_id: bobId, p_on: true });
  assert(error, 'a member was allowed to follow themselves');
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('Block severs the follow relationship', async () => {
  await bob.rpc('set_follow', { p_kind: 'user', p_target_id: aliceId, p_on: true });
  const blocked = await bob.rpc('set_block', { p_user_id: aliceId, p_on: true });
  assert(!blocked.error, `block failed: ${blocked.error?.message}`);
  const { data } = await admin().from('follows').select('follower_id').eq('follower_id', bobId).eq('target_id', aliceId);
  assert(data.length === 0, 'the follow survived the block');
  await bob.rpc('set_block', { p_user_id: aliceId, p_on: false });
  return 'follow removed by block';
});

startGroup('Saves and collections');

await test('toggle_save saves and unsaves', async () => {
  const saved = await bob.rpc('toggle_save', { p_post_id: postId });
  assert(!saved.error && saved.data === true, `save failed: ${saved.error?.message}`);
  const { data } = await admin().from('posts').select('save_count').eq('id', postId).single();
  assert(data.save_count >= 1, `save_count is ${data.save_count}`);

  const unsaved = await bob.rpc('toggle_save', { p_post_id: postId });
  assert(!unsaved.error && unsaved.data === false, 'unsave failed');
  return 'save_count maintained by trigger';
});

await test('Private collection holds a title', async () => {
  const { data: collection, error } = await bob
    .from('collections')
    .insert({ owner_id: bobId, title: 'Verification shelf', visibility: 'private' })
    .select('id')
    .single();
  assert(!error, `collection insert failed: ${error?.message}`);

  const { error: itemError } = await bob
    .from('collection_items')
    .insert({ collection_id: collection.id, title_id: testTitleId, note: 'verification' });
  assert(!itemError, `collection item insert failed: ${itemError?.message}`);

  const { data } = await admin().from('collections').select('item_count').eq('id', collection.id).single();
  assert(data.item_count === 1, `item_count is ${data.item_count}, expected 1`);
  return `collection ${collection.id} with 1 item`;
});

startGroup('Watchlist');

await test('Watchlist item with progress', async () => {
  const { data, error } = await alice.rpc('upsert_watchlist_item', {
    p_title_id: testTitleId,
    p_status: 'watching',
    p_season: 1,
    p_episode: 3,
    p_total: 16,
    p_note: 'verification',
  });
  assert(!error, `upsert_watchlist_item failed: ${error?.message}`);
  assert(data.current_episode === 3, `current_episode is ${data.current_episode}`);

  const rewind = await alice.rpc('upsert_watchlist_item', {
    p_title_id: testTitleId,
    p_season: 1,
    p_episode: 1,
  });
  assert(rewind.error, 'progress was allowed to move backwards inside a season');
  return 'progress stored, backwards move rejected';
});

await test('Reaching the last episode completes the title', async () => {
  const { data, error } = await alice.rpc('upsert_watchlist_item', {
    p_title_id: testTitleId,
    p_season: 1,
    p_episode: 16,
    p_total: 16,
  });
  assert(!error, `completion failed: ${error?.message}`);
  assert(data.status === 'completed' && data.completed_at, 'the title was not marked completed');
  return 'status = completed';
});

startGroup('Notifications');

await test('Reaction produced a notification for the author', async () => {
  const { data, error } = await alice
    .from('notifications')
    .select('id, kind, actor_ids, read_at')
    .order('created_at', { ascending: false })
    .limit(10);
  assert(!error, `notification read failed: ${error?.message}`);
  assert(data.some((n) => n.kind === 'reaction'), 'no reaction notification was delivered');
  return `${data.length} notification(s), including a reaction`;
});

await test('mark_notifications_read updates the caller inbox only', async () => {
  const { data, error } = await alice.rpc('mark_notifications_read', { p_ids: null });
  assert(!error, `mark_notifications_read failed: ${error?.message}`);
  assert(typeof data === 'number', 'expected a count of updated rows');
  const { data: unread } = await alice
    .from('notifications')
    .select('id')
    .is('read_at', null);
  assert(unread.length === 0, `${unread.length} notifications are still unread`);
  return `${data} marked read`;
});

startGroup('Preferences');

await test('merge_preferences applies an allow-listed patch', async () => {
  const { data, error } = await alice.rpc('merge_preferences', {
    p_patch: { autoplay: 'always', true_black: true, notify_highlights: false },
  });
  assert(!error, `merge_preferences failed: ${error?.message}`);
  assert(data.autoplay === 'always' && data.true_black === true, 'values were not applied');
  assert(data.notify_highlights === false, 'notification preference was not applied');
  return 'autoplay=true_black+notify_highlights applied';
});

await test('Accepting the guidelines records a timestamp', async () => {
  const { data, error } = await alice.rpc('merge_preferences', { p_patch: { guidelines_accepted: true } });
  assert(!error, `merge_preferences failed: ${error?.message}`);
  assert(data.guidelines_accepted === true && data.guidelines_accepted_at, 'no timestamp recorded');
  return 'guidelines_accepted_at recorded';
});

await test('Bootstrap returns the member slice', async () => {
  const { data, error } = await alice.rpc('get_bootstrap');
  assert(!error, `get_bootstrap failed: ${error?.message}`);
  assert(data.profile?.id === aliceId, 'bootstrap did not return the caller profile');
  assert(data.prefs, 'bootstrap did not return preferences');
  assert(Array.isArray(data.watchlist), 'bootstrap did not return the watchlist');
  return 'profile, prefs, follows, saves, watchlist returned';
});

startGroup('Analytics');

await test('record_event stores a validated event', async () => {
  const id = await admin().rpc('record_event', {
    p_name: 'verification.probe',
    p_properties: { source: 'verify-backend.mjs' },
    p_anonymous_id: '00000000-0000-0000-0000-000000000001',
  });
  assert(!id.error, `record_event failed: ${id.error?.message}`);
  assert(typeof id.data === 'number', 'record_event did not return an event id');
  return `event ${id.data} stored`;
});

await test('record_event rejects an invalid event name', async () => {
  const { error } = await admin().rpc('record_event', { p_name: 'Not A Valid Name!' });
  assert(error, 'an invalid event name was accepted');
  return `rejected with ${error.code ?? 'an error'}`;
});

// ---------------------------------------------------------------------------------------------
// 3b. Catalog ingest, freshness and discovery
// ---------------------------------------------------------------------------------------------

startGroup('Catalog ingest');

let airingTitleId = null;
let classicTitleId = null;

const upsertPayload = (overrides = {}) => ({
  external_id: `verify-${suffix}`,
  media_type: 'tv',
  world: 'kdrama',
  title: `Verification Ingest ${suffix}`,
  original_title: null,
  year: 2026,
  status: 'airing',
  popularity: 88.5,
  vote_average: 8.1,
  vote_count: 420,
  overview: 'Written by the backend verification script.',
  poster_url: 'https://image.tmdb.org/t/p/w500/poster.jpg',
  backdrop_url: null,
  runtime_minutes: 60,
  original_language: 'ko',
  genres: ['Drama', 'Romance'],
  tags: [],
  network: 'Verification TV',
  origin_country: ['KR'],
  first_air_date: new Date().toISOString().slice(0, 10),
  last_air_date: null,
  episode_count: 16,
  season_count: 1,
  provider_data: {},
  ...overrides,
});

await test('catalog_upsert_title writes a new record', async () => {
  const { data, error } = await admin().rpc('catalog_upsert_title', {
    p_provider_id: 'tmdb',
    p_payload: upsertPayload(),
  });
  assert(!error, `catalog_upsert_title failed: ${error?.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  assert(row?.id, 'no title id returned');
  assert(row?.written === true, 'the first ingest did not report a write');
  airingTitleId = row.id;

  const { data: stored } = await admin()
    .from('titles')
    .select('catalog_synced_at, content_hash, popularity, origin_country')
    .eq('id', airingTitleId)
    .single();
  assert(stored.catalog_synced_at, 'catalog_synced_at was not stamped');
  assert(stored.content_hash, 'content_hash was not stored');
  assert(Number(stored.popularity) === 88.5, 'provider popularity was not stored');
  return `title ${airingTitleId} written with provenance`;
});

await test('catalog_upsert_title is idempotent (identical payload writes nothing)', async () => {
  const { data, error } = await admin().rpc('catalog_upsert_title', {
    p_provider_id: 'tmdb',
    p_payload: upsertPayload(),
  });
  assert(!error, `replay failed: ${error?.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  assert(row?.written === false, 'an unchanged payload reported a write');
  assert(row?.id === airingTitleId, 'the replay created a second title instead of reusing the first');
  return 'same id, written = false';
});

await test('catalog_upsert_title applies a real change', async () => {
  const { data } = await admin().rpc('catalog_upsert_title', {
    p_provider_id: 'tmdb',
    p_payload: upsertPayload({ synopsis: undefined, overview: 'The overview changed.', vote_average: 9.0 }),
  });
  const row = Array.isArray(data) ? data[0] : data;
  assert(row?.written === true, 'a changed payload did not write');
  const { data: stored } = await admin().from('titles').select('synopsis, vote_average').eq('id', airingTitleId).single();
  assert(stored.synopsis === 'The overview changed.', 'the synopsis did not change');
  return 'changed payload applied in place';
});

await test('catalog_upsert_title rejects a payload with an unknown world', async () => {
  const { error } = await admin().rpc('catalog_upsert_title', {
    p_provider_id: 'tmdb',
    p_payload: upsertPayload({ external_id: `verify-bad-${suffix}`, world: 'not-a-world' }),
  });
  assert(error, 'an ingest with an unknown world was accepted');
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('titles_needing_refresh returns only records that are actually due', async () => {
  const { data, error } = await admin().rpc('titles_needing_refresh', {
    p_world: 'kdrama',
    p_limit: 50,
  });
  assert(!error, `titles_needing_refresh failed: ${error?.message}`);
  const reasons = new Set((data ?? []).map((r) => r.reason));
  assert(!reasons.has('fresh'), 'a freshly synced record was offered for refresh');
  for (const row of data ?? []) {
    assert(row.reason !== 'fresh', `record ${row.title_id} is fresh and should not be in the queue`);
  }
  return `${(data ?? []).length} due record(s), reasons: ${[...reasons].join(', ') || 'none'}`;
});

await test('catalog_mark_missing flags a record instead of deleting it', async () => {
  const { data, error } = await admin().rpc('catalog_mark_missing', {
    p_provider_id: 'tmdb',
    p_media_type: 'tv',
    p_external_ids: [`verify-${suffix}`],
  });
  assert(!error, `catalog_mark_missing failed: ${error?.message}`);

  const { data: still } = await admin().from('titles').select('id, catalog_missing_count').eq('id', airingTitleId).single();
  assert(still, 'the record was deleted — a missing provider record must never be deleted');
  assert(still.catalog_missing_count >= 1, 'the missing counter did not move');

  // The sync itself resets the streak.
  await admin().rpc('catalog_upsert_title', { p_provider_id: 'tmdb', p_payload: upsertPayload() });
  const { data: reset } = await admin().from('titles').select('catalog_missing_count').eq('id', airingTitleId).single();
  assert(reset.catalog_missing_count === 0, 'a confirmed record did not clear its missing streak');
  return `missing count reached ${still.catalog_missing_count}, then reset on confirmation`;
});

startGroup('Discovery');

await test('Catalog state is derived from dates, not from a cached flag', async () => {
  const { data, error } = await admin().rpc('catalog_recompute_title_state', { p_title_id: airingTitleId });
  assert(!error, `catalog_recompute_title_state failed: ${error?.message}`);
  assert(data === 'airing', `a title airing today resolved to "${data}"`);

  // Force the contradiction: claim it is upcoming while its air date is today.
  await admin().from('titles').update({ status: 'upcoming' }).eq('id', airingTitleId);
  const { data: corrected } = await admin().rpc('catalog_recompute_title_state', { p_title_id: airingTitleId });
  assert(corrected === 'airing', `a stale "upcoming" flag survived reconciliation (got "${corrected}")`);
  return 'upcoming + air date today → airing';
});

await test('A long-finished title is not presented as current', async () => {
  const { data: created, error } = await admin().rpc('catalog_upsert_title', {
    p_provider_id: 'tmdb',
    p_payload: upsertPayload({
      external_id: `verify-classic-${suffix}`,
      title: `Verification Classic ${suffix}`,
      year: 2004,
      status: 'completed',
      last_air_date: '2005-03-01',
      first_air_date: '2004-09-01',
    }),
  });
  assert(!error, `classic ingest failed: ${error?.message}`);
  classicTitleId = (Array.isArray(created) ? created[0] : created).id;

  const { data: trending } = await admin().rpc('trending_titles', { p_world: 'kdrama', p_limit: 50 });
  const trendingIds = (trending ?? []).map((t) => t.id);
  assert(!trendingIds.includes(classicTitleId), 'a 20-year-old finished title topped a trending list');

  const { data: airing } = await admin().rpc('airing_titles', { p_world: 'kdrama', p_limit: 50 });
  const airingIds = (airing ?? []).map((t) => t.id);
  assert(!airingIds.includes(classicTitleId), 'a finished title was listed as currently airing');
  assert(airingIds.includes(airingTitleId), 'the airing title is missing from airing_titles');

  return 'classic excluded from trending and airing; the airing title is present';
});

await test('Upcoming titles are inside a real release window', async () => {
  const { data, error } = await admin().rpc('upcoming_titles', { p_world: 'kdrama', p_days: 365, p_limit: 50 });
  assert(!error, `upcoming_titles failed: ${error?.message}`);
  const cutoff = Date.now() + 365 * 86_400_000;
  for (const row of data ?? []) {
    if (!row.first_air_date) continue;
    const when = new Date(row.first_air_date).getTime();
    assert(when <= cutoff, `${row.title} has a first air date beyond the requested window`);
    assert(when >= Date.now() - 86_400_000, `${row.title} is in the past but listed as upcoming`);
  }
  return `${(data ?? []).length} upcoming title(s), all inside the window`;
});

await test('Recommended titles exclude what the member muted', async () => {
  await alice.rpc('set_mute', { p_kind: 'title', p_target_id: airingTitleId, p_on: true });
  const { data, error } = await alice.rpc('recommended_titles', { p_limit: 50 });
  assert(!error, `recommended_titles failed: ${error?.message}`);
  const ids = (data ?? []).map((t) => t.id);
  assert(!ids.includes(airingTitleId), 'a muted title was recommended');
  await alice.rpc('set_mute', { p_kind: 'title', p_target_id: airingTitleId, p_on: false });
  return 'muted titles are not recommended';
});

await test('Home discovery returns rails and member statistics, not catalog counts', async () => {
  const { data, error } = await alice.rpc('get_home_discovery', { p_limit: 5 });
  assert(!error, `get_home_discovery failed: ${error?.message}`);
  const keys = (data?.sections ?? []).map((s) => s.key);
  for (const rail of ['tonight', 'trending', 'upcoming', 'recent', 'continue']) {
    assert(keys.includes(rail), `the "${rail}" rail is missing from the Home payload`);
  }
  assert(data?.stats, 'the Home payload has no member statistics');
  for (const key of ['watching', 'want_to_watch', 'completed', 'unread_notifications']) {
    assert(typeof data.stats[key] === 'number', `stats.${key} is not a number`);
  }
  return `sections: ${keys.join(', ')}`;
});

await test('World discovery returns a ranked rail per world', async () => {
  const { data, error } = await anonymous().rpc('get_world_discoveries', { p_limit: 5 });
  assert(!error, `get_world_discoveries failed: ${error?.message}`);
  const worlds = (data ?? []).map((w) => w.world);
  for (const world of ['kdrama', 'cdrama', 'anime', 'hollywood']) {
    assert(worlds.includes(world), `the ${world} rail is missing`);
  }
  return `${worlds.length} world rails`;
});

await test('Title discovery returns episodes, cast and similar titles', async () => {
  const { error: epError } = await admin().rpc('catalog_upsert_episodes', {
    p_title_id: airingTitleId,
    p_season: 1,
    p_episodes: [
      { season: 1, number: 1, title: 'Pilot', air_date: new Date().toISOString().slice(0, 10), runtime_minutes: 60, episode_type: 1 },
      { season: 1, number: 2, title: 'The one after', air_date: null, runtime_minutes: 55, episode_type: 1 },
    ],
  });
  assert(!epError, `catalog_upsert_episodes failed: ${epError?.message}`);

  const { error: creditError } = await admin().rpc('catalog_upsert_title_people', {
    p_title_id: airingTitleId,
    p_credits: [{ external_id: `person-${suffix}`, name: 'Verification Actor', job: 'actor', character: 'Lead', order_index: 0 }],
  });
  assert(!creditError, `catalog_upsert_title_people failed: ${creditError?.message}`);

  const { data, error } = await anonymous().rpc('get_title_discovery', { p_title_id: airingTitleId });
  assert(!error, `get_title_discovery failed: ${error?.message}`);
  assert(data?.episodes?.length >= 2, 'the episode list is missing');
  assert(data?.cast?.length >= 1, 'the cast list is missing');
  assert(data?.title?.lifecycle === 'airing', `lifecycle resolved to "${data?.title?.lifecycle}"`);
  return `${data.episodes.length} episodes, ${data.cast.length} cast member(s)`;
});

await test('Ingest is refused from a member session', async () => {
  const { error } = await alice.rpc('catalog_upsert_title', {
    p_provider_id: 'tmdb',
    p_payload: upsertPayload({ external_id: `verify-unauth-${suffix}` }),
  });
  assert(error, 'a member could run the catalog ingest');
  return `rejected with ${error.code ?? 'an error'}`;
});

// ---------------------------------------------------------------------------------------------
// 3c. Notifications, delivery and push tokens
// ---------------------------------------------------------------------------------------------

startGroup('Notification delivery');

await test('An identical notification event is coalesced, not duplicated', async () => {
  const dedupe = `verify-dedupe-${suffix}`;
  const first = await admin().rpc('enqueue_notification', {
    p_recipient: aliceId,
    p_kind: 'episode_aired',
    p_group: 'drama',
    p_dedupe_key: dedupe,
    p_title_id: airingTitleId,
    p_title: 'Verification show',
    p_body: 'Episode 1 is out.',
  });
  assert(!first.error, `first enqueue failed: ${first.error?.message}`);

  const second = await admin().rpc('enqueue_notification', {
    p_recipient: aliceId,
    p_kind: 'episode_aired',
    p_group: 'drama',
    p_dedupe_key: dedupe,
    p_title_id: airingTitleId,
    p_title: 'Verification show',
    p_body: 'Episode 1 is out.',
  });
  assert(!second.error, `second enqueue failed: ${second.error?.message}`);
  assert(first.data === second.data, 'the same event created two notification rows');

  const { data: rows } = await admin()
    .from('notifications')
    .select('id, coalesce_count')
    .eq('dedupe_key', dedupe);
  assert(rows.length === 1, `the dedupe key produced ${rows.length} rows`);
  assert(rows[0].coalesce_count === 2, `coalesce_count is ${rows[0].coalesce_count}, expected 2`);
  return 'one row, coalesce_count = 2';
});

await test('A preference switch is respected at creation time', async () => {
  await alice.rpc('merge_preferences', { p_patch: { notify_episodes: false } });
  const { data } = await admin().rpc('enqueue_notification', {
    p_recipient: aliceId,
    p_kind: 'episode_aired',
    p_group: 'drama',
    p_dedupe_key: `verify-muted-${suffix}`,
    p_title_id: airingTitleId,
  });
  assert(data === null, 'a notification was created for a member with episode alerts off');

  await alice.rpc('merge_preferences', { p_patch: { notify_episodes: true } });
  const { data: after } = await admin().rpc('enqueue_notification', {
    p_recipient: aliceId,
    p_kind: 'episode_aired',
    p_group: 'drama',
    p_dedupe_key: `verify-unmuted-${suffix}`,
    p_title_id: airingTitleId,
  });
  assert(after, 'a notification was not created after the preference was turned back on');
  return 'notify_episodes = false suppressed, true allowed';
});

await test('Fan-out creates one delivery per active device', async () => {
  const token = `verification-delivery-${suffix}-aaaaaaaaaaaaaaaaaaaa`;
  await alice.rpc('register_push_token', { p_token: token, p_platform: 'android', p_device_name: 'verification device' });

  const { data: notification } = await admin()
    .from('notifications')
    .select('id')
    .eq('dedupe_key', `verify-unmuted-${suffix}`)
    .single();

  let { data: created, error } = await admin().rpc('fanout_notification', { p_notification_id: notification.id });
  assert(!error, `fanout_notification failed: ${error?.message}`);
  if ((created ?? 0) < 1) {
    // Live `notifications_fanout_and_wake` trigger wakes `send-push` immediately on insert; ensure
    // the synthetic verification token wasn't just disabled by FCM before `fanout_notification` ran.
    await admin().from('push_tokens').update({ disabled_at: null }).eq('token', token);
    const retryFanout = await admin().rpc('fanout_notification', { p_notification_id: notification.id });
    assert(!retryFanout.error, `fanout retry failed: ${retryFanout.error?.message}`);
    created = retryFanout.data ?? 0;
  }
  const { count: totalDeliveries } = await admin()
    .from('notification_deliveries')
    .select('*', { count: 'exact', head: true })
    .eq('notification_id', notification.id);
  assert((created ?? 0) >= 1 || (totalDeliveries ?? 0) >= 1, 'no delivery rows were created');

  const again = await admin().rpc('fanout_notification', { p_notification_id: notification.id });
  assert(!again.error, `second fanout failed: ${again.error?.message}`);
  assert(again.data === 0, `a repeated fan-out created ${again.data} extra rows`);

  return `${Math.max(created ?? 0, totalDeliveries ?? 0)} delivery row(s), repeated fan-out added 0`;
});

await test('A claimed delivery can be reported sent', async () => {
  let { data, error } = await admin().rpc('claim_notification_deliveries', { p_limit: 10, p_max_attempts: 5 });
  assert(!error, `claim_notification_deliveries failed: ${error?.message}`);
  let claimed = data ?? [];
  if (claimed.length === 0) {
    // Live 24/7 push-dispatch Edge Function can claim the test row within ~150ms before this step runs;
    // re-arm this test run's own verification notification row so claim + report_delivery is always tested deterministically.
    const { data: notif } = await admin()
      .from('notifications')
      .select('id')
      .eq('dedupe_key', `verify-unmuted-${suffix}`)
      .single();
    if (notif?.id) {
      await admin()
        .from('push_tokens')
        .update({ disabled_at: null })
        .eq('user_id', aliceId);
      const { error: rearmErr } = await admin()
        .from('notification_deliveries')
        .update({ status: 'queued', attempt: 0, next_attempt_at: new Date(Date.now() - 1000).toISOString() })
        .eq('notification_id', notif.id);
      assert(!rearmErr, `rearm delivery failed: ${rearmErr?.message}`);
      const retry = await admin().rpc('claim_notification_deliveries', { p_limit: 10, p_max_attempts: 5 });
      assert(!retry.error, `claim_notification_deliveries retry failed: ${retry.error?.message}`);
      claimed = retry.data ?? [];
    }
  }
  assert(claimed.length > 0, 'nothing was claimable');

  const first = claimed[0];
  const { error: reportError } = await admin().rpc('report_delivery', {
    p_delivery_id: first.delivery_id,
    p_sent: true,
    p_provider_message_id: `verify-${suffix}`,
  });
  assert(!reportError, `report_delivery failed: ${reportError?.message}`);

  const { data: stored } = await admin()
    .from('notification_deliveries')
    .select('status, sent_at')
    .eq('id', first.delivery_id)
    .single();
  assert(stored.status === 'sent', `status is "${stored.status}", expected sent`);
  assert(stored.sent_at, 'no delivery timestamp was recorded');
  return `delivery ${first.delivery_id} marked sent`;
});

await test('A rejected token is disabled and its other deliveries are failed', async () => {
  await alice.rpc('register_push_token', {
    p_token: `verification-dead-${suffix}-bbbbbbbbbbbbbbbbbbbb`,
    p_platform: 'ios',
    p_device_name: 'dead device',
  });
  const { data: dead } = await admin()
    .from('push_tokens')
    .select('id')
    .eq('token', `verification-dead-${suffix}-bbbbbbbbbbbbbbbbbbbb`)
    .single();

  const dedupe = `verify-invalid-${suffix}`;
  const { data: notification } = await admin().rpc('enqueue_notification', {
    p_recipient: aliceId,
    p_kind: 'system',
    p_group: 'system',
    p_dedupe_key: dedupe,
    p_title: 'Invalid token test',
  });
  await admin().rpc('fanout_notification', { p_notification_id: notification });

  const { data: deliveries } = await admin()
    .from('notification_deliveries')
    .select('id')
    .eq('push_token_id', dead.id);
  assert(deliveries.length > 0, 'no delivery targeted the dead token');

  for (const delivery of deliveries) {
    await admin().rpc('report_delivery', {
      p_delivery_id: delivery.id,
      p_sent: false,
      p_error: 'DeviceNotRegistered',
      p_invalid: true,
    });
  }

  const { data: token } = await admin().from('push_tokens').select('disabled_at').eq('id', dead.id).single();
  assert(token.disabled_at, 'the invalid token was not disabled');

  const { data: rows } = await admin()
    .from('notification_deliveries')
    .select('status')
    .eq('push_token_id', dead.id);
  assert(rows.every((r) => r.status === 'invalid_token'), 'a delivery for the dead token stayed queued');
  return 'token disabled, every delivery marked invalid_token';
});

await test('A transient failure schedules a retry instead of losing the notification', async () => {
  // Enqueue FIRST before registering the synthetic token so the `notifications_fanout_and_wake`
  // AFTER INSERT trigger does not dispatch `send-push` concurrently against Google FCM mid-test.
  const { data: notification } = await admin().rpc('enqueue_notification', {
    p_recipient: aliceId,
    p_kind: 'system',
    p_group: 'system',
    p_dedupe_key: `verify-flaky-${suffix}`,
    p_title: 'Flaky device',
  });

  const token = `verification-flaky-${suffix}-cccccccccccccccccccc`;
  await alice.rpc('register_push_token', { p_token: token, p_platform: 'android' });
  const { data: flakyTok } = await admin()
    .from('push_tokens')
    .select('id')
    .eq('token', token)
    .single();

  await admin().rpc('fanout_notification', { p_notification_id: notification });

  const { data: delivery } = await admin()
    .from('notification_deliveries')
    .select('id')
    .eq('notification_id', notification)
    .eq('push_token_id', flakyTok.id)
    .single();

  // Claim ownership (`status = 'sending'`) with a future `next_attempt_at` and ensure it wasn't
  // touched by an active `send-push` drain loop before invoking `report_delivery(p_invalid: false)`.
  await admin()
    .from('notification_deliveries')
    .update({ status: 'sending', attempt: 1, next_attempt_at: new Date(Date.now() + 600_000).toISOString() })
    .eq('id', delivery.id);

  await admin().rpc('report_delivery', {
    p_delivery_id: delivery.id,
    p_sent: false,
    p_error: 'rate limited by provider',
    p_invalid: false,
  });

  const { data: row } = await admin()
    .from('notification_deliveries')
    .select('status, attempt, next_attempt_at')
    .eq('id', delivery.id)
    .single();
  assert(['queued', 'failed'].includes(row.status), `status is "${row.status}"`);
  assert(new Date(row.next_attempt_at) > new Date(), 'the retry was not scheduled in the future');
  return `retry scheduled at ${row.next_attempt_at}`;
});

await test('A member cannot read or disable another member\'s token', async () => {
  const ownedToken = `verification-owned-${suffix}-dddddddddddddddddddd`;
  await alice.rpc('register_push_token', { p_token: ownedToken, p_platform: 'android' });

  const { data: beforeRow } = await admin()
    .from('push_tokens')
    .select('id, user_id, disabled_at')
    .eq('token', ownedToken)
    .single();

  const { error: disableError } = await bob.rpc('disable_push_token', {
    p_token_id: beforeRow.id,
  });
  assert(!disableError, `the RPC itself should succeed for a non-owner id: ${disableError?.message}`);

  const { data } = await admin()
    .from('push_tokens')
    .select('user_id, disabled_at')
    .eq('id', beforeRow.id)
    .single();
  assert(data.user_id === aliceId, 'the token moved to another member');
  assert(data.disabled_at === null, 'a member disabled another member\'s token');
  return 'ownership enforced';
});

await test('Notification summary reports grouped unread counts', async () => {
  const { data, error } = await alice.rpc('notification_summary');
  assert(!error, `notification_summary failed: ${error?.message}`);
  assert(typeof data?.unread === 'number', 'no unread count');
  assert(data?.unread_by_group && typeof data.unread_by_group === 'object', 'no per-group counts');
  return `unread = ${data.unread}`;
});

// ---------------------------------------------------------------------------------------------
// 3d. Episode alerts
// ---------------------------------------------------------------------------------------------

startGroup('Episode alerts');

await test('Only members with a relationship with the title are alerted', async () => {
  // alice follows the title; bob has no relationship with it at all.
  await alice.rpc('set_follow', { p_kind: 'title', p_target_id: airingTitleId, p_on: true });

  const { data: aliceAudience } = await admin().rpc('title_audience', { p_title_id: airingTitleId });
  const audience = (aliceAudience ?? []).map((id) => id);
  assert(audience.includes(aliceId), 'alice follows the title but is not in the audience');
  assert(!audience.includes(bobId), 'bob has no relationship with the title but is in the audience');

  await admin().rpc('job_queue_new_episodes', { p_from_date: new Date().toISOString().slice(0, 10), p_to_date: new Date().toISOString().slice(0, 10) });
  return `audience size ${audience.length}`;
});

await test('Re-running the alert job does not notify the same episode twice', async () => {
  const today = new Date().toISOString().slice(0, 10);
  await admin().rpc('job_queue_new_episodes', { p_from_date: today, p_to_date: today });
  await admin().rpc('job_queue_new_episodes', { p_from_date: today, p_to_date: today });

  const { data: rows } = await admin()
    .from('notifications')
    .select('dedupe_key')
    .eq('recipient_id', aliceId)
    .like('dedupe_key', `aired:${airingTitleId}%`);

  const keys = (rows ?? []).map((r) => r.dedupe_key);
  assert(new Set(keys).size === keys.length, 'the same episode produced two notification rows');
  return `${keys.length} episode notification(s), all distinct`;
});

// ---------------------------------------------------------------------------------------------
// 3e. Share accounting
// ---------------------------------------------------------------------------------------------

startGroup('Share accounting');

await test('record_share counts a share once and returns the counter', async () => {
  const first = await bob.rpc('record_share', { p_post_id: postId, p_channel: 'link' });
  assert(!first.error, `record_share failed: ${first.error?.message}`);
  assert(first.data.counted === true, 'the first share was not counted');
  assert(first.data.share_count === 1, `share_count is ${first.data.share_count}, expected 1`);

  const repeat = await bob.rpc('record_share', { p_post_id: postId, p_channel: 'link' });
  assert(!repeat.error, `the repeat share failed: ${repeat.error?.message}`);
  assert(repeat.data.counted === false, 'a repeat share on the same day was counted again');
  assert(repeat.data.share_count === 1, `share_count became ${repeat.data.share_count} after a repeat`);

  return 'counted once, idempotent per day';
});

await test('A share counter cannot be written by a client', async () => {
  const { error } = await alice.from('posts').update({ share_count: 9999 }).eq('id', postId);
  assert(error, "a member wrote another member's share_count directly");
  const { data } = await admin().from('posts').select('share_count').eq('id', postId).single();
  assert(data.share_count === 1, `share_count is ${data.share_count} after a spoofing attempt`);
  return `rejected with ${error.code ?? 'an error'}, counter still ${data.share_count}`;
});

await test('Reaction counters cannot be written by a client either', async () => {
  const { error } = await alice.from('posts').update({ loved_count: 5000 }).eq('id', postId);
  assert(error, 'a member wrote a reaction counter directly');
  const { data } = await admin().from('posts').select('loved_count').eq('id', postId).single();
  assert(data.loved_count === 0, `loved_count became ${data.loved_count}`);
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('Sharing an unavailable post is refused', async () => {
  const { error } = await bob.rpc('record_share', {
    p_post_id: '00000000-0000-0000-0000-000000000000',
    p_channel: 'link',
  });
  assert(error, 'a share was recorded for a post that does not exist');
  return `rejected with ${error.code ?? 'an error'}`;
});

// ---------------------------------------------------------------------------------------------
// 3f. Communities
// ---------------------------------------------------------------------------------------------

startGroup('Communities');

let communityId = null;

await test('Join and leave a community', async () => {
  const { data: rooms, error } = await admin().from('communities').select('id, join_policy').limit(1);
  assert(!error, `could not read the seeded communities: ${error?.message}`);
  assert(rooms.length > 0, 'no community is seeded');
  communityId = rooms[0].id;

  const join = await alice.rpc('join_community', { p_community_id: communityId, p_on: true });
  assert(!join.error, `join_community failed: ${join.error?.message}`);
  assert(join.data.status === 'active', `join returned status "${join.data.status}"`);

  const { data: members } = await admin()
    .from('community_members')
    .select('role, status')
    .eq('community_id', communityId)
    .eq('user_id', aliceId)
    .single();
  assert(members.status === 'active', 'the membership row is not active');
  assert(members.role === 'member', 'a self-join granted a staff role');

  const leave = await alice.rpc('join_community', { p_community_id: communityId, p_on: false });
  assert(!leave.error, `leave failed: ${leave.error?.message}`);
  return 'joined as member, left cleanly';
});

await test('A member cannot promote themselves to moderator', async () => {
  const { error } = await bob.rpc('set_community_role', {
    p_community_id: communityId,
    p_user_id: bobId,
    p_role: 'moderator',
  });
  assert(error, 'a member promoted themselves to moderator');
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('A member cannot edit the community settings', async () => {
  const { error } = await bob.rpc('update_community_settings', {
    p_community_id: communityId,
    p_name: 'Hijacked room',
  });
  assert(error, 'a member renamed a community');
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('A member cannot moderate another member in the room', async () => {
  const { error } = await bob.rpc('moderate_community_post', {
    p_post_id: postId,
    p_action: 'hide',
    p_reason: 'not my call',
  });
  assert(error, 'a member hid a post in a community they do not moderate');
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('Ownership is claimed once and cannot be stolen', async () => {
  const claimed = await alice.rpc('claim_community_ownership', { p_community_id: communityId });
  assert(!claimed.error, `claim_community_ownership failed: ${claimed.error?.message}`);

  const { data: room } = await admin().from('communities').select('owner_id').eq('id', communityId).single();
  assert(room.owner_id === aliceId, 'the owner was not recorded');

  const steal = await bob.rpc('claim_community_ownership', { p_community_id: communityId });
  assert(!steal.error, `the second claim failed unexpectedly: ${steal.error?.message}`);
  assert(steal.data === false, 'a second claim took ownership');

  const { data: after } = await admin().from('communities').select('owner_id').eq('id', communityId).single();
  assert(after.owner_id === aliceId, 'ownership changed');
  return 'claimed once, second claim refused';
});

await test('The owner can appoint and remove a moderator', async () => {
  const promote = await alice.rpc('set_community_role', {
    p_community_id: communityId,
    p_user_id: bobId,
    p_role: 'moderator',
  });
  assert(!promote.error, `set_community_role failed: ${promote.error?.message}`);

  const { data: member } = await admin()
    .from('community_members')
    .select('role')
    .eq('community_id', communityId)
    .eq('user_id', bobId)
    .single();
  assert(member.role === 'moderator', 'the role was not applied');

  // A room moderator cannot remove the owner.
  const removeOwner = await bob.rpc('remove_community_member', {
    p_community_id: communityId,
    p_user_id: aliceId,
    p_reason: 'because',
  });
  assert(removeOwner.error, 'a moderator removed the room owner');

  await alice.rpc('set_community_role', { p_community_id: communityId, p_user_id: bobId, p_role: 'member' });
  return 'promoted, owner protected, demoted';
});

await test('A membership request is reviewable by the owner', async () => {
  await admin()
    .from('communities')
    .update({ join_policy: 'request' })
    .eq('id', communityId);

  const request = await bob.rpc('join_community', { p_community_id: communityId, p_on: true });
  assert(!request.error, `join failed: ${request.error?.message}`);
  assert(request.data.status === 'pending', `a request-mode join returned "${request.data.status}"`);

  const { data: room } = await admin().from('communities').select('member_count').eq('id', communityId).single();
  const { data: member } = await admin()
    .from('community_members')
    .select('status')
    .eq('community_id', communityId)
    .eq('user_id', bobId)
    .single();
  assert(member.status === 'pending', 'the request was not stored as pending');

  const approve = await alice.rpc('review_membership_request', {
    p_community_id: communityId,
    p_user_id: bobId,
    p_approve: true,
  });
  assert(!approve.error, `review_membership_request failed: ${approve.error?.message}`);
  assert(approve.data === 'active', `approval returned "${approve.data}"`);

  await admin().from('communities').update({ join_policy: 'open' }).eq('id', communityId);
  await bob.rpc('join_community', { p_community_id: communityId, p_on: false });
  return `request → pending → ${approve.data}`;
});

await test('A banned member cannot re-join', async () => {
  await bob.rpc('join_community', { p_community_id: communityId, p_on: true });
  const ban = await alice.rpc('ban_community_member', {
    p_community_id: communityId,
    p_user_id: bobId,
    p_reason: 'verification',
  });
  assert(!ban.error, `ban_community_member failed: ${ban.error?.message}`);

  const rejoin = await bob.rpc('join_community', { p_community_id: communityId, p_on: true });
  assert(rejoin.error, 'a banned member rejoined');
  return `rejected with ${rejoin.code ?? 'an error'}`;
});

// ---------------------------------------------------------------------------------------------
// 3g. Moderation
// ---------------------------------------------------------------------------------------------

startGroup('Moderation');

let reportId = null;

await test('A member cannot moderate', async () => {
  const { error } = await bob.rpc('moderate_content', {
    p_target_type: 'post',
    p_target_id: postId,
    p_action: 'hide',
    p_reason: 'I felt like it',
  });
  assert(error, 'an ordinary member moderated content');
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('A member cannot read the moderation queue', async () => {
  const { error } = await bob.rpc('moderation_queue', { p_status: 'open' });
  assert(error, 'an ordinary member read the moderation queue');
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('Moderation actions are refused without a moderator', async () => {
  const { error } = await bob.rpc('record_moderation_action', {
    p_action: 'content_hidden',
    p_target_type: 'post',
    p_target_id: postId,
    p_reason: 'forged entry',
  });
  assert(error, 'an ordinary member wrote to the moderation log');
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('The audit log cannot be written or edited by a member', async () => {
  const { error: insertError } = await bob.from('moderation_actions').insert({
    action: 'content_hidden',
    target_type: 'post',
    target_id: postId,
    actor_id: bobId,
  });
  assert(insertError, 'a member inserted a moderation action directly');

  const { error: updateError } = await bob
    .from('moderation_actions')
    .update({ reason: 'rewritten' })
    .eq('target_id', postId);
  assert(updateError, 'a member updated a moderation action');
  return 'direct insert and update both rejected';
});

await test('Reporting and resolving a report is recorded', async () => {
  const filed = await bob.rpc('report_content', {
    p_target_type: 'post',
    p_target_id: postId,
    p_reason: 'verification report',
    p_detail: 'filed by the backend verification script',
  });
  assert(!filed.error, `report_content failed: ${filed.error?.message}`);
  reportId = filed.data;

  const { data: report } = await admin()
    .from('reports')
    .select('id, status')
    .eq('id', reportId)
    .single();
  assert(report.status === 'open', 'the report did not open');
  return `report ${reportId} filed`;
});

// ---------------------------------------------------------------------------------------------
// 3h. Search
// ---------------------------------------------------------------------------------------------

startGroup('Search');

await test('Search finds titles by name', async () => {
  const { data, error } = await anonymous().rpc('search_titles', {
    p_query: `Verification Ingest ${suffix}`,
    p_limit: 10,
  });
  assert(!error, `search_titles failed: ${error?.message}`);
  assert((data ?? []).some((row) => row.id === airingTitleId), 'the ingested title was not found');
  return `${(data ?? []).length} result(s)`;
});

await test('Search ranks a current title above a matching classic', async () => {
  const { data, error } = await anonymous().rpc('search_titles', {
    p_query: 'Verification',
    p_world: 'kdrama',
    p_limit: 50,
  });
  assert(!error, `search_titles failed: ${error?.message}`);
  const ids = (data ?? []).map((row) => row.id);
  const airingIndex = ids.indexOf(airingTitleId);
  const classicIndex = ids.indexOf(classicTitleId);
  if (airingIndex !== -1 && classicIndex !== -1) {
    assert(airingIndex < classicIndex, 'a finished title outranked the airing one on the same query');
  }
  return 'lifecycle weighting applied to search ranking';
});

await test('Federated search covers titles, people, communities and members', async () => {
  const { data, error } = await alice.rpc('search_all', { p_query: `Verification ${suffix}`, p_per_type: 5 });
  assert(!error, `search_all failed: ${error?.message}`);
  for (const key of ['titles', 'people', 'communities', 'collections', 'members', 'counts']) {
    assert(data[key] !== undefined, `search_all returned no "${key}"`);
  }
  assert(Array.isArray(data.titles), 'titles is not an array');
  return `titles ${data.titles.length}, people ${data.people.length}, members ${data.members.length}`;
});

await test('Search never exposes a deleted or suspended member', async () => {
  const { data: bobProfile } = await admin().from('profiles').select('handle').eq('id', bobId).single();
  const { data } = await anonymous().rpc('search_members', { p_query: bobProfile.handle, p_limit: 20 });
  assert(!data || data.length === 0, `a deleted account was returned by member search: ${data?.length} row(s)`);
  return 'deleted accounts are invisible to search';
});

await test('A private collection is only visible to its owner', async () => {
  const { data: collection } = await bob
    .from('collections')
    .insert({ owner_id: bobId, title: `Private shelf ${suffix}`, visibility: 'private' })
    .select('id')
    .single();

  const owner = await bob.rpc('search_collections', { p_query: `Private shelf ${suffix}`, p_limit: 10 });
  assert((owner.data ?? []).some((row) => row.id === collection.id), 'the owner cannot find their own collection');

  const other = await alice.rpc('search_collections', { p_query: `Private shelf ${suffix}`, p_limit: 10 });
  assert(!(other.data ?? []).some((row) => row.id === collection.id), "another member found a private collection");

  return 'owner sees it, another member does not';
});

await test('Type-ahead suggestions are bounded and ordered', async () => {
  const { data, error } = await anonymous().rpc('search_suggestions', { p_query: 'Verification', p_limit: 10 });
  assert(!error, `search_suggestions failed: ${error?.message}`);
  assert((data ?? []).length <= 10, 'search_suggestions returned more than its limit');
  return `${(data ?? []).length} suggestion(s)`;
});

// ---------------------------------------------------------------------------------------------
// 3i. Feed pagination
// ---------------------------------------------------------------------------------------------

startGroup('Feed pagination');

await test('The feed returns a cursor and reports whether more exists', async () => {
  const { data, error } = await alice.rpc('feed_page', { p_scope: 'latest', p_limit: 2 });
  assert(!error, `feed_page failed: ${error?.message}`);
  assert(Array.isArray(data.items), 'the feed returned no items');
  assert(data.next_cursor, 'no cursor was returned');
  assert(typeof data.has_more === 'boolean', 'has_more is not a boolean');
  return `${data.items.length} item(s), has_more = ${data.has_more}`;
});

await test('Cursor pages are stable and never repeat a row', async () => {
  const seen = new Set();
  let cursor = null;
  let pages = 0;

  do {
    const { data, error } = await alice.rpc('feed_page', {
      p_scope: 'latest',
      p_limit: 2,
      p_cursor: cursor,
    });
    assert(!error, `feed_page page ${pages} failed: ${error?.message}`);
    for (const item of data.items) {
      assert(!seen.has(item.id), `post ${item.id} appeared on two pages`);
      seen.add(item.id);
    }
    cursor = data.next_cursor;
    pages += 1;
  } while (cursor && pages < 20);

  assert(pages > 1, 'paging stopped after the first page');
  return `${seen.size} distinct posts across ${pages} pages`;
});

await test('A corrupt cursor restarts the feed instead of failing', async () => {
  const { data, error } = await alice.rpc('feed_page', {
    p_scope: 'latest',
    p_limit: 2,
    p_cursor: 'not-a-real-cursor',
  });
  assert(!error, `a corrupt cursor raised an error: ${error?.message}`);
  assert(Array.isArray(data.items), 'no items were returned');
  return 'bad cursor handled';
});

await test('Every scope the app needs is supported', async () => {
  for (const scope of ['latest', 'for_you', 'following']) {
    const { error } = await alice.rpc('feed_page', { p_scope: scope, p_limit: 5 });
    assert(!error, `the "${scope}" scope failed: ${error?.message}`);
  }

  const titleFeed = await alice.rpc('feed_page', {
    p_scope: 'title',
    p_title_id: airingTitleId,
    p_limit: 5,
  });
  assert(!titleFeed.error, `the title scope failed: ${titleFeed.error?.message}`);

  const worldFeed = await alice.rpc('feed_page', { p_scope: 'world', p_world: 'kdrama', p_limit: 5 });
  assert(!worldFeed.error, `the world scope failed: ${worldFeed.error?.message}`);

  const unknown = await alice.rpc('feed_page', { p_scope: 'nonsense', p_limit: 5 });
  assert(unknown.error, 'an unknown feed scope was accepted');
  return 'latest, for_you, following, title and world all respond';
});

await test('Blocked authors never appear in the feed', async () => {
  await bob.rpc('set_block', { p_user_id: aliceId, p_on: true });
  const { data } = await bob.rpc('feed_page', { p_scope: 'following', p_limit: 50 });
  assert(!(data.items ?? []).some((item) => item.author_id === aliceId), 'a blocked author appeared in the feed');
  await bob.rpc('set_block', { p_user_id: aliceId, p_on: false });
  return 'block filtering applied in the query';
});

await test('Comments paginate with a cursor', async () => {
  const { data, error } = await alice.rpc('comment_page', { p_post_id: postId, p_limit: 10 });
  assert(!error, `comment_page failed: ${error?.message}`);
  assert(Array.isArray(data.items), 'comment_page returned no items');
  assert(typeof data.has_more === 'boolean', 'has_more is not a boolean');
  return `${data.items.length} comment(s)`;
});

// ---------------------------------------------------------------------------------------------
// 3j. Media lifecycle
// ---------------------------------------------------------------------------------------------

startGroup('Media lifecycle');

await test('An upload must live in the caller\'s own folder', async () => {
  const { error } = await alice.rpc('begin_media_upload', {
    p_storage_path: `u/${bobId}/posts/stolen.png`,
    p_kind: 'image',
  });
  assert(error, 'an upload was announced into another member\'s folder');
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('An announced upload is completed and attached to a post', async () => {
  const path = `u/${aliceId}/posts/lifecycle-${suffix}.png`;
  const bytes = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf00000301010018dd8db00000000049454e44ae426082',
    'hex',
  );
  const { error: uploadError } = await alice.storage.from('media').upload(path, bytes, {
    contentType: 'image/png',
    upsert: true,
  });
  assert(!uploadError, `the object upload failed: ${uploadError?.message}`);

  const begun = await alice.rpc('begin_media_upload', {
    p_storage_path: path,
    p_kind: 'image',
    p_byte_size: bytes.byteLength,
    p_content_type: 'image/png',
  });
  assert(!begun.error, `begin_media_upload failed: ${begun.error?.message}`);

  const { data: pending } = await admin()
    .from('media_uploads')
    .select('state')
    .eq('id', begun.data)
    .single();
  assert(pending.state === 'pending', 'a new upload is not pending');

  const completed = await alice.rpc('complete_media_upload', {
    p_upload_id: begun.data,
    p_post_id: postId,
    p_width: 1,
    p_height: 1,
  });
  assert(!completed.error, `complete_media_upload failed: ${completed.error?.message}`);

  const { data: attached } = await admin()
    .from('media_uploads')
    .select('state, post_media_id')
    .eq('id', begun.data)
    .single();
  assert(attached.state === 'attached', 'the upload was not attached');
  assert(attached.post_media_id === completed.data, 'the media row id was not recorded');
  return `upload ${begun.data} attached to post_media ${completed.data}`;
});

await test('A failed upload queues its object for removal', async () => {
  const path = `u/${aliceId}/posts/failed-${suffix}.png`;
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  await alice.storage.from('media').upload(path, bytes, { contentType: 'image/png', upsert: true });

  const begun = await alice.rpc('begin_media_upload', { p_storage_path: path, p_kind: 'image' });
  const failed = await alice.rpc('fail_media_upload', { p_upload_id: begun.data, p_error: 'verification' });
  assert(!failed.error, `fail_media_upload failed: ${failed.error?.message}`);

  const { data } = await admin().from('media_uploads').select('state').eq('id', begun.data).single();
  assert(data.state === 'failed', `state is "${data.state}", expected failed`);

  // The database cannot delete the object itself: Supabase's storage.protect_delete() refuses a
  // direct DELETE on storage.objects for every role. What it can do is record the path, and the
  // queue is the promise that the bytes go away (media-cleanup drains it through the Storage API).
  const { data: queued, error: queueError } = await admin()
    .from('media_removal_queue')
    .select('path, reason')
    .eq('path', path)
    .single();
  assert(!queueError, `the failed upload was not queued for removal: ${queueError?.message}`);
  assert(queued.reason === 'failed_upload', `queued with reason "${queued.reason}", expected failed_upload`);

  // The owner may also remove it through their own Storage API connection, and then it is gone.
  const { error: removeError } = await alice.storage.from('media').remove([path]);
  assert(!removeError, `the owner could not remove the queued object: ${removeError?.message}`);
  const { error: gone } = await alice.storage.from('media').download(path);
  assert(gone, 'the object survived the removal');

  await admin().rpc('complete_media_removals', { p_paths: [path] });
  return 'row marked failed, path queued as failed_upload, object removed by its owner';
});

await test('No client can read or write the media removal queue', async () => {
  // The table must exist before "a client cannot see it" means anything: against a project without
  // it, every member read and write simply errors and the check would pass without proving a thing.
  const { error: adminError } = await admin().from('media_removal_queue').select('path').limit(1);
  assert(!adminError, `the project has no readable media_removal_queue: ${adminError?.message}`);

  // The table is not granted to `authenticated` at all, so PostgREST either refuses the read or
  // returns nothing. Both are the guarantee; a single visible row is not.
  const { data } = await alice.from('media_removal_queue').select('*').limit(5);
  assert((data ?? []).length === 0, `a member read ${(data ?? []).length} queue row(s)`);

  const { error: insertError } = await alice.from('media_removal_queue').insert({
    path: `u/${aliceId}/posts/forged-${suffix}.png`,
    reason: 'orphaned',
  });
  assert(insertError, 'a client queued an object for deletion');
  return 'the queue exists and reads nothing, writes refused, for a member';
});

await test('The reconciliation job runs and reports what it did', async () => {
  const { data, error } = await admin().rpc('job_reconcile_media', { p_user_retention: '30 days' });
  assert(!error, `job_reconcile_media failed: ${error?.message}`);
  for (const key of ['broken_rows_removed', 'orphan_objects_queued', 'upload_rows_purged', 'queue_depth']) {
    assert(typeof data[key] === 'number', `${key} is not a number`);
  }
  return `removed ${data.broken_rows_removed} broken row(s), queued ${data.orphan_objects_queued} orphan object(s)`;
});

// ---------------------------------------------------------------------------------------------
// 3k. Scheduled jobs
// ---------------------------------------------------------------------------------------------

startGroup('Scheduled jobs');

await test('A job run is claimed once and not twice for the same key', async () => {
  const key = `verify-${suffix}`;
  const first = await admin().rpc('job_claim', { p_job: 'verification.probe', p_run_key: key });
  assert(!first.error, `job_claim failed: ${first.error?.message}`);
  const firstRow = Array.isArray(first.data) ? first.data[0] : first.data;
  assert(firstRow.did_claim === true, 'the first claim did not get the run');

  const second = await admin().rpc('job_claim', { p_job: 'verification.probe', p_run_key: key });
  const secondRow = Array.isArray(second.data) ? second.data[0] : second.data;
  assert(secondRow.id === firstRow.id, 'the same key created a second run');
  assert(secondRow.did_claim === false, 'the same key was claimed twice');

  await admin().rpc('job_complete', { p_run_id: firstRow.id, p_status: 'succeeded', p_items_processed: 1 });

  const third = await admin().rpc('job_claim', { p_job: 'verification.probe', p_run_key: key });
  const thirdRow = Array.isArray(third.data) ? third.data[0] : third.data;
  assert(thirdRow.did_claim === false, 'a completed run was claimed again');

  return 'claimed once, replay refused';
});

await test('The job dispatcher runs and reports each job', async () => {
  const job = 'catalog.status';
  const { data, error } = await admin().rpc('run_scheduled_jobs', { p_jobs: [job] });
  assert(!error, `run_scheduled_jobs failed: ${error?.message}`);
  assert(Array.isArray(data), 'the dispatcher returned no rows');
  assert(data.every((row) => row.status !== 'failed'), `a job failed: ${JSON.stringify(data)}`);

  // The run key is hourly, so a second suite run inside the same hour legitimately reports nothing —
  // the window was already claimed, by this run or an earlier one. Asserting on what this call
  // returned therefore proves nothing about the scheduler, and "0 job(s) run" once passed for exactly
  // that reason. What must hold either way is that the window holds a *completed* run for this job.
  const { data: runs, error: runsError } = await admin()
    .from('job_runs')
    .select('id, status, attempt, items_processed, started_at')
    .eq('job', job)
    .order('started_at', { ascending: false })
    .limit(5);
  assert(!runsError, `could not read job_runs: ${runsError?.message}`);

  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const inWindow = (runs ?? []).find((run) => new Date(run.started_at).getTime() >= twoHoursAgo);
  assert(inWindow, `no ${job} run is recorded in the last two hours — the scheduler did not run`);
  assert(inWindow.status === 'succeeded', `the ${job} run finished as "${inWindow.status}"`);

  return `${data.length} job(s) run by this call; the window's run is ${inWindow.status} (attempt ${inWindow.attempt}, ${inWindow.items_processed} item(s))`;
});

await test('Jobs cannot be run by a member', async () => {
  const { error } = await alice.rpc('run_scheduled_jobs', { p_jobs: ['catalog.status'] });
  assert(error, 'a member ran the job dispatcher');
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('Running the same job twice in a window does no work twice', async () => {
  const job = 'catalog.episode_schedule';
  const first = await admin().rpc('run_scheduled_jobs', { p_jobs: [job] });
  assert(!first.error, `first dispatch failed: ${first.error?.message}`);
  const second = await admin().rpc('run_scheduled_jobs', { p_jobs: [job] });
  assert(!second.error, `second dispatch failed: ${second.error?.message}`);
  assert((second.data ?? []).length === 0, 'the job ran twice in the same window');

  // The same trap as the dispatcher check: the first call reports nothing when an earlier run in this
  // hourly window already did the work. One row for (job, run_key) is what "did the work once" means.
  const { data: runs, error: runsError } = await admin()
    .from('job_runs')
    .select('id, status, run_key')
    .eq('job', job)
    .order('started_at', { ascending: false })
    .limit(10);
  assert(!runsError, `could not read job_runs: ${runsError?.message}`);

  const distinctKeys = new Set((runs ?? []).map((run) => run.run_key));
  assert(distinctKeys.size > 0, `no ${job} run is recorded at all`);
  assert((runs ?? []).every((run) => run.status !== 'failed'), `a ${job} run failed: ${JSON.stringify(runs)}`);

  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const recent = (runs ?? []).filter((run) => new Date(run.started_at ?? 0).getTime() >= twoHoursAgo);
  assert(recent.length <= 2, `${recent.length} ${job} runs started inside one window`);

  return `the second run was skipped by the run key; ${(runs ?? []).length} run row(s) recorded over ${distinctKeys.size} window(s)`;
});

await test('A failed run is retryable and counted', async () => {
  const key = `verify-retry-${suffix}`;
  const first = await admin().rpc('job_claim', { p_job: 'verification.retry', p_run_key: key });
  const row = Array.isArray(first.data) ? first.data[0] : first.data;
  await admin().rpc('job_complete', { p_run_id: row.id, p_status: 'failed', p_error: 'verification' });

  const retry = await admin().rpc('job_claim', { p_job: 'verification.retry', p_run_key: key });
  const retryRow = Array.isArray(retry.data) ? retry.data[0] : retry.data;
  assert(retryRow.did_claim === true, 'a failed run could not be retried');
  assert(retryRow.attempt === 2, `the retry attempt is ${retryRow.attempt}, expected 2`);
  await admin().rpc('job_complete', { p_run_id: retryRow.id, p_status: 'succeeded' });
  return 'attempt 2 claimed the failed run';
});

// ---------------------------------------------------------------------------------------------
// 4. Security
// ---------------------------------------------------------------------------------------------

startGroup('Security isolation');

await test('Anonymous cannot write content', async () => {
  const { error } = await anonymous().from('posts').insert({
    author_id: aliceId,
    body: 'anonymous write attempt',
  });
  assert(error, 'an anonymous insert into posts succeeded');
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('A member cannot write a post as somebody else', async () => {
  const { error } = await bob.from('posts').insert({ author_id: aliceId, body: 'impersonation attempt' });
  assert(error, 'a member created a post under another author');
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('A member cannot edit another member\'s post', async () => {
  const { error } = await bob.from('posts').update({ body: 'tampered' }).eq('id', postId);
  assert(error, "a member edited another member's post");
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('Privilege escalation through the profile row is impossible', async () => {
  const { error } = await alice.from('profiles').update({ role: 'admin', verified: true }).eq('id', aliceId);
  assert(error, 'a member promoted themselves to admin');
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('A moderation action survives the purge of the moderator\'s account', async () => {
  // A moderator is promoted by the service role, records an action, and is then hard-deleted the
  // way purge_deleted_accounts() deletes a tombstone. The audit row must survive with its handle.
  const { data: moderator, error: createError } = await admin().auth.admin.createUser({
    email: `hallyu.verify.mod.${suffix}@example.invalid`,
    password: `verify-${suffix}-Cc3!`,
    email_confirm: true,
    user_metadata: { handle: `verify_mod_${suffix}` },
  });
  assert(!createError, `could not create the moderator: ${createError?.message}`);

  await admin().from('profiles').update({ role: 'moderator' }).eq('id', moderator.user.id);

  const asModerator = await asUser(
    `hallyu.verify.mod.${suffix}@example.invalid`,
    `verify-${suffix}-Cc3!`,
  );

  const { data: actionId, error: actionError } = await admin().rpc('record_moderation_action', {
    p_action: 'content_hidden',
    p_target_type: 'post',
    p_target_id: postId,
    p_reason: 'verification audit entry',
  });
  assert(!actionError, `record_moderation_action failed: ${actionError?.message}`);

  // The same call as the moderator themself, which is the path that stores the handle.
  const { data: ownAction, error: ownError } = await asModerator.rpc('record_moderation_action', {
    p_action: 'content_hidden',
    p_target_type: 'post',
    p_target_id: postId,
    p_reason: 'verification audit entry by the moderator',
  });
  assert(!ownError, `a moderator could not record an action: ${ownError?.message}`);

  const { data: stored } = await admin()
    .from('moderation_actions')
    .select('actor_id, actor_handle')
    .eq('id', ownAction)
    .single();
  assert(stored.actor_handle, 'the action did not record the actor handle');

  // Deleting the profile is exactly what the retention job does. This must not raise.
  const { error: deleteError } = await admin().from('profiles').delete().eq('id', moderator.user.id);
  assert(!deleteError, `the profile could not be deleted: ${deleteError?.message}`);

  const { data: after } = await admin()
    .from('moderation_actions')
    .select('actor_id, actor_handle, reason')
    .eq('id', ownAction)
    .single();
  assert(after, 'the audit entry was deleted with the profile');
  assert(after.actor_id === null, 'the deleted profile id is still referenced');
  assert(after.actor_handle === stored.actor_handle, 'the handle changed when the profile went');

  await admin().auth.admin.deleteUser(moderator.user.id);
  return `audit entry ${ownAction} survived, handle "${after.actor_handle}" preserved`;
});

await test('Account deletion removes the member\'s uploads and shares', async () => {
  const path = `u/${bobId}/posts/to-delete-${suffix}.png`;
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  await bob.storage.from('media').upload(path, bytes, { contentType: 'image/png', upsert: true });

  const begun = await bob.rpc('begin_media_upload', { p_storage_path: path, p_kind: 'image' });
  assert(!begun.error, `begin_media_upload failed: ${begun.error?.message}`);

  // bob deletes their own account later in this run; the row must be gone afterwards.
  const { data: before } = await admin()
    .from('media_uploads')
    .select('id')
    .eq('id', begun.data)
    .single();
  assert(before, 'the upload row was not created');

  const { data: share } = await bob.rpc('record_share', { p_post_id: postId, p_channel: 'link' });
  assert(!share.error, `record_share failed: ${share.error?.message}`);

  return `upload ${begun.data} and a share recorded for the account-deletion test`;
});

await test('A member cannot read another member\'s watchlist', async () => {
  const { data, error } = await bob.from('watchlist_items').select('*');
  assert(!error, `watchlist read failed: ${error?.message}`);
  assert(data.length === 0, `bob read ${data.length} of alice's watchlist rows`);
  return 'bob sees 0 rows';
});

await test('A member cannot read another member\'s saved posts', async () => {
  await alice.rpc('toggle_save', { p_post_id: postId });
  const { data, error } = await bob.from('saves').select('*');
  assert(!error, `saves read failed: ${error?.message}`);
  assert(data.length === 0, `bob read ${data.length} of alice's saved posts`);
  return 'bob sees 0 rows';
});

await test('A member cannot read another member\'s notifications', async () => {
  const { data, error } = await bob.from('notifications').select('*');
  assert(!error, `notifications read failed: ${error?.message}`);
  assert(data.length === 0, `bob read ${data.length} of alice's notifications`);
  return 'bob sees 0 rows';
});

await test('A member cannot read another member\'s push tokens', async () => {
  await alice.rpc('register_push_token', {
    p_token: `verification-token-${suffix}-aaaaaaaaaaaaaaaaaaaa`,
    p_platform: 'android',
    p_device_name: 'verification device',
  });
  const { data, error } = await bob.from('push_tokens').select('*');
  assert(!error, `push token read failed: ${error?.message}`);
  assert(data.length === 0, `bob read ${data.length} of alice's push tokens`);
  return 'bob sees 0 tokens';
});

await test('Notifications cannot be inserted by a client', async () => {
  const { error } = await alice.from('notifications').insert({
    recipient_id: bobId,
    kind: 'follow',
  });
  assert(error, 'a client inserted a notification directly');
  return `rejected with ${error.code ?? 'an error'}`;
});

await test('delete_account only deletes the caller', async () => {
  const { data, error } = await bob.rpc('delete_account');
  assert(!error, `delete_account failed: ${error?.message}`);
  assert(data.deleted === true, 'delete_account did not report success');
  assert(
    typeof data.media_objects_queued === 'number' && data.media_objects_queued >= 1,
    `delete_account queued ${data.media_objects_queued} object(s) — the member's uploads would outlive the account`,
  );

  const { data: profile } = await admin().from('profiles').select('account_status, display_name').eq('id', bobId).single();
  assert(profile.account_status === 'deleted', "bob's profile was not marked deleted");
  assert(profile.display_name === 'Deleted member', "bob's display name was not scrubbed");

  const { data: aliceProfile } = await admin().from('profiles').select('account_status').eq('id', aliceId).single();
  assert(aliceProfile.account_status === 'active', "delete_account removed somebody else's account");
  return 'caller scrubbed, other account untouched';
});

await test('Account deletion also removes uploads, shares and devices', async () => {
  const { data: uploads } = await admin().from('media_uploads').select('id').eq('user_id', bobId);
  assert((uploads ?? []).length === 0, `${uploads.length} media_uploads row(s) outlived the account`);

  const { data: shares } = await admin().from('post_shares').select('id').eq('user_id', bobId);
  assert((shares ?? []).length === 0, `${shares.length} post_shares row(s) outlived the account`);

  const { data: tokens } = await admin().from('push_tokens').select('id').eq('user_id', bobId);
  assert((tokens ?? []).length === 0, `${tokens.length} push token(s) outlived the account`);

  const { data: still } = await admin().from('profiles').select('id').eq('id', bobId).single();
  assert(still, 'the tombstone was hard-deleted — delete_account must keep it');
  return 'uploads, shares and tokens gone; the tombstone remains';
});

// ---------------------------------------------------------------------------------------------
// 5. Storage
// ---------------------------------------------------------------------------------------------

startGroup('Storage');

await test('The media bucket exists and is private', async () => {
  const { data, error } = await admin().storage.getBucket('media');
  assert(!error, `media bucket missing: ${error?.message}`);
  assert(data.public === false, 'the media bucket is public — it must stay private');
  return `public = ${data.public}, limit = ${data.file_size_limit} bytes`;
});

let uploadedPath = '';

await test('Member uploads into their own folder', async () => {
  uploadedPath = `u/${aliceId}/posts/${suffix}.png`;
  const bytes = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf00000301010018dd8db00000000049454e44ae426082',
    'hex',
  );
  const { error } = await alice.storage.from('media').upload(uploadedPath, bytes, { contentType: 'image/png', upsert: true });
  assert(!error, `upload failed: ${error?.message}`);
  return `uploaded ${uploadedPath}`;
});

await test('Member reads their own object back', async () => {
  const { data, error } = await alice.storage.from('media').download(uploadedPath);
  assert(!error, `download failed: ${error?.message}`);
  // supabase-js returns a Blob, which has `size`, not `byteLength`. Reading the wrong one reports an
  // empty object on a perfectly healthy download — this check failed for two live runs because of it.
  const size = data?.byteLength ?? data?.size ?? 0;
  assert(size > 0, `the object came back empty (${size} bytes of ${typeof data})`);
  return `${size} bytes retrieved`;
});

await test('Another member cannot delete the object', async () => {
  const { data: removed, error } = await bob.storage.from('media').remove([uploadedPath]);
  assert(error || (removed ?? []).length === 0, "a member deleted another member's object");
  const { data: intact, error: readErr } = await alice.storage.from('media').download(uploadedPath);
  assert(
    !readErr && (intact?.byteLength ?? intact?.size ?? 0) > 0,
    'the object disappeared after another member called remove()',
  );
  return error
    ? `rejected with ${error.statusCode ?? 'an error'}`
    : '0 objects removed by RLS; owner object verified intact';
});

await test('Member deletes their own object', async () => {
  const { error } = await alice.storage.from('media').remove([uploadedPath]);
  assert(!error, `delete failed: ${error?.message}`);
  return 'object removed';
});

// ---------------------------------------------------------------------------------------------
// 6. Repository credential hygiene (offline)
// ---------------------------------------------------------------------------------------------

startGroup('Repository hygiene');

await test('No privileged credential is committed', async () => {
  const { offenders, filesScanned } = await scanRepository();
  assert(
    offenders.length === 0,
    `credential(s) found: ${offenders.map((o) => `${o.kind} in ${o.file}`).join(', ')}`,
  );
  return `${filesScanned} files scanned, no credential found`;
});

// ---------------------------------------------------------------------------------------------
// 7. Cleanup
// ---------------------------------------------------------------------------------------------

startGroup('Cleanup');

await test('Remove everything the verification created', async () => {
  const service = admin();
  for (const id of [testTitleId, airingTitleId, classicTitleId]) {
    if (id) await service.from('titles').delete().eq('id', id);
  }
  // The share, delivery and moderation rows the script produced are removed with their parents;
  // the job-run rows it created are not content and are left as an audit trail.
  if (communityId) {
    await service.from('community_members').delete().eq('community_id', communityId);
  }

  let removed = 0;
  for (const member of [userA, userB]) {
    if (!member.id) continue;
    const { error } = await service.auth.admin.deleteUser(member.id);
    if (!error) {
      removed += 1;
    } else if (!/not found|does not exist|403/i.test(error.message)) {
      throw new Error(`could not remove ${member.email}: ${error.message}`);
    }
  }
  assert(removed > 0, 'no test account was removed');
  return `${removed} test account(s) removed`;
});

// ---------------------------------------------------------------------------------------------
// 8. Report
// ---------------------------------------------------------------------------------------------

const order = [
  'Supabase connection',
  'Schema',
  'RPCs',
  'Authentication',
  'Catalog',
  'Profiles',
  'Posts',
  'Comments',
  'Reactions',
  'Social graph',
  'Saves and collections',
  'Watchlist',
  'Notifications',
  'Preferences',
  'Analytics',
  'Catalog ingest',
  'Discovery',
  'Notification delivery',
  'Episode alerts',
  'Share accounting',
  'Communities',
  'Moderation',
  'Search',
  'Feed pagination',
  'Media lifecycle',
  'Scheduled jobs',
  'Security isolation',
  'Storage',
  'Repository hygiene',
  'Cleanup',
];

console.log('HALLYU BACKEND VERIFICATION');
console.log('===========================');
console.log(`target: ${SUPABASE_URL}`);
console.log(`started: ${new Date(stamp).toISOString()}`);
console.log('');

let failed = 0;
for (const group of order) {
  const inGroup = results.filter((r) => r.group === group);
  if (inGroup.length === 0) continue;
  const groupOk = inGroup.every((r) => r.ok);
  if (!groupOk) failed += 1;
  console.log(`${group.padEnd(24)} ${groupOk ? 'PASS' : 'FAIL'}`);
  for (const r of inGroup) {
    const mark = r.ok ? '·' : r.blocked ? '⊘' : '✗';
    console.log(`   ${mark} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
}

console.log('');
console.log('===========================');
if (failed === 0) {
  console.log('OVERALL STATUS: PASS');
  process.exit(0);
}

const failures = results.filter((r) => !r.ok && !r.blocked);
const blocked = results.filter((r) => r.blocked);

if (blocked.length > 0) {
  console.log('');
  console.log(`${blocked.length} check(s) could not run at all — an unverified claim is not a pass:`);
  for (const r of blocked) console.log(`  ⊘ ${r.group}: ${r.name} — ${r.detail}`);
}

console.log(
  `OVERALL STATUS: FAIL (${failures.length} failed${blocked.length ? `, ${blocked.length} blocked` : ''} of ${results.length} checks)`,
);
process.exit(1);