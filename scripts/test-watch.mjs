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

/* ---------- Player and download rules (lib/watchRules.ts) ---------- */

const R = await load('lib/watchRules.ts');

test('clock: m:ss under an hour, h:mm:ss past it, unknown reads as 0:00', () => {
  assert.equal(R.formatClock(0), '0:00');
  assert.equal(R.formatClock(65_400), '1:05');
  assert.equal(R.formatClock(3_725_000), '1:02:05');
  assert.equal(R.formatClock(null), '0:00');
  assert.equal(R.formatClock(Number.NaN), '0:00');
  assert.equal(R.formatClock(-5), '0:00');
});

test('seek: clamps to the start and to the known duration', () => {
  assert.equal(R.seekTarget(4_000, -10_000, 60_000), 0);
  assert.equal(R.seekTarget(55_000, 10_000, 60_000), 60_000);
  assert.equal(R.seekTarget(20_000, 10_000, 0), 30_000); // unknown duration: no upper clamp
});

test('tap zones: left and right thirds skip, the centre toggles controls', () => {
  assert.equal(R.tapZone(50, 400), 'left');
  assert.equal(R.tapZone(200, 400), 'centre');
  assert.equal(R.tapZone(350, 400), 'right');
  assert.equal(R.fractionAt(10, 0), 0);
});

test('quality: only offered qualities are chosen; preference, then 480p, 360p, then best', () => {
  assert.equal(R.chooseQuality(['1080p', '720p', '480p'], '720p'), '720p');
  assert.equal(R.chooseQuality(['1080p', '720p', '480p'], '360p'), '480p');
  assert.equal(R.chooseQuality(['1080p', '720p'], null), '1080p');
  assert.equal(R.chooseQuality(['360p', '1080p'], null), '360p');
  assert.equal(R.chooseQuality([], '480p'), null);
});

test('quality: labels are sorted by their real number; unknown labels never get a guessed rank', () => {
  assert.deepEqual(R.sortQualities(['480p', '1080p', 'Auto', '720p', '480p']), ['1080p', '720p', '480p', 'Auto']);
  assert.equal(R.qualityRank('4K'), null);
  assert.equal(R.qualityRank('1080p'), 1080);
});

test('downloads: a file is complete only when its size matches the server length, when known', () => {
  assert.equal(R.transferComplete(0, null), false);
  assert.equal(R.transferComplete(1000, null), true);
  assert.equal(R.transferComplete(1000, 1000), true);
  assert.equal(R.transferComplete(900, 1000), false);
  assert.equal(R.transferComplete(-1, 1000), false);
});

test('downloads: a valid MP4 has "ftyp" at byte 4; HTML and short data are rejected', () => {
  const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  assert.equal(R.isMp4Header(mp4), true);
  assert.equal(R.isMp4Header(new TextEncoder().encode('<html><body>error</body></html>')), false);
  assert.equal(R.isMp4Header(new Uint8Array([0, 0, 0, 0x18])), false);
});

test('sizes: MB and GB formatting; unknown is never guessed', () => {
  assert.equal(R.formatBytes(null), 'Size unavailable');
  assert.equal(R.formatBytes(undefined), 'Size unavailable');
  assert.equal(R.formatBytes(-1), 'Size unavailable');
  assert.equal(R.formatBytes(300 * 1024 * 1024), '300 MB');
  assert.equal(R.formatBytes(1.5 * 1024 * 1024 * 1024), '1.50 GB');
});

test('progress: no percentage when the total is unknown', () => {
  assert.equal(R.progressFraction(50, null), null);
  assert.equal(R.progressFraction(50, 200), 0.25);
  assert.equal(R.progressFraction(300, 200), 1);
});

test('duplicates: no second active or finished copy of the same title and quality', () => {
  const active = [{ key: 'a:1:1', quality: '480p', status: 'downloading' }];
  assert.equal(R.canStartDownload(active, [], 'a:1:1', '480p').reason, 'already_downloading');
  assert.equal(R.canStartDownload([], [{ key: 'a:1:1', quality: '480p' }], 'a:1:1', '480p').reason, 'already_downloaded');
  assert.equal(R.canStartDownload(active, [], 'a:1:1', '720p').ok, true);
  assert.equal(R.canStartDownload([{ key: 'a:1:1', quality: '480p', status: 'failed' }], [], 'a:1:1', '480p').ok, true);
});

test('state: completed transfers cannot be paused; failed ones can only be retried', () => {
  assert.equal(R.canTransition('completed', 'paused'), false);
  assert.equal(R.canTransition('downloading', 'paused'), true);
  assert.equal(R.canTransition('paused', 'downloading'), true);
  assert.equal(R.canTransition('failed', 'paused'), false);
  assert.equal(R.canTransition('failed', 'downloading'), true);
});

