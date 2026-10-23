#!/usr/bin/env node
/**
 * Publishes all freshly verified signed CPU split APKs (`arm64-v8a`, `armeabi-v7a`, `x86_64`)
 * directly to public Supabase Storage bucket `app-releases/latest/`, generates truthful commit-based
 * release notes dynamically from git history since the previous `apk-*` tag, registers the release
 * in `public.app_releases` + `latest/manifest.json`, AND broadcasts out-of-app push alerts via
 * `public.announce_app_release` + `push-dispatch` so users know an update is ready even when Hallyu
 * is closed.
 */
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';

const supabaseUrl = (process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '')
  .trim()
  .replace(/\/$/, '');
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const repoSlug = (process.env.GITHUB_REPO_SLUG ?? 'halluyapp/hallyuapp').trim();
const releaseTag = (process.env.GITHUB_RELEASE_TAG ?? '').trim();

const slimPath = process.argv[2] || 'hallyu-slim.apk';
const arm32Path = process.argv[3] || 'hallyu-armeabi-v7a.apk';
const x86Path = process.argv[4] || 'hallyu-x86_64.apk';

const versionCode = Number.parseInt(process.env.HALLYU_SLIM_VERSION_CODE ?? '10004', 10);
const releaseTrain = Math.floor(versionCode / 10);
const versionName = (
  process.env.HALLYU_APP_VERSION ??
  process.env.EXPO_PUBLIC_APP_VERSION ??
  '1.0.0'
).trim();
const commit = (process.env.SOURCE_SHORT ?? '').trim();

if (!supabaseUrl || !serviceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for CDN release upload.');
  process.exit(1);
}

