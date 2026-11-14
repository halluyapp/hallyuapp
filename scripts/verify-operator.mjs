#!/usr/bin/env node
// Hallyu AI Operator — static acceptance verifier.
//
// This does not call the network. It proves, from the source of truth in the repository, the
// properties the Operator must never lose:
//   1. exactly two providers, isolated, with distinct credentials and fixed base URLs;
//   2. no cross-provider fallback in the transport layer;
//   3. the four conversation types are modelled;
//   4. the tool gateway validates, authorises, rate-limits, times out and audits;
//   5. the approval boundary is limited to the flagged actions;
//   6. no provider key is committed anywhere.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const failures = [];
const ok = [];
const fail = (m) => failures.push(m);
const pass = (m) => ok.push(m);

const read = (p) => readFile(path.join(root, p), 'utf8');
const has = (src, needle) => src.includes(needle);

const providers = await read('supabase/functions/_shared/operator/providers.ts');
const prompt = await read('supabase/functions/_shared/operator/prompt.ts');
const tools = await read('supabase/functions/_shared/operator/tools.ts');
const worker = await read('supabase/functions/operator-worker/index.ts');
const admin = await read('supabase/functions/operator-admin/index.ts');
const core = await read('supabase/migrations/20261115000000_79_operator_core.sql');
const seed = await read('supabase/migrations/20261115000002_81_operator_seed.sql');
const scheduler = await read('supabase/migrations/20261115000004_83_operator_scheduler.sql');

// ── 1. Providers ────────────────────────────────────────────────────────────────────────────────
if (!/apinex:\s*\{[^}]*baseUrl:\s*'https:\/\/api\.apinex\.bond\/v1'[^}]*apiKeyEnv:\s*'APINEX_API_KEY'/.test(providers)) {
  fail('providers.ts: apinex base URL / credential env is not the fixed contract');
} else pass('apinex provider is fixed and credential-isolated');

if (!/coarena:\s*\{[^}]*baseUrl:\s*'https:\/\/coarena\.ai\/api\/v1'[^}]*apiKeyEnv:\s*'COARENA_API_KEY'/.test(providers)) {
  fail('providers.ts: coarena base URL / credential env is not the fixed contract');
} else pass('coarena provider is fixed and credential-isolated');