/* ---------- Interrupted download continuation (decideAfterTransfer) ---------- */

test('a short transfer continues from the bytes on disk, not from zero', () => {
  // The connection closed at about 2 MB of a 40 MB file.
  const d = R.decideAfterTransfer({ status: 200, startBytes: 0, bytesOnDisk: 2_000_000, expectedBytes: 40_000_000, continues: 0 });
  assert.deepEqual(d, { action: 'continue', fromBytes: 2_000_000 });
});

test('a continuation answered 200 restarts the file, because appending would corrupt it', () => {
  const d = R.decideAfterTransfer({ status: 200, startBytes: 2_000_000, bytesOnDisk: 42_000_000, expectedBytes: 40_000_000, continues: 1 });
  assert.deepEqual(d, { action: 'restart' });
});

test('a continuation answered 206 that completes the length is complete', () => {
  const d = R.decideAfterTransfer({ status: 206, startBytes: 2_000_000, bytesOnDisk: 40_000_000, expectedBytes: 40_000_000, continues: 1 });
  assert.deepEqual(d, { action: 'complete' });
});

test('continuations stop after the limit and report a network failure', () => {
  const d = R.decideAfterTransfer({ status: 206, startBytes: 5_000_000, bytesOnDisk: 6_000_000, expectedBytes: 40_000_000, continues: R.MAX_AUTO_CONTINUES });
  assert.deepEqual(d, { action: 'fail', reason: 'network' });
});

test('expired links and HTTP errors are never retried silently', () => {
  assert.deepEqual(R.decideAfterTransfer({ status: 403, startBytes: 0, bytesOnDisk: 0, expectedBytes: null, continues: 0 }), { action: 'fail', reason: 'link_expired' });
  assert.deepEqual(R.decideAfterTransfer({ status: 502, startBytes: 0, bytesOnDisk: 0, expectedBytes: null, continues: 0 }), { action: 'fail', reason: 'http_error' });
});

test('a file longer than the server said is restarted, not accepted', () => {
  const d = R.decideAfterTransfer({ status: 200, startBytes: 0, bytesOnDisk: 41_000_000, expectedBytes: 40_000_000, continues: 0 });
  assert.deepEqual(d, { action: 'restart' });
});

test('an unknown length is never marked complete, even with bytes on disk', () => {
  assert.deepEqual(R.decideAfterTransfer({ status: 200, startBytes: 0, bytesOnDisk: 5, expectedBytes: null, continues: 0 }), { action: 'fail', reason: 'unknown' });
  assert.deepEqual(R.decideAfterTransfer({ status: 200, startBytes: 0, bytesOnDisk: 0, expectedBytes: null, continues: 0 }), { action: 'fail', reason: 'unknown' });
});

test('the full length is read from Content-Range of a one-byte probe', () => {
  assert.equal(R.totalFromContentRange('bytes 0-0/41943040'), 41943040);
  assert.equal(R.totalFromContentRange('bytes 0-0/*'), null);
  assert.equal(R.totalFromContentRange(null), null);
});

test('a 416 on a continuation with every byte on disk is complete, not an error', () => {
  const d = R.decideAfterTransfer({ status: 416, startBytes: 88_000_000, bytesOnDisk: 88_000_000, expectedBytes: 88_000_000, continues: 1 });
  assert.deepEqual(d, { action: 'complete' });
});

test('a 206 starting at the wrong byte restarts instead of appending at the wrong offset', () => {
  const d = R.decideAfterTransfer({ status: 206, startBytes: 2_000_000, bytesOnDisk: 4_000_000, expectedBytes: 40_000_000, continues: 0, contentRangeStart: 0 });
  assert.deepEqual(d, { action: 'restart' });
});

test('a 206 starting at the requested byte continues normally', () => {
  const d = R.decideAfterTransfer({ status: 206, startBytes: 2_000_000, bytesOnDisk: 4_000_000, expectedBytes: 40_000_000, continues: 0, contentRangeStart: 2_000_000 });
  assert.deepEqual(d, { action: 'continue', fromBytes: 4_000_000 });
});

test('a dropped connection reports the bytes reached', () => {
  assert.match(R.lostMessage(83 * 1024 * 1024, 84 * 1024 * 1024), /Connection lost at 83 MB of 84 MB/);
});

test('the failure message states how far the transfer got', () => {
  const msg = R.stoppedMessage(2 * 1024 * 1024, 40 * 1024 * 1024, 200);
  assert.match(msg, /Stopped at 2 MB of 40 MB/);
});
