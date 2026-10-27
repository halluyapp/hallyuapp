// Unit checks for the pure helpers behind Where-to-watch links, diary CSV import and shelf layout.
// The TypeScript sources are transpiled on the fly so this runs under plain `node --test`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 } }).outputText;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hallyu-test-'));
  const file = path.join(dir, path.basename(rel).replace(/\.ts$/, '.mjs'));
  fs.writeFileSync(file, out);
  return import(pathToFileURL(file).href);
}

const csv = await load('lib/diaryCsv.ts');
const links = await load('lib/whereToWatch.ts');
const shelf = await load('lib/shelfLayout.ts');

test('CSV: header mapping, quoted commas, CRLF and BOM', () => {
  const text = '\uFEFFDate,Name,Year,Letterboxd URI,Rating\r\n2026-10-01,"Parasite, the film",2019,https://x,4.5\r\n';
  const { rows, skipped } = csv.parseDiaryCsv(text);
  assert.equal(skipped, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Parasite, the film');
  assert.equal(rows[0].year, 2019);
  assert.equal(rows[0].watchedOn, '2026-10-01');
  assert.equal(rows[0].rating, 5, 'half stars round to whole stars within 1..5');
});

test('CSV: half-star ratings clamp to 1..5 and missing ratings stay null', () => {
  const text = 'Date,Name,Year,Rating\n2026-10-01,A,2001,0.5\n2026-10-02,B,2002,3.5\n2026-10-03,C,2003,\n';
  const { rows } = csv.parseDiaryCsv(text);
  assert.deepEqual(rows.map((r) => r.rating), [1, 4, null]);
});

test('CSV: rows without a title or a readable date are skipped and counted', () => {
  const text = 'Date,Name,Year\n2026-10-01,,2001\nnot-a-date,Real,2002\n2026-10-03,Good,2003\n';
  const { rows, skipped } = csv.parseDiaryCsv(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Good');
  assert.equal(skipped, 2);
});

test('CSV: missing required columns imports nothing', () => {
  const { rows } = csv.parseDiaryCsv('Title only\nA\nB\n');
  assert.equal(rows.length, 0);
});

test('CSV: escaped double quotes survive', () => {
  const { rows } = csv.parseDiaryCsv('Date,Name,Year\n2026-10-01,"He said ""hi""",2020\n');
  assert.equal(rows[0].title, 'He said "hi"');
});

test('Where to watch: only Netflix, Viki and Disney+ get official links', () => {
  const n = links.officialWatchLink('Netflix', 'Pachinko');
  assert.equal(n.service, 'netflix');
  assert.equal(n.url, 'https://www.netflix.com/search?q=Pachinko');
  assert.equal(links.officialWatchLink('Rakuten Viki', 'Boys Over Flowers').url, 'https://www.viki.com/search?q=Boys%20Over%20Flowers');
  assert.equal(links.officialWatchLink('Disney+', 'Anything').url, 'https://www.disneyplus.com/home');
  assert.equal(links.officialWatchLink('Crunchyroll', 'Anything'), null, 'unsupported services stay plain labels');
  assert.equal(links.officialWatchLink('iQIYI', 'Anything'), null);
});

test('Where to watch: every link is https and points at an official host', () => {
  const hosts = links.exploreWatchLinks('x').map((l) => new URL(l.url));
  for (const u of hosts) {
    assert.equal(u.protocol, 'https:');
    assert.match(u.hostname, /(^|\.)(netflix\.com|viki\.com|disneyplus\.com)$/);
  }
});

test('Shelf packing: lines never exceed the width and keep order', () => {
  const spines = [
    { id: 'a', title: 'A', width: 40, color: '#000' },
    { id: 'b', title: 'B', width: 40, color: '#000' },
    { id: 'c', title: 'C', width: 40, color: '#000' },
    { id: 'd', title: 'D', width: 90, color: '#000' },
  ];
  const lines = shelf.packSpines(spines, 100);
  assert.deepEqual(lines.map((l) => l.map((s) => s.id)), [['a', 'b'], ['c'], ['d']]);
  const wide = shelf.packSpines(spines.slice(0, 2), 200);
  assert.deepEqual(wide.map((l) => l.map((s) => s.id)), [['a', 'b']]);
  for (const line of shelf.packSpines(spines, 100)) {
    const used = line.reduce((sum, s, i) => sum + s.width + (i ? 2 : 0), 0);
    assert.ok(used <= 100 || line.length === 1, 'a single spine may overflow only when it cannot fit at all');
  }
  assert.deepEqual(shelf.packSpines([], 100), []);
});