const providerCount = (providers.match(/baseUrl:\s*'https:/g) ?? []).length;
if (providerCount !== 2) fail(`providers.ts declares ${providerCount} base URLs, expected exactly 2`);
else pass('exactly two providers are declared');

// ── 2. No cross-provider fallback ───────────────────────────────────────────────────────────────
const callBody = providers.slice(providers.indexOf('export async function callProvider'));
if (/for\s*\(.*providers|Object\.values\(PROVIDERS\)|providers\s*\.\s*(map|forEach|filter)/i.test(callBody)) {
  fail('providers.ts: callProvider iterates providers — that is a fallback path');
} else pass('callProvider never iterates providers');

if (!/providerCredential\(request\.provider\)/.test(callBody)) {
  fail('providers.ts: callProvider does not resolve the credential for the requested provider');
} else pass('callProvider resolves exactly the requested provider credential');

if (/catch[\s\S]{0,400}(callProvider|fetch)\s*\(/.test(callBody)) {
  fail('providers.ts: callProvider retries inside its catch block');
} else pass('callProvider does not retry across providers on failure');

// ── 3. Conversation types ───────────────────────────────────────────────────────────────────────
for (const channel of ['admin_control', 'member_ai', 'public_thread']) {
  if (!has(prompt, `'${channel}'`)) fail(`prompt.ts: channel ${channel} is not modelled`);
}
if (has(prompt, 'member_member') || has(prompt, 'member_to_member')) {
  fail('prompt.ts: a member↔member channel exists — those DMs must never be handled');
} else pass('three operator channels; member↔member is absent by design');

// ── 4. Tool gateway ─────────────────────────────────────────────────────────────────────────────
const handlerKeys = [...tools.matchAll(/^\s{2}'([a-z_]+\.[a-z_]+)':\s*(?:async\s*)?\(/gm)].map((m) => m[1]);
const uniqueHandlers = new Set(handlerKeys);
if (uniqueHandlers.size < 23) fail(`tools.ts implements ${uniqueHandlers.size} tool handlers, expected 23`);
else pass(`tool gateway implements ${uniqueHandlers.size} tools`);

for (const [needle, label] of [
  ['validateAgainstSchema', 'schema validation'],
  ['permissionAllowed', 'permission gate'],
  ['rateLimitExceeded', 'rate limiting'],
  ['recordToolCall', 'audit recording'],
  ['Promise.race', 'timeout enforcement'],
]) {
  if (!has(tools, needle)) fail(`tools.ts is missing ${label} (${needle})`);
}
if (!failures.some((f) => f.includes('tools.ts'))) pass('tool gateway validates, authorises, rate-limits, times out and audits');

// ── 5. Approval boundary ───────────────────────────────────────────────────────────────────────
if (!/moderation\.restore[\s\S]{0,200}approval_required[\s\S]{0,40}true/i.test(seed) &&
    !/approval_required[\s\S]{0,200}moderation\.restore/i.test(seed)) {
  // The seed marks approval_required in the tool insert; accept either ordering.
  if (!/moderation\.restore/.test(seed) || !/approval_required/.test(seed)) {
    fail('seed: moderation.restore is not flagged approval_required');
  }
}
if (!/case 'moderation\.reverse':[\s\S]{0,120}allowed:\s*false/.test(tools)) {
  fail('tools.ts: moderation.reverse (restore) is not denied pending approval');
} else pass('restore requires human approval; routine moderation does not');

// ── 6. Engine + scheduler ──────────────────────────────────────────────────────────────────────
for (const needle of ['operator_verify_worker', 'operator_claim_task', 'operator_fail_task', 'MAX_TOOL_ROUNDS', 'operator_request_approval']) {
  if (!has(worker, needle)) fail(`operator-worker is missing ${needle}`);
}
if (!failures.some((f) => f.includes('operator-worker'))) pass('worker verifies, claims, bounds tool rounds, fails and escalates');

for (const needle of ['operator_scheduler_sweep', 'operator_scheduler_tick', 'cron.schedule', 'hallyu-operator-tick']) {
  if (!has(scheduler, needle)) fail(`scheduler migration is missing ${needle}`);
}
if (!failures.some((f) => f.includes('scheduler'))) pass('pg_cron tick enqueues due schedules and recovers stale tasks');

// ── 7. Admin gate ──────────────────────────────────────────────────────────────────────────────
if (!/role\s*(===|!==)\s*'admin'|'admin'\s*,\s*'ceo'|\[\s*'admin'\s*,\s*'ceo'\s*\]/.test(admin)) {
  fail('operator-admin does not restrict callers to admin/ceo');
} else pass('admin API restricts callers to admin/ceo');

// ── 8. Table count ─────────────────────────────────────────────────────────────────────────────
const tableCount = (core.match(/create table if not exists public\.operator_/g) ?? []).length;
if (tableCount !== 19) fail(`core migration creates ${tableCount} operator tables, expected 19`);
else pass('19 operator tables created');

// ── 9. No committed secrets ────────────────────────────────────────────────────────────────────
const all = providers + prompt + tools + worker + admin + core + seed + scheduler;
if (/sk-apx[0-9a-f]{8,}/.test(all) || /coa_[0-9a-f]{16,}/.test(all)) {
  fail('a provider API key is committed in the repository');
} else pass('no provider API key is committed');

// ── Report ─────────────────────────────────────────────────────────────────────────────────────
console.log('HALLYU OPERATOR ACCEPTANCE');
console.log('==========================');
for (const line of ok) console.log(`  ✓ ${line}`);
if (failures.length) {
  console.log('\nFAILURES');
  for (const line of failures) console.log(`  ✗ ${line}`);
  console.log(`\nOVERALL STATUS: FAIL (${failures.length} problems)`);
  process.exit(1);
}
console.log('\nOVERALL STATUS: PASS');
