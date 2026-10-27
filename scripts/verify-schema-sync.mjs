#!/usr/bin/env node
// Compares the live project's function surface against what supabase/migrations defines.
//
// The live suite reports symptoms ("recommended_titles failed: operator does not exist"); this
// reports the cause: the project is running a body that this repository no longer defines. Every
// function in the migrations is called through PostgREST with its declared parameters (defaults
// where the migration declares one, NULL otherwise). A function that does not exist in the project
// answers PGRST202 / 404; one that exists answers with its own logic (a validation error, or a
// result). Nothing is written: the calls either fail on a NULL argument or run read-only bodies,
// and any function that does write is given a NULL identity, which every writer rejects.
//
// Env: SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
// Exit: 0 = the project has every function the repository defines, 1 = drift, 2 = not configured
import process from 'node:process';
import path from 'node:path';
import { expectedFunctions, nullArgsBody, classifyRpcProbe } from './lib/db-signatures.mjs';

if (typeof globalThis.WebSocket === 'undefined') {
  try {
    const { default: NodeWebSocket } = await import('ws');
    globalThis.WebSocket = NodeWebSocket;
  } catch {
    /* only needed by supabase-js; this script talks plain HTTP */
  }
}

const URL_BASE = (process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!URL_BASE || !SERVICE_KEY) {
  console.error('::error title=Configuration failure::schema sync needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(2);
}

const REPO = process.argv[2] ?? process.cwd();
const MIGRATIONS = path.join(REPO, 'supabase', 'migrations');

// The declared signatures — and the parameters a presence probe has to send — live in
// scripts/lib/db-signatures.mjs, shared with the live suite.
const expected = expectedFunctions(MIGRATIONS);

const call = async (fn) => {
  // Every declared parameter is sent as null: the names resolve the function (so a function the
  // project does not have answers PGRST202), while a null argument is refused by any writer before
  // it touches a row. Declared defaults are deliberately not replayed — this is a presence probe,
  // not a behavioural test (scripts/verify-backend.mjs is that).
  const body = nullArgsBody(fn.argText);
  const response = await fetch(`${URL_BASE}/rest/v1/rpc/${fn.name}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === '{}' ? '{}' : body,
  });
  const text = await response.text();
  let code = null;
  let message = '';
  try {
    const parsed = JSON.parse(text);
    code = parsed?.code ?? null;
    message = parsed?.message ?? parsed?.error ?? '';
  } catch {
    /* the body is not JSON (a plain-text error) */
    message = text;
  }
  return { status: response.status, code, message, verdict: classifyRpcProbe({ code, message, status: response.status }), text: text.slice(0, 200) };
};

console.log(`Probing ${expected.size} declared function(s) against ${URL_BASE}`);
const missing = [];
const present = [];
const failures = [];
for (const fn of expected.values()) {
  let outcome;
  try {
    outcome = await call(fn);
  } catch (e) {
    failures.push({ fn, error: e?.message ?? String(e) });
    continue;
  }
  // The shared classifier decides: a function that raised, or refused a null argument, is present;
  // only a resolution failure is missing, and a transport failure is neither.
  if (outcome.verdict === 'missing') missing.push({ fn, outcome });
  else if (outcome.verdict === 'unreachable') failures.push({ fn, error: outcome.message || `HTTP ${outcome.status}` });
  else present.push({ fn, outcome });
}

for (const { fn, outcome } of missing) {
  console.log(`  ✗ ${fn.name} (${fn.file}) — the project does not have it: HTTP ${outcome.status}${outcome.code ? ` ${outcome.code}` : ''}`);
}
for (const { fn, error } of failures) console.log(`  ✗ ${fn.name} (${fn.file}) — probe failed: ${error}`);

console.log('');
console.log(`present: ${present.length} · missing: ${missing.length} · unreachable: ${failures.length}`);

if (missing.length === 0 && failures.length === 0) {
  console.log('OVERALL STATUS: PASS — the project implements every function this repository defines.');
  process.exit(0);
}

console.log('');
console.log('The project is running schema this repository no longer defines. Apply supabase/migrations');
console.log('to the project in filename order (each file disables function body validation for itself while');
console.log('it runs), then run scripts/localdb/verify-function-bodies.mjs against the project, then');
console.log('re-run this workflow — the live suite asserts the behaviour of the definitions in this branch.');
process.exit(1);
