// Runs the real `moviebox` edge function (supabase/functions/moviebox/index.ts) in-process. Only the network
// is replaced: the upstream answers are the zarhosting responses recorded on 2026-10-29 (trimmed to the fields
// the function reads). Covers: movie and series resolve, detail_path rule, quality default, no URLs in
// metadata, sealed proxy round trip with Range, attachment only for downloads, tamper refusal, captions as
// proxy links, trending/ranking removed, and no Megan anywhere on the path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'supabase/functions/moviebox/index.ts');

// ----- recorded upstream answers (zarhosting, 2026-10-29) -----
const STREAM_BREAKING_BAD_S1E1 = {
  subject_id: '6207982430134357800', se: 1, ep: 1, has_resource: true,
  sources: [
    { resolution: '360p', format: 'MP4', url: 'https://bcdnxw.hakunaymatata.com/bt/ad047603.mp4?sign=aaa&t=1793276780', size: '200149402', duration: 3501, codec: 'h264' },
    { resolution: '480p', format: 'MP4', url: 'https://bcdnxw.hakunaymatata.com/bt/5f906e71.mp4?sign=bbb&t=1793274840', size: '242949969', duration: 3501, codec: 'h264' },
    { resolution: '720p', format: 'MP4', url: 'https://bcdnxw.hakunaymatata.com/resource/500b601b.mp4?sign=ccc&t=1793275444', size: '684742893', duration: 3501, codec: 'h264' },
    { resolution: '1080p', format: 'MP4', url: 'https://bcdnxw.hakunaymatata.com/resource/6e866b57.mp4?sign=ddd&t=1793276177', size: '1439519712', duration: 3501, codec: 'h264' },
  ],
  hls: [], dash: [], free_episodes: 999, limited: false, note: null,
};
const STREAM_MOVIE = {
  subject_id: '3611754855066391712', se: 0, ep: 0, has_resource: true,
  sources: [
    { resolution: '360p', format: 'MP4', url: 'https://bcdnxw.hakunaymatata.com/animekai/d1f448f6.mp4?sign=eee', size: '314056334', duration: 5563, codec: 'h264' },
    { resolution: '720p', format: 'MP4', url: 'https://bcdnxw.hakunaymatata.com/animekai/5234f0c5.mp4?sign=fff', size: '779607888', duration: 5563, codec: 'h264' },
  ],
  hls: [], dash: [], free_episodes: 999, limited: false, note: null,
};
const STREAM_NO_RESOURCE = { subject_id: '100001', se: 1, ep: 1, has_resource: false, sources: [], hls: [], dash: [] };
const STREAM_PREVIEW_ONLY = {
  subject_id: '200002', se: 0, ep: 0, has_resource: true,
  sources: [{ resolution: '1080p', format: 'MP4', url: 'https://bcdnxw.hakunaymatata.com/preview.mp4?sign=p', size: '2000000', duration: 23, codec: 'h264' }],
};
const CAPTIONS_BREAKING_BAD = {
  subject_id: '6207982430134357800', se: 1, ep: 1, count: 2,
  captions: [
    { id: '1', lan: 'en', lanName: 'English', url: 'https://cacdn.hakunaymatata.com/subtitle/3d4c0c73.srt?Policy=p&Signature=s&Key-Pair-Id=k', size: '42882', delay: 0 },
    { id: '2', lan: 'fr', lanName: 'Français', url: 'https://cacdn.hakunaymatata.com/subtitle/b822e7bd.srt?Policy=p&Signature=s&Key-Pair-Id=k', size: '39521', delay: 0 },
  ],
};
const HOME = {
  status: 'success',
  sections: [
    { section: 'Banner', count: 2, items: [
      { name: 'The Dog Stars', poster_url: 'https://pbcdn.aoneroom.com/image/a.webp', slug: 'the-dog-stars-ckRYy8wX5I1', subject_id: '1436232475147128696', badge: '' },
      { name: 'Get FREE Premium!', poster_url: 'https://pbcdn.aoneroom.com/image/b.jpg', slug: '', subject_id: null, badge: null },
    ] },
    { section: 'Popular Series', count: 1, items: [
      { name: 'Lupin [English]', poster_url: 'https://pbcdnw.aoneroom.com/image/c.jpg', slug: 'lupin-english-UqNLZqu3DD', subject_id: '536473933005177184', rating: '7.5', year: '2025', genre: 'Action,Crime,Drama', type: 'tv', release_date: '2025-01-01', country: 'France' },
    ] },
  ],
};
const SEARCH_LUPIN = {
  query: 'Lupin', page: 1, count: 1, total: 132, total_pages: 6, has_more: true, next_page: 2,
  items: [{ name: 'Lupin [English] S1-S4', poster_url: 'https://pbcdnw.aoneroom.com/image/d.jpg', slug: 'lupin-english-UqNLZqu3DD', subject_id: '536473933005177184', rating: '7.5', year: '2025', genre: 'Action,Crime,Drama', type: 'tv', release_date: '2025-01-01', country: 'France', has_resource: true }],
};
const DETAIL_BREAKING_BAD = {
  code: 0, message: 'ok',
  data: {
    subject: { subjectId: '6207982430134357800', title: 'Breaking Bad', description: 'A chemistry teacher.', releaseDate: '2008-01-20', genre: 'Crime,Drama,Thriller', countryName: 'United States', imdbRate: '9.5', detailPath: 'breaking-bad-ej6Bp0MCAo7', cover: { url: 'https://pbcdnw.aoneroom.com/image/bb.jpg', width: 2000 } },
    resource: { seasons: [{ se: 1, maxEp: 7, allEp: '1,2,4,5,6,7', resolutions: [] }, { se: 2, maxEp: 13, allEp: '', resolutions: [] }] },
  },
};

