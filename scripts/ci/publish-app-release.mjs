#!/usr/bin/env node
/**
 * Publishes all signed Android release APKs (`arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`,
 * `arm-universal` [dual ARM64+ARMv7 <= 30 MB], and full 4-ABI `universal`):
 *   1. Uploads every artifact `<= 49 MB` to immutable versioned paths
 *      `releases/v<versionName>/hallyu-<abi>.apk` AND mutable `latest/hallyu-<abi>.apk` in
 *      Supabase Storage CDN, while gracefully falling back to GitHub Releases CDN URLs if the
 *      full 4-ABI `universal` APK exceeds Supabase Free-Tier's 50 MB per-object cap.
 *   2. Uploads a dual-ARM (`arm64-v8a` + `armeabi-v7a`, ~26 MB) or full 4-ABI universal APK to
 *      legacy `latest/hallyu-arm64.apk` AND `manifest.abis['arm64-v8a']` (`versionCode = base + 5`)
 *      so existing installs on older Hallyu builds (`v1.0.201`–`v1.0.218`) upgrade cleanly in 1 tap
 *      even on 64-bit CPUs running 32-bit Android OS!
 *   3. Publishes `latest/manifest.json` (`perAbi` exact splits + `universal` + `minSdkVersion`).
 *   4. Upserts `public.app_releases` (`is_latest = true`) and verifies HTTP 200 / 302 across every
 *      published URL before marking the build green.
 */
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SUPABASE_URL = (process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '')
  .trim()
  .replace(/\/$/, '');
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const BUCKET = 'app-releases';
const SUPABASE_MAX_UPLOAD_BYTES = 49 * 1024 * 1024; // 49 MiB safety margin below 50 MiB limit
const SIGNING_SHA256 =
  '64:20:BE:5B:CF:B5:EA:B5:D7:3A:74:BA:06:B7:94:36:FC:68:B2:69:7E:3E:63:36:16:4B:74:51:CB:15:31:DA';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.log('Skipping Supabase CDN APK publish: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(0);
}

const cliArgs = process.argv.slice(2).map((p) => path.resolve(p));
const releaseDir = path.resolve('android/app/build/outputs/apk/release');

function pickExisting(candidates) {
  for (const p of candidates) {
    if (p && fs.existsSync(p) && fs.statSync(p).size > 1_000_000) return p;
  }
  return null;
}

const arm64Path = pickExisting([
  path.resolve('hallyu-arm64-v8a.apk'),
  path.resolve('hallyu-slim.apk'),
  path.join(releaseDir, 'app-arm64-v8a-release.apk'),
  cliArgs[0],
]);
const arm32Path = pickExisting([
  path.resolve('hallyu-armeabi-v7a.apk'),
  path.join(releaseDir, 'app-armeabi-v7a-release.apk'),
  cliArgs[1],
]);
const x86_64Path = pickExisting([
  path.resolve('hallyu-x86_64.apk'),
  path.join(releaseDir, 'app-x86_64-release.apk'),
  cliArgs[2],
]);
const x86Path = pickExisting([
  path.resolve('hallyu-x86.apk'),
  path.join(releaseDir, 'app-x86-release.apk'),
  cliArgs[3],
]);
const universalPath = pickExisting([
  path.resolve('hallyu-universal.apk'),
  path.resolve('hallyu.apk'),
  path.join(releaseDir, 'app-universal-release.apk'),
  path.join(releaseDir, 'app-release.apk'),
  cliArgs[4],
]);
const armUniversalPath = pickExisting([
  path.resolve('hallyu-arm-universal.apk'),
  universalPath,
]);

if (!arm64Path || !universalPath) {
  console.error(
    `Missing required APK files (arm64=${arm64Path}, universal=${universalPath})`,
  );
  process.exit(1);
}

const runNumber = Number(process.env.GITHUB_RUN_NUMBER ?? '1');
const baseCode = Number(process.env.EXPO_PUBLIC_BUILD_NUMBER ?? String(10000 + runNumber * 10));
const versionName = (process.env.HALLYU_APP_VERSION ?? `1.0.${runNumber}`).trim();
const gitRef = process.env.SOURCE_REF ?? process.env.GITHUB_REF_NAME ?? 'main';
const repoSlug = process.env.GITHUB_REPO_SLUG ?? process.env.GITHUB_REPOSITORY ?? 'halluyapp/hallyuapp';
const releaseTag = process.env.GITHUB_RELEASE_TAG ?? `apk-${runNumber}`;

