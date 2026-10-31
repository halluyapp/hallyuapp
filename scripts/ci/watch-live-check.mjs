#!/usr/bin/env node
/**
 * Hallyu CI — Watch verification.
 *
 * Two kinds of check, deliberately separated by who owns the failure:
 *
 *   BLOCKING (ours): the catalog API answers, a real title resolves to a full-length MP4 with a
 *   stated size, and — when the media host does serve bytes — Range is forwarded correctly (206,
 *   continuation offset, exact byte count, MP4 header, restart at zero, out-of-range refusal).
 *
 *   EVIDENCE (theirs): whether a third-party CDN will serve video bytes to a GitHub runner. The
 *   delivery host for this catalog is an ISP/region-gated CDN that answers 429/426/428 to datacenter
 *   networks. That is not a Hallyu defect, so it is a warning annotation and never fails a release.
 *   Set WATCH_CDN_STRICT=1 to make it blocking again (manual verification runs).
 *
 * A CDN that answers but answers wrongly (200 with no length, a short body, a non-MP4 body) is still
 * a failure: that is the case the app cannot survive, so it stays blocking.
 *
 * Env: WATCH_CHECK_QUERY (optional, default "Lupin")
 *      WATCH_CHECK_URL   (optional: probe this URL directly; skips catalog resolution)
 *      WATCH_CDN_STRICT  (optional: "1" makes an external refusal fail the run)
 */
import { appendFileSync } from 'node:fs';
import process from 'node:process';

const ZARHOSTING_BASE = 'https://movieapi.zarhosting.dpdns.org/api/public/v1';
const QUERY = (process.env.WATCH_CHECK_QUERY || 'Lupin').trim();
const OVERRIDE_URL = (process.env.WATCH_CHECK_URL || '').trim();
const STRICT = process.env.WATCH_CDN_STRICT === '1';

const MIN_PLAYABLE_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 30_000;
const SAMPLE_BYTES = 65_536;

/** Refusals a delivery network makes about the *client*, before it looks at the file. */
const EXTERNAL_REFUSAL = new Set([401, 403, 425, 426, 428, 429]);
/** Statuses that mean "the host is having a moment", also not our defect. */
const TRANSIENT_REFUSAL = new Set([500, 502, 503, 504]);

const report = [];
const pass = [];
const fail = [];
const blocked = [];

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
function warn(text) {
  blocked.push(text);
  line(`WARN  ${text}`);
}
function info(text) {
  line(`      ${text}`);
}

