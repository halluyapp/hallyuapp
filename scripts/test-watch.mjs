// Unit checks for lib/watchModel.ts (the Watch response normalisers). Fixtures mirror the field names
// seen in live `moviebox` responses on 2026-10-24: home rows (banner.items or subjects), search
// data.items, detail subject + resource.seasons, and stream data.streams. Values are trimmed test data.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hallyu-watch-'));
  const file = path.join(dir, path.basename(rel).replace(/\.ts$/, '.mjs'));
  fs.writeFileSync(file, out);
  return import(pathToFileURL(file).href);
}

const { normaliseHome, normaliseSearch, normaliseDetail, normaliseStreams, normalisePlayback, isDownloadable, isFullStream, pickStream, qualityOptions, normaliseDiagnostics, MIN_FULL_DOWNLOAD_BYTES } = await load('lib/watchModel.ts');

const subject = (id, title, extra = {}) => ({
  subjectId: id,
  subjectType: 2,
  title,
  releaseDate: '2025-06-27',
  genre: 'Action,Crime,Drama',
  cover: { url: `https://pbcdnw.aoneroom.com/image/${id}.jpg`, width: 260, height: 390 },
  countryName: 'Korea',
  imdbRatingValue: '7.9',
  detailPath: `${title.toLowerCase().replace(/\W+/g, '-')}-${id.slice(0, 6)}`,
  ...extra,
});