let gitCommit = process.env.SOURCE_COMMIT ?? process.env.GITHUB_SHA ?? '';
if (!gitCommit) {
  try {
    gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    gitCommit = 'unknown';
  }
}

let commitBullets = '';
try {
  const prevTag = execSync('git tag --list "apk-*" --sort=-creatordate | head -n 1', {
    encoding: 'utf8',
  }).trim();
  const range = prevTag ? `${prevTag}..HEAD` : '-n 6';
  commitBullets = execSync(`git log ${range} --no-merges --pretty=format:"• %s" | head -n 6`, {
    encoding: 'utf8',
  }).trim();
} catch {
  commitBullets = '';
}

const releaseNotes = (
  process.env.HALLYU_RELEASE_NOTES ??
  (commitBullets ||
    `Hallyu v${versionName} — universal Android ABI compatibility (ARM64, ARMv7, x86_64, x86 & 16 KB page support), verified in-place upgrades, and stability improvements.`)
).trim();

function inspectLocalApk(filePath, versionCode, ghAssetName) {
  const buf = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    filePath,
    buf,
    bytes: buf.byteLength,
    sha256,
    versionCode,
    ghUrl: `https://github.com/${repoSlug}/releases/download/${releaseTag}/${ghAssetName}`,
  };
}

const artifacts = {
  x86: x86Path ? inspectLocalApk(x86Path, baseCode + 1, 'hallyu-x86.apk') : null,
  'armeabi-v7a': arm32Path
    ? inspectLocalApk(arm32Path, baseCode + 2, 'hallyu-armeabi-v7a.apk')
    : null,
  x86_64: x86_64Path
    ? inspectLocalApk(x86_64Path, baseCode + 3, 'hallyu-x86_64.apk')
    : null,
  'arm64-v8a': inspectLocalApk(arm64Path, baseCode + 4, 'hallyu-slim.apk'),
  universal: inspectLocalApk(universalPath, baseCode + 5, 'hallyu.apk'),
  armUniversal:
    armUniversalPath && armUniversalPath !== universalPath
      ? inspectLocalApk(armUniversalPath, baseCode + 5, 'hallyu-arm-universal.apk')
      : null,
};

async function ensurePublicBucket() {
  const listRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (listRes.ok) return;

  const createRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: BUCKET,
      name: BUCKET,
      public: true,
    }),
  });
  if (!createRes.ok) {
    throw new Error(`Bucket create failed (${createRes.status}): ${await createRes.text()}`);
  }
}

