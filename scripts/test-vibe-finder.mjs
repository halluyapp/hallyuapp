// Unit checks for lib/vibeFinder.ts. The fixtures below are test data only: they exist to check
// filtering and explanations, and they never reach the app or the catalogue.
// Runs under plain `node --test`; the TypeScript is transpiled on the fly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 } }).outputText;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hallyu-vibe-'));
  const file = path.join(dir, path.basename(rel).replace(/\.ts$/, '.mjs'));
  fs.writeFileSync(file, out);
  return import(pathToFileURL(file).href);
}

const { parseVibeQuery, rankVibeResults, worldOf, describeVibeQuery } = await load('lib/vibeFinder.ts');

// ---- parser -------------------------------------------------------------------------------------

test('reads a dark historical K-Drama with political intrigue and revenge', () => {
  const q = parseVibeQuery('A dark historical K-Drama with political intrigue and revenge.');
  assert.equal(q.world, 'kdrama');
  assert.deepEqual(q.genres, ['Historical']);
  assert.ok(q.moods.includes('dark') && q.moods.includes('political intrigue') && q.moods.includes('revenge'));
  assert.equal(q.interpreter, 'rules');
});

test('reads a completed C-Drama with a strong female lead', () => {
  const q = parseVibeQuery('A completed C-Drama with a powerful female lead and slow-burn romance.');
  assert.equal(q.world, 'cdrama');
  assert.equal(q.status, 'completed');
  assert.deepEqual(q.genres, ['Romance']);
  assert.ok(q.moods.includes('strong female lead') && q.moods.includes('slow-burn'));
});

test('negated genre goes to avoidGenres, not genres', () => {
  const q = parseVibeQuery('Anime with clever battles and little romance.');
  assert.equal(q.world, 'anime');
  assert.ok(q.genres.includes('Action'));
  assert.deepEqual(q.avoidGenres, ['Romance']);
});

test('short series maps to a series episode cap', () => {
  const q = parseVibeQuery('A short series with a satisfying ending.');
  assert.equal(q.maxEpisodes, 16);
  assert.equal(q.mediaType, 'tv');
});

test('a film request is read as a movie', () => {
  const q = parseVibeQuery('A Hollywood mystery movie that keeps me guessing');
  assert.equal(q.world, 'hollywood');
  assert.equal(q.mediaType, 'movie');
  assert.ok(q.genres.includes('Mystery'));
});

test('avoid-completed phrasing sets excludeCompleted', () => {
  assert.equal(parseVibeQuery('Recommend a new show, but avoid anything I have already completed.').excludeCompleted, true);
});

test('less tragic sets an avoid-mood instead of a genre', () => {
  const q = parseVibeQuery('Something like my favourite drama, but less tragic.');
  assert.deepEqual(q.avoidMoods, ['tragic']);
  assert.deepEqual(q.genres, []);
});

test('an unreadable request reports zero signals, so the caller falls back to text matching', () => {
  assert.equal(parseVibeQuery('qwerty zxcvb').signalCount, 0);
  assert.equal(parseVibeQuery('').signalCount, 0);
});

test('conflicting worlds are not guessed', () => {
  assert.equal(parseVibeQuery('Korean or Japanese anime').world, null);
});

test('describeVibeQuery reports exactly what was understood', () => {
  const parts = describeVibeQuery(parseVibeQuery('A completed C-Drama with slow-burn romance'));
  assert.ok(parts.includes('C-Drama') && parts.includes('Completed') && parts.includes('Romance'));
});

// ---- ranking ------------------------------------------------------------------------------------

const base = { synopsis: '', tags: [], genres: [], rating: undefined, episodeCount: 16, seasons: [], episodes: [], cast: [], followerCount: 0, status: 'completed', tone: '#000', year: 2020, title: 'x', mediaType: 'tv' };
const fixtures = [
  { ...base, id: 'k-hist', title: 'Court Shadows', format: 'kdrama', genres: ['Historical', 'Thriller'], rating: 8.4, synopsis: 'A palace scheme and a revenge plot.', tags: ['political'] },
  { ...base, id: 'c-rom', title: 'Lantern Love', format: 'cdrama', genres: ['Romance'], rating: 7.9, episodeCount: 40, synopsis: 'Slow burn romance across seasons.' },
  { ...base, id: 'a-battle', title: 'Iron Blades', format: 'anime', genres: ['Action', 'Romance'], rating: 8.0, episodeCount: 24 },
  { ...base, id: 'a-clean', title: 'Gear Grid', format: 'anime', genres: ['Action', 'Sci-fi'], rating: 7.6, episodeCount: 12 },
  { ...base, id: 'h-movie', title: 'Night Ledger', format: 'hollywood-movie', mediaType: 'movie', genres: ['Mystery'], rating: 7.2, episodeCount: 1 },
  { ...base, id: 'h-series', title: 'Quiet Clue', format: 'hollywood-series', genres: ['Mystery'], rating: undefined, episodeCount: 8, status: 'airing' },
  { ...base, id: 'nofmt', title: 'Unknown Origin', format: undefined, genres: ['Mystery'], rating: 9, episodeCount: 6 },
  { ...base, id: 'k-dup', title: 'Court Shadows', format: 'kdrama', genres: ['Historical', 'Thriller'], rating: 8.4 },
  { ...base, id: 'k-tragic', title: 'Last Winter', format: 'kdrama', genres: ['Historical'], rating: 7.0, synopsis: 'A tragic grief-filled tale; the hero dies.' },
];

