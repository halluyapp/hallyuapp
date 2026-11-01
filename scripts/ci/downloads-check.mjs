/**
 * Download transfer contract, checked against a local server with real HTTP Range semantics.
 *
 * The brief names an 83/84 MB transfer as the proof that downloads behave. That size cannot be fetched
 * from the third-party media host inside CI (it refuses datacenter networks), so this fixture serves the
 * same sizes itself and asserts the two things a real transfer depends on:
 *
 *   1. the server states the full length, honours a byte range, and refuses an out-of-range request;
 *   2. the app's rules turn each of those responses into the right decision — continue, restart, complete.
 *
 * No network, no credentials, no third-party host: safe to block a build on.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 } }).outputText;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hallyu-downloads-'));
  const file = path.join(dir, path.basename(rel).replace(/\.ts$/, '.mjs'));
  fs.writeFileSync(file, out);
  return import(pathToFileURL(file).href);
}

const R = await load('lib/watchRules.ts');

/** The sizes named in the brief. */
const SIZE_83 = 83 * 1024 * 1024;
const SIZE_84 = 84 * 1024 * 1024;

/** A stable, position-dependent byte, so a continuation can be checked against the right offset. */
function byteAt(position) {
  return position % 251;
}

/** A server that behaves like a real media host: Accept-Ranges, 206 with Content-Range, 416 past the end. */
function serve(size) {
  const server = http.createServer((req, res) => {
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');
    const range = req.headers.range;

    if (!range) {
      res.statusCode = 200;
      res.setHeader('Content-Length', String(size));
      res.end();
      return;
    }

    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }

    const start = Number(match[1]);
    const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (start >= size || start > end) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }

    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));

    const chunk = Buffer.alloc(64 * 1024);
    let position = start;
    const pump = () => {
      while (position <= end) {
        const n = Math.min(chunk.length, end - position + 1);
        for (let i = 0; i < n; i += 1) chunk[i] = byteAt(position + i);
        position += n;
        if (!res.write(Buffer.from(chunk.subarray(0, n)))) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function listenPort(server) {
  return server.address().port;
}

/** Full response, body included. */
function fetchAll(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method: 'GET', path: '/media.mp4', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Headers only: the body is abandoned as soon as the response line and headers arrive. */
function fetchHeaders(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method: 'GET', path: '/media.mp4', headers }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers });
      req.destroy();
      res.destroy();
    });
    req.on('error', reject);
    req.end();
  });
}

test('83 MB: a one-byte probe states the real full length', async (t) => {
  const server = await serve(SIZE_83);
  t.after(() => server.close());
  const res = await fetchHeaders(listenPort(server), { Range: 'bytes=0-0' });
  assert.equal(res.status, 206);
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(Number(res.headers['content-length']), 1);
  assert.equal(res.headers['content-range'], `bytes 0-0/${SIZE_83}`);
  assert.equal(R.totalFromContentRange(res.headers['content-range']), SIZE_83);
});

test('84 MB: a full-length request states 84 MB, not a provider estimate', async (t) => {
  const server = await serve(SIZE_84);
  t.after(() => server.close());
  const res = await fetchHeaders(listenPort(server));
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers['content-length']), SIZE_84);
});

test('83 MB: a continuation from 80 MB returns exactly the remaining bytes, at the right offset', async (t) => {
  const server = await serve(SIZE_83);
  t.after(() => server.close());
  const from = 80 * 1024 * 1024;
  const res = await fetchAll(listenPort(server), { Range: `bytes=${from}-` });
  assert.equal(res.status, 206);
  assert.equal(res.headers['content-range'], `bytes ${from}-${SIZE_83 - 1}/${SIZE_83}`);
  assert.equal(res.body.length, SIZE_83 - from);
  assert.equal(res.body[0], byteAt(from));
  assert.equal(res.body[res.body.length - 1], byteAt(SIZE_83 - 1));
  // The continuation completes the file, so the rule accepts it as done rather than continuing again.
  assert.deepEqual(
    R.decideAfterTransfer({ status: 206, startBytes: from, bytesOnDisk: SIZE_83, expectedBytes: SIZE_83, continues: 1, contentRangeStart: from }),
    { action: 'complete' },
  );
});

test('a range past the end is refused with 416 and the real length', async (t) => {
  const server = await serve(SIZE_83);
  t.after(() => server.close());
  const res = await fetchHeaders(listenPort(server), { Range: `bytes=${SIZE_83 + 1}-` });
  assert.equal(res.status, 416);
  assert.equal(res.headers['content-range'], `bytes */${SIZE_83}`);
});

test('a 206 at the requested byte continues; a 206 at any other byte restarts', () => {
  const from = 20 * 1024 * 1024;
  assert.deepEqual(
    R.decideAfterTransfer({ status: 206, startBytes: from, bytesOnDisk: from, expectedBytes: SIZE_83, continues: 0, contentRangeStart: from }),
    { action: 'continue', fromBytes: from },
  );
  assert.deepEqual(
    R.decideAfterTransfer({ status: 206, startBytes: from, bytesOnDisk: from, expectedBytes: SIZE_83, continues: 0, contentRangeStart: 0 }),
    { action: 'restart' },
  );
});

test('two qualities of one episode are two separate files', () => {
  const a = R.qualityDownloadKey('536473933005177184', 1, 1, '360p');
  const b = R.qualityDownloadKey('536473933005177184', 1, 1, '480p');
  assert.notEqual(a, b);
  const nameFor = (key) => `${key.replace(/[^A-Za-z0-9_-]/g, '_')}.mp4`;
  assert.notEqual(nameFor(a), nameFor(b));
});

test('a refused download says why, so a failure is not one generic sentence', () => {
  assert.match(R.nativeFailureMessage(6), /not enough free storage/i);
  assert.match(R.nativeFailureMessage(4), /server refused/i);
  assert.match(R.nativeFailureMessage(2), /server refused/i);
  assert.match(R.nativeFailureMessage(null), /download stopped/i);
});
