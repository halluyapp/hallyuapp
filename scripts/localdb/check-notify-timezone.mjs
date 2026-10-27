#!/usr/bin/env node
// Runs scripts/localdb/notify_timezone.sql against the local database and fails when any check is not OK.
// Covers episode reminder time zones (en-NG is a locale, not a zone), quiet hours, reminder dedupe and re-surfacing.
//
// Usage: node scripts/localdb/check-notify-timezone.mjs [repoRoot]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(process.argv[2] ?? process.cwd());
const SQL = path.join(REPO, 'scripts', 'localdb', 'notify_timezone.sql');
const DB = process.env.HALLYU_LOCAL_DB ?? 'hallyu';
const SCRATCH = path.join(os.tmpdir(), 'hallyu-db');
mkdirSync(SCRATCH, { recursive: true });

const result = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=0', '-d', DB, '-f', SQL], {
  encoding: 'utf8',
  cwd: SCRATCH,
  env: { ...process.env },
  maxBuffer: 32 * 1024 * 1024,
});
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

const results = [];
for (const line of output.split('\n')) {
  const m = /CHECK (.+?): (OK.*|FAIL.*|ERROR.*)$/.exec(line.replace(/^psql:[^:]*:\s*(NOTICE:\s*)?/, '').trim());
  if (m) results.push({ name: m[1], outcome: m[2] });
}

const failures = results.filter((r) => !r.outcome.startsWith('OK'));
for (const failure of failures) console.log(`✗ ${failure.name}: ${failure.outcome}`);
for (const pass of results.filter((r) => r.outcome.startsWith('OK'))) console.log(`✓ ${pass.name}`);
console.log(`\n${results.length} notify/timezone check(s): ${results.length - failures.length} passed, ${failures.length} failed.`);

// Errors that stopped a block before its CHECK line show up in stderr; surface them.
const blockErrors = output.split('\n').filter((l) => /ERROR:/.test(l) && !/CHECK /.test(l));
if (blockErrors.length) {
  console.log('\nSQL errors reported while running the file (each may have stopped one block):');
  for (const e of blockErrors.slice(0, 20)) console.log(`  ${e}`);
}

const expected = Number(/--\s*expects:\s*(\d+)\s+checks/i.exec(readFileSync(SQL, 'utf8'))?.[1] ?? 0);
if (expected > 0 && results.length < expected) {
  console.error(`::error::notify_timezone.sql produced ${results.length} check lines but declares ${expected}.`);
  process.exit(1);
}
process.exit(failures.length === 0 && results.length >= expected ? 0 : 1);