test('home: banner rows read banner.items[].subject, subject rows read subjects[]', () => {
  const rows = normaliseHome({
    operatingList: [
      { type: 'BANNER', title: 'Banner_Africa', subjects: [], banner: { items: [{ subjectId: '536473933005177184', subject: subject('536473933005177184', 'Lupin [English]', { detailPath: 'lupin-english-UqNLZqu3DD' }), detailPath: 'lupin-english-UqNLZqu3DD' }] } },
      { type: 'SPORT_LIVE', title: 'Live', subjects: [] },
      { type: 'SUBJECTS_MOVIE', title: 'Popular Series', subjects: [subject('3089349649006742360', 'Squid Game S3')] },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Banner_Africa');
  assert.equal(rows[0].items[0].title, 'Lupin [English]');
  assert.equal(rows[0].items[0].detailPath, 'lupin-english-UqNLZqu3DD');
  assert.equal(rows[1].items[0].rating, '7.9');
  assert.equal(rows[1].items[0].cover, 'https://pbcdnw.aoneroom.com/image/3089349649006742360.jpg');
});

test('home: malformed payloads give an empty list, never a throw', () => {
  assert.deepEqual(normaliseHome(null), []);
  assert.deepEqual(normaliseHome({ operatingList: 'nope' }), []);
  assert.deepEqual(normaliseHome({ operatingList: [{ title: 'x', subjects: [{ title: 'no id' }] }] }), []);
});

test('search: data.items[] become titles; records without id or title are dropped', () => {
  const items = normaliseSearch({ items: [subject('3089349649006742360', 'Squid Game S3'), { subjectId: '', title: 'x' }, { title: 'no id' }], pager: { hasMore: true } });
  assert.equal(items.length, 1);
  assert.equal(items[0].subjectId, '3089349649006742360');
});

test('detail: seasons come from resource.seasons and keep only usable entries', () => {
  const d = normaliseDetail({
    subject: { ...subject('536473933005177184', 'Lupin [English] S1-S4'), description: 'Inspired by the adventures of Lupin.' },
    resource: { source: 'fzmovies.cms', seasons: [{ se: 1, maxEp: 5 }, { se: 2, maxEp: 5 }, { se: 0, maxEp: 3 }, { se: 4, maxEp: 0 }] },
  });
  assert.equal(d.title, 'Lupin [English] S1-S4');
  assert.equal(d.description, 'Inspired by the adventures of Lupin.');
  assert.deepEqual(d.seasons, [{ se: 1, maxEp: 5 }, { se: 2, maxEp: 5 }]);
});

test('detail: a movie has no seasons', () => {
  const d = normaliseDetail({ subject: subject('1180525116611069248', 'Some Film'), resource: { seasons: [] } });
  assert.deepEqual(d.seasons, []);
});

test('streams: metadata only, never a URL or headers, and drops entries that are not full-length', () => {
  const s = normaliseStreams({
    subject_id: '536473933005177184',
    season: 1,
    episode: 1,
    streams: [
      { url: 'https://bcdnxw.hakunaymatata.com/x/a.mp4?sig=1', source: 'Web CDN (https://123moviesfree.club)', quality: '1080p', quality_value: 1080, format: 'MP4', codec: 'hevc', size_mb: 1400, duration_sec: 2700, required_headers: { Referer: 'https://123moviesfree.club/' } },
      { quality: '720p', format: 'MP4' },
    ],
  });
  assert.equal(s.season, 1);
  assert.equal(s.episode, 1);
  assert.equal(s.streams.length, 1);
  assert.equal(s.streams[0].quality, '1080p');
  assert.equal('url' in s.streams[0], false);
  assert.equal('requiredHeaders' in s.streams[0], false);
});

test('downloads: only progressive MP4 is offered as a file; DASH never is', () => {
  assert.equal(isDownloadable({ format: 'MP4' }), true);
  assert.equal(isDownloadable({ format: 'mp4' }), true);
  assert.equal(isDownloadable({ format: 'DASH' }), false);
  assert.equal(isDownloadable({ format: null }), false);
});

test('downloads: a full file must be at least 50 MB', () => {
  assert.equal(MIN_FULL_DOWNLOAD_BYTES, 50 * 1024 * 1024);
});

const raw = (over) => ({ source: 'Web CDN', quality: '720p', quality_value: 720, format: 'MP4', size_mb: 900, duration_sec: 2700, ...over });

test('streams: rejects Mobile Native previews even when labelled 1080p', () => {
  const r = normaliseStreams({ streams: [raw({ source: 'Mobile Native CDN', quality: '1080p', quality_value: 1080, size_mb: 0.8, duration_sec: 23 })] });
  assert.equal(r.streams.length, 0);
});

test('streams: rejects 300 seconds or less, unknown duration, and 50 MB or less', () => {
  assert.equal(isFullStream({ source: 'Web CDN', durationSec: 300, sizeMb: 900 }), false);
  assert.equal(isFullStream({ source: 'Web CDN', durationSec: null, sizeMb: 900 }), false);
  assert.equal(isFullStream({ source: 'Web CDN', durationSec: 2700, sizeMb: 50 }), false);
  assert.equal(isFullStream({ source: 'Web CDN', durationSec: 301, sizeMb: 51 }), true);
});

test('streams: sorts MP4 before DASH, then higher quality first', () => {
  const r = normaliseStreams({ streams: [
    raw({ format: 'DASH', quality: '1080p', quality_value: 1080 }),
    raw({ quality: '480p', quality_value: 480 }),
    raw({ quality: '1080p', quality_value: 1080 }),
  ] });
  assert.deepEqual(r.streams.map((s) => [s.format, s.quality]), [['MP4', '1080p'], ['MP4', '480p'], ['DASH', '1080p']]);
});

test('pickStream: requested quality first, never a preview, never blindly streams[0]', () => {
  const streams = normaliseStreams({ streams: [raw({ quality: '1080p', quality_value: 1080 }), raw({ quality: '480p', quality_value: 480 })] }).streams;
  assert.equal(pickStream(streams, '480p').quality, '480p');
  assert.equal(pickStream(streams, '1080p').quality, '1080p');
  assert.equal(pickStream(streams, '4K').quality, '480p');
  assert.equal(pickStream([]), undefined);
  assert.deepEqual(qualityOptions(streams), ['1080p', '480p']);
});

test('streams: a mixed list keeps only the full-length entries', () => {
  const r = normaliseStreams({ streams: [raw({ source: 'Mobile Native CDN', quality: '1080p', quality_value: 1080, size_mb: 0.8, duration_sec: 23 }), raw({ quality: '720p', quality_value: 720 })] });
  assert.deepEqual(r.streams.map((s) => s.quality), ['720p']);
});

test('live fixture (2026-10-25): full Web CDN MP4s pass, the Mobile Native clip is rejected', () => {
  // Shape copied from moviebox v6 for Lucifer S1E1 (host bcdnxw.hakunaymatata.com). URLs trimmed.
  const r = normaliseStreams({ season: 1, episode: 1, streams: [
    { source: 'Web CDN (https://123moviesfree.club)', quality: '1080p', quality_value: 1080, format: 'MP4', size_mb: 614.5, duration_sec: 2700 },
    { source: 'Mobile Native CDN', quality: '1080p', quality_value: 1080, format: 'MP4', size_mb: 0.8, duration_sec: 23 },
    { source: 'Web DASH (https://123moviesfree.club)', quality: '1080p (Adaptive)', format: 'DASH', size_mb: 0, duration_sec: null },
  ] });
  assert.equal(r.streams.length, 1);
  assert.equal(r.streams[0].quality, '1080p');
  assert.equal(r.streams[0].durationSec, 2700);
});

test('diagnostics: maps server candidates to client shape', () => {
  const d = normaliseDiagnostics([{ host: 'macdn.aoneroom.com', source: 'Mobile Native CDN', format: 'MP4', quality: '1080p', duration_sec: 23, size_mb: 0.8, host_allowed: true, full: false }]);
  assert.deepEqual(d, [{ host: 'macdn.aoneroom.com', source: 'Mobile Native CDN', format: 'MP4', quality: '1080p', durationSec: 23, sizeMb: 0.8, hostAllowed: true, full: false }]);
  assert.deepEqual(normaliseDiagnostics(undefined), []);
});

test('playback (live 2026-10-25): Lupin S1E1 1080p proxy link passes; a short clip cannot', () => {
  const ok = normalisePlayback({ subject_id: '536473933005177184', season: 1, episode: 1, playback_url: 'https://kzxlbscfkixnswurpkzb.supabase.co/functions/v1/moviebox?action=proxy&t=abc', download_url: 'https://kzxlbscfkixnswurpkzb.supabase.co/functions/v1/moviebox?action=proxy&t=def', quality: '1080p', format: 'MP4', duration_sec: 2922, size_mb: 868.3, qualities: ['1080p', '480p'], expires_at: 1792917314771 });
  assert.equal(ok.quality, '1080p');
  assert.deepEqual(ok.qualities, ['1080p', '480p']);
  assert.match(ok.playbackUrl, /action=proxy&t=/);
  assert.equal(normalisePlayback({ playback_url: 'https://x.supabase.co/a?t=1', download_url: 'https://x.supabase.co/a?t=2', quality: '1080p', format: 'MP4', duration_sec: 23, size_mb: 0.8 }), null);
});

test('playback: rejects missing links, plain http, and too-short or too-small full-length claims', () => {
  const base = { playback_url: 'https://x.supabase.co/f?action=proxy&t=1', download_url: 'https://x.supabase.co/f?action=proxy&t=2', format: 'MP4', duration_sec: 2700, size_mb: 900 };
  assert.notEqual(normalisePlayback(base), null);
  assert.equal(normalisePlayback({ ...base, playback_url: undefined }), null);
  assert.equal(normalisePlayback({ ...base, download_url: undefined }), null);
  assert.equal(normalisePlayback({ ...base, playback_url: 'http://x.supabase.co/f?t=1' }), null);
  assert.equal(normalisePlayback({ ...base, duration_sec: 300 }), null);
  assert.equal(normalisePlayback({ ...base, duration_sec: null }), null);
  assert.equal(normalisePlayback({ ...base, size_mb: 50 }), null);
  assert.equal(normalisePlayback(null), null);
});

test('playback: a stream with no reported size still needs a full duration', () => {
  const base = { playback_url: 'https://x.supabase.co/f?t=1', download_url: 'https://x.supabase.co/f?t=2', format: 'MP4', size_mb: null };
  assert.notEqual(normalisePlayback({ ...base, duration_sec: 2700 }), null);
  assert.equal(normalisePlayback({ ...base, duration_sec: null }), null);
});

test('pickStream default: 480p, then 360p, then the best available', () => {
  const mk = (qs) => normaliseStreams({ streams: qs.map((q) => raw({ quality: q, quality_value: parseInt(q, 10) })) }).streams;
  assert.equal(pickStream(mk(['1080p', '480p', '360p']), null).quality, '480p');
  assert.equal(pickStream(mk(['1080p', '360p']), undefined).quality, '360p');
  assert.equal(pickStream(mk(['1080p', '720p']), null).quality, '1080p');
});