test('worldOf maps every format and refuses unknown ones', () => {
  assert.equal(worldOf({ format: 'hollywood-movie' }), 'hollywood');
  assert.equal(worldOf({ format: 'cdrama' }), 'cdrama');
  assert.equal(worldOf({ format: undefined }), null);
});

test('a requested world never returns a title from another world or an unknown one', () => {
  const r = rankVibeResults(fixtures, parseVibeQuery('K-Drama historical'));
  assert.ok(r.results.length > 0);
  for (const { drama } of r.results) assert.equal(worldOf(drama), 'kdrama');
  assert.ok(!r.results.some(({ drama }) => drama.id === 'nofmt'));
});

test('movie and series filters are respected', () => {
  const movies = rankVibeResults(fixtures, parseVibeQuery('mystery film')).results.map((r) => r.drama.id);
  assert.deepEqual(movies, ['h-movie']);
});

test('airing and completed status come from metadata', () => {
  const r = rankVibeResults(fixtures, parseVibeQuery('currently airing mystery series'));
  assert.deepEqual(r.results.map((x) => x.drama.id), ['h-series']);
});

test('a rating request never passes a title whose rating is unknown', () => {
  const r = rankVibeResults(fixtures, parseVibeQuery('highly rated mystery'));
  assert.ok(!r.results.some(({ drama }) => drama.id === 'h-series'));
  for (const { drama } of r.results) assert.ok(typeof drama.rating === 'number' && drama.rating >= 7.5);
});

test('short-series requests exclude films and titles with no known episode count', () => {
  const r = rankVibeResults([...fixtures, { ...base, id: 'k-unknown-eps', title: 'No Count', format: 'kdrama', genres: ['Romance'], rating: 8, episodeCount: 0 }], parseVibeQuery('short romance series'));
  assert.ok(!r.results.some(({ drama }) => drama.mediaType === 'movie' || drama.id === 'k-unknown-eps'));
});

test('avoided genres are removed, not merely down-ranked', () => {
  const r = rankVibeResults(fixtures, parseVibeQuery('anime with battles and little romance'));
  assert.deepEqual(r.results.map((x) => x.drama.id), ['a-clean']);
});

test('muted titles are never returned, even when they match', () => {
  const r = rankVibeResults(fixtures, parseVibeQuery('K-Drama historical'), { mutedDramaIds: ['k-hist'] });
  assert.ok(!r.results.some(({ drama }) => drama.id === 'k-hist'));
});

test('completed titles are excluded only when the member asked', () => {
  const asked = rankVibeResults(fixtures, parseVibeQuery('mystery, avoid anything I already completed'), { completedDramaIds: ['h-movie'] });
  assert.ok(!asked.results.some(({ drama }) => drama.id === 'h-movie'));
  const notAsked = rankVibeResults(fixtures, parseVibeQuery('mystery film'), { completedDramaIds: ['h-movie'] });
  assert.ok(notAsked.results.some(({ drama }) => drama.id === 'h-movie'));
});

test('duplicates are removed by id', () => {
  const r = rankVibeResults(fixtures, parseVibeQuery('K-Drama historical thriller'));
  const ids = r.results.map((x) => x.drama.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('an avoid-tragic request demotes the tragic title without hiding it', () => {
  const r = rankVibeResults(fixtures, parseVibeQuery('historical K-Drama, less tragic'));
  const ids = r.results.map((x) => x.drama.id);
  assert.ok(ids.includes('k-tragic'));
  assert.ok(ids.indexOf('k-tragic') > ids.indexOf('k-hist'));
});

test('reasons describe real matched fields only', () => {
  const r = rankVibeResults(fixtures, parseVibeQuery('K-Drama historical'));
  const top = r.results.find((x) => x.drama.id === 'k-hist');
  assert.ok(top.reasons.some((s) => s.includes('Historical')));
  for (const reason of top.reasons) assert.ok(!/must|best|amazing|perfect/i.test(reason));
});

test('a request the reader cannot interpret says so, and does not claim an AI reading', () => {
  const r = rankVibeResults(fixtures, parseVibeQuery('qwerty'));
  assert.match(r.note, /could not turn that into filters/);
  assert.ok(!/\bAI\b.*(read|understood)/.test(r.note) || /No AI model/.test(r.note));
});

test('the note never claims a model is running', () => {
  const r = rankVibeResults(fixtures, parseVibeQuery('dark K-Drama'));
  assert.match(r.note, /No AI model is connected/);
});

test('results are capped', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ ...base, id: `m${i}`, title: `T${i}`, format: 'anime', genres: ['Action'], rating: 7 }));
  assert.equal(rankVibeResults(many, parseVibeQuery('anime action')).results.length, 12);
});
