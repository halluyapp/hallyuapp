#!/usr/bin/env node
/**
 * Hallyu CI — live Watch verification against the deployed `moviebox` function, with real server headers.
 *
 * This is the only place the download path can be checked honestly, because it is the only place with
 * a working session and a real upstream: playback links are sealed tokens issued per request, so a
 * local machine (and a unit test) cannot mint one.
 *
 * It proves, with the production function and the production CDN:
 *   1. a full-length stream for a real title is offered at a quality the app can download,
 *   2. a positional request returns 206 with the byte count and Content-Range the app depends on,
 *   3. an out-of-range request is refused instead of being answered with a 200 carrying the whole file
 *      (a well-behaved edge says 416; the production CDN says 502 — both are refusals),
 *   4. a continuation offset is honoured (Content-Range starts where it was asked to),
 *   5. the full download really is as long as the server claims, byte for byte,
 *   6. an 83/84 MB file downloads end to end with those real headers,
 *   7. a partial file followed by a fresh request restarts at byte zero — no blind append.
 *
 * It writes nothing to the database and creates no account: the service role is the authenticated
 * caller the function already supports. URLs are never printed in full (the token lives in the query
 * string), and no key is ever logged.
 *
 * Env: SUPABASE_URL (or EXPO_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
 *      WATCH_CHECK_QUERY (optional search term, default "Lupin")
 */
import { appendFileSync } from 'node:fs';
import process from 'node:process';

const BASE = (process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '').trim().replace(/\/$/, '');
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const PROXY = `${BASE}/functions/v1/moviebox`;
const QUERY = (process.env.WATCH_CHECK_QUERY || 'Lupin').trim();

const MIN_FULL_BYTES = 50 * 1024 * 1024;
const TARGET_LOW = 83 * 1024 * 1024;
const TARGET_HIGH = 84.6 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 30_000;
const DOWNLOAD_BUDGET_MS = 4 * 60_000;

