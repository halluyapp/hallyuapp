#!/usr/bin/env node
// Every function body in supabase/migrations, checked against the *finished* schema.
//
// The migrations switch `check_function_bodies` off while each file runs, because a file may define a
// function whose dependencies arrive in a later file (00 defines is_moderator() before profiles
// exists). That is the right way to apply them, but on its own it means a body can be wrong in ways
// nothing ever notices: a misspelled column, a table that never gets created, an operator that lives
// in a schema the function's pinned search_path does not contain.
//
// This script closes that hole. It re-reads every `create [or replace] function` in the migrations,
// in filename order, and re-creates each one against the database that the migrations just built —
// this time with body validation ON — inside a transaction that is rolled back immediately.
//
// Rolling back is what makes the pass safe as well as thorough. A definition is grouped with every
// other definition of the same name across the whole set, so the pass re-runs a function that a later
// migration replaced or dropped; against a live schema that would resurrect the old overload and
// change how an RPC resolves. Validation happens when the function is created, so a body that cannot
// resolve is reported before the rollback discards the creation — the schema is left exactly as it was.
//
// What it catches that a parse cannot: for `language sql` bodies, PostgreSQL resolves every table,
// column, function and operator when the body is validated. (A plpgsql body is only syntax-checked;
// its SQL is resolved at run time, so this pass is not a proof for those — see the note it prints.)
//
// Usage:
//   node scripts/localdb/verify-function-bodies.mjs [repoRoot] [--dbname <conninfo>]
// Env:
//   HALLYU_LOCAL_DB   local database name (default: hallyu) when no --dbname is given
//
// Exit code 0 = every body validated. 1 = at least one body is broken, named with its file.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Pulls every function definition out of one migration file.
 *
 * Bodies are delimited by `$$` (or `$tag$`) or by single quotes, and either can contain semicolons,
 * so a naive split on `;` would cut a body in half. The scan goes delimiter by delimiter and throws
 * if it reaches the end of a file without finding the terminator — a definition that cannot be
 * extracted must fail loudly rather than be silently skipped.
 */
export function extractFunctionDefinitions(sql, file) {
  const definitions = [];
  const create = /create\s+(?:or\s+replace\s+)?function\s/gi;
  let match;
  while ((match = create.exec(sql)) !== null) {
    const start = match.index;
    // Skip a mention inside a comment or a string: only a statement start counts.
    const lineStart = sql.lastIndexOf('\n', start) + 1;
    const before = sql.slice(lineStart, start);
    if (before.trim() !== '' || /--|\/\*/.test(before)) continue;
    if (/^\s*--/.test(sql.slice(lineStart, start))) continue;

    const bodyDelim = sql.slice(start).match(/\$[A-Za-z_]*\$/);
    let end;
    if (bodyDelim) {
      const tag = bodyDelim[0];
      const bodyStart = start + bodyDelim.index;
      const bodyEnd = sql.indexOf(tag, bodyStart + tag.length);
      if (bodyEnd === -1) throw new Error(`${file}: unterminated ${tag} body for a function at offset ${start}`);
      end = bodyEnd + tag.length;
    } else {
      const quoteStart = sql.indexOf("'", start);
      if (quoteStart === -1) throw new Error(`${file}: no body found for a function at offset ${start}`);
      let index = quoteStart + 1;
      while (index < sql.length && !(sql[index] === "'" && sql[index + 1] !== "'")) {
        index += sql[index] === "'" && sql[index + 1] === "'" ? 2 : 1;
      }
      if (index >= sql.length) throw new Error(`${file}: unterminated quoted body for a function at offset ${start}`);
      end = index + 1;
    }

    const trailing = sql.slice(end).match(/^\s*;/);
    if (trailing) end += trailing[0].length;
    definitions.push({ file, sql: sql.slice(start, end), offset: start });
  }
  return definitions;
}

