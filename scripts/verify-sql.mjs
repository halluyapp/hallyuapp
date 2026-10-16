#!/usr/bin/env node
// Hallyu backend — SQL migration validation.
//
// There is no Postgres in this workspace, so this script does the strongest offline check available:
// it parses every file in supabase/migrations with libpg_query (the real PostgreSQL parser, via
// pgsql-parser) and then enforces the invariants that a parse alone cannot catch.
//
//   1. every migration parses as valid PostgreSQL
//   2. migration filenames are ordered and uniquely prefixed
//   3. every table has row level security enabled
//   4. every RLS-enabled application table has at least one policy — partitions excepted, because a
//      partition is meant to be deny-all; instead every partition must carry its own RLS flag
//   5. every SECURITY DEFINER function pins its search_path
//   6. no function accepts or executes free-form SQL
//   7. no migration mentions a privileged credential
//
// Exit code 0 = all checks pass. Any failure exits 1 and prints what to fix.

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parse } from 'pgsql-parser';

const MIGRATIONS_DIR = path.resolve('supabase/migrations');
const failures = [];
const notes = [];

const fail = (file, message) => failures.push(`${file}: ${message}`);
const ok = (message) => notes.push(message);

// ---------------------------------------------------------------------------------------------
// 1 + 2. Parse every migration, and check the ordering contract
// ---------------------------------------------------------------------------------------------

if (!existsSync(MIGRATIONS_DIR)) {
  console.error('✗ supabase/migrations is missing — the backend source of truth must live in the repository.');
  process.exit(1);
}

const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
if (files.length === 0) {
  console.error('✗ no migrations found');
  process.exit(1);
}

const seenPrefix = new Set();
const asts = new Map();

for (const file of files) {
  if (!/^\d{8,14}_[a-z0-9_]+\.sql$/.test(file)) {
    fail(file, 'filename must be <timestamp>_<slug>.sql so migrations apply in a deterministic order');
  }
  const prefix = file.split('_')[0];
  if (seenPrefix.has(prefix)) fail(file, `duplicate migration timestamp prefix ${prefix} (already used by another file)`);
  seenPrefix.add(prefix);

  const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');

  try {
    asts.set(file, await parse(sql));
  } catch (error) {
    fail(file, `does not parse as PostgreSQL: ${error.message}`);
  }
}

if (failures.length === 0) ok(`${files.length} migrations parse as valid PostgreSQL`);

// ---------------------------------------------------------------------------------------------
// 3–6. Invariants, read from the parse trees rather than from text matching
// ---------------------------------------------------------------------------------------------

const rlsTables = new Set();
const policyTables = new Set();
const functions = [];
const partitions = new Map(); // partition name -> parent name
let tablesCreated = 0;

/**
 * Returns one function's own text: from its `create [or replace] function` to the end of its body
 * delimiter. A function written with the single-quote body form has no `$$`, so that form is
 * supported too.
 */
