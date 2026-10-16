#!/usr/bin/env node
// Apply supabase/migrations to a LIVE Rork Cloud / Supabase database.
//
// The repository owns the schema: every object the app and the live suite rely on is defined in
// supabase/migrations, in filename order. This script is the step that puts the project in step with
// that set, so the live suite tests the code in this branch rather than whatever an older branch left
// behind.
//
// How it stays honest:
//   * strict filename order, no deferrals, exactly as scripts/localdb/apply-mjs does for the
//     disposable database — one schema definition, two places to run it;
//   * nothing is set on the session: each migration turns function body validation off for itself and
//     back on at the end (migration 00 defines is_moderator() before profiles exists — see
//     docs/RORK-CLOUD-CONNECTION-REPORT.md §3), so the files behave the same here, in the local
//     harness, in the SQL editor and under `supabase db push`;
//   * once every file has run, scripts/localdb/verify-function-bodies.mjs re-creates all 174 function
//     definitions against the finished schema with validation ON (each in a transaction that is rolled
//     back), so a body that cannot resolve is caught here rather than by the first member who calls it;
//   * VERBOSITY verbose, so every error carries its SQLSTATE. Only the "this object already exists"
//     states are tolerated, and each one is printed with the statement that hit it. Every other
//     error — a syntax error, a return-type change that needs a DROP, a permission failure — stops
//     the run and names the file and statement. Nothing is swallowed.
//
// seed.sql is deliberately NOT applied: it is reference data for a fresh database, and inserting it
// into a project that already has members would be a change nobody asked for.
//
// Usage:  node scripts/ci/apply-migrations.mjs [repoRoot]
// Env:    SUPABASE_DB_URL (or DATABASE_URL), or the usual PG* variables. `psql` must be installed.
//         The connection string is a repository secret; it is never written into this repository.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFunctionBodies } from '../localdb/verify-function-bodies.mjs';

// ── Errors that mean "the object is already there", and nothing worse ────────────────────────
// Every one of these is printed with its statement. Anything outside this list fails the run.
const ALREADY_EXISTS = new Set([
  '42710', // duplicate_object — policy, trigger, type, enum label, constraint, function
  '42704', // duplicate_object, older spelling used by some object types
  '42701', // duplicate_column
  '42723', // duplicate_function
  '42P06', // duplicate_schema
  '42P07', // duplicate_table
  '23505', // unique_violation — an idempotent reference row that is already present
]);

