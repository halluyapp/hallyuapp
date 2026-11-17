// Reproduce the digest-pinned single-file entrypoint used by the connected deployment API.
// Prefer deploying the self-contained _bundles file directly with Supabase CLI when available.
// Usage: node scripts/operator-release-entrypoint.mjs operator-worker <40-character-commit>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [name,ref] = process.argv.slice(2);
if (!['operator-worker','operator-voice','operator-acceptance'].includes(name) || !/^[a-f0-9]{40}$/.test(ref ?? '')) {
  throw new Error('Expected an allowed operator function and immutable 40-character Git commit.');
}
const file = `supabase/functions/_bundles/${name}.js`;
const source = execFileSync('git',['show',`${ref}:${file}`],{encoding:'utf8',maxBuffer:1024*1024});
const sha = createHash('sha256').update(source).digest('hex');
const url = `https://api.github.com/repos/halluyapp/hallyuapp/contents/${file}?ref=${ref}`;
console.log(`// Immutable reviewed release ${ref}; digest mismatch fails closed.
const response = await fetch(${JSON.stringify(url)}, {headers: {'Accept':'application/vnd.github.raw+json','User-Agent':'HallyuRelease/1.0'}, signal: AbortSignal.timeout(15000)});
if (!response.ok) throw new Error('release_source_unavailable');
const source = await response.text();
const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))), b=>b.toString(16).padStart(2,'0')).join('');
if (digest !== '${sha}') throw new Error('release_integrity_failure');
new Function(source)();`);