function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}?<signed>`;
  } catch {
    return '<unparseable url>';
  }
}

const HEADERS = {
  'User-Agent': 'HallyuApp/1.0 (+media client)',
  Accept: 'application/json',
};

async function callZarhosting(path) {
  const res = await fetch(`${ZARHOSTING_BASE}${path}`, { headers: HEADERS });
  if (!res.ok) return { status: res.status, json: null };
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** Reads a bounded slice and reports the headers the app depends on. */
async function head(url, range, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { ...(range ? { Range: range } : {}), 'Accept-Encoding': 'identity' },
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

async function measure(url, range, budgetMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const res = await fetch(url, {
      headers: { ...(range ? { Range: range } : {}), 'Accept-Encoding': 'identity' },
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
    return { status: res.status, bytes, ftyp, contentRange: res.headers.get('content-range') };
  } finally {
    clearTimeout(timer);
  }
}

const totalFromContentRange = (v) => {
  const m = /\/(\d+)\s*$/.exec(v ?? '');
  return m ? Number(m[1]) : null;
};
const startFromContentRange = (v) => {
  const m = /^bytes\s+(\d+)-/.exec(v ?? '');
  return m ? Number(m[1]) : null;
};

/** Blocking: the catalog answers and offers a downloadable full-length MP4 with a stated size. */
async function verifyCatalog() {
  const queries = Array.from(new Set([QUERY, 'Squid Game', 'Queen of Tears', 'Demon Slayer'].filter(Boolean)));
  const tried = [];
  for (const q of queries) {
    const search = await callZarhosting(`/search?q=${encodeURIComponent(q)}&page=1`);
    if (search.status !== 200 || !Array.isArray(search.json?.items)) {
      tried.push(`${q}: search status ${search.status}`);
      continue;
    }
    if (search.json.items.length === 0) {
      tried.push(`${q}: no titles`);
      continue;
    }
    ok(`catalog search answers with ${search.json.items.length} titles for "${q}"`);

    for (const item of search.json.items.slice(0, 5)) {
      const subjectId = String(item?.subject_id ?? '');
      const detailPath = String(item?.slug ?? '');
      if (!subjectId || !detailPath) continue;
      const streams = await callZarhosting(
        `/stream/${subjectId}?detail_path=${encodeURIComponent(detailPath)}&se=1&ep=1`,
      );
      const sources = Array.isArray(streams.json?.sources) ? streams.json.sources : [];
      const mp4 = sources.filter((s) => String(s?.format ?? '').toUpperCase() === 'MP4' && typeof s?.url === 'string');
      if (mp4.length === 0) {
        tried.push(`${item?.name ?? subjectId}: no MP4`);
        continue;
      }
      const sizes = mp4.map((s) => Number(s.size)).filter((n) => Number.isFinite(n) && n > 0);
      if (sizes.length !== mp4.length) {
        bad(`${item?.name ?? subjectId}: ${mp4.length - sizes.length} source(s) report no byte size, so completion cannot be verified`);
      } else {
        ok(`every source reports its byte size (${sizes.length} source(s), smallest ${Math.min(...sizes)} bytes)`);
      }
      const qualities = mp4.map((s) => String(s.resolution ?? s.quality ?? '')).filter(Boolean);
      if (qualities.includes('360p')) {
        ok('the 360p default exists for this title');
      } else {
        info(`NOTE: this title offers ${qualities.join(', ') || '<none>'}; the app falls back to the lowest quality`);
      }
      const chosen = mp4.find((s) => String(s.resolution) === '360p') ?? mp4[0];
      info(`title: ${item?.name ?? subjectId} · testing ${chosen.resolution}`);
      return chosen.url;
    }
  }
  bad(`no downloadable full-length MP4 found (${tried.slice(0, 6).join('; ') || 'no candidates'})`);
  return null;
}

/**
 * If the media host refuses the runner, record *why* and stop. Everything the app controls has already
 * been asserted, so an external refusal is evidence, not a broken build.
 */
function externalRefusal(status, what) {
  const message = `media host refused this runner with ${status} (${what}); CDN bytes are not verifiable from CI here`;
  if (STRICT || TRANSIENT_REFUSAL.has(status)) {
    bad(message);
  } else {
    warn(message);
    console.log(`::warning title=External media host refused CI::${message}. Not a Hallyu defect: set WATCH_CDN_STRICT=1 to enforce.`);
  }
}

async function main() {
  const cdnUrl = OVERRIDE_URL || (await verifyCatalog());
  if (!cdnUrl) return;

  line(OVERRIDE_URL ? `Probing the supplied URL directly (${safeUrl(cdnUrl)})` : `Media host: ${safeUrl(cdnUrl)}`);

  const first = await head(cdnUrl, 'bytes=0-0');
  let total = totalFromContentRange(first.contentRange);

  if (first.status === 206 && total) {
    ok(`positional request answered 206 with a total of ${total} bytes`);
  } else if (first.status === 200 && Number.isSafeInteger(Number(first.contentLength))) {
    total = Number(first.contentLength);
    ok(`direct request answered 200 with a total of ${total} bytes`);
  } else if (EXTERNAL_REFUSAL.has(first.status) || TRANSIENT_REFUSAL.has(first.status)) {
    externalRefusal(first.status, `Range bytes=0-0 to ${safeUrl(cdnUrl)}`);
    return;
  } else {
    bad(`expected 206 or 200 with a content length, got ${first.status}`);
    return;
  }

  if (total < MIN_PLAYABLE_BYTES) {
    bad(`the host states ${total} bytes, below the app's ${MIN_PLAYABLE_BYTES}-byte playable floor`);
    return;
  }

  // Continuation offset must be honoured exactly.
  const offset = Math.floor(total / 3);
  const continuation = await head(cdnUrl, `bytes=${offset}-`);
  if (continuation.status === 206 && startFromContentRange(continuation.contentRange) === offset) {
    ok(`a continuation from byte ${offset} starts exactly there`);
  } else {
    bad(`a continuation from byte ${offset} answered ${continuation.status} with Content-Range ${continuation.contentRange ?? '<none>'}`);
  }

  // A bounded read must return exactly the bytes asked for, and begin like an MP4.
  const wanted = Math.min(SAMPLE_BYTES, total);
  const sample = await measure(cdnUrl, `bytes=0-${wanted - 1}`);
  if (sample.status !== 206 && sample.status !== 200) {
    bad(`a ranged read failed with ${sample.status}`);
  } else if (sample.bytes !== wanted) {
    bad(`a ranged read returned ${sample.bytes} bytes but ${wanted} were requested`);
  } else {
    ok(`a ranged read returns exactly ${sample.bytes} bytes`);
  }
  if (sample.ftyp) {
    ok('the stream begins with an MP4 header (ftyp)');
  } else {
    bad('the stream does not begin with an MP4 header');
  }

  // A fresh request after a partial must restart at byte 0 — no blind append.
  const restart = await head(cdnUrl, 'bytes=0-1023');
  if (restart.status === 206 && startFromContentRange(restart.contentRange) === 0) {
    ok('a fresh request after a partial restarts at byte 0 and states the full length');
  } else {
    bad(`restart check failed: ${restart.status} from ${restart.contentRange ?? '<none>'}`);
  }

  // An out-of-range start must never come back as a whole-file 200.
  const beyond = await head(cdnUrl, `bytes=${total}-${total}`);
  if (beyond.status === 200) {
    bad('an out-of-range request returned 200 with the whole file — Range is not honoured');
  } else if (beyond.status === 206 && Number(beyond.contentLength) >= total) {
    bad('an out-of-range request answered 206 with the whole file — that is what a blind append corrupts');
  } else {
    ok(`an out-of-range request is refused without data to append (${beyond.status})`);
  }
}

try {
  await main();
} catch (error) {
  bad(error instanceof Error ? error.message : String(error));
}

const summary = [
  '## Watch verification',
  '',
  ...report.map((r) => (r.startsWith('      ') ? `- ${r.trim()}` : `- \`${r}\``)),
  '',
  `**Result:** ${fail.length === 0 ? `${pass.length} checks passed` : `${fail.length} failed, ${pass.length} passed`}${
    blocked.length ? ` · ${blocked.length} external warning(s)` : ''
  }`,
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}

if (fail.length > 0) {
  for (const f of fail) console.error(`::error::${f}`);
  process.exit(1);
}
console.log(`Watch verification passed: ${pass.length} checks${blocked.length ? `, ${blocked.length} external warning(s)` : ''}.`);
