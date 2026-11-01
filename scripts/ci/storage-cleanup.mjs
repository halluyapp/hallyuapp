/**
 * One-off, dispatch-only storage recovery for the public `app-releases` bucket.
 *
 * Modes (env CLEANUP_MODE):
 *   dry-run (default) - inventories the bucket, verifies the bytes, prints the plan. Writes nothing.
 *   apply             - performs the plan in verified steps (see `main`).
 *
 * Scope is strictly `app-releases`. The `media` bucket, database tables, auth and the
 * Hallyu TV streaming path are never touched. Only the universal APK is kept per release.
 */
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BUCKET = 'app-releases';
const CURRENT_VERSION = '1.0.291';
const PREVIOUS_VERSION = '1.0.289';
const CURRENT_UNIVERSAL_SHA256 = 'd9d4224c206c495221cd4d60cf6df65986b92ec9c0d5787ee20e83602f7b3f0d';
const CURRENT_UNIVERSAL_BYTES = 39750307;
const GITHUB_ASSET_BASE = 'https://github.com/halluyapp/hallyuapp/releases/download';

/** Per-ABI APKs that are no longer served from Supabase. Hallyu ships to phones via the universal APK. */
const PER_ABI_LATEST = /^latest\/hallyu-(arm64-v8a|armeabi-v7a|x86_64|x86)\.apk$/;
const KEEP_IN_RELEASE_FOLDER = /^hallyu-universal\.apk$|\.json$/;
const RELEASE_FOLDER = /^releases\/(v\d+\.\d+\.\d+)\/(.+)$/;

/** Paths that must always survive, whatever else the plan says. */
export const PROTECTED_PATHS = [
  `releases/v${CURRENT_VERSION}/hallyu-universal.apk`,
  `releases/v${PREVIOUS_VERSION}/hallyu-universal.apk`,
  'latest/hallyu-universal.apk',
  'latest/hallyu-arm64.apk',
  'latest/manifest.json',
];

/**
 * Pure planner. `objects` is a flat list of `{ path, bytes }` for every file in the bucket.
 * Returns the paths to delete and aborts (reason set) if the protected set is incomplete.
 */
export function planDeletions(objects, { currentVersion = CURRENT_VERSION, previousVersion = PREVIOUS_VERSION } = {}) {
  const paths = new Set(objects.map((o) => o.path));
  const missing = PROTECTED_PATHS.filter((p) => !paths.has(p));
  if (missing.length > 0) {
    return { deletes: [], keep: [], reason: `protected object(s) missing, nothing deleted: ${missing.join(', ')}` };
  }
  const keepFolders = new Set([`v${currentVersion}`, `v${previousVersion}`]);
  const deletes = [];
  const keep = [];
  for (const { path } of objects) {
    if (PROTECTED_PATHS.includes(path)) {
      keep.push(path);
      continue;
    }
    if (PER_ABI_LATEST.test(path)) {
      deletes.push(path);
      continue;
    }
    const m = RELEASE_FOLDER.exec(path);
    if (m) {
      const [, folder, file] = m;
      if (!keepFolders.has(folder) || !KEEP_IN_RELEASE_FOLDER.test(file)) {
        deletes.push(path);
      } else {
        keep.push(path);
      }
      continue;
    }
    keep.push(path);
  }
  return { deletes: deletes.sort(), keep: keep.sort(), reason: null };
}

/** Manifest rewrite: every per-ABI entry (and the *ApkUrl fields) points at the universal APK. */
export function rewriteManifestToUniversal(manifest) {
  const universal = manifest?.perAbi?.universal;
  if (!universal?.url || !universal?.sha256) throw new Error('manifest has no perAbi.universal url/sha256');
  const next = JSON.parse(JSON.stringify(manifest));
  const uni = { ...universal, latestUrl: universal.latestUrl ?? universal.url };
  for (const key of Object.keys(next.perAbi)) {
    if (key === 'universal') continue;
    next.perAbi[key] = { ...uni, versionCode: next.perAbi[key]?.versionCode ?? uni.versionCode };
  }
  if (next.abis) {
    for (const key of Object.keys(next.abis)) {
      if (key === 'arm64-v8a') continue; // legacy bridge stays at latest/hallyu-arm64.apk, which is kept
      next.abis[key] = { ...uni, versionCode: next.abis[key]?.versionCode ?? uni.versionCode };
    }
  }
  for (const field of ['arm64ApkUrl', 'arm32ApkUrl', 'x86_64ApkUrl', 'x86ApkUrl']) {
    next[field] = universal.url;
  }
  return next;
}

/** Every manifest URL must be the universal URL (or the kept legacy bridge for `abis['arm64-v8a']`). */
export function verifyManifestUrls(manifest, universalUrl) {
  const bad = [];
  for (const [key, entry] of Object.entries(manifest.perAbi ?? {})) {
    if (entry.url !== universalUrl) bad.push(`perAbi.${key}`);
  }
  for (const field of ['arm64ApkUrl', 'arm32ApkUrl', 'x86_64ApkUrl', 'x86ApkUrl']) {
    if (manifest[field] !== universalUrl) bad.push(field);
  }
  return bad;
}

function publicUrl(path) {
  return `${process.env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/${path}`;
}

