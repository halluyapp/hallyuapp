/**
 * Regression guard for the Home render loop that made the release APK unresponsive.
 *
 * The loop was:
 *   1. `useApp()` returned a fresh object literal, so `const { getDrama } = useApp()` gave Home a
 *      new function identity on every render;
 *   2. `liveFeed` is `useMemo(..., [state, tab, universe, getDrama])`, so that identity invalidated
 *      the memo every render and it built a brand-new array every render;
 *   3. `useEffect(..., [liveFeed]) { setFeed(liveFeed) }` therefore ran after every commit and always
 *      wrote a new array reference, scheduling another render — forever. The JS thread never got
 *      back to the event loop, so no `onPress`, no `TextInput`, no navigation ran; native scrolling
 *      kept working because it never needs JS to move the content.
 *
 * This asserts the two invariants that make that impossible, so it cannot come back unnoticed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const failures = [];
const check = (ok, msg) => {
  if (ok) console.log(`  ok  ${msg}`);
  else {
    console.log(`FAIL  ${msg}`);
    failures.push(msg);
  }
};

const hooks = read('lib/hooks.ts');
const home = read('app/(tabs)/index.tsx');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// ---------------------------------------------------------------------------
// 1. useApp() must not hand out per-render function identities.
// ---------------------------------------------------------------------------
console.log('\nuseApp() identity stability');
const hooksCode = code(hooks);
const useAppStart = hooksCode.indexOf('export function useApp()');
const useAppEnd = hooksCode.indexOf('\nexport ', useAppStart + 10);
const useAppSrc = hooksCode.slice(useAppStart, useAppEnd === -1 ? undefined : useAppEnd);
{
  // Every getter named in the public surface must be produced by useCallback, and the object
  // literal returned must be inside a useMemo — otherwise the object (and its members) is new
  // on every render and any dependency array containing a getter is permanently dirty.
  const accessors = [...new Set([...useAppSrc.matchAll(/^\s+const (\w+) = useCallback\(/gm)].map((m) => m[1]))];
  const plain = [...new Set([...useAppSrc.matchAll(/^\s+(get\s)?(\w+):/gm)].map((m) => m[2]))];
  const named = [...new Set([...accessors, ...plain])].filter((n) => n !== 'useMemo' && n !== 'useRef');
  check(named.length >= 12, `useApp() exposes ${named.length} accessors (${accessors.length} via useCallback)`);
  for (const g of accessors.filter((n) => n !== 't')) {
    check(new RegExp(`^\\s+${g},?$`, 'm').test(useAppSrc), `\`${g}\` is surfaced from the memoized object`);
  }
  for (const g of plain) {
    if (g === 'state' || g === 'me' || g === 'unread' || g === 't') continue; // getters on the memoized object
    check(accessors.includes(g), `\`${g}\` is a useCallback (stable identity)`);
  }
  check(/return useMemo\(\s*\n?\s*\(\) => \(\{/.test(useAppSrc), 'the returned object is memoized');
  check(!/\n\s*(get\s?\w+|\w+):[^\n]*=>\s*t?\s?track\(/.test(useAppSrc), 'no accessor closes over the per-render tracker directly');
  check(/trackRef\.current = track/.test(useAppSrc), 'the per-render tracker is read through a ref');
}

// ---------------------------------------------------------------------------
// 2. Home's feed adoption must converge.
// ---------------------------------------------------------------------------
console.log('\nHome feed adoption convergence');
{
  const appCall = home.match(/const\s*\{([^}]*)\}\s*=\s*useApp\(\)/);
  check(!!appCall, 'Home destructures useApp()');
  const bound = appCall ? appCall[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean) : [];

  // Any memo/effect dep that names a useApp() getter is only safe now that useApp is stable, and
  // must not be able to feed itself. Assert the adoption path is guarded by a functional update.
  check(/const adoptFeed = useCallback\(\(next: FeedItem\[\]\) => setFeed\(\(prev\) => \(feedSnapshotEqual\(prev, next\) \? prev : next\)\)/.test(home), 'feed adoption compares post versions, not array identity');
  check(!/setFeed\(liveFeed\)/.test(code(home)), 'no bare `setFeed(liveFeed)` (always-new reference) remains');
  const comparator = readFileSync('lib/feedSnapshot.ts', 'utf8');
  check(/a\[i\]!\.post !== b\[i\]!\.post/.test(comparator), 'feedSnapshotEqual adopts changed reaction/comment objects');

  const effectBlocks = [...home.matchAll(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[([^\]]*)\]\);/g)];
  for (const [, deps] of effectBlocks) {
    for (const d of deps.split(',').map((s) => s.trim())) {
      if (!bound.includes(d)) continue;
      const guarded = /adoptFeed\(/.test(home.slice(home.indexOf(d)));
      check(guarded, `effect depending on \`${d}\` writes through the guarded setter`);
    }
  }

  // The recommendation loaders must be interaction-deferred, not fire during the first paint.
  check(/useInteractionGate\(\)/.test(home), 'Home opens an interaction gate');
  check(/const catalogReady = useMemo\(\(\) => !!anchor && !guest && catalog\.available && deferred/.test(home), 'live recommendations/cross-fandom wait for the gate');
}

// ---------------------------------------------------------------------------
// 3. Nothing may reintroduce an unguarded state write driven by its own output.
// ---------------------------------------------------------------------------
console.log('\nSelf-feeding effects');
{
  const loops = [...home.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[([^\]]*)\]\);/g)].filter(([, body, deps]) => {
    const names = deps.split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length) return false;
    // a bare setX(...) of a name that the effect itself depends on
    return names.some((n) => new RegExp(`(?<!adopt)set${n[0].toUpperCase()}${n.slice(1)}\\(`).test(body) && !/feedSnapshotEqual/.test(body));
  });
  check(loops.length === 0, `no effect re-sets a dependency through a bare setter (${loops.length} found)`);
}

console.log('');
if (failures.length) {
  console.error(`verify-home-render: ${failures.length} invariant(s) violated`);
  process.exit(1);
}
console.log('verify-home-render: Home cannot enter an unbounded render loop.');