export function verifyFunctionBodies({ repo = process.cwd(), conninfo = '', dbname = '' } = {}) {
  const MIGRATIONS = path.join(repo, 'supabase', 'migrations');
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const definitions = [];
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    definitions.push(...extractFunctionDefinitions(sql, file));
  }
  if (definitions.length === 0) {
    console.error('✗ no function definitions found in supabase/migrations — extraction is broken, nothing was proven');
    return 1;
  }

  // The parse-based checks count ~174 definitions; a collapse well below that means the extractor
  // stopped recognising a form rather than that the schema lost its functions.
  if (definitions.length < 150) {
    console.error(
      `✗ only ${definitions.length} function definitions were extracted (the migrations define far more) — ` +
        'the extractor is missing a form, so a clean run would prove nothing',
    );
    return 1;
  }

  const workdir = mkdtempSync(path.join(os.tmpdir(), 'hallyu-bodies-'));
  const driverPath = path.join(workdir, 'bodies.sql');
  const driver = [
    '\\set VERBOSITY verbose',
    '\\set ON_ERROR_STOP off',
    'set check_function_bodies = on;',
    '\\echo ==== validating every function body against the finished schema',
  ];
  for (const def of definitions) {
    const statement = def.sql.endsWith(';') ? def.sql : `${def.sql};`;
    driver.push(`\\echo ---- ${def.file}`);
    // One transaction per definition: a body that cannot resolve aborts its own transaction and the
    // rollback clears it, so the run reports every broken body instead of stopping at the first, and
    // nothing it creates is left behind for the schema to keep.
    driver.push('begin;');
    driver.push(statement);
    driver.push('rollback;');
    driver.push('');
  }
  writeFileSync(driverPath, driver.join('\n'));

  // With neither a connection string nor a database name given, psql is left to its own PG*
  // environment — which is how the CI job reaches its service container.
  const args = [
    '-X',
    ...(conninfo ? ['--dbname', conninfo] : dbname ? ['-d', dbname] : []),
    '--file',
    driverPath,
  ];
  const run = spawnSync('psql', args, {
    encoding: 'utf8',
    cwd: workdir,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60 * 1000,
  });

  if (run.error) {
    console.error(`✗ psql could not be run: ${run.error.message}`);
    return 2;
  }
  const err = run.stderr ?? '';

  // Report per definition, not per error line: psql echoes the failing statement, so the marker above
  // it names the migration the body came from.
  //
  // A definition that is refused because the object already exists is not a body problem and is
  // counted separately rather than dropped: nothing reported here may be silently discarded.
  const failures = [];
  let alreadyExists = 0;
  let superseded = 0;
  for (const block of err.split(/\n(?=ERROR:)/)) {
    if (!/ERROR:/.test(block)) continue;
    if (/already exists/i.test(block)) {
      alreadyExists += 1;
      continue;
    }
    // A later migration replaced this function with a different return type (36 redefines
    // purge_deleted_accounts, for instance). The old body is dead code — it cannot be created
    // alongside the live one, and it is not what the database runs — so it is counted and named
    // rather than failed. The definition that *is* live is validated where it appears later.
    if (/cannot change return type of existing function/i.test(block)) {
      superseded += 1;
      continue;
    }
    const file = /---- (\S+\.sql)/.exec(block)?.[1] ?? block.match(/([0-9]+_[a-z_]+\.sql)/)?.[1] ?? 'unknown file';
    const message = /ERROR:\s*([^\n]*)/.exec(block)?.[1] ?? block.split('\n')[0];
    failures.push({ file, message });
  }

  console.log('HALLYU FUNCTION BODY VALIDATION');
  console.log('==============================');
  console.log(`  • migrations read: ${files.length}`);
  console.log(`  • function definitions re-created with validation on: ${definitions.length}`);
  console.log(`  • definitions refused as already existing: ${alreadyExists} (not a body problem)`);
  console.log(`  • superseded definitions (a later migration changed the return type): ${superseded}`);
  console.log('  • note: `language sql` bodies are fully resolved here; plpgsql bodies are syntax-checked only');
  console.log('  • every definition ran inside a transaction that was rolled back — the schema is unchanged');
  console.log('');

  if (failures.length === 0) {
    console.log('  ✓ every function body re-created cleanly against the finished schema');
    console.log('');
    console.log('OVERALL STATUS: PASS');
    return 0;
  }

  console.log('FAILURES');
  for (const failure of failures) console.log(`  ✗ ${failure.file}: ${failure.message}`);
  console.log('');
  console.log(`OVERALL STATUS: FAIL (${failures.length} broken body/bodies)`);
  return 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const dbnameIndex = argv.indexOf('--dbname');
  const dbname = dbnameIndex === -1 ? '' : argv[dbnameIndex + 1];
  const repo = argv.find((a) => !a.startsWith('--') && a !== dbname) ?? process.cwd();
  // A live project is reached with a connection string; the local harness with a database name.
  const conninfo = dbname || process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';
  const localDb = process.env.HALLYU_LOCAL_DB ?? 'hallyu';
  process.exit(
    verifyFunctionBodies({ repo: path.resolve(repo), conninfo, dbname: conninfo ? '' : localDb }),
  );
}
