// Unit checks for the Book Tracker and Viewing Diary pure rules (lib/bookRules.ts, lib/diaryRules.ts).
// The TypeScript sources are transpiled on the fly so this runs under plain `node --test`.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hallyu-bookdiary-'));
  const file = path.join(dir, path.basename(rel).replace(/\.ts$/, '.mjs'));
  fs.writeFileSync(file, out);
  return import(pathToFileURL(file).href);
}

const book = await load('lib/bookRules.ts');
const diary = await load('lib/diaryRules.ts');

const draft = (over = {}) => ({ title: 'Notebook', authors: '', year: '', pages: '', coverUrl: '', isbn: '', notes: '', ...over });

// ─── Book: progress never negative, never past the total, unknown length tolerated ─────────────

test('progress: rejects negative, decimal, blank and over-total input', () => {
  assert.equal(book.parseProgress('-3', 300).ok, false);
  assert.equal(book.parseProgress('12.5', 300).ok, false);
  assert.equal(book.parseProgress('', 300).ok, false);
  assert.equal(book.parseProgress('301', 300).ok, false);
  assert.equal(book.parseProgress('300', 300).ok, true);
  assert.equal(book.parseProgress('0', 300).value, 0);
});

test('progress: unknown length accepts any whole page up to the global cap', () => {
  assert.equal(book.parseProgress('5000', null).ok, true);
  assert.equal(book.parseProgress('20001', null).ok, false);
});

test('percent is null for unknown length and clamped for known length', () => {
  assert.equal(book.progressPercent(50, null), null);
  assert.equal(book.progressPercent(0, 200), 0);
  assert.equal(book.progressPercent(50, 200), 25);
  assert.equal(book.progressPercent(999, 200), 100);
});

test('effective total prefers the member override over the catalogue count', () => {
  assert.equal(book.effectiveTotal({ pageCount: 512, totalPagesOverride: 480 }), 480);
  assert.equal(book.effectiveTotal({ pageCount: null, totalPagesOverride: null }), null);
  assert.equal(book.effectiveTotal({ pageCount: 120, totalPagesOverride: null }), 120);
});

test('pages read: 1 to 2000 whole numbers', () => {
  assert.equal(book.parsePagesRead('0').ok, false);
  assert.equal(book.parsePagesRead('2001').ok, false);
  assert.equal(book.parsePagesRead('abc').ok, false);
  assert.equal(book.parsePagesRead(' 12 ').value, 12);
});

test('total pages: blank means unknown, otherwise 1 to 20000', () => {
  assert.deepEqual(book.parseTotalPages(''), { ok: true, value: null });
  assert.equal(book.parseTotalPages('0').ok, false);
  assert.equal(book.parseTotalPages('20001').ok, false);
  assert.equal(book.parseTotalPages('320').value, 320);
});

test('rating: only whole numbers 1 to 5 survive, null clears', () => {
  assert.equal(book.parseRating(null), null);
  assert.equal(book.parseRating(0), null);
  assert.equal(book.parseRating(6), null);
  assert.equal(book.parseRating(2.5), null);
  assert.equal(book.parseRating(4), 4);
});

test('shelves include Dropped', () => {
  assert.deepEqual(book.SHELF_ORDER, ['want', 'reading', 'finished', 'dropped']);
  assert.equal(book.SHELF_LABELS.dropped, 'Dropped');
});

// ─── Book: manual entry is independent of Open Library ─────────────────────────────────────────

test('manual book: title alone is enough', () => {
  const r = book.validateManualBook(draft({ title: '  Handmade Notebook  ' }), 2026);
  assert.equal(r.ok, true);
  assert.equal(r.value.title, 'Handmade Notebook');
  assert.deepEqual(r.value.authors, []);
  assert.equal(r.value.pageCount, null);
  assert.equal(r.value.coverUrl, null);
  assert.equal(r.value.isbn13, null);
  assert.equal(r.value.note, null);
});

test('manual book: blank title is refused with a field message', () => {
  const r = book.validateManualBook(draft({ title: '   ' }), 2026);
  assert.equal(r.ok, false);
  assert.match(r.errors.title, /required/);
});

test('manual book: all optional fields round-trip', () => {
  const r = book.validateManualBook(
    draft({
      title: 'Field Guide',
      authors: 'A. Writer; B. Editor\nC. Reader',
      year: '2024',
      pages: '240',
      coverUrl: 'https://example.com/cover.jpg',
      isbn: '978-0-306-40615-7',
      notes: '  Lent by a friend  ',
    }),
    2026,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.authors, ['A. Writer', 'B. Editor', 'C. Reader']);
  assert.equal(r.value.firstPublishYear, 2024);
  assert.equal(r.value.pageCount, 240);
  assert.equal(r.value.isbn13, '9780306406157');
  assert.equal(r.value.note, 'Lent by a friend');
});

test('manual book: rejects bad year, insecure cover, bad ISBN and long notes', () => {
  const r = book.validateManualBook(
    draft({ title: 'X', year: '3000', coverUrl: 'http://insecure.example/a.jpg', isbn: '12345', notes: 'n'.repeat(281) }),
    2026,
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.year);
  assert.ok(r.errors.coverUrl);
  assert.ok(r.errors.isbn);
  assert.ok(r.errors.notes);
});

test('manual book: identical titles are allowed (no client-side duplicate block)', () => {
  const a = book.validateManualBook(draft({ title: 'Notebook' }), 2026);
  const b = book.validateManualBook(draft({ title: 'Notebook' }), 2026);
  assert.equal(a.ok && b.ok, true);
});

