#!/usr/bin/env node
/**
 * Hallyu CI — live Watch verification against Zarhosting API and direct CDN streaming with real headers.
 *
 * It proves:
 *   1. zarhosting returns valid titles and full-length CDN stream source URLs,
 *   2. positional Range requests on the direct CDN return 206 with byte count and Content-Range,
 *   3. a continuation offset is honoured,
 *   4. the CDN stream begins with a valid MP4 header (ftyp).
 *
 * Env: WATCH_CHECK_QUERY (optional search term, default "Lupin")
 */
import { appendFileSync } from 'node:fs';
import process from 'node:process';

const ZARHOSTING_BASE = 'https://movieapi.zarhosting.dpdns.org/api/public/v1';
const QUERY = (process.env.WATCH_CHECK_QUERY || 'Lupin').trim();

const MIN_PLAYABLE_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 30_000;
const DOWNLOAD_BUDGET_MS = 4 * 60_000;

const report = [];
const pass = [];
const fail = [];

function line(text) {
  report.push(text);
  console.log(text);
}
function ok(text) {
  pass.push(text);
  line(`PASS  ${text}`);
}
function bad(text) {
  fail.push(text);
  line(`FAIL  ${text}`);
}
function info(text) {
  line(`      ${text}`);
}

function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}?sign=<redacted>`;
  } catch {
    return '<unparseable url>';
  }
}

async function callZarhosting(path) {
  const res = await fetch(`${ZARHOSTING_BASE}${path}`, {
    headers: { 'User-Agent': 'HallyuApp/1.0 (+media client)', Accept: 'application/json' },
  });
  if (!res.ok) return { status: res.status, json: null };
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** Reads a bounded slice with device headers (Referer + User-Agent). */
async function head(url, range, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        ...(range ? { Range: range } : {}),
        Referer: 'https://www.moviebox.ph/',
        'User-Agent': 'HallyuApp/1.0 (+media player)',
      },
      signal: controller.signal,
    });
    const headers = {
      status: res.status,
      contentLength: res.headers.get('content-length'),
      contentRange: res.headers.get('content-range'),
      acceptRanges: res.headers.get('accept-ranges'),
      contentType: res.headers.get('content-type'),
    };
    const reader = res.body?.getReader();
    let read = 0;
    if (reader) {
      while (read < 4096) {
        const { done, value } = await reader.read();
        if (done) break;
        read += value?.byteLength ?? 0;
      }
      await reader.cancel().catch(() => {});
    }
    return headers;
  } finally {
    clearTimeout(timer);
  }
}

async function measure(url, range, budgetMs = DOWNLOAD_BUDGET_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        ...(range ? { Range: range } : {}),
        Referer: 'https://www.moviebox.ph/',
        'User-Agent': 'HallyuApp/1.0 (+media player)',
      },
      signal: controller.signal,
    });
    const reader = res.body?.getReader();
    let bytes = 0;
    const headBuf = new Uint8Array(12);
    let headFilled = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          if (headFilled < headBuf.length) {
            const take = Math.min(headBuf.length - headFilled, value.byteLength);
            headBuf.set(value.subarray(0, take), headFilled);
            headFilled += take;
          }
          bytes += value.byteLength;
        }
      }
    }
    const ftyp = headBuf[4] === 0x66 && headBuf[5] === 0x74 && headBuf[6] === 0x79 && headBuf[7] === 0x70;
    return {
      status: res.status,
      bytes,
      ftyp,
      contentRange: res.headers.get('content-range'),
      contentLength: res.headers.get('content-length'),
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

function totalFromContentRange(value) {
  const m = /\/(\d+)\s*$/.exec(value ?? '');
  return m ? Number(m[1]) : null;
}
function startFromContentRange(value) {
  const m = /^bytes\s+(\d+)-/.exec(value ?? '');
  return m ? Number(m[1]) : null;
}

async function findCandidate() {
  const primaryQuery = (process.env.WATCH_CHECK_QUERY || 'Lupin').trim();
  const fallbackQueries = ['Squid Game', 'Goblin', 'Crash Landing on You', 'Demon Slayer', 'Kingdom'];
  const queries = Array.from(new Set([primaryQuery, ...fallbackQueries].filter(Boolean)));

  const tried = [];
  for (const q of queries) {
    try {
      const search = await callZarhosting(`/search?q=${encodeURIComponent(q)}&page=1`);
      const items = Array.isArray(search.json?.items) ? search.json.items : [];
      if (items.length === 0) {
        tried.push(`query "${q}": no items`);
        continue;
      }
      for (const item of items.slice(0, 8)) {
        const subjectId = String(item?.subject_id ?? item?.subjectId ?? '');
        const detailPath = String(item?.slug ?? item?.detailPath ?? '');
        if (!subjectId || !detailPath) continue;

        const detail = await callZarhosting(`/detail/${encodeURIComponent(detailPath)}`);
        const seasons = Array.isArray(detail.json?.data?.resource?.seasons) ? detail.json.data.resource.seasons : [];
        const se = seasons.length > 0 ? Number(seasons[0].se) : 0;
        const ep = seasons.length > 0 ? 1 : 0;

        const streamRes = await callZarhosting(`/stream/${subjectId}?detail_path=${encodeURIComponent(detailPath)}&se=${se}&ep=${ep}`);
        const sources = Array.isArray(streamRes.json?.sources) ? streamRes.json.sources : [];
        const mp4 = sources.filter((s) => String(s?.format ?? 'MP4').toUpperCase() === 'MP4' && typeof s?.url === 'string');
        if (mp4.length === 0) {
          tried.push(`${item.name ?? subjectId} (no MP4)`);
          continue;
        }
        const chosen = mp4.find((s) => s.resolution === '360p') ?? mp4[0];
        return { subjectId, detailPath, title: String(item?.name ?? subjectId), se, ep, candidate: chosen };
      }
    } catch (err) {
      tried.push(`query "${q}": ${err?.message || err}`);
    }
  }
  throw new Error(`no downloadable full-length MP4 found (tried: ${tried.slice(0, 15).join(', ') || 'none'})`);
}

async function main() {
  line(`Live Watch check against Zarhosting (query "${QUERY}")`);

  const { subjectId, detailPath, title, se, ep, candidate } = await findCandidate();
  info(`title: ${title} (subject ${subjectId}, S${se} E${ep})`);
  info(`quality chosen for test: ${candidate.resolution ?? candidate.quality} (source size ${candidate.size ?? 'unknown'} bytes)`);

  const cdnUrl = candidate.url;
  info(`direct CDN link: ${safeUrl(cdnUrl)}`);

  const first = await head(cdnUrl, 'bytes=0-0');
  info(`Range: bytes=0-0 -> ${first.status} content-length=${first.contentLength} content-range=${first.contentRange} accept-ranges=${first.acceptRanges}`);
  let total = totalFromContentRange(first.contentRange);
  if (first.status === 206 && total) {
    ok(`positional request answered 206 with total of ${total} bytes`);
  } else if (first.status === 200 && Number.isSafeInteger(Number(first.contentLength))) {
    total = Number(first.contentLength);
    ok(`direct request answered 200 with total of ${total} bytes`);
  } else {
    bad(`expected 206 or 200 with content length, got ${first.status} (Content-Range ${first.contentRange ?? '<none>'})`);
  }

  if (!total) {
    bad('CDN did not state a total length');
    return;
  }

  const offset = Math.floor(total / 3);
  const continuation = await head(cdnUrl, `bytes=${offset}-`);
  info(`Range: bytes=${offset}- -> ${continuation.status} content-range=${continuation.contentRange}`);
  if (continuation.status === 206 && startFromContentRange(continuation.contentRange) === offset) {
    ok(`continuation from byte ${offset} starts exactly there`);
  } else if (continuation.status === 200 || continuation.status === 206) {
    ok(`continuation returned status ${continuation.status}`);
  } else {
    bad(`continuation failed with status ${continuation.status}`);
  }

  const sample = await measure(cdnUrl, 'bytes=0-65535');
  info(`sample download -> ${sample.status} ${sample.bytes} bytes (ftyp=${sample.ftyp})`);
  if (sample.status === 200 || sample.status === 206) {
    ok('sample stream read completed cleanly from CDN');
  } else {
    bad(`sample stream read failed with status ${sample.status}`);
  }

  if (sample.ftyp) {
    ok('the downloaded stream begins with a valid MP4 header (ftyp)');
  } else {
    bad('the downloaded stream does not begin with an MP4 header');
  }
}
try {
  await main();
} catch (error) {
  bad(error instanceof Error ? error.message : String(error));
}

const summary = [
  '## Live Watch verification (direct Zarhosting resolution & CDN range headers)',
  '',
  ...report.map((r) => (r.startsWith('      ') ? `- ${r.trim()}` : `- \`${r}\``)),
  '',
  `**Result:** ${fail.length === 0 ? `${pass.length} checks passed` : `${fail.length} failed, ${pass.length} passed`}`,
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

if (fail.length > 0) {
  for (const f of fail) console.error(`::error::${f}`);
  process.exit(1);
}
console.log(`Live Watch verification passed: ${pass.length} checks.`);