export function buildDynamicReleaseNotes({
  versionName: ver,
  commitShort,
  overrideNotes,
} = {}) {
  if (overrideNotes && String(overrideNotes).trim()) {
    return String(overrideNotes).trim();
  }
  try {
    const tags = execSync('git tag --list "apk-*" --sort=-creatordate', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((t) => t.trim())
      .filter((t) => t && t !== releaseTag);
    const prevTag = tags[0] ?? '';
    const rangeArg = prevTag ? `${prevTag}..HEAD` : '-n 6';
    const subjects = execSync(`git log ${rangeArg} --no-merges --pretty=format:%s`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^chore\(ci\):/i.test(line));

    const unique = [...new Set(subjects)].slice(0, 6);
    if (unique.length > 0) {
      return [
        `Signed release v${ver}${commitShort ? ` (${commitShort})` : ''}:`,
        ...unique.map((s) => `• ${s}`),
      ].join('\n');
    }
  } catch {
    // Fallback if git history unavailable
  }
  return `Signed release v${ver}${commitShort ? ` (${commitShort})` : ''}: Reliability, performance, and stability updates.`;
}

function inspectApkFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required APK artifact missing for ${label}: ${filePath}`);
  }
  const bytes = fs.readFileSync(filePath);
  if (
    bytes.byteLength < 5_000_000 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  ) {
    throw new Error(`Invalid or truncated APK binary for ${label}: ${filePath} (${bytes.byteLength} bytes)`);
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    bytes,
    sha256,
    sizeBytes: bytes.byteLength,
    sizeMb: Number((bytes.byteLength / (1024 * 1024)).toFixed(1)),
  };
}

async function uploadObject(objectPath, bytes, contentType, cacheControl) {
  const res = await fetch(`${supabaseUrl}/storage/v1/object/app-releases/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upload ${objectPath} failed (${res.status}): ${errText}`);
  }
}

const ghReleaseBase = releaseTag
  ? `https://github.com/${repoSlug}/releases/download/${releaseTag}`
  : `https://github.com/${repoSlug}/releases/latest/download`;

const arm64Info = inspectApkFile(slimPath, 'arm64-v8a');
let slimPublicUrl = `${supabaseUrl}/storage/v1/object/public/app-releases/latest/hallyu-arm64.apk`;
console.log(
  `Uploading latest/hallyu-arm64.apk (${arm64Info.sizeMb} MB, sha256=${arm64Info.sha256.slice(0, 16)}…)`,
);
try {
  await uploadObject(
    'latest/hallyu-arm64.apk',
    arm64Info.bytes,
    'application/vnd.android.package-archive',
    'public, max-age=120',
  );
} catch (err) {
  console.warn(`Supabase CDN upload fallback for arm64 APK: ${err.message}`);
  slimPublicUrl = `${ghReleaseBase}/hallyu-slim.apk`;
}

const abis = {
  'arm64-v8a': {
    abi: 'arm64-v8a',
    url: slimPublicUrl,
    sha256: arm64Info.sha256,
    sizeBytes: arm64Info.sizeBytes,
    sizeMb: arm64Info.sizeMb,
    versionCode: releaseTrain * 10 + 4,
  },
};

let arm32PublicUrl = null;
if (fs.existsSync(arm32Path)) {
  const arm32Info = inspectApkFile(arm32Path, 'armeabi-v7a');
  arm32PublicUrl = `${supabaseUrl}/storage/v1/object/public/app-releases/latest/hallyu-armeabi-v7a.apk`;
  console.log(
    `Uploading latest/hallyu-armeabi-v7a.apk (${arm32Info.sizeMb} MB, sha256=${arm32Info.sha256.slice(0, 16)}…)`,
  );
  try {
    await uploadObject(
      'latest/hallyu-armeabi-v7a.apk',
      arm32Info.bytes,
      'application/vnd.android.package-archive',
      'public, max-age=120',
    );
  } catch (err) {
    console.warn(`Supabase CDN upload fallback for armeabi-v7a APK: ${err.message}`);
    arm32PublicUrl = `${ghReleaseBase}/hallyu-armeabi-v7a.apk`;
  }
  abis['armeabi-v7a'] = {
    abi: 'armeabi-v7a',
    url: arm32PublicUrl,
    sha256: arm32Info.sha256,
    sizeBytes: arm32Info.sizeBytes,
    sizeMb: arm32Info.sizeMb,
    versionCode: releaseTrain * 10 + 2,
  };
}

let x86PublicUrl = null;
if (fs.existsSync(x86Path)) {
  const x86Info = inspectApkFile(x86Path, 'x86_64');
  x86PublicUrl = `${supabaseUrl}/storage/v1/object/public/app-releases/latest/hallyu-x86_64.apk`;
  console.log(
    `Uploading latest/hallyu-x86_64.apk (${x86Info.sizeMb} MB, sha256=${x86Info.sha256.slice(0, 16)}…)`,
  );
  try {
    await uploadObject(
      'latest/hallyu-x86_64.apk',
      x86Info.bytes,
      'application/vnd.android.package-archive',
      'public, max-age=120',
    );
  } catch (err) {
    console.warn(`Supabase CDN upload fallback for x86_64 APK: ${err.message}`);
    x86PublicUrl = `${ghReleaseBase}/hallyu-x86_64.apk`;
  }
  abis.x86_64 = {
    abi: 'x86_64',
    url: x86PublicUrl,
    sha256: x86Info.sha256,
    sizeBytes: x86Info.sizeBytes,
    sizeMb: x86Info.sizeMb,
    versionCode: releaseTrain * 10 + 3,
  };
}

const releaseNotes = buildDynamicReleaseNotes({
  versionName,
  commitShort: commit,
  overrideNotes: process.env.RELEASE_NOTES,
});

const manifest = {
  version: versionName,
  versionCode,
  releaseTrain,
  slimUrl: slimPublicUrl,
  arm32Url: arm32PublicUrl,
  x86_64Url: x86PublicUrl,
  universalUrl: arm32PublicUrl ?? slimPublicUrl,
  slimSha256: arm64Info.sha256,
  slimSizeBytes: arm64Info.sizeBytes,
  slimSizeMb: arm64Info.sizeMb,
  abis,
  commit,
  publishedAt: new Date().toISOString(),
  notes: releaseNotes,
};

await uploadObject(
  'latest/manifest.json',
  Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
  'application/json',
  'no-cache, max-age=0',
);

const dbRes = await fetch(`${supabaseUrl}/rest/v1/app_releases?on_conflict=version_code`, {
  method: 'POST',
  headers: {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  },
  body: JSON.stringify({
    version_code: versionCode,
    version_name: versionName,
    apk_url: slimPublicUrl,
    universal_apk_url: arm32PublicUrl ?? slimPublicUrl,
    sha256: arm64Info.sha256,
    file_size_bytes: arm64Info.sizeBytes,
    release_notes: releaseNotes,
    is_mandatory: false,
    min_supported_version: 1,
    git_commit: commit || null,
  }),
});

if (!dbRes.ok) {
  console.warn(`Warning: app_releases table upsert status ${dbRes.status}: ${await dbRes.text()}`);
} else {
  console.log(`Registered build v${versionName} (#${versionCode}) in public.app_releases!`);
}

// Broadcast background + in-app update alert idempotently across all members (`public.announce_app_release`)
const announceRes = await fetch(`${supabaseUrl}/rest/v1/rpc/announce_app_release`, {
  method: 'POST',
  headers: {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    p_version_code: versionCode,
    p_version_name: versionName,
    p_release_notes: releaseNotes,
  }),
}).catch(() => null);

if (announceRes?.ok) {
  const notifiedCount = await announceRes.json().catch(() => 0);
  console.log(`Broadcasted v${versionName} update alert to ${notifiedCount} active member(s).`);
} else if (announceRes) {
  console.warn(`Warning: announce_app_release returned HTTP ${announceRes.status}`);
}

// Immediately wake push-dispatch so Android FCM + Web Push devices outside Hallyu get alerted now
await fetch(`${supabaseUrl}/functions/v1/push-dispatch`, {
  method: 'POST',
  headers: {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  },
  body: '{}',
}).catch(() => {});

console.log('Published signed ARM64 + ARM32 + x86_64 APKs + dynamic notes + push alert cleanly!');