test('authors: at most 10, blanks dropped, each capped at 200 characters', () => {
  const many = Array.from({ length: 14 }, (_, i) => `Author ${i}`).join(', ');
  assert.equal(book.parseAuthors(many).length, 10);
  assert.deepEqual(book.parseAuthors(' , ;  '), []);
  assert.equal(book.parseAuthors('x'.repeat(250))[0].length, 200);
});

// ─── Book: search states never present an error as "no results" ───────────────────────────────

test('search state: error is distinct from empty and from loading', () => {
  assert.equal(book.searchState({ query: '', loading: false, error: null, hitCount: 0 }), 'idle');
  assert.equal(book.searchState({ query: 'a', loading: false, error: null, hitCount: 0 }), 'short');
  assert.equal(book.searchState({ query: 'pachinko', loading: true, error: null, hitCount: 0 }), 'loading');
  assert.equal(book.searchState({ query: 'pachinko', loading: false, error: 'timeout', hitCount: 0 }), 'error');
  assert.equal(book.searchState({ query: 'pachinko', loading: false, error: null, hitCount: 0 }), 'empty');
  assert.equal(book.searchState({ query: 'pachinko', loading: false, error: null, hitCount: 3 }), 'results');
});

// ─── Book: idempotency keys and details patches ───────────────────────────────────────────────

test('client keys: distinct per attempt, within the server length limits', () => {
  const k1 = book.makeClientKey('read', 1700000000000, () => 0.1);
  const k2 = book.makeClientKey('read', 1700000000000, () => 0.2);
  assert.notEqual(k1, k2);
  assert.ok(k1.length >= 8 && k1.length <= 120);
});

test('details patch carries only changed fields and uses null to clear', () => {
  const before = { rating: 4, note: 'old', startedOn: '2026-10-01', finishedOn: null, totalPages: 300 };
  const same = { ...before };
  assert.deepEqual(book.detailsPatch(before, same), {});
  const cleared = { ...before, rating: null, note: null };
  assert.deepEqual(book.detailsPatch(before, cleared), { rating: null, note: '' });
  const moved = { ...before, totalPages: null, finishedOn: '2026-10-20' };
  assert.deepEqual(book.detailsPatch(before, moved), { finished_on: '2026-10-20', total_pages: null });
});

test('ISBN and date helpers reject impossible values', () => {
  assert.equal(book.cleanIsbn('').value, null);
  assert.equal(book.cleanIsbn('0-306-40615-2').ok, true);
  assert.equal(book.cleanIsbn('123').ok, false);
  assert.equal(book.isValidDateKey('2026-02-28'), true);
  assert.equal(book.isValidDateKey('2026-02-30'), false);
  assert.equal(book.isValidDateKey('26-10-01'), false);
});

// ─── Diary: day grouping, merging, labels, coverage and rejections ─────────────────────────────

test('grouping: one group per calendar day, newest first, no duplicate keys', () => {
  const rows = [
    { id: 'a', watchedOn: '2026-10-03' },
    { id: 'b', watchedOn: '2026-10-03' },
    { id: 'c', watchedOn: '2026-10-01' },
    { id: 'b', watchedOn: '2026-10-03' }, // duplicate id from an overlapping page is dropped
    { id: 'd', watchedOn: '2026-10-03' }, // backdated row for the same day stays in that day
  ];
  const groups = diary.groupByDay(rows);
  assert.deepEqual(groups.map((g) => g.key), ['2026-10-03', '2026-10-01']);
  assert.deepEqual(groups[0].items.map((i) => i.id), ['a', 'b', 'd']);
  assert.equal(new Set(groups.map((g) => g.key)).size, groups.length);
});

test('merging pages keeps order and drops ids already shown', () => {
  const merged = diary.mergePages([{ id: '1' }, { id: '2' }], [{ id: '2' }, { id: '3' }]);
  assert.deepEqual(merged.map((m) => m.id), ['1', '2', '3']);
});

test('day labels use the member local day for Today and Yesterday', () => {
  assert.equal(diary.dayLabel('2026-10-24', '2026-10-24'), 'Today');
  assert.equal(diary.dayLabel('2026-10-23', '2026-10-24'), 'Yesterday');
  assert.equal(diary.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(diary.addDays('2028-02-28', 1), '2028-02-29');
  assert.match(diary.dayLabel('2026-09-01', '2026-10-24'), /2026/);
});

test('day keys: impossible calendar dates are rejected', () => {
  assert.equal(diary.isValidDayKey('2026-02-29'), false);
  assert.equal(diary.isValidDayKey('2028-02-29'), true);
});

test('runtime coverage is stated, never hidden', () => {
  assert.equal(diary.runtimeCoverageLine(0, 0), null);
  assert.equal(diary.runtimeCoverageLine(5, 0), 'Runtime known for every entry.');
  assert.equal(diary.runtimeCoverageLine(2, 3), 'Runtime known for 2 of 5 entries. Minutes count only those.');
});

test('import rejections are grouped by reason with row numbers', () => {
  const summary = diary.summarizeRejections([
    { index: 0, reason: 'daily diary limit of 60 entries reached' },
    { index: 4, reason: 'daily diary limit of 60 entries reached' },
    { index: 9, reason: 'title x does not exist' },
  ]);
  assert.equal(summary[0].count, 2);
  assert.deepEqual(summary[0].rows, [1, 5]);
  assert.equal(summary[1].reason, 'title x does not exist');
  assert.equal(diary.friendlyImportReason('title x does not exist'), 'That title is not in the catalogue.');
});
