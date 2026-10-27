// Unit checks for lib/deviceTimeZone.ts: a locale is never accepted as a time zone, and a valid
// IANA zone is accepted. Runs under plain `node --test`; the TypeScript is transpiled on the fly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 } }).outputText;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hallyu-tz-'));
  const file = path.join(dir, path.basename(rel).replace(/\.ts$/, '.mjs'));
  fs.writeFileSync(file, out);
  return import(pathToFileURL(file).href);
}

const tz = await load('lib/deviceTimeZone.ts');

test('a locale is never accepted as a time zone', () => {
  assert.equal(tz.normalizeTimeZone('en-NG'), null);
  assert.equal(tz.normalizeTimeZone('en-US'), null);
  assert.equal(tz.normalizeTimeZone('zh-Hant-TW'), null);
});

test('valid IANA zones are accepted unchanged', () => {
  assert.equal(tz.normalizeTimeZone('Africa/Lagos'), 'Africa/Lagos');
  assert.equal(tz.normalizeTimeZone('America/New_York'), 'America/New_York');
  assert.equal(tz.normalizeTimeZone('America/Argentina/Buenos_Aires'), 'America/Argentina/Buenos_Aires');
  assert.equal(tz.normalizeTimeZone('Asia/Seoul'), 'Asia/Seoul');
  assert.equal(tz.normalizeTimeZone('UTC'), 'UTC');
  assert.equal(tz.normalizeTimeZone('  Europe/London  '), 'Europe/London');
});

test('missing and malformed zones fall back to null', () => {
  assert.equal(tz.normalizeTimeZone(undefined), null);
  assert.equal(tz.normalizeTimeZone(null), null);
  assert.equal(tz.normalizeTimeZone(''), null);
  assert.equal(tz.normalizeTimeZone('   '), null);
  assert.equal(tz.normalizeTimeZone(42), null);
  assert.equal(tz.normalizeTimeZone('Mars'), null);
  assert.equal(tz.normalizeTimeZone('Africa/Lagos; drop table'), null);
  assert.equal(tz.normalizeTimeZone('A'.repeat(65)), null);
});

test('locale normalization keeps language tags and drops everything else', () => {
  assert.equal(tz.normalizeLocale('en-NG'), 'en-NG');
  assert.equal(tz.normalizeLocale('ko'), 'ko');
  assert.equal(tz.normalizeLocale('Africa/Lagos'), null);
  assert.equal(tz.normalizeLocale('zh-Hant-TW'), null);
  assert.equal(tz.normalizeLocale(undefined), null);
});

test('device helpers never throw and only return validated values', () => {
  const zone = tz.deviceTimeZone();
  const locale = tz.deviceLocale();
  assert.ok(zone === null || tz.normalizeTimeZone(zone) === zone);
  assert.ok(locale === null || tz.normalizeLocale(locale) === locale);
});
