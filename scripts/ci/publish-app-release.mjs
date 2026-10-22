#!/usr/bin/env node
/**
 * Publishes freshly verified signed APKs (`hallyu-arm64.apk` + `hallyu-universal.apk`) to public
 * Supabase Storage bucket `app-releases/latest/` AND registers the release metadata row in
 * `public.app_releases` so both the Web Landing Page and In-App Self-Updater (`get_latest_app_release`)
 * serve the exact latest build automatically.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';

const supabaseUrl = (process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '')
  .trim()
  .replace(/\/$/, '');
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const slimPath = process.argv[2] || 'hallyu-slim.apk';
const universalPath = process.argv[3] || 'hallyu.apk';
const versionCode = Number.parseInt(process.env.HALLYU_SLIM_VERSION_CODE ?? '10004', 10);
const versionName = (process.env.HALLYU_APP_VERSION ?? '1.0.0').trim();
const commit = (process.env.SOURCE_SHORT ?? '').trim();

if (!supabaseUrl || !serviceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for CDN release upload.');
  process.exit(1);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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

const slimBytes = fs.readFileSync(slimPath);
const univBytes = fs.readFileSync(universalPath);
const slimSha256 = sha256File(slimPath);
const universalSha256 = sha256File(universalPath);
const slimSizeMb = Number((slimBytes.byteLength / (1024 * 1024)).toFixed(1));
const universalSizeMb = Number((univBytes.byteLength / (1024 * 1024)).toFixed(1));

const slimPublicUrl = `${supabaseUrl}/storage/v1/object/public/app-releases/latest/hallyu-arm64.apk`;
const universalPublicUrl = `${supabaseUrl}/storage/v1/object/public/app-releases/latest/hallyu-universal.apk`;

console.log(`Uploading latest/hallyu-arm64.apk (${slimSizeMb} MB, sha256=${slimSha256.slice(0, 16)}…)`);
await uploadObject(
  'latest/hallyu-arm64.apk',
  slimBytes,
  'application/vnd.android.package-archive',
  'public, max-age=300',
);

console.log(
  `Uploading latest/hallyu-universal.apk (${universalSizeMb} MB, sha256=${universalSha256.slice(0, 16)}…)`,
);
await uploadObject(
  'latest/hallyu-universal.apk',
  univBytes,
  'application/vnd.android.package-archive',
  'public, max-age=300',
);

const releaseNotes = `Signed release #${versionCode} (${commit || 'latest'}): Social-First Home Feed, Live Watch Parties & Prediction Polls, 24/7 Live Push Engine, and Pure 2025/2026 Explore Rankings.`;

const manifest = {
  version: versionName,
  versionCode,
  slimUrl: slimPublicUrl,
  universalUrl: universalPublicUrl,
  slimSha256,
  universalSha256,
  slimSizeMb,
  universalSizeMb,
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

// Register active release in public.app_releases so in-app `get_latest_app_release()` serves it live
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
    universal_apk_url: universalPublicUrl,
    sha256: slimSha256,
    file_size_bytes: slimBytes.byteLength,
    release_notes: releaseNotes,
    is_mandatory: false,
    min_supported_version: 1,
    git_commit: commit || null,
    is_active: true,
  }),
});

if (!dbRes.ok) {
  console.warn(`Warning: app_releases table upsert status ${dbRes.status}: ${await dbRes.text()}`);
} else {
  console.log(`Registered build #${versionCode} in public.app_releases!`);
}

console.log('Published signed Slim + Universal APKs + manifest + DB record cleanly!');
