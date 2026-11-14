#!/usr/bin/env node
// Builds the single-file bundles used to deploy the Operator Edge Functions.
//
// Why this exists: `operator-admin` and `operator-worker` import shared modules from
// `supabase/functions/_shared`, and the deployment path used here uploads one file. The bundles in
// `supabase/functions/_bundles/` are the exact repo source with those imports inlined, so what runs
// in production is the code in this repository, not a hand-copied variant.
//
// Run after changing either function, and commit the regenerated bundles:
//   node scripts/build-operator-bundles.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FUNCTIONS = ['operator-admin', 'operator-worker'];
const HEADER = `// GENERATED FILE — do not edit by hand.
// Source: supabase/functions/%s/index.ts (plus its imports from supabase/functions/_shared).
// Regenerate with: node scripts/build-operator-bundles.mjs
`;

for (const name of FUNCTIONS) {
  const out = `supabase/functions/_bundles/${name}.js`;
  execFileSync(
    'npx',
    ['esbuild', '--bundle', '--format=esm', '--platform=neutral', '--target=es2022', `--outfile=${out}`, `supabase/functions/${name}/index.ts`],
    { stdio: 'inherit' },
  );
  const code = readFileSync(out, 'utf8');
  if (!code.startsWith('// GENERATED FILE')) {
    writeFileSync(out, HEADER.replace('%s', name) + code);
  }
  console.log(`bundled ${name} -> ${out}`);
}
