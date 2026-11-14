// Unit checks for lib/subtitles.ts: SRT and WebVTT parsing and cue lookup by playback time.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hallyu-subs-'));
  const file = path.join(dir, path.basename(rel).replace(/\.ts$/, '.mjs'));
  fs.writeFileSync(file, out);
  return import(pathToFileURL(file).href);
}

const S = await load('lib/subtitles.ts');

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  'Hello there.',
  '',
  '2',
  '00:01:02,250 --> 00:01:04,000',
  '<i>Second</i> line',
  'with two rows',
  '',
  '3',
  '01:00:00,000 --> 01:00:02,000',
  'An hour in.',
  '',
].join('\r\n');

const VTT = [
  'WEBVTT',
  '',
  'NOTE this is a comment',
  '',
  '00:02.000 --> 00:04.000 align:start',
  '<c.yellow>Short form</c>',
  '',
  'intro --> the cue id line is not a timing line',
  '00:10.500 --> 00:12.000',
  'Ten seconds in',
  '',
].join('\n');

test('subtitles: SRT with CRLF, comma decimals, markup and multi-line cues', () => {
  assert.equal(S.detectSubtitleFormat(SRT), 'srt');
  const cues = S.parseSubtitles(SRT);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues[0], { startMs: 1000, endMs: 3500, text: 'Hello there.' });
  assert.deepEqual(cues[1], { startMs: 62250, endMs: 64000, text: 'Second line\nwith two rows' });
  assert.equal(cues[2].startMs, 3600000);
});

test('subtitles: WebVTT with NOTE blocks, short timestamps and cue settings', () => {
  assert.equal(S.detectSubtitleFormat(VTT), 'vtt');
  const cues = S.parseSubtitles(VTT);
  assert.deepEqual(cues, [
    { startMs: 2000, endMs: 4000, text: 'Short form' },
    { startMs: 10500, endMs: 12000, text: 'Ten seconds in' },
  ]);
});

test('subtitles: a byte-order mark is accepted', () => {
  assert.equal(S.parseSubtitles('\uFEFF' + SRT).length, 3);
});

test('subtitles: an HTML page, JSON or empty text is not a subtitle file', () => {
  assert.equal(S.detectSubtitleFormat('<html><body>Not found</body></html>'), null);
  assert.equal(S.detectSubtitleFormat('{"error":"expired"}'), null);
  assert.deepEqual(S.parseSubtitles(''), []);
  assert.deepEqual(S.parseSubtitles('<html>--></html>'), []);
});

test('subtitles: a cue that ends before it starts is dropped, not shown at the wrong time', () => {
  const bad = '1\n00:00:05,000 --> 00:00:02,000\nBackwards\n\n2\n00:00:06,000 --> 00:00:07,000\nFine\n';
  assert.deepEqual(S.parseSubtitles(bad), [{ startMs: 6000, endMs: 7000, text: 'Fine' }]);
});

test('lookup: the cue for a playback position, nothing between cues, and seeking both ways', () => {
  const cues = S.parseSubtitles(SRT);
  assert.equal(S.cueTextAt(cues, 0), null);
  assert.equal(S.cueTextAt(cues, 1000), 'Hello there.');
  assert.equal(S.cueTextAt(cues, 3500), null, 'end time is exclusive');
  assert.equal(S.cueTextAt(cues, 63000), 'Second line\nwith two rows');
  // Seeking backward then forward again lands on the correct cue with no state carried between calls.
  assert.equal(S.cueTextAt(cues, 1500), 'Hello there.');
  assert.equal(S.cueTextAt(cues, 3600500), 'An hour in.');
  assert.equal(S.cueTextAt(cues, Number.NaN), null);
  assert.equal(S.cueTextAt([], 1000), null);
});

test('lookup: overlapping cues both resolve to a visible line', () => {
  const cues = [
    { startMs: 0, endMs: 5000, text: 'First' },
    { startMs: 2000, endMs: 3000, text: 'Overlap' },
  ];
  assert.equal(S.cueTextAt(cues, 2500), 'Overlap');
  assert.equal(S.cueTextAt(cues, 4000), 'First');
});