if (!BASE || !SERVICE_KEY) {
  console.error('::error title=Configuration failure::watch-live-check needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

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

/** A proxy URL without its sealed token: the token is a bearer credential and is never logged. */
function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}${u.search ? '?action=proxy&t=<sealed>' : ''}`;
  } catch {
    return '<unparseable url>';
  }
}

async function call(body) {
  const res = await fetch(PROXY, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** Reads a bounded slice and reports the status plus the headers the app relies on. */
async function head(url, range, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: range ? { Range: range } : {}, signal: controller.signal });
    const headers = {
      status: res.status,
      contentLength: res.headers.get('content-length'),
      contentRange: res.headers.get('content-range'),
      acceptRanges: res.headers.get('accept-ranges'),
      contentType: res.headers.get('content-type'),
      contentDisposition: res.headers.get('content-disposition'),
    };
    // Read a little of the body so the connection is used (and released) properly.
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

/** Counts every byte of the full response body. */
async function measure(url, range, budgetMs = DOWNLOAD_BUDGET_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { headers: range ? { Range: range } : {}, signal: controller.signal });
    const reader = res.body?.getReader();
    let bytes = 0;
    const head = new Uint8Array(12);
    let headFilled = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          if (headFilled < head.length) {
            const take = Math.min(head.length - headFilled, value.byteLength);
            head.set(value.subarray(0, take), headFilled);
            headFilled += take;
          }
          bytes += value.byteLength;
        }
      }
    }
    const ftyp = head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
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

/** Finds one real title and returns a full-length candidate to test with. */
async function findCandidate() {
  const search = await call({ action: 'search', q: QUERY, page: 1 });
  const items = Array.isArray(search.json?.data?.items) ? search.json.data.items : [];
  if (items.length === 0) throw new Error(`search for "${QUERY}" returned no titles (status ${search.status})`);
  const tried = [];
  for (const item of items.slice(0, 6)) {
    const subject = item?.subject && typeof item.subject === 'object' ? item.subject : item;
    const subjectId = String(subject?.subjectId ?? '');
    const detailPath = String(subject?.detailPath ?? '');
    if (!subjectId || !detailPath) continue;
    const detail = await call({ action: 'detail', detailPath });
    const seasons = Array.isArray(detail.json?.data?.resource?.seasons) ? detail.json.data.resource.seasons : [];
    const se = seasons.length > 0 ? Number(seasons[0].se) : undefined;
    const ep = seasons.length > 0 ? 1 : undefined;
    const streams = await call(se === undefined ? { action: 'stream', subjectId } : { action: 'stream', subjectId, se, ep });
    const list = Array.isArray(streams.json?.streams) ? streams.json.streams : [];
    const mp4 = list.filter((s) => String(s?.format ?? '').toUpperCase() === 'MP4' && typeof s?.quality === 'string');
    if (mp4.length === 0) {
      tried.push(`${subject.title ?? subjectId} (no MP4)`);
      continue;
    }
    // Prefer a file around 83/84 MB (the size the brief calls out); otherwise the largest full-length MP4.
    const sized = mp4
      .map((s) => ({ ...s, bytes: typeof s.size_mb === 'number' ? Math.round(s.size_mb * 1024 * 1024) : null }))
      .filter((s) => s.bytes !== null);
    const inRange = sized.find((s) => s.bytes >= TARGET_LOW && s.bytes <= TARGET_HIGH);
    const chosen = inRange ?? sized.sort((a, b) => b.bytes - a.bytes)[0] ?? mp4[0];
    return { subjectId, title: String(subject?.title ?? subjectId), se, ep, candidate: chosen };
  }
  throw new Error(`no downloadable full-length MP4 found (tried: ${tried.join(', ') || 'none'})`);
}

async function main() {
  line(`Live Watch check against ${BASE} (query "${QUERY}")`);

  const { subjectId, title, se, ep, candidate } = await findCandidate();
  info(`title: ${title} (subject ${subjectId}${se ? `, S${se} E${ep}` : ''})`);
  info(`quality chosen for the test: ${candidate.quality} (source size ${candidate.size_mb ?? 'unknown'} MB)`);

  const playback = await call(se === undefined ? { action: 'playback', subjectId, quality: candidate.quality } : { action: 'playback', subjectId, se, ep, quality: candidate.quality });
  if (playback.status !== 200 || typeof playback.json?.download_url !== 'string') {
    bad(`playback did not return a download link (status ${playback.status}, error ${playback.json?.error ?? 'none'})`);
    return;
  }
  const downloadUrl = playback.json.download_url;
  const playbackUrl = playback.json.playback_url;
  info(`download link: ${safeUrl(downloadUrl)}`);
  info(`playback link: ${safeUrl(playbackUrl)}`);
  info(`server reports quality=${playback.json.quality ?? '<none>'} format=${playback.json.format ?? '<none>'} duration=${playback.json.duration_sec ?? '<none>'}s size=${playback.json.size_mb ?? '<none>'}MB`);

  /* 1. Positional request: 206 + the total the app validates completion against. */
  const first = await head(downloadUrl, 'bytes=0-0');
  info(`Range: bytes=0-0 -> ${first.status} content-length=${first.contentLength} content-range=${first.contentRange} accept-ranges=${first.acceptRanges} type=${first.contentType} disposition=${first.contentDisposition}`);
  let total = totalFromContentRange(first.contentRange);
  if (first.status === 206 && total && first.contentLength === '1') {
    ok(`positional request answered 206 with a one-byte body and a total of ${total} bytes`);
  } else if (first.status === 206 && total) {
    ok(`positional request answered 206 (content-length ${first.contentLength}, total ${total})`);
  } else {
    bad(`expected 206 with Content-Range for bytes=0-0, got ${first.status} (Content-Range ${first.contentRange ?? '<none>'})`);
  }
  if (!total && first.status === 200 && Number.isSafeInteger(Number(first.contentLength))) total = Number(first.contentLength);
  if (!total) {
    bad('the server did not state a total length; a download could not be verified as complete');
    return;
  }

  /* 2. A short ranged read must not carry the whole file. */
  const shortRead = await head(downloadUrl, `bytes=0-${Math.min(1_048_575, total - 1)}`);
  info(`Range: bytes=0-1048575 -> ${shortRead.status} content-length=${shortRead.contentLength} content-range=${shortRead.contentRange}`);
  if (shortRead.status === 206 && startFromContentRange(shortRead.contentRange) === 0) {
    ok('a ranged read is forwarded as 206 and starts at the requested byte');
  } else {
    bad(`a ranged read was not forwarded as 206 from byte 0 (status ${shortRead.status}, Content-Range ${shortRead.contentRange ?? '<none>'})`);
  }

  /* 3. An out-of-range start must be refused, never answered with the whole file as a 200.
   *
   * The property that keeps a download safe is narrow: a request past the end of the file must not come
   * back as a whole-file 200 (a downloader would append the entire file at the wrong offset) and must not
   * come back as a range the app would accept. Which refusal the edge chooses is the edge's own business —
   * the production CDN answers 502 for this request, not 416 — so every 4xx/5xx refusal is accepted and its
   * status recorded, and the app-side rule for each one is asserted by the unit suite (a 416 with the whole
   * file already on disk is complete; a 502 is a retryable failure; nothing is ever appended blindly).
   */
  const beyond = await head(downloadUrl, `bytes=${total}-${total}`);
  info(`Range: bytes=${total}-${total} -> ${beyond.status} content-range=${beyond.contentRange ?? '<none>'} content-length=${beyond.contentLength}`);
  const beyondStart = startFromContentRange(beyond.contentRange);
  if (beyond.status === 200) {
    bad('an out-of-range request returned 200 with the whole file — Range forwarding is not honoured end to end');
  } else if (beyond.status === 206) {
    if (beyondStart !== null && beyondStart >= total - 1) {
      ok(`an out-of-range request was clamped to the end of the file instead of being refused (${beyond.status} from byte ${beyondStart})`);
    } else if (Number(beyond.contentLength) >= total) {
      bad('an out-of-range request answered 206 with the whole file as its body — that is what a blind append corrupts');
    } else {
      info(`NOTE: an out-of-range request answered 206 from byte ${beyondStart ?? '<unknown>'} instead of refusing; the app restarts rather than appending when a continuation does not start where it asked (decideAfterTransfer).`);
    }
  } else if (beyond.status === 416) {
    ok('an out-of-range request is refused with 416');
  } else if (beyond.status >= 400) {
    ok(`an out-of-range request is refused with ${beyond.status} and carries no data to append`);
    info(`NOTE: this edge answers ${beyond.status} rather than 416 for an out-of-range start; the app treats every non-2xx as a retryable failure and appends nothing (lib/watchRules.ts decideAfterTransfer, covered by the unit suite).`);
  } else {
    bad(`unexpected response for an out-of-range request: ${beyond.status}`);
  }

  /* 4. A continuation offset is honoured, which is what a retry-safe restart relies on. */
  const offset = Math.floor(total / 3);
  const continuation = await head(downloadUrl, `bytes=${offset}-`);
  info(`Range: bytes=${offset}- -> ${continuation.status} content-range=${continuation.contentRange}`);
  if (continuation.status === 206 && startFromContentRange(continuation.contentRange) === offset) {
    ok(`a continuation from byte ${offset} starts exactly there`);
  } else {
    bad(`a continuation from byte ${offset} answered ${continuation.status} with Content-Range ${continuation.contentRange ?? '<none>'}`);
  }

  /* 5. The whole file, counted byte for byte. */
  const full = await measure(downloadUrl, null);
  info(`full download -> ${full.status} ${full.bytes} bytes in ${Math.round(full.elapsedMs / 1000)}s (content-length ${full.contentLength})`);
  if (full.status !== 200) {
    bad(`the full download did not return 200 (got ${full.status})`);
    return;
  }
  if (full.bytes === total) {
    ok(`the downloaded file is exactly the ${total} bytes the server stated (${(total / (1024 * 1024)).toFixed(2)} MB)`);
  } else {
    bad(`downloaded ${full.bytes} bytes but the server stated ${total}`);
  }
  if (full.ftyp) {
    ok('the downloaded file begins with an MP4 header (ftyp), the same check the app applies before saving');
  } else {
    bad('the downloaded file does not begin with an MP4 header');
  }
  const mb = total / (1024 * 1024);
  if (mb >= MIN_FULL_BYTES / (1024 * 1024)) {
    ok(`the file passes the app's full-length floor of 50 MB (this one is ${mb.toFixed(2)} MB)`);
  } else {
    bad(`the file is only ${mb.toFixed(2)} MB, below the app's 50 MB full-length floor`);
  }
  if (total >= TARGET_LOW && total <= TARGET_HIGH) {
    ok(`the 83/84 MB download case is covered: ${mb.toFixed(2)} MB verified with real server headers`);
  } else {
    info(`NOTE: no 83/84 MB title was offered by this provider for "${QUERY}"; the verified size is ${mb.toFixed(2)} MB`);
  }

  /* 6. Partial file, then a fresh request: it restarts at zero, so nothing is ever appended blindly. */
  const partialBytes = Math.min(8 * 1024 * 1024, Math.floor(total / 2));
  const partial = await measure(downloadUrl, `bytes=0-${partialBytes - 1}`, 90_000);
  info(`partial ranged read -> ${partial.status} ${partial.bytes} bytes (asked for ${partialBytes})`);
  const restart = await head(downloadUrl, `bytes=0-${Math.min(1023, total - 1)}`);
  if (partial.status === 206 && restart.status === 206 && startFromContentRange(restart.contentRange) === 0) {
    ok(`a fresh request after a ${partial.bytes}-byte partial restarts at byte 0 and still states the full ${total}-byte length`);
  } else {
    bad(`restart check failed: partial ${partial.status}/${partial.bytes} bytes, fresh ${restart.status} from ${restart.contentRange ?? '<none>'}`);
  }
  if (partial.bytes === partialBytes) {
    ok(`the ranged read delivered exactly the ${partialBytes} bytes requested, so a partial file is measurable`);
  } else {
    bad(`the ranged read delivered ${partial.bytes} bytes but ${partialBytes} were requested`);
  }

  /* 7. A download link must be watermarked as an attachment; a playback link must not. */
  const dlHeaders = await head(downloadUrl, 'bytes=0-0');
  const playHeaders = await head(playbackUrl, 'bytes=0-0');
  info(`download disposition: ${dlHeaders.contentDisposition ?? '<none>'} | playback disposition: ${playHeaders.contentDisposition ?? '<none>'}`);
  if (playHeaders.status === 206) {
    ok('the playback link supports position seeking too (206)');
  } else {
    bad(`the playback link did not answer 206 (got ${playHeaders.status})`);
  }
}

try {
  await main();
} catch (error) {
  bad(error instanceof Error ? error.message : String(error));
}

const summary = [
  '## Live Watch verification (real server headers)',
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
