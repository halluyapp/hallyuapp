#!/usr/bin/env node
// Runs scripts/localdb/repro.sql against the local database and fails when any check is not OK.
//
// Each block in repro.sql reports `CHECK <name>: OK` or `CHECK <name>: ERROR <message>` /
// `CHECK <name>: FAIL …` / `CHECK <name>: ERROR no notification row …`. Every check is a behaviour
// the live suite asserts (member post creation under RLS, reactions, notifications, catalog ingest,
// communities, media, feed/search, jobs, bootstrap), replayed here as SQL so a regression is caught
// before the connected job ever talks to a real project.
//
// The header of repro.sql declares how many CHECK lines it emits. A block that fails to compile
// emits none, which would otherwise look like a smaller suite rather than a broken one.
//
// Usage: node scripts/localdb/check.mjs [repoRoot]
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(process.argv[2] ?? process.cwd());
const SQL = path.join(REPO, 'scripts', 'localdb', 'repro.sql');
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
  const m = /CHECK (.+?): (OK.*|ERROR.*|FAIL.*)$/.exec(line.replace(/^psql:[^:]*:\s*(NOTICE:\s*)?/, '').trim());
  if (m) results.push({ name: m[1], outcome: m[2] });
}

const failures = results.filter((r) => !r.outcome.startsWith('OK'));
for (const failure of failures) console.log(`✗ ${failure.name}: ${failure.outcome}`);
for (const pass of results.filter((r) => r.outcome.startsWith('OK'))) {
  console.log(`✓ ${pass.name}: ${pass.outcome}`);
}
console.log(`\n${results.length} behaviour check(s): ${results.length - failures.length} passed, ${failures.length} failed.`);

// A block whose body fails to compile produces no CHECK line, and a missing line is indistinguishable
// from a passing suite. repro.sql declares how many it should emit; a shortfall means a block died.
const expected = Number(/--\s*expects:\s*(\d+)\s+checks/i.exec(readFileSync(SQL, 'utf8'))?.[1] ?? 0);
if (expected > 0 && results.length < expected) {
  console.error(`::error::repro.sql produced ${results.length} check lines but declares ${expected} — a block failed to compile and its checks are missing, not passing.`);
  process.exit(1);
}
if (failures.length === 0 && result.status === 0) {
  const repair = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', path.join(REPO, 'scripts', 'localdb', 'login-engagement-repairs.sql')], {
    encoding: 'utf8', cwd: SCRATCH, env: { ...process.env }, maxBuffer: 32 * 1024 * 1024,
  });
  const repairOutput = `${repair.stdout ?? ''}${repair.stderr ?? ''}`.trim();
  if (repairOutput) console.log(repairOutput);
  if (repair.status !== 0) {
    console.error('::error::login/engagement repair behavior checks failed.');
    process.exit(1);
  }
  console.log('✓ suspended writes rejected; self-deletion and service episode ingest preserved');
}
process.exit(failures.length === 0 && result.status === 0 ? 0 : 1);