// ----- harness: transpile the real function, capture its handler, and mock only the network -----
const ENV = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'svc-test-key',
  WATCH_PLAYBACK_KEY: 'x'.repeat(40),
};
let handler = null;
globalThis.Deno = {
  env: { get: (k) => ENV[k] },
  serve: (fn) => {
    handler = fn;
  },
};

const calls = [];
let mediaRange = null;
let mediaReturn429 = 0;
const mediaLog = [];
const mediaHeaders = [];
function route(url, init) {
  const u = String(url);
  calls.push(u);
  if (u.includes('movieapi.zarhosting.dpdns.org')) {
    if (u.includes('/captions')) return json(CAPTIONS_BREAKING_BAD);
    if (u.includes('/stream/3611754855066391712')) return json(STREAM_MOVIE);
    if (u.includes('/stream/100001?')) return json(STREAM_NO_RESOURCE);
    if (u.includes('/stream/200002?')) return json(STREAM_PREVIEW_ONLY);
    if (u.includes('/stream/')) return json(STREAM_BREAKING_BAD_S1E1);
    if (u.includes('/home')) return json(HOME);
    if (u.includes('/search')) return json(SEARCH_LUPIN);
    if (u.includes('/detail/')) return json(DETAIL_BREAKING_BAD);
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  }
  if (u.includes('hakunaymatata.com')) {
    mediaRange = init?.headers?.Range ?? null;
    mediaLog.push(mediaRange);
    mediaHeaders.push(init?.headers ?? {});
    if (mediaReturn429 > 0) {
      mediaReturn429 -= 1;
      return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
    }
    if (mediaRange) {
      const m = /bytes=(\d+)-(\d*)/.exec(mediaRange);
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : 999;
      return new Response('MEDIA-BYTES'.slice(0, end - start + 1), {
        status: 206,
        headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/1000`, 'accept-ranges': 'bytes' },
      });
    }
    // A whole-file answer that states no length, as the live host does for this request.
    return new Response('MEDIA-BYTES', { status: 200, headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' } });
  }
  return new Response('unexpected host', { status: 599 });
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
globalThis.fetch = async (url, init) => route(url, init);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moviebox-edge-'));
const jsFile = path.join(tmpDir, 'moviebox.mjs');
const transpiled = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
fs.writeFileSync(jsFile, transpiled);
await import(pathToFileURL(jsFile).href);
assert.equal(typeof handler, 'function', 'the function registers its handler with Deno.serve');

async function post(body, token = 'svc-test-key') {
  const req = new Request('https://proj.supabase.co/functions/v1/moviebox', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await handler(req);
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null), text: null };
}
async function get(url) {
  const res = await handler(new Request(url, { method: 'GET' }));
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const BB = { subjectId: '6207982430134357800', detailPath: 'breaking-bad-ej6Bp0MCAo7' };

test('stream: a series episode resolves to full-length streams, best first, with no URLs', async () => {
  const r = await post({ action: 'stream', ...BB, se: 1, ep: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.streams.map((s) => s.quality), ['1080p', '720p', '480p', '360p']);
  assert.equal(r.json.streams[0].format, 'MP4');
  assert.equal(r.json.streams[0].size_mb, Math.round((1439519712 / (1024 * 1024)) * 100) / 100);
  const text = JSON.stringify(r.json);
  assert.ok(!text.includes('bcdnxw'), 'no CDN host in metadata');
  assert.ok(!text.includes('sign='), 'no signed URL in metadata');
  assert.ok(!/"url"/.test(text), 'no url field in metadata');
});

test('stream: detail_path is required and sent upstream', async () => {
  const missing = await post({ action: 'stream', subjectId: BB.subjectId, se: 1, ep: 1 });
  assert.equal(missing.status, 400);
  // A season and episode no earlier test asked for, so the answer is fetched upstream and not from the cache.
  calls.length = 0;
  await post({ action: 'stream', ...BB, se: 2, ep: 3 });
  const upstream = calls.find((u) => u.includes('/stream/6207982430134357800'));
  assert.ok(upstream, 'an upstream call was made');
  assert.ok(upstream.includes('detail_path=breaking-bad-ej6Bp0MCAo7'));
  assert.ok(upstream.includes('se=2') && upstream.includes('ep=3'));
});

test('stream: a movie is requested as se=0 and ep=0', async () => {
  calls.length = 0;
  const r = await post({ action: 'stream', subjectId: '3611754855066391712', detailPath: 'lupin-iii-the-first-english-65vn4DhSNi4' });
  assert.equal(r.status, 200);
  const upstream = calls.find((u) => u.includes('/stream/3611754855066391712'));
  assert.ok(upstream.includes('se=0') && upstream.includes('ep=0'));
  assert.deepEqual(r.json.streams.map((s) => s.quality), ['720p', '360p']);
});

test('stream: no resource, and a preview-only title, are no_full_stream (404), never a crash', async () => {
  const none = await post({ action: 'stream', subjectId: '100001', detailPath: 'nothing-here-aaa111', se: 1, ep: 1 });
  assert.equal(none.status, 404);
  assert.equal(none.json.error, 'no_full_stream');
  const preview = await post({ action: 'stream', subjectId: '200002', detailPath: 'preview-only-aaa111' });
  assert.equal(preview.status, 404, 'a 23-second 1080p preview is not full-length');
});

test('playback: 360p by default, returns proxy links on this function, and the proxy streams the bytes', async () => {
  const r = await post({ action: 'playback', ...BB, se: 1, ep: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.quality, '360p');
  assert.ok(r.json.playback_url.startsWith('https://proj.supabase.co/functions/v1/moviebox?action=proxy&t='));
  assert.ok(r.json.download_url.startsWith('https://proj.supabase.co/functions/v1/moviebox?action=proxy&t='));
  assert.ok(!JSON.stringify(r.json).includes('bcdnxw'), 'no CDN host in the playback answer');
  assert.deepEqual(r.json.qualities, ['1080p', '720p', '480p', '360p']);

  const play = await get(r.json.playback_url + '');
  assert.equal(play.status, 200);
  assert.equal(play.text, 'MEDIA-BYTES');
  assert.equal(play.headers.get('content-disposition'), null, 'playback is never an attachment');
});

test('playback: a requested quality is honoured, and Range is forwarded to the media host', async () => {
  const r = await post({ action: 'playback', ...BB, se: 1, ep: 1, quality: '720p' });
  assert.equal(r.json.quality, '720p');
  mediaRange = null;
  const part = await handler(new Request(r.json.playback_url, { method: 'GET', headers: { Range: 'bytes=0-11' } }));
  assert.equal(part.status, 206);
  assert.equal(mediaRange, 'bytes=0-11');
  assert.equal(part.headers.get('content-range'), 'bytes 0-11/1000');
});

test('download: the download link is an attachment; the playback link is not', async () => {
  const r = await post({ action: 'playback', ...BB, se: 1, ep: 1, quality: '360p' });
  const dl = await get(r.json.download_url);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition') ?? '', /^attachment; filename=/);
});

test('proxy: a tampered token is refused and nothing is fetched', async () => {
  const r = await post({ action: 'playback', ...BB, se: 1, ep: 1 });
  const token = new URL(r.json.playback_url).searchParams.get('t');
  const bad = token.slice(0, -4) + (token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  calls.length = 0;
  const res = await get(`https://proj.supabase.co/functions/v1/moviebox?action=proxy&t=${bad}`);
  assert.equal(res.status, 403);
  assert.equal(calls.filter((u) => u.includes('hakunaymatata')).length, 0);
});

test('proxy: a whole-file answer with no stated length gets its total from a one-byte probe', async () => {
  const r = await post({ action: 'playback', ...BB, se: 1, ep: 1, quality: '360p' });
  mediaLog.length = 0;
  const full = await get(r.json.playback_url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-length'), '1000', 'the total is stated so the client can verify the download');
  assert.ok(mediaLog.includes('bytes=0-0'), 'the total came from a ranged probe');
});

test('proxy: a 429 from the media host is retried, and the retried answer is passed on', async () => {
  const r = await post({ action: 'playback', ...BB, se: 1, ep: 1, quality: '360p' });
  mediaReturn429 = 1;
  mediaLog.length = 0;
  const part = await handler(new Request(r.json.playback_url, { method: 'GET', headers: { Range: 'bytes=0-3' } }));
  assert.equal(part.status, 206);
  assert.equal(mediaLog.length, 2, 'one refused attempt, then one answered attempt');
  assert.equal(mediaLog[1], 'bytes=0-3', 'the same Range is sent again');
});

test('proxy: media requests carry the app identity and no impersonated player Referer', async () => {
  const r = await post({ action: 'playback', ...BB, se: 1, ep: 1, quality: '360p' });
  mediaHeaders.length = 0;
  await get(r.json.playback_url);
  assert.ok(mediaHeaders.length > 0);
  const sent = mediaHeaders[0];
  assert.equal(sent.Referer, undefined);
  assert.equal(sent.Origin, undefined);
  assert.equal(sent['User-Agent'], 'HallyuApp/1.0 (+media proxy)');
  assert.equal(sent['Accept-Encoding'], 'identity');
});

test('proxy: a plain request with no token is refused', async () => {
  const res = await get('https://proj.supabase.co/functions/v1/moviebox?action=proxy');
  assert.equal(res.status, 403);
});

test('captions: returns the MovieBox tracks as proxy links, labelled by lanName, never raw CDN links', async () => {
  const r = await post({ action: 'captions', ...BB, se: 1, ep: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.usable, true);
  assert.equal(r.json.data.length, 2);
  assert.equal(r.json.data[0].language, 'en');
  assert.equal(r.json.data[0].label, 'English');
  assert.equal(r.json.data[0].format, 'srt');
  for (const c of r.json.data) {
    assert.ok(c.url.startsWith('https://proj.supabase.co/functions/v1/moviebox?action=proxy&t='));
    assert.ok(!c.url.includes('cacdn'));
  }
  const srt = await get(r.json.data[0].url);
  assert.equal(srt.status, 200);
});

test('home: catalog rows keep only items with a real subject id; trending and ranking are gone', async () => {
  const r = await post({ action: 'home' });
  assert.equal(r.status, 200);
  const rows = r.json.data.operatingList;
  assert.deepEqual(rows.map((x) => x.title), ['Banner', 'Popular Series']);
  assert.equal(rows[0].subjects.length, 1, 'the premium advert with no subject id is dropped');
  assert.equal(rows[1].subjects[0].detailPath, 'lupin-english-UqNLZqu3DD');
  for (const action of ['trending', 'ranking']) {
    const gone = await post({ action });
    assert.equal(gone.status, 400);
    assert.equal(gone.json.error, 'unknown_action');
  }
});

test('search: returns items with detailPath from the slug, and a paging flag', async () => {
  const r = await post({ action: 'search', q: 'Lupin' });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.items[0].detailPath, 'lupin-english-UqNLZqu3DD');
  assert.equal(r.json.data.hasMore, true);
  assert.equal((await post({ action: 'search', q: 'L' })).status, 400);
});

test('detail: returns subject and seasons in the shape the app reads', async () => {
  const r = await post({ action: 'detail', detailPath: BB.detailPath });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.subject.subjectId, BB.subjectId);
  assert.equal(r.json.data.subject.imdbRatingValue, '9.5');
  assert.deepEqual(r.json.data.resource.seasons.map((s) => [s.se, s.maxEp]), [[1, 7], [2, 13]]);
});

test('auth: a POST without a signed-in user is refused; a playback without the sealing key is 503', async () => {
  const anon = await handler(new Request('https://proj.supabase.co/functions/v1/moviebox', { method: 'POST', body: '{}' }));
  assert.equal(anon.status, 401);
  const saved = ENV.WATCH_PLAYBACK_KEY;
  ENV.WATCH_PLAYBACK_KEY = 'short';
  const noKey = await post({ action: 'playback', ...BB, se: 1, ep: 1 });
  ENV.WATCH_PLAYBACK_KEY = saved;
  assert.equal(noKey.status, 503);
});

test('no Megan anywhere in the function', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(!/megan/i.test(src), 'the function must not mention Megan');
  assert.ok(!/apis\.megan\.qzz\.io/.test(src));
  assert.ok(!/OPENSUBTITLES|opensubtitles/i.test(src), 'OpenSubtitles is not used');
});
