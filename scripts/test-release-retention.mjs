// Release retention and universal-only publishing. Run: node --test scripts/test-release-retention.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { folderFromUrl, planRetention, retentionDryRun } from './ci/release-retention.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publishSource = fs.readFileSync(path.join(ROOT, 'scripts/ci/publish-app-release.mjs'), 'utf8');

const url = (v, file = 'hallyu-universal.apk') =>
  `https://kzxlbscfkixnswurpkzb.supabase.co/storage/v1/object/public/app-releases/releases/v${v}/${file}`;

const releases = [
  { version_name: '1.0.291', version_code: 12915, universal_apk_url: url('1.0.291'), apk_url: 'https://x/latest/hallyu-arm64.apk' },
  { version_name: '1.0.289', version_code: 12895, universal_apk_url: url('1.0.289'), apk_url: 'https://x/latest/hallyu-arm64.apk' },
  { version_name: '1.0.282', version_code: 12825, universal_apk_url: url('1.0.282'), apk_url: null },
  { version_name: '1.0.269', version_code: 12695, universal_apk_url: url('1.0.269'), apk_url: null },
];
const folders = ['v1.0.269', 'v1.0.282', 'v1.0.289', 'v1.0.291'];

test('folderFromUrl reads the version folder from a release URL and nothing else', () => {
  assert.equal(folderFromUrl(url('1.0.291')), 'v1.0.291');
  assert.equal(folderFromUrl('https://x/latest/hallyu-arm64.apk'), null);
  assert.equal(folderFromUrl(null), null);
});

test('retention keeps the current release and the previous stable release', () => {
  const plan = planRetention({ folders: ['v1.0.289', 'v1.0.291'], currentVersion: '1.0.291', releases: releases.slice(0, 2) });
  assert.deepEqual(plan.keep, ['v1.0.289', 'v1.0.291']);
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.reason, null);
});

test('retention keeps an old folder while a release row still references it', () => {
  // all four rows present: 1.0.282 and 1.0.269 are referenced, so they stay until their rows are repointed
  const plan = planRetention({ folders, currentVersion: '1.0.291', releases });
  assert.deepEqual(plan.remove, []);
  assert.ok(plan.keep.includes('v1.0.282') && plan.keep.includes('v1.0.269'));
});

test('retention removes an unreferenced old folder', () => {
  const unreferenced = releases.slice(0, 2); // rows for 1.0.291 and 1.0.289 only
  const plan = planRetention({ folders, currentVersion: '1.0.291', releases: unreferenced });
  assert.deepEqual(plan.remove, ['v1.0.269', 'v1.0.282']);
  assert.ok(plan.keep.includes('v1.0.291') && plan.keep.includes('v1.0.289'));
});

test('retention refuses to delete anything when the current folder is missing', () => {
  const plan = planRetention({ folders: ['v1.0.269'], currentVersion: '1.0.291', releases });
  assert.deepEqual(plan.remove, []);
  assert.match(plan.reason, /current folder v1\.0\.291 is missing/);
});

test('retention never touches folders it does not recognise', () => {
  const plan = planRetention({
    folders: ['v1.0.291', 'v1.0.100', 'manifests', 'v1.0.289-beta', 'tmp'],
    currentVersion: '1.0.291',
    releases: [releases[0]],
  });
  assert.deepEqual(plan.remove, ['v1.0.100']);
});

test('retention refuses invalid input rather than guessing', () => {
  assert.deepEqual(planRetention({ folders: null, currentVersion: '1.0.291', releases }).remove, []);
  assert.deepEqual(planRetention({ folders, currentVersion: 291, releases }).remove, []);
});

test('retention is a dry run unless HALLYU_RETENTION_APPLY=1 is set', () => {
  assert.equal(retentionDryRun({}), true);
  assert.equal(retentionDryRun({ HALLYU_RETENTION_APPLY: '0' }), true);
  assert.equal(retentionDryRun({ HALLYU_RETENTION_APPLY: 'yes' }), true);
  assert.equal(retentionDryRun({ HALLYU_RETENTION_APPLY: '1' }), false);
});

test('CI verifies that the public APK bytes are the newly built release', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/build-apk.yml'), 'utf8');
  assert.match(workflow, /EXPECTED_SHA256: \$\{\{ steps\.meta\.outputs\.sha256 \}\}/);
  assert.match(workflow, /sha256sum -c -/);
  assert.match(workflow, /ACTUAL_SIZE=\$\(stat -c%s \/tmp\/hallyu-published\.apk\)/);
});

test('release worker uses GitHub OIDC and the Storage API, retaining only the stable APK', () => {
  const worker = fs.readFileSync(path.join(ROOT, 'supabase/functions/release-maintenance/index.ts'), 'utf8');
  const auth = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/githubActions.ts'), 'utf8');
  const migration = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261111150000_66_login_engagement_catalog_and_release_repairs.sql'), 'utf8');
  assert.match(migration, /drop trigger if exists app_releases_prune_trg on storage\.objects/);
  assert.match(worker, /verifyGitHubActionsToken\(token, repository\)/);
  assert.match(worker, /const current = await fetch\([^\n]+\{ method: 'HEAD'/);
  assert.match(worker, /entry\.name\.toLowerCase\(\)\.endsWith\('\.apk'\)/);
  assert.match(worker, /const obsolete = names\.filter\(\(name\) => name !== KEEP\)/);
  assert.match(worker, /adminClient\(\)\.storage\.from\(BUCKET\)\.remove\(obsolete\)/);
  assert.match(worker, /remaining\.length\) return jsonResponse/);
  assert.ok(auth.includes('payload.job_workflow_ref'));
  assert.ok(auth.includes('.github/workflows/build-apk.yml'));
  assert.ok(auth.includes("crypto.subtle.verify('RSASSA-PKCS1-v1_5'"));
  assert.ok(auth.includes("['push', 'workflow_dispatch'].includes(String(payload.event_name))"));
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/build-apk.yml'), 'utf8');
  assert.ok(workflow.includes('/functions/v1/release-maintenance'));
  assert.ok(workflow.includes('id-token: write'));
});

test('publisher uploads only the universal APK to Supabase and points every ABI at it', () => {
  assert.match(publishSource, /const SUPABASE_PUBLISHED_KEYS = new Set\(\['universal'\]\)/);
  assert.match(publishSource, /if \(!SUPABASE_PUBLISHED_KEYS\.has\(key\)\) \{/);
  assert.match(publishSource, /if \(!perAbi\[abi\]\) perAbi\[abi\] = \{ \.\.\.perAbi\.universal \};/);
  assert.match(publishSource, /file_size_bytes: perAbi\.universal\.sizeBytes,/);
  assert.doesNotMatch(publishSource, /file_size_bytes: perAbi\['arm64-v8a'\]/);
});

test('retention runs only after the release row is written, and its failure cannot fail the release', () => {
  const insertAt = publishSource.indexOf('/rest/v1/app_releases?on_conflict=version_code');
  const retentionAt = publishSource.indexOf('await applyRetention();');
  assert.ok(insertAt > 0 && retentionAt > insertAt, 'retention must come after the app_releases insert');
  assert.match(publishSource, /Retention step failed; the release is unaffected/);
});
