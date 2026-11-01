import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDeletions, rewriteManifestToUniversal, verifyManifestUrls, PROTECTED_PATHS } from './ci/storage-cleanup.mjs';

const U291 = 'https://x.supabase.co/storage/v1/object/public/app-releases/releases/v1.0.291/hallyu-universal.apk';

function baseObjects() {
  const objs = PROTECTED_PATHS.map((path) => ({ path, bytes: 1 }));
  objs.push({ path: 'latest/hallyu-arm64-v8a.apk', bytes: 1 });
  objs.push({ path: 'latest/hallyu-armeabi-v7a.apk', bytes: 1 });
  objs.push({ path: 'latest/hallyu-x86.apk', bytes: 1 });
  objs.push({ path: 'latest/hallyu-x86_64.apk', bytes: 1 });
  for (const f of ['hallyu-universal.apk', 'hallyu-arm64-v8a.apk', 'hallyu-armeabi-v7a.apk', 'hallyu-x86.apk', 'hallyu-x86_64.apk', 'manifest.json']) {
    objs.push({ path: `releases/v1.0.291/${f}`, bytes: 1 });
    objs.push({ path: `releases/v1.0.289/${f}`, bytes: 1 });
  }
  objs.push({ path: 'releases/v1.0.282/hallyu-universal.apk', bytes: 1 });
  objs.push({ path: 'releases/v1.0.222/hallyu-universal.apk', bytes: 1 });
  return objs;
}

test('keeps only universal APKs in the two kept releases and the protected latest files', () => {
  const plan = planDeletions(baseObjects());
  assert.equal(plan.reason, null);
  for (const p of PROTECTED_PATHS) assert.ok(plan.keep.includes(p), `keep ${p}`);
  assert.ok(plan.keep.includes('releases/v1.0.291/manifest.json'));
  assert.ok(plan.keep.includes('releases/v1.0.289/manifest.json'));
  assert.ok(plan.deletes.includes('releases/v1.0.291/hallyu-arm64-v8a.apk'));
  assert.ok(plan.deletes.includes('releases/v1.0.289/hallyu-x86.apk'));
});

test('deletes per-ABI latest files and every older release folder', () => {
  const plan = planDeletions(baseObjects());
  for (const p of ['latest/hallyu-arm64-v8a.apk', 'latest/hallyu-armeabi-v7a.apk', 'latest/hallyu-x86.apk', 'latest/hallyu-x86_64.apk', 'releases/v1.0.282/hallyu-universal.apk', 'releases/v1.0.222/hallyu-universal.apk']) {
    assert.ok(plan.deletes.includes(p), `delete ${p}`);
  }
});

test('never deletes the legacy bridge or the universal APK', () => {
  const plan = planDeletions(baseObjects());
  assert.ok(!plan.deletes.includes('latest/hallyu-arm64.apk'));
  assert.ok(!plan.deletes.includes('latest/hallyu-universal.apk'));
  assert.ok(!plan.deletes.includes(U291.split('/storage/v1/object/public/app-releases/')[1]));
});

test('refuses to plan anything when a protected object is missing', () => {
  const objs = baseObjects().filter((o) => o.path !== 'latest/manifest.json');
  const plan = planDeletions(objs);
  assert.deepEqual(plan.deletes, []);
  assert.match(plan.reason, /latest\/manifest\.json/);
});

test('manifest rewrite points every ABI and *ApkUrl at the universal APK', () => {
  const manifest = {
    perAbi: {
      universal: { url: U291, latestUrl: 'https://x/latest/hallyu-universal.apk', sha256: 'abc', sizeBytes: 5, versionCode: 12915 },
      'arm64-v8a': { url: 'https://x/releases/v1.0.291/hallyu-arm64-v8a.apk', sha256: 'def', sizeBytes: 3, versionCode: 12915 },
      x86: { url: 'https://x/releases/v1.0.291/hallyu-x86.apk', sha256: 'ghi', sizeBytes: 2, versionCode: 12915 },
    },
    abis: { 'arm64-v8a': { url: 'https://x/latest/hallyu-arm64.apk' }, x86: { url: 'https://x/latest/hallyu-x86.apk' } },
    arm64ApkUrl: 'a', arm32ApkUrl: 'b', x86_64ApkUrl: 'c', x86ApkUrl: 'd',
  };
  const next = rewriteManifestToUniversal(manifest);
  assert.deepEqual(verifyManifestUrls(next, U291), []);
  assert.equal(next.perAbi['arm64-v8a'].sha256, 'abc');
  assert.equal(next.perAbi['arm64-v8a'].sizeBytes, 5);
  assert.equal(next.abis['arm64-v8a'].url, 'https://x/latest/hallyu-arm64.apk', 'legacy bridge untouched');
  assert.equal(next.abis.x86.url, U291);
  assert.equal(next.x86ApkUrl, U291);
});

test('manifest rewrite refuses a manifest without a universal entry', () => {
  assert.throws(() => rewriteManifestToUniversal({ perAbi: {} }), /universal/);
});