/**
 * Split one migration into top-level statements.
 *
 * A SQL parser would be nicer, but these files are PL/pgSQL by the dozen: a naive split on `;`
 * shreds every function body into fragments that each fail. So this walks the text and tracks single
 * quotes, double-quoted identifiers, dollar-quoted bodies ($$ and $tag$), line comments and block
 * comments. Only a `;` outside all of those ends a statement.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;

  while (i < sql.length) {
    const rest = sql.slice(i);

    // Line comment
    if (rest.startsWith('--')) {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    // Block comment (PostgreSQL does not nest these)
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // Dollar-quoted body
    const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (tag) {
      const close = sql.indexOf(tag[0], i + tag[0].length);
      const stop = close === -1 ? sql.length : close + tag[0].length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) j += 2; // a doubled quote is still inside the literal
          else {
            j += 1;
            break;
          }
        } else j += 1;
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }

    if (ch === ';') {
      // The terminator belongs to the statement: dropped, two statements fuse into one buffer and
      // psql reports a syntax error on the *second* create — which looks like a broken migration.
      statements.push(`${current};`);
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (current.trim()) statements.push(current);
  // A "statement" that is nothing but comments carries no SQL.
  return statements
    .map((s) => s.trim())
    .filter((s) => s && s.replace(/(--[^\n]*)/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim());
}

export function main(argv = process.argv) {
  const REPO = path.resolve(argv[2] ?? process.cwd());
  const MIGRATIONS = path.join(REPO, 'supabase', 'migrations');
  const conninfo = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';

  if (!conninfo && !process.env.PGHOST) {
    console.error(
      '✗ No database connection.\n' +
        '  Set the SUPABASE_DB_URL repository secret to the project\'s Postgres connection string\n' +
        '  (Rork Cloud → the project → Database → Connection string; the pooled URI is enough — copy\n' +
        '  it from the dashboard rather than writing one here, so no credential is ever committed).\n' +
        '  This script never invents a connection and never falls back to the local harness.',
    );
    return 2;
  }

  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (!files.length) {
    console.error(`✗ No migrations found in ${MIGRATIONS}`);
    return 1;
  }

  // ── One driver script, one psql process ───────────────────────────────────────────────────
  // `\echo` keeps the output attributable to a file, and psql's own line numbers map back to the
  // statement, so a failure can be named exactly instead of "somewhere in migration 37".
  const workdir = mkdtempSync(path.join(os.tmpdir(), 'hallyu-apply-'));
  const driverPath = path.join(workdir, 'driver.sql');
  const lineToStatement = new Map();
  const driver = ['\\set VERBOSITY verbose', '\\set ON_ERROR_STOP off'];
  // A line cursor, not `driver.length`: a statement is one array element spanning many lines, so
  // counting elements puts every reported line number in the wrong statement — which is how a failure
  // gets blamed on a migration that has nothing to do with it.
  let lineCursor = 2; // the two \set lines above
  let total = 0;

  const emit = (text) => {
    const count = text.split('\n').length;
    const firstLine = lineCursor + 1;
    lineCursor += count;
    driver.push(text);
    return { firstLine, count };
  };

  for (const file of files) {
    const statements = splitStatements(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    total += statements.length;
    emit(`\\echo ==== ${file} (${statements.length} statements)`);
    statements.forEach((raw, index) => {
      // A file whose last statement has no `;` still has to be terminated when it is fed to psql.
      const sql = /;\s*$/.test(raw) ? raw : `${raw}\n;`;
      emit(`\\echo ---- ${file} #${index + 1}`);
      const { firstLine, count } = emit(sql);
      emit('');
      const record = { file, index: index + 1, sql };
      // psql reports the line it noticed the error on, which for a multi-line statement is not
      // necessarily its first line — so every line of the statement maps back to it.
      for (let l = firstLine; l < firstLine + count; l += 1) lineToStatement.set(l, record);
    });
  }
  writeFileSync(driverPath, driver.join('\n'));

  console.log(
    `Applying ${files.length} migration file(s) / ${total} statements to the live project, in filename order.`,
  );

  // spawnSync, not execFileSync: with ON_ERROR_STOP off psql *exits 0* even when statements failed, and
  // execFileSync hands back stdout only on success — the statement errors go to stderr and would be
  // discarded, which reads as a clean apply over a database that never changed.
  const run = spawnSync('psql', ['-X', ...(conninfo ? ['--dbname', conninfo] : []), '--file', driverPath], {
    encoding: 'utf8',
    cwd: workdir,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 12 * 60 * 1000,
  });
  const out = run.stdout ?? '';
  const err = run.stderr ?? '';

  if (run.error) {
    console.error(`✗ psql could not be run: ${run.error.message}`);
    return 2;
  }
  if (run.signal) {
    console.error('✗ psql did not finish within 12 minutes — the run was stopped, nothing is proven.');
    return 2;
  }
  // 0 = every statement ran (some may have been refused). 2/3 = psql itself failed: bad credentials,
  // no route to the host, or the database is unreachable. Nothing was applied; that is not a schema
  // problem and must not be reported as one.
  if (run.status !== 0) {
    console.error(`✗ psql exited ${run.status} — the database was not reached or refused the connection.`);
    console.error(err.trim() || out.trim() || '(no output)');
    console.error(
      '\nCheck that SUPABASE_DB_URL is current and that the runner can reach the pooler host. Nothing\n' +
        'was applied, so this says nothing about the migrations themselves.',
    );
    return 2;
  }

  const { tolerated, fatal, unparsed } = classifyPsqlOutput(`${out}\n${err}`, lineToStatement);

  // Anti-fiction guard: if psql announced a failure and the parser could not read it, the parser is
  // wrong — and calling that a clean apply is precisely how a harness invents a pass.
  if (unparsed.length) {
    console.error('✗ psql reported failures this run could not classify:');
    for (const line of unparsed) console.error(`    ${line}`);
    console.error('Nothing is proven by this run.');
    return 1;
  }

  if (tolerated.length) {
    console.log(`\n${tolerated.length} statement(s) were already present — left exactly as they are:`);
    for (const t of tolerated) console.log(`  · ${t.file} #${t.index} ${t.code} ${t.message}`);
  }

  if (fatal.length) {
    console.error(`\n✗ ${fatal.length} statement(s) failed for a reason that is NOT "already exists":`);
    for (const f of fatal) {
      console.error(`\n  ${f.file} #${f.index} ${f.code} ${f.message}\n${indent(f.sql)}`);
    }
    console.error(
      '\nEach statement runs on its own, so the ones before these are in place and the ones after are\n' +
        'not. Fix the migration — a DROP before a changed signature is usually the answer — and run this\n' +
        'again; applying it is idempotent, so re-running costs nothing.',
    );
    return 1;
  }

  const executed = total - tolerated.length;
  console.log(
    `\nAPPLY OK — ${executed} statement(s) executed, ${tolerated.length} already present, across ${files.length} file(s).`,
  );

  // Every migration turned body validation off for its own duration, so the schema is applied but no
  // body has been resolved. This is where that happens: all 174 definitions are re-created against
  // the schema that now exists, with validation on, each inside a transaction that is rolled back.
  console.log('');
  const bodies = verifyFunctionBodies({ repo: REPO, conninfo });
  if (bodies !== 0) {
    console.error('✗ the schema applied, but function bodies did not all validate — see above.');
    return bodies;
  }
  return 0;
}

/**
 * Read psql's own error report back out of the output.
 *
 * psql writes `psql:<file>:<line>: ERROR:  <sqlstate>: <message>` — and prints NO column number for
 * DDL, only a bare line. A parser that insists on a column matches nothing at all, finds zero errors
 * and reports a clean apply over a database that never changed. Both that failure and the reverse one
 * (stderr dropped entirely, because execFileSync returns stdout only when psql exits 0) actually
 * happened while this script was being written; `unparsed` exists so neither can come back silently.
 *
 * Returns the errors that are merely "already present", the ones that are not, and any line that
 * looks like a failure but could not be read.
 */