async function sha256Of(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

function authHeaders() {
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  return { apikey: key, Authorization: `Bearer ${key}` };
}

/** Lists every file under `prefix`, recursing into folders (Supabase reports folders with id === null). */
async function listAll(prefix) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const out = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(`${base}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!res.ok) throw new Error(`list ${prefix} failed (${res.status})`);
    const items = (await res.json()) ?? [];
    for (const item of items) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null) out.push(...(await listAll(path)));
      else out.push({ path, bytes: Number(item.metadata?.size ?? 0) });
    }
    if (items.length < 1000) break;
    offset += 1000;
  }
  return out;
}

async function removePaths(paths) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const res = await fetch(`${base}/storage/v1/object/${BUCKET}`, {
      method: 'DELETE',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: chunk }),
    });
    if (!res.ok) throw new Error(`delete batch failed (${res.status})`);
    console.log(`deleted ${chunk.length} object(s)`);
  }
}

async function uploadJson(path, body) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'x-upsert': 'true',
    },
    body,
  });
  if (!res.ok) throw new Error(`upload ${path} failed (${res.status})`);
}

async function fetchManifest() {
  const res = await fetch(`${publicUrl('latest/manifest.json')}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`manifest fetch failed (${res.status})`);
  return { text: await res.text() };
}

function report(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function mib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  const mode = (process.env.CLEANUP_MODE || 'dry-run').trim();
  if (mode !== 'dry-run' && mode !== 'apply') throw new Error(`unknown CLEANUP_MODE "${mode}"`);
  report(`## app-releases cleanup (${mode})`);

  // 1. Inventory.
  const objects = [...(await listAll('latest')), ...(await listAll('releases'))];
  const total = objects.reduce((s, o) => s + o.bytes, 0);
  report(`Inventory: ${objects.length} object(s), ${mib(total)}`);

  // 2. Verify the universal bytes that will be kept, against the database sha and the GitHub asset.
  const uni = await sha256Of(publicUrl(`releases/v${CURRENT_VERSION}/hallyu-universal.apk`));
  if (uni.sha256 !== CURRENT_UNIVERSAL_SHA256 || uni.bytes !== CURRENT_UNIVERSAL_BYTES) {
    throw new Error(`universal v${CURRENT_VERSION} mismatch: ${uni.sha256} ${uni.bytes} bytes`);
  }
  report(`Verified releases/v${CURRENT_VERSION}/hallyu-universal.apk: sha256 and size match.`);
  const gh = await sha256Of(`${GITHUB_ASSET_BASE}/apk-291/hallyu.apk`);
  if (gh.sha256 !== CURRENT_UNIVERSAL_SHA256) throw new Error('GitHub apk-291 hallyu.apk does not match');
  report('Verified GitHub apk-291/hallyu.apk is byte-identical (sha256).');

  // 3. Plan.
  const plan = planDeletions(objects);
  if (plan.reason) throw new Error(plan.reason);
  const freed = objects.filter((o) => plan.deletes.includes(o.path)).reduce((s, o) => s + o.bytes, 0);
  report(`Plan: delete ${plan.deletes.length} object(s), free ${mib(freed)}; keep ${plan.keep.length} object(s).`);
  for (const p of plan.deletes) report(`  - ${p}`);

  if (mode === 'dry-run') {
    report('Dry run: nothing changed.');
    return;
  }

  // 4. Apply, in order. Each step is verified before the next one runs.
  const manifestRes = await fetchManifest();
  const manifest = JSON.parse(manifestRes.text);
  if (manifest?.perAbi?.universal?.sha256 !== CURRENT_UNIVERSAL_SHA256) {
    throw new Error('live manifest universal sha256 does not match expected; aborting before any change');
  }
  const next = rewriteManifestToUniversal(manifest);
  const universalUrl = publicUrl(`releases/v${CURRENT_VERSION}/hallyu-universal.apk`);
  const body = JSON.stringify(next, null, 2);
  await uploadJson('latest/manifest.json', body);
  const check = JSON.parse((await fetchManifest()).text);
  const bad = verifyManifestUrls(check, universalUrl);
  if (bad.length > 0) throw new Error(`manifest rewrite did not stick: ${bad.join(', ')}`);
  report('Step 1: manifest now points every ABI at the universal APK (verified).');

  const deletes = plan.deletes;
  await removePaths(deletes);
  const after = await listAll('');
  const afterPaths = new Set(after.map((o) => o.path));
  for (const p of PROTECTED_PATHS) {
    if (!afterPaths.has(p)) throw new Error(`protected object disappeared after delete: ${p}`);
  }
  const remaining = after.reduce((s, o) => s + o.bytes, 0);
  report(`Step 2: removed ${deletes.length} object(s). Bucket now ${mib(remaining)} (${after.length} object(s)).`);

  const liveCheck = await sha256Of(universalUrl);
  if (liveCheck.sha256 !== CURRENT_UNIVERSAL_SHA256) throw new Error('post-delete universal check failed');
  report('Step 3: live universal APK still verifies after deletion.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    const msg = String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 500);
    console.error(`storage cleanup failed: ${msg}`);
    console.log(`::error title=storage cleanup failed::${msg}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `FAILED: ${msg}\n`);
    process.exitCode = 1;
  });
}