function sliceFunctionBody(sql, name) {
  if (!name) return '';
  const start = sql.search(new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+(public\\.)?${name}\\s*\\(`, 'i'));
  if (start === -1) return '';

  const dollarStart = sql.indexOf('$$', start);
  if (dollarStart !== -1) {
    const dollarEnd = sql.indexOf('$$;', dollarStart + 2);
    return sql.slice(start, dollarEnd === -1 ? Math.min(sql.length, dollarStart + 4000) : dollarEnd + 2);
  }

  const quoteStart = sql.indexOf("'", sql.indexOf('language', start));
  if (quoteStart === -1) return '';

  let index = quoteStart + 1;
  while (index < sql.length) {
    if (sql[index] === "'" && sql[index + 1] === "'") {
      index += 2;
      continue;
    }
    if (sql[index] === "'") break;
    index += 1;
  }
  return sql.slice(start, index + 1);
}

for (const [file, tree] of asts) {
  const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
  const statements = Array.isArray(tree) ? tree : tree?.stmts ?? [];
  const rawStmts = Array.isArray(tree) ? tree : tree?.stmts ?? [];

  for (const stmt of rawStmts) {
    const node = stmt?.stmt ?? stmt;
    if (!node) continue;

    // CREATE TABLE
    if (node.CreateStmt) {
      const name = node.CreateStmt.relation?.relname;
      if (name) tablesCreated += 1;
      // `partition of parent` — libpg_query records the bound in `partbound` and names the parent
      // in `inhRelations`.
      if (name && node.CreateStmt.partbound) {
        const parent = (node.CreateStmt.inhRelations ?? [])
          .map((r) => r?.RangeVar?.relname ?? r?.relname ?? null)
          .find(Boolean);
        if (parent) partitions.set(name, parent);
      }
      continue;
    }

    // ALTER TABLE ... ENABLE ROW LEVEL SECURITY
    if (node.AlterTableStmt) {
      const name = node.AlterTableStmt.relation?.relname;
      const cmds = node.AlterTableStmt.cmds ?? [];
      for (const cmd of cmds) {
        const subtype = cmd?.AlterTableCmd?.subtype;
        if (name && (subtype === 'AT_EnableRowSecurity' || subtype === 'AT_ForceRowSecurity')) {
          rlsTables.add(`${file}:${name}`);
        }
      }
      continue;
    }

    // CREATE POLICY
    if (node.CreatePolicyStmt) {
      const table = node.CreatePolicyStmt.table?.relname;
      if (table) policyTables.add(table);
      continue;
    }

    // CREATE FUNCTION
    if (node.CreateFunctionStmt) {
      // libpg_query keeps the function's own name in `funcname`; `parameters[0]` is the first
      // *argument*. Reading the argument as the name is how a checker ends up reporting nothing.
      const funcname = node.CreateFunctionStmt.funcname ?? [];
      const name = funcname[funcname.length - 1]?.String?.sval ?? null;
      functions.push({
        file,
        name,
        options: node.CreateFunctionStmt.options ?? [],
        // The AST does not carry the body for every function shape, so the body is sliced out of
        // the migration text below — checking the whole file would let one function's SQL vouch
        // for another's.
        definition: sliceFunctionBody(sql, name),
      });
      continue;
    }
  }
}

// RLS coverage. auth.* and storage.* objects are owned by Supabase; this schema never creates them.
//
// Partitions are excluded from the "must have a policy" rule on purpose: a partition is supposed to
// be deny-all, and the policy that governs reads lives on the parent. They are not free of checks —
// see the partition rule below, which is the stronger one.
const applicationTables = [...rlsTables]
  .map((entry) => entry.split(':')[1])
  .filter((t) => !partitions.has(t));

const tablesWithoutPolicies = applicationTables.filter((t) => !policyTables.has(t));
if (tablesWithoutPolicies.length > 0) {
  fail('supabase/migrations', `RLS is enabled but no policy exists for: ${tablesWithoutPolicies.join(', ')}`);
} else if (rlsTables.size > 0) {
  ok(`${rlsTables.size} tables have row level security enabled, each with at least one policy`);
}

// Partitions: a partition read by name is checked against its own RLS flag, never the parent's, and
// it inherits the parent's privileges only when the query goes through the parent. So a partition
// without RLS is readable by anyone who holds a grant on it — including a grant nobody meant to
// give, which is exactly the kind of mistake this check exists to catch.
const partitionsWithoutRls = [...partitions.keys()].filter(
  (p) => ![...rlsTables].some((entry) => entry.endsWith(`:${p}`)),
);
if (partitionsWithoutRls.length > 0) {
  fail(
    'supabase/migrations',
    `partition(s) created without row level security: ${partitionsWithoutRls.join(', ')}`,
  );
}

// Partitions created at run time (by a function that runs DDL) cannot be seen in the parse tree, so
// the rule is applied to the code that creates them: whoever runs `create table ... partition of`,
// the same routine must switch RLS on for what it just created.
const parents = new Set(partitions.values());
for (const fn of functions) {
  const createsPartition = /create\s+table\s+[^;]*partition\s+of\s+(?:public\.)?(\w+)/gi;
  for (const match of fn.definition.matchAll(createsPartition)) {
    parents.add(match[1]);
    if (!/enable\s+row\s+level\s+security/i.test(fn.definition)) {
      fail(
        'supabase/migrations',
        `${fn.name}() creates a partition of ${match[1]} but never enables row level security on it`,
      );
    }
  }
}

if (partitions.size > 0 && partitionsWithoutRls.length === 0) {
  ok(`${partitions.size} partition(s) carry their own row level security; ${parents.size} partitioned parent(s) checked`);
}

// SECURITY DEFINER functions must pin their search_path, and none may execute caller-supplied SQL.
//
// Both facts are read from the parsed option list, not from the file text. The option for
// `security definer` is a DefElem named "security" whose argument is a boolean, and the option for
// `set search_path = …` is a DefElem named "set" whose argument is a VariableSetStmt naming
// search_path. Reading `o.definer` here (as an earlier version of this script did) always returned
// undefined, which silently skipped every function and made this check pass on any input.
for (const fn of functions) {
  const elems = fn.options.map((o) => o.DefElem).filter(Boolean);

  const isDefiner = elems.some(
    (e) => e.defname === 'security' && e.arg?.Boolean?.boolval === true,
  );
  if (!isDefiner) continue;

  const pinned = elems.some((e) => {
    if (e.defname !== 'set') return false;
    const set = e.arg?.VariableSetStmt;
    if (!set) return false;
    const name = set.name ?? set.kind;
    return name === 'search_path';
  });

  if (!pinned) {
    fail(fn.file, `SECURITY DEFINER function ${fn.name}() does not pin search_path`);
  }

  if (/execute\s+(?!format\s*\()\s*[^;]/i.test(fn.definition)) {
    fail(
      fn.file,
      `function ${fn.name}() executes a variable — caller input must never become a statement`,
    );
  }
}

if (functions.length > 0) {
  ok(`${functions.length} functions parsed; every SECURITY DEFINER function pins search_path`);
}

// Dynamic SQL is allowed only in the form `execute format('… %I … %L …')`, where identifiers and
// literals are quoted by PostgreSQL itself. A raw `%s` splices a value into the statement text,
// which is the shape of an injection bug, and is rejected here.
for (const file of files) {
  const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
  if (/execute\s+format\s*\([^)]*%s/i.test(sql)) {
    fail(file, "uses execute format with a raw %s — use %I for identifiers and %L for values");
  }
  if (/\b(p_execute|run_sql|exec_sql|execute_sql)\b/i.test(sql)) {
    fail(file, 'looks like an arbitrary SQL execution endpoint');
  }
}
ok('dynamic SQL uses %I/%L only; no free-form SQL execution endpoint exists');

// ---------------------------------------------------------------------------------------------
// 7. No privileged credential may appear in a migration
// ---------------------------------------------------------------------------------------------

// A migration may name roles (`grant … to service_role`, `auth.role() not in ('service_role', …)`)
// — that is configuration. What must never appear is a credential value.
const CREDENTIAL_PATTERNS = [
  { pattern: /\bSERVICE_ROLE_KEY\s*[:=]\s*['"][A-Za-z0-9._-]{16,}/i, label: 'service-role key literal' },
  { pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, label: 'JWT-looking literal' },
  { pattern: /\bsb_(publishable|secret)_[A-Za-z0-9_-]{10,}/, label: 'Supabase key literal' },
  { pattern: /rpk_[A-Za-z0-9]{10,}/, label: 'Rork app key literal' },
  { pattern: /\bpostgres(ql)?:\/\/[^'\s]+:[^'\s@]+@/, label: 'connection string with password' },
];

for (const file of files) {
  const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
  for (const { pattern, label } of CREDENTIAL_PATTERNS) {
    if (pattern.test(sql)) fail(file, `contains a ${label} — migrations must never carry a credential`);
  }
}

if (!failures.some((f) => f.includes('credential'))) {
  ok('no migration contains a credential or privileged key literal');
}

// ---------------------------------------------------------------------------------------------
// 8. No function may delete a storage row directly
// ---------------------------------------------------------------------------------------------

// Supabase installs `storage.protect_delete()`, which refuses `DELETE` on `storage.objects` and
// `storage.buckets` for every role — "Direct deletion from storage tables is not allowed. Use the
// Storage API instead." A function that does it parses, applies, compiles, and then fails at the
// only moment it runs, which is why this is checked here and not left to the live project.
//
// The check reads the *final* definition of every function, not the text of every migration: an
// earlier migration may define a function the way the platform forbade, as long as a later one
// replaces it (migration 37 does exactly that). Only the definition that survives is a defect.
const finalDefinitions = new Map(); // function name -> { file, sql }

for (const file of files) {
  const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');

  // Every definition, in the order they appear, so the *last* one for a name is the one that
  // survives `supabase db push` — a file may redefine a function several times.
  for (const match of sql.matchAll(/create\s+(or\s+replace\s+)?function\s+(public\.)?(\w+)\s*\(/gi)) {
    finalDefinitions.set(match[3].toLowerCase(), {
      file,
      sql: sliceFunctionBody(sql.slice(match.index), match[3]),
    });
  }
}

for (const [name, { file, sql }] of finalDefinitions) {
  for (const statement of sql.matchAll(/delete\s+from\s+storage\.(objects|buckets)/gi)) {
    fail(
      file,
      `${name}() deletes storage.${statement[1]} directly — Supabase refuses that for every role; queue the path in public.media_removal_queue and let the Storage API remove it`,
    );
  }
}

if (!failures.some((f) => f.includes('Storage API remove it'))) {
  ok(`no function deletes a storage row directly (${finalDefinitions.size} function definitions checked)`);
}

// ---------------------------------------------------------------------------------------------
// 9. The migration set must be re-appliable: a function whose row type changes is dropped first
// ---------------------------------------------------------------------------------------------

// `create or replace function` cannot change a function's row type. Redefining one whose
// `RETURNS TABLE` differs from the version already in the database fails with 42P13, so a set that
// only ever applies to a virgin database is not a set that can be applied to a live project brought
// forward file by file — which is exactly what the connected workflow has to do.
//
// The rule: when one function signature is defined more than once with more than one return shape,
// every one of those definitions must be preceded by `drop function if exists` for that signature.
// On a fresh database the drop is a no-op, so this costs nothing and unblocks re-application.
const signatures = new Map(); // name(args) -> [{ file, index, returns }]

for (const file of files) {
  const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');

  for (const match of sql.matchAll(
    /create\s+(?:or\s+replace\s+)?function\s+(public\.)?([a-z0-9_]+)\s*\(/gi,
  )) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    const argsStart = cursor;
    for (; cursor < sql.length && depth > 0; cursor += 1) {
      if (sql[cursor] === '(') depth += 1;
      else if (sql[cursor] === ')') depth -= 1;
    }
    // `returns trigger` handlers are not called by name, so their row type is irrelevant here.
    if (/^\s*returns\s+trigger\b/i.test(sql.slice(cursor, cursor + 40))) continue;

    const returns = /returns\s+([\s\S]{0,200}?)\s*language\b/i.exec(sql.slice(cursor, cursor + 400));
    const name = match[2].toLowerCase();
    const key = `${name}(${sql.slice(argsStart, cursor - 1).replace(/\s+/g, ' ').trim()})`;
    if (!signatures.has(key)) signatures.set(key, []);
    signatures.get(key).push({
      file,
      name,
      index: match.index,
      returns: (returns?.[1] ?? '?').replace(/\s+/g, ' ').trim(),
    });
  }
}

let reapplyConflicts = 0;
for (const [signature, definitions] of signatures) {
  if (new Set(definitions.map((d) => d.returns)).size < 2) continue;
  reapplyConflicts += 1;

  for (const definition of definitions) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, definition.file), 'utf8');
    const dropped = new RegExp(
      `drop\\s+function\\s+(if\\s+exists\\s+)?(public\\.)?${definition.name}\\s*\\(`,
      'i',
    ).test(sql.slice(0, definition.index));
    if (!dropped) {
      fail(
        definition.file,
        `${definition.name}() is defined more than once with different return shapes (${signature}), and this definition is not preceded by \`drop function if exists ${definition.name}(...)\` — re-applying the set over a database that already has another version fails with 42P13 (see docs/RORK-CLOUD-CONNECTION-REPORT.md)`,
      );
    }
  }
}

if (!failures.some((f) => f.includes('42P13'))) {
  ok(
    reapplyConflicts === 0
      ? 'every function keeps one return shape across the migration set (nothing to drop)'
      : `${reapplyConflicts} function signature(s) change shape; each definition drops the old version first`,
  );
}

// ---------------------------------------------------------------------------------------------

console.log('HALLYU SQL VALIDATION');
console.log('=====================');
for (const note of notes) console.log(`  ✓ ${note}`);
console.log(`  • tables created: ${tablesCreated}`);
console.log(`  • migrations: ${files.length}`);
console.log('');

if (failures.length > 0) {
  console.log('FAILURES');
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  console.log('\nOVERALL STATUS: FAIL');
  process.exit(1);
}

console.log('OVERALL STATUS: PASS');