export function classifyPsqlOutput(output, lineToStatement = new Map()) {
  const errorRe = /^psql:[^:\n]*:(\d+):(?:\d+:)?\s*(ERROR|FATAL):\s*([^\n]*)$/gm;
  const tolerated = [];
  const fatal = [];
  const claimed = new Set();
  let match;

  while ((match = errorRe.exec(output)) !== null) {
    const severity = match[2];
    const message = match[3].trim();
    const code = /^\s*(\w{5}):/.exec(message)?.[1] ?? '';
    const where = lineToStatement.get(Number(match[1]));
    const record = {
      ...(where ?? { file: '(driver)', index: Number(match[1]), sql: '' }),
      code,
      message,
      severity,
    };
    claimed.add(match[0]);
    if (severity === 'FATAL' || !ALREADY_EXISTS.has(code)) fatal.push(record);
    else tolerated.push(record);
  }

  // A failure psql announced but the parser could not read. VERBOSITY verbose prefixes every SQL
  // error with its code; anything matching this that was not claimed is unclassified, not harmless.
  const unparsed = (output.match(/^\s*(?:psql:[^\n]*)?\b(ERROR|FATAL):\s*\S.*$/gm) ?? []).filter(
    (line) => !claimed.has(line.trim()),
  );

  return { tolerated, fatal, unparsed };
}

function indent(text) {
  return String(text ?? '')
    .split('\n')
    .slice(0, 14)
    .map((l) => `      ${l}`)
    .join('\n');
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());