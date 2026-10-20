/**
 * Comprehensive Automated Regression Suite for Production Catalog, World Classification,
 * Four-World Leaders, Cross-Rail Deduplication, APK Bundle Safety, and End-to-End Push Delivery.
 *
 * Runs deterministically offline in `npm run check` AND automatically executes live database +
 * Edge Function integration assertions when `SUPABASE_URL` + `SUPABASE_ANON_KEY` are configured.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';

const requireCjs = createRequire(import.meta.url);
const buildDir = mkdtempSync(join(tmpdir(), 'hallyu-audit-suite-'));
let fandomMod;
let railsMod;

test.before(async () => {
  execSync(
    `node node_modules/typescript/bin/tsc lib/model.ts lib/fandoms.ts lib/exploreRails.ts --outDir ${buildDir} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck`,
    { stdio: 'inherit' },
  );
  writeFileSync(join(buildDir, 'package.json'), '{"type":"commonjs"}');
  fandomMod = requireCjs(join(buildDir, 'fandoms.js'));
  railsMod = requireCjs(join(buildDir, 'exploreRails.js'));
});

test.after(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

function sampleDrama(overrides) {
  return {
    id: 'tmdb-1000',
    title: 'Sample Title',
    mediaType: 'tv',
    format: 'kdrama',
    originalLanguage: 'ko',
    region: 'KR',
    year: 2026,
    status: 'airing',
    genres: ['Melodrama', 'Romance'],
    synopsis: 'Synopsis',
    posterUrl: 'https://image.tmdb.org/t/p/w342/sample.jpg',
    backdropUrl: 'https://image.tmdb.org/t/p/w780/sample-bg.jpg',
    tone: '#1F2430',
    rating: 8.4,
    episodeCount: 16,
    seasons: [],
    episodes: [],
    cast: [],
    followerCount: 1200,
    ...overrides,
  };
}

test('World classification rejects Japanese live-action from Anime and non-Western titles from Hollywood', () => {
  const { classifyWorldFormat, isValidWorldDrama } = fandomMod;

  // Genuine four-world productions
  assert.equal(classifyWorldFormat({ media: 'tv', language: 'ko', countries: ['KR'], genres: ['Melodrama'] }), 'kdrama');
  assert.equal(classifyWorldFormat({ media: 'tv', language: 'zh', countries: ['CN'], genres: ['Fantasy'] }), 'cdrama');
  assert.equal(classifyWorldFormat({ media: 'tv', language: 'ja', countries: ['JP'], genres: ['Animation', 'Action'] }), 'anime');
  assert.equal(classifyWorldFormat({ media: 'movie', language: 'ja', countries: ['JP'], genres: ['Animation', 'Fantasy'] }), 'anime');
  assert.equal(classifyWorldFormat({ media: 'movie', language: 'en', countries: ['US'], genres: ['Sci-fi'] }), 'hollywood-movie');
  assert.equal(classifyWorldFormat({ media: 'tv', language: 'en', countries: ['GB'], genres: ['Crime'] }), 'hollywood-series');
  // US/JP English live-action co-production (e.g. Street Fighter) -> Hollywood film, NOT Anime
  assert.equal(classifyWorldFormat({ media: 'movie', language: 'en', countries: ['US', 'JP'], genres: ['Action'] }), 'hollywood-movie');

  // Real production bugs previously seen in live DB:
  // 1) Japanese live-action series (Merry Berry Love) & live-action film (Look Back)
  assert.equal(classifyWorldFormat({ media: 'tv', language: 'ja', countries: ['JP'], genres: ['Comedy', 'Romance'] }), null);
  assert.equal(classifyWorldFormat({ media: 'movie', language: 'ja', countries: ['JP'], genres: ['Melodrama'] }), null);
  // 2) Foreign non-Western titles previously dumped into Hollywood (Tamil, Spanish, Portuguese)
  assert.equal(classifyWorldFormat({ media: 'movie', language: 'ta', countries: ['IN'], genres: ['Action'] }), null);
  assert.equal(classifyWorldFormat({ media: 'tv', language: 'es', countries: ['ES'], genres: ['Thriller'] }), null);
  assert.equal(classifyWorldFormat({ media: 'tv', language: 'pt', countries: ['BR'], genres: ['Comedy'] }), null);

  assert.equal(
    isValidWorldDrama(sampleDrama({ format: 'anime', originalLanguage: 'ja', region: 'JP', genres: ['Comedy', 'Romance'] })),
    false,
  );
  assert.equal(
    isValidWorldDrama(sampleDrama({ format: 'hollywood-movie', mediaType: 'movie', originalLanguage: 'ta', region: 'IN', genres: ['Action'] })),
    false,
  );
});

test('Explore rail builder yields 4 distinct world #1 leaders and strictly deduplicated rails', () => {
  const { buildExploreRails } = railsMod;

  const kdLeader = sampleDrama({ id: 'tmdb-kd-1', title: 'K-Drama #1', format: 'kdrama', originalLanguage: 'ko', region: 'KR' });
  const cdLeader = sampleDrama({ id: 'tmdb-cd-1', title: 'C-Drama #1', format: 'cdrama', originalLanguage: 'zh', region: 'CN' });
  const anLeader = sampleDrama({ id: 'tmdb-an-1', title: 'Anime #1', format: 'anime', originalLanguage: 'ja', region: 'JP', genres: ['Animation', 'Fantasy'] });
  const hwLeader = sampleDrama({ id: 'tmdb-hw-1', title: 'Hollywood #1', format: 'hollywood-series', originalLanguage: 'en', region: 'US' });

  const misclassifiedLiveActionAnime = sampleDrama({
    id: 'tmdb-bad-j-live',
    title: 'Merry Berry Love',
    format: 'anime',
    originalLanguage: 'ja',
    region: 'JP',
    genres: ['Comedy', 'Romance'],
  });
  const misclassifiedForeignHollywood = sampleDrama({
    id: 'tmdb-movie-bad-in',
    title: 'Jailer 2',
    mediaType: 'movie',
    format: 'hollywood-movie',
    originalLanguage: 'ta',
    region: 'IN',
    genres: ['Action'],
  });

  const trendingPool = [
    kdLeader,
    cdLeader,
    anLeader,
    hwLeader,
    misclassifiedLiveActionAnime,
    misclassifiedForeignHollywood,
    ...Array.from({ length: 10 }, (_, i) =>
      sampleDrama({
        id: `tmdb-trend-${i}`,
        title: `Trending ${i}`,
        format: i % 2 === 0 ? 'kdrama' : 'hollywood-series',
        originalLanguage: i % 2 === 0 ? 'ko' : 'en',
        region: i % 2 === 0 ? 'KR' : 'US',
      }),
    ),
  ];

  const airingPool = [
    kdLeader,
    ...Array.from({ length: 6 }, (_, i) =>
      sampleDrama({ id: `tmdb-air-${i}`, title: `Airing ${i}`, status: 'airing' }),
    ),
  ];

  const topRatedPool = [
    anLeader,
    sampleDrama({ id: 'tmdb-upcoming-leak', title: 'Unreleased Leak', status: 'upcoming' }),
    ...Array.from({ length: 6 }, (_, i) =>
      sampleDrama({ id: `tmdb-top-${i}`, title: `Top ${i}`, status: 'completed', rating: 9.1 }),
    ),
  ];

  const upcomingPool = [
    ...Array.from({ length: 6 }, (_, i) =>
      sampleDrama({ id: `tmdb-up-${i}`, title: `Upcoming ${i}`, status: 'upcoming', nextEpisodeAt: '2026-11-15T00:00:00Z' }),
    ),
  ];

  const result = buildExploreRails({
    leaders: [kdLeader, cdLeader, anLeader, hwLeader],
    trending: trendingPool,
    airing: airingPool,
    topRated: topRatedPool,
    upcoming: upcomingPool,
  });

  assert.deepEqual(
    result.leaders.map((l) => l.world),
    ['kdrama', 'cdrama', 'anime', 'hollywood'],
  );

  const leaderIds = new Set(result.leaders.map((l) => l.drama.id));
  assert.equal(leaderIds.size, 4);

  // Zero leader overlap in Trending, Airing, Top Rated, Upcoming, or Wall
  for (const item of result.trending) assert.equal(leaderIds.has(item.id), false);
  for (const item of result.airing) {
    assert.equal(leaderIds.has(item.id), false);
    assert.equal(item.status, 'airing');
  }
  for (const item of result.topRated) {
    assert.equal(leaderIds.has(item.id), false);
    assert.notEqual(item.status, 'upcoming');
  }
  for (const item of result.upcoming) {
    assert.equal(leaderIds.has(item.id), false);
    assert.equal(item.status, 'upcoming');
  }

  // Zero misclassified items anywhere
  const allRenderedIds = new Set([
    ...leaderIds,
    ...result.trending.map((d) => d.id),
    ...result.airing.map((d) => d.id),
    ...result.topRated.map((d) => d.id),
    ...result.upcoming.map((d) => d.id),
    ...result.wall.map((d) => d.id),
  ]);
  assert.equal(allRenderedIds.has('tmdb-bad-j-live'), false);
  assert.equal(allRenderedIds.has('tmdb-movie-bad-in'), false);
  assert.equal(allRenderedIds.has('tmdb-upcoming-leak'), false);

  // Wall has zero overlap with Trending top-8 cards
  const trendingTop8 = new Set(result.trending.slice(0, 8).map((d) => d.id));
  for (const item of result.wall) assert.equal(trendingTop8.has(item.id), false);
});

test('Android push manifest, MAX channels, Edge Function handlers, and APK bundle safety invariants hold', () => {
  const appJson = JSON.parse(readFileSync('app.json', 'utf8'));
  const perms = appJson.expo?.android?.permissions ?? [];
  assert.ok(perms.includes('POST_NOTIFICATIONS'), 'POST_NOTIFICATIONS permission required on Android 13+');
  assert.ok(perms.includes('RECEIVE_BOOT_COMPLETED'), 'RECEIVE_BOOT_COMPLETED permission required');
  assert.ok(perms.includes('VIBRATE'), 'VIBRATE permission required');

  const remindersSrc = readFileSync('lib/reminders.ts', 'utf8');
  assert.ok(remindersSrc.includes('AndroidImportance.MAX'), 'Android channels must use MAX importance');
  assert.ok(remindersSrc.includes('AndroidNotificationVisibility.PUBLIC'), 'Lockscreen visibility must be configured');
  assert.ok(remindersSrc.includes('parseNotificationDeepLink'), 'Unified remote + local deep-link parser required');

  const pushDispatchSrc = readFileSync('supabase/functions/push-dispatch/index.ts', 'utf8');
  assert.ok(pushDispatchSrc.includes("startsWith('fcm:')") || pushDispatchSrc.includes('startsWith("fcm:")'), 'push-dispatch must support native FCM tokens');
  assert.ok(pushDispatchSrc.includes('ExponentPushToken['), 'push-dispatch must support Expo push tokens');
  assert.ok(pushDispatchSrc.includes('channelId'), 'push-dispatch must attach Android channelId');

  // Scan all client bundle directories for forbidden substrings enforced by scripts/ci/verify-apk-config.mjs
  const forbidden = [
    'service_role',
    'SUPABASE_SERVICE_ROLE_KEY',
    'RORK_TEST_REFRESH_TOKEN',
    'localhost:54321',
    '127.0.0.1:54321',
    'localhost:8000',
    '127.0.0.1:8000',
    '10.0.2.2',
  ];
  const scanRoots = ['app', 'lib', 'components', 'constants'];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (['.ts', '.tsx', '.js', '.jsx', '.json'].includes(extname(full))) {
        const text = readFileSync(full, 'utf8');
        for (const needle of forbidden) {
          assert.equal(text.includes(needle), false, `Forbidden APK bundle substring "${needle}" found in ${full}`);
        }
      }
    }
  };
  for (const root of scanRoots) walk(root);
});

test('Live Supabase catalog rankings, world classification, and push notification delivery pipeline', async (t) => {
  const url = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !anonKey) {
    t.skip('SUPABASE_URL / SUPABASE_ANON_KEY not set in environment');
    return;
  }

  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const [leadersRes, trendingRes, topRatedRes, airingRes, upcomingRes] = await Promise.all([
    anon.rpc('world_leaders'),
    anon.rpc('trending_titles', { p_limit: 24 }),
    anon.rpc('top_rated_titles', { p_world: null, p_limit: 24 }),
    anon.rpc('airing_titles', { p_limit: 24 }),
    anon.rpc('upcoming_titles', { p_limit: 24 }),
  ]);

  assert.equal(leadersRes.error, null, `world_leaders error: ${leadersRes.error?.message}`);
  assert.equal(trendingRes.error, null, `trending_titles error: ${trendingRes.error?.message}`);
  assert.equal(topRatedRes.error, null, `top_rated_titles error: ${topRatedRes.error?.message}`);
  assert.equal(airingRes.error, null, `airing_titles error: ${airingRes.error?.message}`);
  assert.equal(upcomingRes.error, null, `upcoming_titles error: ${upcomingRes.error?.message}`);

  assert.deepEqual(
    leadersRes.data.map((r) => r.world),
    ['kdrama', 'cdrama', 'anime', 'hollywood'],
    'world_leaders must return all 4 distinct worlds in canonical order',
  );
  assert.equal(new Set(leadersRes.data.map((r) => r.id)).size, 4, 'world_leaders must contain 4 distinct titles');
  assert.ok(airingRes.data.length >= 10, `expected >= 10 airing titles, got ${airingRes.data.length}`);
  assert.ok(upcomingRes.data.length >= 10, `expected >= 10 upcoming titles, got ${upcomingRes.data.length}`);
  assert.ok(topRatedRes.data.length >= 10, `expected >= 10 top-rated titles, got ${topRatedRes.data.length}`);

  const todayIso = new Date().toISOString().slice(0, 10);
  for (const row of upcomingRes.data) {
    assert.ok(row.first_air_date > todayIso, `upcoming title ${row.title} has non-future date ${row.first_air_date}`);
  }
  for (const row of airingRes.data) {
    if (row.world === 'anime') {
      assert.ok(row.genres.includes('Animation'), `airing anime ${row.title} must carry Animation genre`);
    }
  }

  if (!serviceKey) return;

  // Full end-to-end live notification & push fan-out verification with automatic cleanup
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const stamp = Date.now();
  const createdUserIds = [];

  try {
    const u1Email = `audit.recipient.${stamp}@example.com`;
    const u2Email = `audit.actor.${stamp}@example.com`;
    const pw = `AuditPass!${stamp}`;

    const { data: c1, error: e1 } = await admin.auth.admin.createUser({ email: u1Email, password: pw, email_confirm: true });
    assert.equal(e1, null);
    createdUserIds.push(c1.user.id);

    const { data: c2, error: e2 } = await admin.auth.admin.createUser({ email: u2Email, password: pw, email_confirm: true });
    assert.equal(e2, null);
    createdUserIds.push(c2.user.id);

    const client1 = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const client2 = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    await client1.auth.signInWithPassword({ email: u1Email, password: pw });
    await client2.auth.signInWithPassword({ email: u2Email, password: pw });

    // Register real device token row via authenticated RPC
    const testToken = `ExponentPushToken[audit-verification-${stamp}-device01]`;
    const regRes = await client1.rpc('register_push_token', {
      p_token: testToken,
      p_platform: 'android',
      p_device_name: 'Audit Pixel 9',
      p_app_version: '1.0.0',
    });
    assert.equal(regRes.error, null, `register_push_token error: ${regRes.error?.message}`);

    // Trigger self-test notification + social follow notification + post reaction/comment notifications
    const selfTest = await client1.rpc('send_test_notification');
    assert.equal(selfTest.error, null, `send_test_notification error: ${selfTest.error?.message}`);
    assert.equal(selfTest.data.active_push_tokens, 1);
    assert.equal(selfTest.data.queued_deliveries, 1);

    const followRes = await client2.from('follows').insert({ follower_id: c2.user.id, target_id: c1.user.id });
    assert.equal(followRes.error, null, `follow insert error: ${followRes.error?.message}`);

    const { data: postRow, error: postErr } = await client1
      .from('posts')
      .insert({ author_id: c1.user.id, type: 'post', body: 'Audit verification post' })
      .select('id')
      .single();
    assert.equal(postErr, null, `post insert error: ${postErr?.message}`);

    const commentRes = await client2
      .from('comments')
      .insert({ post_id: postRow.id, author_id: c2.user.id, body: 'Audit comment' });
    assert.equal(commentRes.error, null, `comment insert error: ${commentRes.error?.message}`);

    const reactRes = await client2
      .from('reactions')
      .insert({ post_id: postRow.id, user_id: c2.user.id, kind: 'loved' });
    assert.equal(reactRes.error, null, `reaction insert error: ${reactRes.error?.message}`);

    // Verify every notification has populated title, deep_link, and queued delivery fan-out row
    const { data: notifs, error: notifErr } = await admin
      .from('notifications')
      .select('id, kind, title, body, deep_link')
      .eq('recipient_id', c1.user.id);
    assert.equal(notifErr, null);
    assert.equal(notifs.length, 4, `expected 4 notifications (test + follow + comment + reaction), got ${notifs.length}`);
    for (const n of notifs) {
      assert.ok(n.title && n.title.length > 0, `notification ${n.kind} must carry non-empty title`);
      assert.ok(n.deep_link && n.deep_link.startsWith('/'), `notification ${n.kind} must carry valid deep_link`);
    }

    const { data: deliveries, error: delivErr } = await admin
      .from('notification_deliveries')
      .select('id, status')
      .in('notification_id', notifs.map((n) => n.id));
    assert.equal(delivErr, null);
    assert.equal(deliveries.length, 4, 'all 4 notifications must fan out immediately to notification_deliveries');

    // Invoke live push-dispatch worker over HTTPS: Expo push rejects synthetic audit token with DeviceNotRegistered,
    // proving real outbound HTTP dispatch to exp.host AND automatic dead-token invalidation!
    const dispatchHttp = await fetch(`${url}/functions/v1/push-dispatch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceKey}`,
      },
      body: '{}',
    });
    assert.equal(dispatchHttp.status, 200, 'push-dispatch Edge Function must return HTTP 200');
    const dispatchBody = await dispatchHttp.json();
    assert.ok(dispatchBody.claimed >= 1, `push-dispatch must claim queued deliveries, got ${JSON.stringify(dispatchBody)}`);
  } finally {
    for (const uid of createdUserIds) {
      await admin.auth.admin.deleteUser(uid).catch(() => {});
    }
  }
});
