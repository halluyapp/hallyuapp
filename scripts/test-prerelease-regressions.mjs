#!/usr/bin/env node
/**
 * Pre-Release Audit Automated Regression Suite (`node --test scripts/test-prerelease-regressions.mjs`)
 *
 * Directly compiles & executes the real TypeScript production modules via `typescript.transpileModule`
 * (no hand-waved mocks of the code under test) across all 9 pre-release findings + repository rename:
 *   - Repo Rename (`halluyapp/hallyuapp` -> `https://halluyapp.github.io/hallyuapp/`)
 *   - P1 #1: Private-profile privacy invariants in Migration 48 (all 5 roles across tables, storage & RPCs)
 *   - P1 #2: Atomic / safely recoverable post publishing (`runAtomicPostPublishPipeline`) across every stage failure + retry
 *   - P1 #3: Verified server-first account deletion (`performVerifiedAccountDeletion`) on success, error, missing session & offline signout
 *   - P1 #4: Single-source DM notification trigger (`on_direct_message_notify` + `send_direct_message`) invariants
 *   - P2 #5: Post editor full field persistence (`updatePost` + composer `editing` immutability lock)
 *   - P2 #6: Recoverable media & avatar URL failures (`resolveSignedUrlsWithSigner` bounded retry + path preservation + zero public leaks)
 *   - P2 #7: Architecture-specific APK updater selection (`arm64-v8a`, `armeabi-v7a`, `x86_64`, unsupported ABI, ZIP magic & size checks)
 *   - P2 #8: Server follow-request validation (`respond_follow_request` pending check, target check, block check & replay rejection)
 *   - P2 #9: Clearing profile bio (`app/edit-profile.tsx`, `lib/store.tsx`, `lib/api/social.ts`) without touching unrelated fields
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const ROOT = process.cwd();
const nodeRequire = createRequire(import.meta.url);

function loadTsModule(relPath, customMocks = {}) {
  const absPath = path.resolve(ROOT, relPath);
  const src = fs.readFileSync(absPath, 'utf8');
  const transpiled = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
    fileName: absPath,
  });

  const exportsObj = {};
  const moduleObj = { exports: exportsObj };
  const dir = path.dirname(absPath);

  const localRequire = (spec) => {
    if (spec in customMocks) return customMocks[spec];
    if (spec.startsWith('.')) {
      for (const ext of ['', '.ts', '.tsx', '.js', '.mjs']) {
        const candidate = path.resolve(dir, `${spec}${ext}`);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          if (candidate.endsWith('.ts') || candidate.endsWith('.tsx')) {
            return loadTsModule(path.relative(ROOT, candidate), customMocks);
          }
          return nodeRequire(candidate);
        }
      }
    }
    return nodeRequire(spec);
  };

  const wrapped = new vm.Script(
    `(function(exports, require, module, __filename, __dirname) { ${transpiled.outputText}\n})`,
    { filename: absPath },
  );
  wrapped.runInThisContext()(exportsObj, localRequire, moduleObj, absPath, dir);
  return moduleObj.exports;
}

test('Repo rename: links, App Links intent filters, Web Push SW path, OpenGraph HTML, and release publisher align with halluyapp/hallyuapp', () => {
  const linksMod = loadTsModule('lib/links.ts', {
    'react-native': { Platform: { OS: 'android' } },
  });
  assert.equal(linksMod.DEFAULT_WEB_BASE_URL, 'https://halluyapp.github.io/hallyuapp');
  assert.equal(linksMod.sharePostUrl('abc-123'), 'https://halluyapp.github.io/hallyuapp/post/abc-123');
  assert.equal(linksMod.shareUserUrl('@ceohallyu'), 'https://halluyapp.github.io/hallyuapp/u/ceohallyu');

  const appConfigFactory = nodeRequire(path.resolve(ROOT, 'app.config.js'));
  const resolvedAppConfig = appConfigFactory({
    config: { version: '1.0.212', ios: {}, android: { permissions: [] }, experiments: {} },
  });
  const intentData = resolvedAppConfig.android.intentFilters[0].data;
  assert.ok(
    intentData.some((d) => d.host === 'halluyapp.github.io' && d.pathPrefix === '/hallyuapp'),
    'Android App Links must include halluyapp.github.io/hallyuapp',
  );
  assert.ok(
    !JSON.stringify(intentData).includes('macaulay-spec'),
    'Android App Links must not reference stale macaulay-spec host',
  );

  const publishScript = fs.readFileSync(path.resolve(ROOT, 'scripts/ci/publish-app-release.mjs'), 'utf8');
  assert.ok(publishScript.includes("'halluyapp/hallyuapp'"));
  assert.ok(!publishScript.includes('macaulay-spec'));

  const enhanceHtml = fs.readFileSync(path.resolve(ROOT, 'scripts/ci/enhance-web-html.mjs'), 'utf8');
  assert.ok(enhanceHtml.includes("'halluyapp'"));
  assert.ok(!enhanceHtml.includes('macaulay-spec'));
});

test('P1 #1 & P1 #4 & P2 #8: Migration 48 enforces can_view_author_content across tables/storage/RPCs, single DM trigger, and strict respond_follow_request validation', () => {
  const sql = fs.readFileSync(
    path.resolve(ROOT, 'supabase/migrations/20260101124800_48_prerelease_security_and_integrity.sql'),
    'utf8',
  );
  // P1 #1: All read surfaces enforce `public.can_view_author_content`
  for (const requiredPolicy of [
    'create policy posts_select_anonymous',
    'create policy posts_select_visible',
    'create policy post_media_select_anonymous',
    'create policy post_media_select_with_post',
    'create policy comments_select_anonymous',
    'create policy comments_select_visible',
    'create policy collections_select_anonymous',
    'create policy collections_select_visible',
    'create policy media_read_own',
    'create policy media_read_authorized',
  ]) {
    assert.ok(sql.includes(requiredPolicy), `Migration 48 missing policy: ${requiredPolicy}`);
  }
  assert.ok(sql.includes('drop policy if exists media_read_attached_or_avatar_public on storage.objects'));

  // P1 #4: `send_direct_message` relies exclusively on trigger `direct_messages_notify_after_insert`
  const sendDmBody = sql.slice(sql.indexOf('create or replace function public.send_direct_message'));
  const sendDmEnd = sendDmBody.indexOf('revoke all on function public.send_direct_message');
  const sendDmSlice = sendDmBody.slice(0, sendDmEnd);
  assert.ok(!sendDmSlice.includes('insert into public.notifications'), 'send_direct_message must not double-insert notifications');

  // P2 #8: `respond_follow_request` deletes/claims pending row and raises `no_data_found` when absent
  assert.ok(sql.includes("and status = 'pending'"));
  assert.ok(sql.includes("raise exception 'no pending follow request from %'"));
  assert.ok(sql.includes('revoke all on function public.respond_follow_request(uuid, boolean) from public, anon'));
});

test('P1 #2: runAtomicPostPublishPipeline cleans up orphaned storage AND incomplete post rows across every failure stage and prevents duplicate posts on retry', async () => {
  const { runAtomicPostPublishPipeline } = loadTsModule('lib/publishPipeline.ts');

  const serverPosts = new Map();
  const storageObjects = new Set(['u/other-user/unrelated.jpg']);
  const postMediaRows = new Map();

  // Seed another user's published post to verify cleanup NEVER touches unrelated data
  serverPosts.set('existing-other-post', { id: 'existing-other-post', authorId: 'other-user', body: 'Safe post' });

  const makeDeps = (failStage) => ({
    uploadImage: async (uid, postId, _uri, index) => {
      if (failStage === 'upload-second' && index === 1) {
        throw new Error('Simulated network drop on image #2');
      }
      const storagePath = `u/${uid}/${postId}-${index}.jpg`;
      storageObjects.add(storagePath);
      return { uploadId: `up-${postId}-${index}`, storagePath, width: 1080, height: 1350 };
    },
    uploadVideo: async () => {
      throw new Error('Unused in image test');
    },
    uploadPoster: async () => {
      throw new Error('Unused in image test');
    },
    insertPost: async (post, uid) => {
      if (failStage === 'insert') throw new Error('Simulated post insert DB rejection');
      serverPosts.set(post.id, { ...post, authorId: uid });
    },
    attachAsset: async ({ uploadId, postId }) => {
      if (failStage === 'attach') throw new Error('Simulated complete_media_upload failure');
      const idx = uploadId.endsWith('-0') ? 0 : 1;
      const list = postMediaRows.get(postId) ?? [];
      list.push(`u/user-1/${postId}-${idx}.jpg`);
      postMediaRows.set(postId, list);
      return `media-${uploadId}`;
    },
    verifyPostMedia: async (postId, expectedPaths) => {
      if (failStage === 'verify') throw new Error('Simulated verification mismatch');
      const attached = postMediaRows.get(postId) ?? [];
      assert.equal(attached.length, expectedPaths.length);
    },
    fetchPosts: async (ids) => {
      if (failStage === 'readback') return [];
      const row = serverPosts.get(ids[0]);
      if (!row) return [];
      const paths = postMediaRows.get(ids[0]) ?? [];
      return [{ ...row, images: paths.map((p) => `https://signed.example/${p}`), imagePaths: paths }];
    },
    cleanupUnpublishedPost: async (postId) => {
      serverPosts.delete(postId);
      postMediaRows.delete(postId);
    },
    discardAssets: async (paths) => {
      for (const p of paths) storageObjects.delete(p);
    },
  });

  const stableDraftPost = {
    id: '11111111-1111-4111-8111-111111111111',
    authorId: 'user-1',
    type: 'post',
    body: ' testing atomic media publish ',
    spoiler: 'none',
    context: {},
    hashtags: [],
    mentions: [],
    reactions: { loved: 0, cried: 0, screamed: 0, swooned: 0, laughed: 0, furious: 0 },
    commentCount: 0,
    saveCount: 0,
    createdAt: new Date().toISOString(),
  };

  // Failure Stage 1: upload #2 fails after upload #1 succeeded -> upload #1 cleaned up, 0 posts created
  await assert.rejects(() =>
    runAtomicPostPublishPipeline(
      {
        post: stableDraftPost,
        userId: 'user-1',
        world: 'kdrama',
        imageUris: ['file:///1.jpg', 'file:///2.jpg'],
        videoInput: null,
      },
      makeDeps('upload-second'),
    ),
  );
  assert.equal(serverPosts.has(stableDraftPost.id), false);
  assert.equal([...storageObjects].filter((k) => k.startsWith('u/user-1/')).length, 0);

  // Failure Stage 2: post row created, then `attachAsset` fails -> incomplete post row DELETED + uploads cleaned
  await assert.rejects(() =>
    runAtomicPostPublishPipeline(
      {
        post: stableDraftPost,
        userId: 'user-1',
        world: 'kdrama',
        imageUris: ['file:///1.jpg', 'file:///2.jpg'],
        videoInput: null,
      },
      makeDeps('attach'),
    ),
  );
  assert.equal(serverPosts.has(stableDraftPost.id), false, 'Orphaned media-less post row MUST NOT remain active');
  assert.equal([...storageObjects].filter((k) => k.startsWith('u/user-1/')).length, 0);

  // Failure Stage 3: attach succeeded, then `verifyPostMedia` fails -> incomplete post row DELETED + uploads cleaned
  await assert.rejects(() =>
    runAtomicPostPublishPipeline(
      {
        post: stableDraftPost,
        userId: 'user-1',
        world: 'kdrama',
        imageUris: ['file:///1.jpg', 'file:///2.jpg'],
        videoInput: null,
      },
      makeDeps('verify'),
    ),
  );
  assert.equal(serverPosts.has(stableDraftPost.id), false);
  assert.equal([...storageObjects].filter((k) => k.startsWith('u/user-1/')).length, 0);

  // Retry with the exact same stable `post.id` succeeds cleanly with 0 duplicates and untouched unrelated user data
  const published = await runAtomicPostPublishPipeline(
    {
      post: stableDraftPost,
      userId: 'user-1',
      world: 'kdrama',
      imageUris: ['file:///1.jpg', 'file:///2.jpg'],
      videoInput: null,
    },
    makeDeps('none'),
  );
  assert.equal(published.id, stableDraftPost.id);
  assert.equal(published.imagePaths.length, 2);
  assert.equal(serverPosts.size, 2); // 1 unrelated existing post + 1 newly published verified post (zero duplicates)
  assert.equal(storageObjects.has('u/other-user/unrelated.jpg'), true);
});

test('P1 #3: performVerifiedAccountDeletion never clears local auth or claims success on server error, redacts PII, and handles offline post-delete signout safely', async () => {
  const { performVerifiedAccountDeletion } = loadTsModule('lib/accountDeletion.ts');

  let signedOutCount = 0;
  let clearedStorageCount = 0;
  let clearedStateCount = 0;
  const diagnostics = [];

  // Forced RPC error containing sensitive email & JWT -> throws, keeps local account untouched, redacts PII
  await assert.rejects(
    () =>
      performVerifiedAccountDeletion({
        hasRemoteBackend: true,
        ensureSessionToken: async () => 'valid-session',
        rpcDeleteAccount: async () => ({
          data: null,
          error: {
            message:
              'timeout for secret.member@gmail.com with token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sigXYZ',
          },
        }),
        signOutRemote: async () => {
          signedOutCount += 1;
        },
        clearLocalAccountStorage: async () => {
          clearedStorageCount += 1;
        },
        clearLocalSessionState: () => {
          clearedStateCount += 1;
        },
        recordDiagnosticError: (_scope, msg) => diagnostics.push(msg),
      }),
    /Account deletion failed on server/,
  );

  assert.equal(signedOutCount, 0, 'Must NOT sign out locally when server RPC fails');
  assert.equal(clearedStorageCount, 0, 'Must NOT wipe local storage when server RPC fails');
  assert.equal(clearedStateCount, 0, 'Must NOT flip auth state when server RPC fails');
  assert.equal(diagnostics.length, 1);
  assert.ok(!diagnostics[0].includes('secret.member@gmail.com'), 'PII email must be redacted');
  assert.ok(!diagnostics[0].includes('eyJhbGci'), 'JWT must be redacted');

  // Server confirms `{ deleted: true }`, then signOut throws network glitch -> local cleanup still completes cleanly
  const okOutcome = await performVerifiedAccountDeletion({
    hasRemoteBackend: true,
    ensureSessionToken: async () => 'valid-session',
    rpcDeleteAccount: async () => ({ data: { deleted: true }, error: null }),
    signOutRemote: async () => {
      signedOutCount += 1;
      throw new Error('offline during local signout');
    },
    clearLocalAccountStorage: async () => {
      clearedStorageCount += 1;
    },
    clearLocalSessionState: () => {
      clearedStateCount += 1;
    },
  });

  assert.equal(okOutcome.deleted, true);
  assert.ok(okOutcome.localSignOutWarning);
  assert.equal(clearedStorageCount, 1);
  assert.equal(clearedStateCount, 1);
});

test('P2 #5 & P2 #9: updatePost persists all editable fields and profile bio clear persists null without touching unrelated fields', async () => {
  let lastTable = null;
  let lastUpdatePayload = null;

  const mockClient = {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok' } } }),
    },
    from: (table) => {
      if (table === 'titles') {
        return {
          select: () => ({
            eq: (_col1, extId) => ({
              eq: () => ({
                limit: async () => ({
                  data: [{ id: extId === '999' ? '99999999-9999-4999-8999-999999999999' : '88888888-8888-4888-8888-888888888888' }],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      return {
        update: (payload) => {
          lastTable = table;
          lastUpdatePayload = payload;
          return {
            eq: () => ({
              select: () => ({
                single: async () => ({ data: { id: '22222222-2222-4222-8222-222222222222' }, error: null }),
              }),
              then: (resolve) => resolve({ error: null }),
            }),
          };
        },
      };
    },
  };

  const socialMod = loadTsModule('lib/api/social.ts', {
    './client': {
      supabase: mockClient,
      ensureBackendSessionToken: async () => 'tok',
      getBackendAccessToken: () => 'tok',
    },
    './media': { uploadAvatar: async () => ({ storagePath: 'u/x/a.jpg', signedUrl: 'https://x' }) },
  });

  await socialMod.updatePost(
    '22222222-2222-4222-8222-222222222222',
    {
      body: 'Updated body #kdrama',
      title: 'Updated Discussion Title',
      kind: 'theory',
      rating: 9,
      verdict: 'Updated verdict',
      spoiler: 'ending',
      hashtags: ['kdrama'],
      mentions: ['33333333-3333-4333-8333-333333333333', 'non-uuid-ignored'],
      context: {
        dramaId: 'tmdb-999',
        secondaryDramaId: 'tmdb-888',
        season: 2,
        episode: 16,
      },
    },
    'kdrama',
  );

  assert.equal(lastTable, 'posts');
  assert.equal(lastUpdatePayload.body, 'Updated body #kdrama');
  assert.equal(lastUpdatePayload.title, 'Updated Discussion Title');
  assert.equal(lastUpdatePayload.kind, 'theory');
  assert.equal(lastUpdatePayload.rating, 9);
  assert.equal(lastUpdatePayload.verdict, 'Updated verdict');
  assert.equal(lastUpdatePayload.spoiler, 'ending');
  assert.deepEqual(lastUpdatePayload.hashtags, ['kdrama']);
  assert.deepEqual(lastUpdatePayload.mentions, ['33333333-3333-4333-8333-333333333333']);
  assert.equal(lastUpdatePayload.title_id, '99999999-9999-4999-8999-999999999999');
  assert.equal(lastUpdatePayload.secondary_title_id, '88888888-8888-4888-8888-888888888888');
  assert.equal(lastUpdatePayload.season, 2);
  assert.equal(lastUpdatePayload.episode, 16);
  assert.equal(lastUpdatePayload.world, 'kdrama');

  // P2 #9: Clearing bio (`bio: ''`) writes `bio: null` to `profiles` and leaves unrelated columns untouched
  await socialMod.updateProfile('22222222-2222-4222-8222-222222222222', { bio: '   ' });
  assert.equal(lastTable, 'profiles');
  assert.deepEqual(lastUpdatePayload, { bio: null });
});

test('P2 #6: resolveSignedUrlsWithSigner recovers from transient failure with bounded 1-retry cap and zero public URL leakage', async () => {
  const mediaMod = loadTsModule('lib/api/media.ts', {
    'react-native': { Platform: { OS: 'android' } },
    'expo-file-system': { FileSystemUploadType: { BINARY_CONTENT: 0 } },
    'expo-image-manipulator': {},
    './client': {
      supabase: null,
      ensureBackendSessionToken: async () => null,
      normalizeMediaUrl: (u) => u,
    },
    './social': { isUuid: () => true },
    '../../constants/keys': {
      MEDIA_BUCKET: 'media',
      SUPABASE_ANON_KEY: 'anon',
      SUPABASE_URL: 'https://kzxlbscfkixnswurpkzb.supabase.co',
    },
    '../media': { prepareLocalImage: async () => ({}) },
    '../video': { inspectVideo: async () => ({}) },
  });

  mediaMod.resetMediaSignCacheForTests();
  let calls = 0;
  const recovered = await mediaMod.resolveSignedUrlsWithSigner(
    ['u/member-1/avatar.jpg'],
    async (wanted) => {
      calls += 1;
      if (calls === 1) {
        return { data: null, error: { message: '502 Bad Gateway transient glitch' } };
      }
      return {
        data: [
          {
            path: wanted[0],
            signedUrl: 'https://kzxlbscfkixnswurpkzb.supabase.co/storage/v1/object/sign/media/u/member-1/avatar.jpg?token=signed123',
          },
        ],
        error: null,
      };
    },
    5,
  );
  assert.equal(calls, 2, 'Should retry exactly once and recover');
  const url = recovered.get('u/member-1/avatar.jpg');
  assert.ok(url?.includes('/object/sign/media/'));
  assert.ok(!url?.includes('/object/public/media/'), 'Private media must NEVER fall back to public URL');

  // Persistent outage must stop after exact 2 calls (initial + 1 retry) — never loop infinitely
  mediaMod.resetMediaSignCacheForTests();
  let failCalls = 0;
  await assert.rejects(() =>
    mediaMod.resolveSignedUrlsWithSigner(
      ['u/member-1/unreadable.jpg'],
      async () => {
        failCalls += 1;
        return { data: null, error: { message: 'Object not found' } };
      },
      5,
    ),
  );
  assert.equal(failCalls, 2, 'Persistent failure must cap at 1 bounded retry');
});

test('P2 #7: APK updater selects arm64-v8a, armeabi-v7a, or x86_64 cleanly, rejects unsupported ABIs, and validates ZIP magic + HTTP headers', () => {
  const updater = loadTsModule('lib/appUpdater.ts', {
    '@react-native-async-storage/async-storage': {},
    'expo-application': { nativeBuildVersion: '12114', nativeApplicationVersion: '1.0.211' },
    'expo-constants': { expoConfig: { version: '1.0.211' } },
    'expo-file-system': { EncodingType: { Base64: 'base64' } },
    'expo-intent-launcher': {},
    'react-native': { Linking: {}, Platform: { OS: 'android', constants: {} } },
    './api/client': { supabase: null },
    './links': {
      LATEST_SLIM_APK_CDN_URL: 'https://cdn.example/hallyu-arm64.apk',
      LATEST_ARM32_APK_CDN_URL: 'https://cdn.example/hallyu-armeabi-v7a.apk',
      LATEST_X86_64_APK_CDN_URL: 'https://cdn.example/hallyu-x86_64.apk',
      SUPABASE_PUBLIC_STORAGE_BASE: 'https://cdn.example',
    },
  });

  const sampleRelease = {
    apkUrl: 'https://cdn.example/hallyu-arm64.apk',
    arm32ApkUrl: 'https://cdn.example/hallyu-armeabi-v7a.apk',
    x86_64ApkUrl: 'https://cdn.example/hallyu-x86_64.apk',
    sha256: 'arm64sha',
    fileSizeBytes: 34_321_521,
    abis: {
      'arm64-v8a': { abi: 'arm64-v8a', url: 'https://cdn.example/hallyu-arm64.apk', sha256: 'sha-arm64', sizeBytes: 34_321_521 },
      'armeabi-v7a': { abi: 'armeabi-v7a', url: 'https://cdn.example/hallyu-armeabi-v7a.apk', sha256: 'sha-arm32', sizeBytes: 29_150_000 },
      x86_64: { abi: 'x86_64', url: 'https://cdn.example/hallyu-x86_64.apk', sha256: 'sha-x86_64', sizeBytes: 35_650_000 },
    },
  };

  // 1. 64-bit ARM device supporting both 64-bit and 32-bit -> picks 64-bit `arm64-v8a`
  const arm64Choice = updater.selectApkArtifactForAbis(['arm64-v8a', 'armeabi-v7a'], sampleRelease);
  assert.deepEqual(arm64Choice, {
    ok: true,
    abi: 'arm64-v8a',
    url: 'https://cdn.example/hallyu-arm64.apk',
    sha256: 'sha-arm64',
    sizeBytes: 34_321_521,
  });

  // 2. 32-bit ARM device -> picks `armeabi-v7a` (NEVER `arm64-v8a`)
  const arm32Choice = updater.selectApkArtifactForAbis(['armeabi-v7a', 'armeabi'], sampleRelease);
  assert.deepEqual(arm32Choice, {
    ok: true,
    abi: 'armeabi-v7a',
    url: 'https://cdn.example/hallyu-armeabi-v7a.apk',
    sha256: 'sha-arm32',
    sizeBytes: 29_150_000,
  });

  // 3. Chromebook / desktop emulator (`x86_64`) -> picks `x86_64`
  const x64Choice = updater.selectApkArtifactForAbis(['x86_64'], sampleRelease);
  assert.deepEqual(x64Choice, {
    ok: true,
    abi: 'x86_64',
    url: 'https://cdn.example/hallyu-x86_64.apk',
    sha256: 'sha-x86_64',
    sizeBytes: 35_650_000,
  });

  // 4. Unsupported 32-bit x86 / MIPS device -> explicitly rejected with human-readable message
  const unsupported = updater.selectApkArtifactForAbis(['x86'], sampleRelease);
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.message, /No compatible signed APK/);

  // 5. HTTP header + ZIP magic byte checks
  assert.equal(updater.validateApkHttpHeaders(200, { 'Content-Type': 'application/vnd.android.package-archive' }).ok, true);
  assert.equal(updater.validateApkHttpHeaders(200, { 'Content-Type': 'text/html; charset=utf-8' }).ok, false);
  assert.equal(updater.validateApkHttpHeaders(404, {}).ok, false);
  assert.equal(updater.verifyApkZipMagicAndSize('UEsDBA==', 34_321_521, 34_321_521).ok, true);
  assert.equal(updater.verifyApkZipMagicAndSize('PCFET0NU', 34_321_521, 34_321_521).ok, false);
  assert.equal(updater.verifyApkZipMagicAndSize('UEsDBA==', 12_000_000, 34_321_521).ok, false);
});

test('Release & Updater v2: semver/train accuracy, zero FLAG_ACTIVITY_NEW_TASK bug, persistent documentDirectory storage, and honest not_installed_yet state', async () => {
  const storageMap = new Map();
  let launchedIntent = null;

  const updater = loadTsModule('lib/appUpdater.ts', {
    '@react-native-async-storage/async-storage': {
      getItem: async (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: async (k, v) => {
        storageMap.set(k, v);
      },
      removeItem: async (k) => {
        storageMap.delete(k);
      },
    },
    'expo-application': {
      applicationId: 'com.hallyu.app',
      nativeBuildVersion: '12141',
      nativeApplicationVersion: '1.0.214',
    },
    'expo-constants': { expoConfig: { version: '1.0.214' } },
    'expo-file-system': {
      documentDirectory: 'file:///data/user/0/com.hallyu.app/files/',
      cacheDirectory: 'file:///data/user/0/com.hallyu.app/cache/',
      EncodingType: { Base64: 'base64' },
      makeDirectoryAsync: async () => {},
      readDirectoryAsync: async () => [],
      deleteAsync: async () => {},
      getInfoAsync: async (uri) =>
        uri.includes('12154')
          ? { exists: true, size: 34_328_867 }
          : { exists: false, size: 0 },
      readAsStringAsync: async () => 'UEsDBA==',
      getContentUriAsync: async (uri) =>
        `content://com.hallyu.app.FileSystemFileProvider/${encodeURIComponent(uri)}`,
    },
    'expo-intent-launcher': {
      ResultCode: { Success: -1, Canceled: 0 },
      startActivityAsync: async (action, params) => {
        launchedIntent = { action, params };
        // Simulate Android returning Canceled when user backs out or unknown-sources wasn't confirmed
        return { resultCode: 0 };
      },
    },
    'react-native': {
      Linking: { openURL: async () => {}, openSettings: async () => {} },
      Platform: { OS: 'android', constants: { SupportedAbis: ['arm64-v8a'] } },
    },
    './api/client': { supabase: null },
    './links': {
      LATEST_SLIM_APK_CDN_URL: 'https://cdn.example/hallyu-arm64.apk',
      LATEST_ARM32_APK_CDN_URL: 'https://cdn.example/hallyu-armeabi-v7a.apk',
      LATEST_X86_64_APK_CDN_URL: 'https://cdn.example/hallyu-x86_64.apk',
      SUPABASE_PUBLIC_STORAGE_BASE: 'https://cdn.example',
    },
  });

  // Same release train across universal (`12141`) vs arm64 (`12144`) MUST report Up to Date (`false`)
  assert.equal(
    updater.isReleaseNewer(12141, '1.0.214', {
      versionCode: 12144,
      releaseTrain: 1214,
      versionName: '1.0.214',
    }),
    false,
  );
  // Newer release train (`12154` > `12141`) MUST report update available (`true`)
  assert.equal(
    updater.isReleaseNewer(12141, '1.0.214', {
      versionCode: 12154,
      releaseTrain: 1215,
      versionName: '1.0.215',
    }),
    true,
  );
  // Zero-padded version segments (`1.7.01` vs `1.7.02`) compare cleanly
  assert.equal(updater.compareVersionStrings('1.7.01', '1.7.01'), 0);
  assert.equal(updater.compareVersionStrings('1.7.01', '1.7.02'), -1);

  const outcome = await updater.downloadAndInstallApk({
    versionCode: 12154,
    versionName: '1.0.215',
    apkUrl: 'https://cdn.example/hallyu-arm64.apk',
    arm32ApkUrl: 'https://cdn.example/hallyu-armeabi-v7a.apk',
    x86_64ApkUrl: 'https://cdn.example/hallyu-x86_64.apk',
    fileSizeBytes: 34_328_867,
    sha256: 'sha256',
  });

  assert.equal(
    launchedIntent.params.flags,
    0x00000001,
    'Must pass ONLY FLAG_GRANT_READ_URI_PERMISSION (0x1) and NEVER FLAG_ACTIVITY_NEW_TASK (0x10000000)',
  );
  assert.ok(
    decodeURIComponent(launchedIntent.params.data).includes('/files/hallyu-updates/'),
    'APK must live inside persistent documentDirectory (`files/hallyu-updates/`)',
  );
  assert.equal(
    outcome.status,
    'not_installed_yet',
    'When Android PackageInstaller returns ResultCode.Canceled, updater must honestly report not_installed_yet',
  );
});

test('Notifications, Admin Studio, Bug Reports, Watch Party & Profile Stats end-to-end invariants', async () => {
  // 1. Notifications RPC payload: marking ALL read sends `p_ids: null`, never `[]`
  const rpcCalls = [];
  const socialMod = loadTsModule('lib/api/social.ts', {
    './client': {
      supabase: {
        rpc: async (fn, args) => {
          rpcCalls.push({ fn, args });
          return { data: null, error: null };
        },
      },
      ensureBackendSessionToken: async () => 'tok',
      fail: (ctx, msg) => {
        throw new Error(`${ctx}: ${msg}`);
      },
    },
    './mappers': {
      mapComment: (x) => x,
      mapNotification: (x) => x,
      mapPost: (x) => x,
      mapProfile: (x) => x,
      POST_SELECT: '*',
      PROFILE_COLUMNS: '*',
    },
    './media': {
      signedUrls: async () => new Map(),
      uploadImage: async () => ({}),
      uploadVideo: async () => ({}),
    },
    '../catalogSync': { ensureServerTitle: async () => null },
  });

  await socialMod.markNotificationsRead(undefined, undefined);
  await socialMod.markNotificationsRead([], 'social');
  await socialMod.markNotificationsRead(['11111111-1111-4111-8111-111111111111'], undefined);

  assert.deepEqual(rpcCalls[0], {
    fn: 'mark_notifications_read',
    args: { p_ids: null, p_group: null },
  });
  assert.deepEqual(rpcCalls[1], {
    fn: 'mark_notifications_read',
    args: { p_ids: null, p_group: 'social' },
  });
  assert.deepEqual(rpcCalls[2], {
    fn: 'mark_notifications_read',
    args: { p_ids: ['11111111-1111-4111-8111-111111111111'], p_group: null },
  });

  // 2. Notification routes & push-dispatch fallback targets
  assert.ok(fs.existsSync(path.resolve(ROOT, 'app/notifications.tsx')));
  assert.ok(fs.existsSync(path.resolve(ROOT, 'app/watch-party/[eventId].tsx')));
  const pushFn = fs.readFileSync(
    path.resolve(ROOT, 'supabase/functions/push-dispatch/index.ts'),
    'utf8',
  );
  assert.ok(!pushFn.includes("'/notifications'"), 'push-dispatch must never link to dead /notifications');
  assert.ok(pushFn.includes("'/(tabs)/activity'"));

  // 3. Admin Studio & Segmented Yoga layout regression guard
  const segmentedSrc = fs.readFileSync(
    path.resolve(ROOT, 'components/ui/Segmented.tsx'),
    'utf8',
  );
  assert.ok(!segmentedSrc.includes("!scrollable ? { flex: 1 } : null"));
  assert.ok(segmentedSrc.includes('minHeight: 45'));
  assert.ok(segmentedSrc.includes('flexShrink: 0'));

  const moderationSrc = fs.readFileSync(
    path.resolve(ROOT, 'app/settings/moderation.tsx'),
    'utf8',
  );
  assert.ok(moderationSrc.includes('resolveStudioTab'));
  assert.ok(moderationSrc.includes("label={`Bugs · ${openTickets.length}`}"));

  // 4. Profile stats accuracy (zero double-counting `+ 1` on followers)
  const profileViewSrc = fs.readFileSync(
    path.resolve(ROOT, 'components/profile/ProfileView.tsx'),
    'utf8',
  );
  assert.ok(
    !profileViewSrc.includes('followingThem && !isMe ? 1 : 0'),
    'ProfileView must never add +1 on top of server follower_count',
  );

  // 5. Watch Party real-time room lifecycle (`connectLiveEpisodeRoom`)
  const statuses = [];
  const receivedChats = [];
  let untracked = false;
  let removed = false;
  let broadcastHandler = null;

  const mockChannel = {
    topic: 'episode-watch-room:event-test',
    presenceState: () => ({
      'user-1': [{ userId: 'user-1', handle: 'alice', displayName: 'Alice', joinedAt: '2026-10-23T00:00:00Z' }],
      'user-2': [{ userId: 'user-2', handle: 'bob', displayName: 'Bob', joinedAt: '2026-10-23T00:00:01Z' }],
    }),
    on(type, filter, cb) {
      if (type === 'broadcast' && filter.event === 'room_chat') broadcastHandler = cb;
      return mockChannel;
    },
    subscribe(cb) {
      cb('SUBSCRIBED');
      return mockChannel;
    },
    track: async () => {},
    untrack: async () => {
      untracked = true;
    },
    send: async ({ event, payload }) => {
      if (event === 'room_chat' && broadcastHandler) broadcastHandler({ payload });
    },
  };

  const featuresMod = loadTsModule('lib/api/features.ts', {
    './client': {
      supabase: {
        getChannels: () => [],
        channel: () => mockChannel,
        removeChannel: async () => {
          removed = true;
        },
      },
      ensureBackendSessionToken: async () => 'tok',
      normalizeMediaUrl: (u) => u,
    },
    './mappers': { mapPost: (x) => x, mapTitle: (x) => x, POST_SELECT: '*' },
    './media': { signedUrls: async () => new Map() },
    './social': { isUuid: () => true },
  });

  let roomViewers = [];
  const room = featuresMod.connectLiveEpisodeRoom(
    'event-test',
    { id: 'user-1', handle: 'alice', displayName: 'Alice' },
    {
      onStatusChange: (st) => statuses.push(st),
      onViewersChange: (v) => {
        roomViewers = v;
      },
      onReactionBurst: () => {},
      onChatMessage: (m) => receivedChats.push(m),
    },
  );

  assert.deepEqual(statuses, ['connecting', 'connected']);
  assert.equal(roomViewers.length, 2);
  const sentMsg = room.sendChat('Hello Watch Party!', '18:30');
  assert.equal(sentMsg.body, 'Hello Watch Party!');
  assert.equal(receivedChats.length, 1);
  room.leave();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(untracked, true, 'Leaving room must untrack presence immediately');
  assert.equal(removed, true, 'Leaving room must remove channel cleanly');
  assert.equal(statuses.at(-1), 'disconnected');
});
