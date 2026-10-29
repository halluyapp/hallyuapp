// Unit tests for lib/watchSubtitleDownload.ts: offline subtitle file paths.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function load(rel) {
  let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  // Strip expo-file-system import for node unit testing
  src = src.replace(/import\s+\*\s+as\s+FileSystem\s+from\s+['"]expo-file-system['"];?/, 'const FileSystem = {};');
  src = src.replace(/import\s+.*from\s+['"]\.\/api\/subtitles['"];?/, 'const fetchCaptionCues = async () => ({ ok: false }), fetchMovieboxCaptions = async () => ({ ok: false }), fetchOpenSubtitleCues = async () => ({ ok: false }), searchOpenSubtitles = async () => ({ ok: false });');
  const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 } }).outputText;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hallyu-subs-dl-'));
  const file = path.join(dir, path.basename(rel).replace(/\.ts$/, '.mjs'));
  fs.writeFileSync(file, out);
  return import(pathToFileURL(file).href);
}

const SD = await load('lib/watchSubtitleDownload.ts');

test('watchSubtitleDownload: subtitleFileUriFor appends .subtitles.json', () => {
  const uri = 'file:///documentDirectory/watch-downloads/item_101.mp4';
  assert.equal(SD.subtitleFileUriFor(uri), 'file:///documentDirectory/watch-downloads/item_101.mp4.subtitles.json');
});

test('watchSubtitleDownload: offline subtitle helpers fail-safe when FileSystem is unconfigured', async () => {
  assert.equal(await SD.saveSubtitleForDownload({ subjectId: '123' }, ''), false);
  assert.equal(await SD.readLocalSubtitle(''), null);
});