async function uploadObject(objectPath, bodyBuffer, contentType, cacheControl) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'x-upsert': 'true',
    },
    body: bodyBuffer,
  });
  if (!res.ok) {
    throw new Error(`Upload ${objectPath} failed (${res.status}): ${await res.text()}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

async function verifyLiveApkUrl(label, url) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Range: 'bytes=0-15',
      'Cache-Control': 'no-cache',
    },
  });
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`Post-publish verification failed for ${label} (${url}): HTTP ${res.status}`);
  }
  const headBytes = Buffer.from(await res.arrayBuffer());
  if (headBytes.length < 4 || headBytes[0] !== 0x50 || headBytes[1] !== 0x4b) {
    throw new Error(`Post-publish ZIP magic mismatch for ${label} (${url})`);
  }
  console.log(`Verified live APK HTTP ${res.status} + PK header: ${label} -> ${url}`);
}

await ensurePublicBucket();

const publishedUrls = {};
const publishedMeta = {};

for (const key of ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86', 'universal']) {
  const art = artifacts[key];
  if (!art) continue;
  const mb = (art.bytes / (1024 * 1024)).toFixed(2);

  if (art.bytes <= SUPABASE_MAX_UPLOAD_BYTES) {
    console.log(
      `Uploading ${key} (${mb} MB, code=${art.versionCode}, sha256=${art.sha256.slice(0, 12)}…) to Supabase CDN…`,
    );
    const immutablePath = `releases/v${versionName}/hallyu-${key}.apk`;
    const latestPath = `latest/hallyu-${key}.apk`;
    const immutableUrl = await uploadObject(
      immutablePath,
      art.buf,
      'application/vnd.android.package-archive',
      'public, max-age=31536000, immutable',
    );
    const latestUrl = await uploadObject(
      latestPath,
      art.buf,
      'application/vnd.android.package-archive',
      'no-cache',
    );
    publishedUrls[key] = { immutableUrl, latestUrl };
    publishedMeta[key] = {
      url: immutableUrl,
      latestUrl,
      githubUrl: art.ghUrl,
      sha256: art.sha256,
      sizeBytes: art.bytes,
      versionCode: art.versionCode,
    };
  } else if (key === 'universal' && artifacts.armUniversal && artifacts.armUniversal.bytes <= SUPABASE_MAX_UPLOAD_BYTES) {
    const fallbackArt = artifacts.armUniversal;
    const fbMb = (fallbackArt.bytes / (1024 * 1024)).toFixed(2);
    console.log(
      `4-ABI universal is ${mb} MB (> 49 MB Supabase cap) — uploading ${fbMb} MB Dual-ARM (arm64-v8a + armeabi-v7a) universal APK directly to public Supabase CDN so public downloads never hit private GitHub URLs!`,
    );
    const immutablePath = `releases/v${versionName}/hallyu-universal.apk`;
    const latestPath = `latest/hallyu-universal.apk`;
    const immutableUrl = await uploadObject(
      immutablePath,
      fallbackArt.buf,
      'application/vnd.android.package-archive',
      'public, max-age=31536000, immutable',
    );
    const latestUrl = await uploadObject(
      latestPath,
      fallbackArt.buf,
      'application/vnd.android.package-archive',
      'no-cache',
    );
    publishedUrls[key] = { immutableUrl, latestUrl };
    publishedMeta[key] = {
      url: immutableUrl,
      latestUrl,
      githubUrl: art.ghUrl,
      sha256: fallbackArt.sha256,
      sizeBytes: fallbackArt.bytes,
      versionCode: fallbackArt.versionCode,
    };
  } else {
    console.log(
      `Artifact ${key} is ${mb} MB (> 49 MB Supabase cap) — serving directly via verified GitHub Releases global CDN (${art.ghUrl}).`,
    );
    publishedUrls[key] = { immutableUrl: art.ghUrl, latestUrl: art.ghUrl };
    publishedMeta[key] = {
      url: art.ghUrl,
      latestUrl: art.ghUrl,
      githubUrl: art.ghUrl,
      sha256: art.sha256,
      sizeBytes: art.bytes,
      versionCode: art.versionCode,
    };
  }
}

// Bridge `latest/hallyu-arm64.apk` + `manifest.abis['arm64-v8a']` for legacy installs (`v1.0.201`–`v1.0.218`):
// Use full 4-ABI `universal` if <= 49 MB, otherwise `armUniversal` (dual ARM64 + ARMv7, ~26 MB),
// so BOTH 64-bit ARM phones AND 64-bit CPUs running 32-bit Android OS upgrade seamlessly!
const bridgeArt =
  artifacts.universal.bytes <= SUPABASE_MAX_UPLOAD_BYTES
    ? artifacts.universal
    : artifacts.armUniversal ?? artifacts['arm64-v8a'];

const legacyBridgeUrl = await uploadObject(
  'latest/hallyu-arm64.apk',
  bridgeArt.buf,
  'application/vnd.android.package-archive',
  'no-cache',
);
publishedUrls.legacyArm64Bridge = { latestUrl: legacyBridgeUrl };

const perAbi = {};
for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86', 'universal']) {
  const m = publishedMeta[abi];
  if (!m) continue;
  perAbi[abi] = {
    url: m.url,
    latestUrl: m.latestUrl,
    githubUrl: m.githubUrl,
    sha256: m.sha256,
    sizeBytes: m.sizeBytes,
    versionCode: m.versionCode,
  };
}

const legacyCompatAbis = {
  ...perAbi,
  'arm64-v8a': {
    url: legacyBridgeUrl,
    latestUrl: legacyBridgeUrl,
    sha256: bridgeArt.sha256,
    sizeBytes: bridgeArt.bytes,
    versionCode: bridgeArt.versionCode,
  },
};

const manifest = {
  packageName: 'com.hallyu.app',
  versionCode: artifacts.universal.versionCode,
  versionName,
  minSdkVersion: 23,
  targetSdkVersion: 34,
  pageSizeAlignedBytes: 16384,
  extractNativeLibs: true,
  gitCommit: gitCommit.slice(0, 7),
  gitCommitFull: gitCommit,
  gitRef,
  apkUrl: perAbi.universal.url,
  universalApkUrl: perAbi.universal.url,
  arm64ApkUrl: perAbi['arm64-v8a'].url,
  arm32ApkUrl: perAbi['armeabi-v7a']?.url ?? perAbi.universal.url,
  x86_64ApkUrl: perAbi.x86_64?.url ?? perAbi.universal.url,
  x86ApkUrl: perAbi.x86?.url ?? perAbi.universal.url,
  perAbi,
  abis: legacyCompatAbis,
  fileSizeBytes: perAbi['arm64-v8a'].sizeBytes,
  universalSizeBytes: perAbi.universal.sizeBytes,
  sha256: perAbi.universal.sha256,
  signingCertSha256: SIGNING_SHA256,
  releaseNotes,
  publishedAt: new Date().toISOString(),
};

const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
await uploadObject('latest/manifest.json', manifestBuf, 'application/json', 'no-cache');
await uploadObject(
  `releases/v${versionName}/manifest.json`,
  manifestBuf,
  'application/json',
  'public, max-age=31536000, immutable',
);

// Verify every single published URL returns HTTP 200/206 + valid ZIP `PK` magic bytes!
for (const [abi, entry] of Object.entries(perAbi)) {
  await verifyLiveApkUrl(abi, entry.url);
}
await verifyLiveApkUrl('legacy-arm64-bridge', legacyBridgeUrl);

const markOldRes = await fetch(`${SUPABASE_URL}/rest/v1/app_releases?is_latest=eq.true`, {
  method: 'PATCH',
  headers: {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  },
  body: JSON.stringify({ is_latest: false }),
});
if (!markOldRes.ok) {
  console.warn('Warning clearing old is_latest flags:', await markOldRes.text());
}

const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/app_releases?on_conflict=version_code`, {
  method: 'POST',
  headers: {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=representation',
  },
  body: JSON.stringify({
    version_code: artifacts.universal.versionCode,
    version_name: versionName,
    git_commit: gitCommit.slice(0, 7),
    git_ref: gitRef,
    apk_url: legacyBridgeUrl,
    universal_apk_url: perAbi.universal.url,
    file_size_bytes: perAbi['arm64-v8a'].sizeBytes,
    sha256: bridgeArt.sha256,
    signing_cert_sha256: SIGNING_SHA256,
    release_notes: releaseNotes,
    is_latest: true,
  }),
});
if (!insertRes.ok) {
  throw new Error(`Insert app_releases failed (${insertRes.status}): ${await insertRes.text()}`);
}

console.log(`Published release v${versionName} (build ${artifacts.universal.versionCode}) to app_releases.`);

const notifyTitle = `Hallyu v${versionName} is Ready`;
const notifyBody = `Tap to update in 1 tap: ${releaseNotes.split('\n')[0].replace(/^•\s*/, '')}`;

const membersRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id&limit=1000`, {
  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
});
if (membersRes.ok) {
  const members = await membersRes.json();
  if (Array.isArray(members) && members.length > 0) {
    const rows = members.map((m) => ({
      user_id: m.id,
      kind: 'system_release',
      title: notifyTitle,
      body: notifyBody,
      deep_link: '/settings/updates',
    }));
    await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows),
    });
    console.log(`Delivered in-app release alert to ${members.length} members.`);
  }
}

try {
  const pushRes = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      broadcast: true,
      title: notifyTitle,
      body: notifyBody,
      path: '/settings/updates',
    }),
  });
  console.log('Release push broadcast status:', pushRes.status);
} catch (err) {
  console.warn('Release push broadcast non-fatal warning:', err);
}
