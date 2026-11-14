# Downloads — how they get fixed

Audit date: 2026-10-29 · branch `arena/c5e9499c-grok-hallyu` · no merge, no deploy in this document.

Streaming works because the browser plays the CDN link directly. Downloads do not work for a
different set of reasons: two platforms cannot download at all, and Android asks the CDN for the
file as a *different client* than the one that is allowed to stream it.

---

## 1. What each platform can do today

| Platform | Download button | Engine | Result |
| --- | --- | --- | --- |
| Android APK (signed, published) | shown | `DownloadManager` via `HallyuDownloader` | starts, then fails or stalls — see §2.2 |
| Android, other builds (Expo Go / EAS) | shown | Expo `DownloadResumable`, foreground only | works while the app stays open |
| Web (browser) | **hidden** | none — `downloadsSupported()` is false | "Downloads are available in the Android and iOS apps." |
| iOS (PWA = the web build) | **hidden** | none | same as web |

So: web/iOS have no downloads by design, and Android has an engine that exists but cannot get the
bytes. Both are fixable; they are different pieces of work.

---

## 2. Root causes

### 2.1 Web and iOS PWA have no download path at all
`lib/watchStore.ts:142` — `downloadsSupported()` returns `Platform.OS !== 'web' && !!FileSystem.documentDirectory`.
iOS runs the web build, so both platforms are excluded by that single line. The title page hides the
Download button behind the same check (`app/watch/[id].tsx:361`), and the Downloads tab
(`components/watch/WatchNav.tsx`) therefore renders an empty state forever on the web.
This is a missing feature, not a crash — and it is the requirement that offline playback on iOS rests on.

### 2.2 Android downloads present a different identity to the CDN than playback does
Playback sends a browser identity on every request:
`app/watch/play.tsx:665` and `lib/watchStore.ts:657` both set
`Referer: https://moviebox.ph/` and an iPhone Safari `User-Agent`.

The native downloader sets neither. `scripts/ci/android-downloader-module.mjs:70-77` builds
`DownloadManager.Request(Uri.parse(url))` with a mime type, a title and a notification — and no
`addRequestHeader("Referer", …)` and no `setUserAgent(…)`. `DownloadManager` therefore arrives as
`User-Agent: AndroidDownloadManager/…`, with no referer.

The media host is `bcdnx.hakunaymatata.com` → ENA CDN, which refuses by client/network rather than by
token (recorded in `docs/BUILD-FAILURE-AUDIT-2026-10-29.md`: signed, unsigned, wrong-sign and every UA
all refused from this runner). A different UA and a missing Referer are exactly the kind of change that
turns a working stream into a refusal — and it matches the symptom you describe: playback fine,
download not.

I cannot prove this from this machine, because the CDN refuses this datacenter IP whatever we send.
It is the cheapest hypothesis to eliminate: two API calls in the generated Kotlin.

### 2.3 The download link is the raw CDN URL, not a proxy link
`lib/api/moviebox.ts:186-192` sets `downloadUrl: rawUrl` — the provider's own CDN URL. The file header
at `lib/api/moviebox.ts:1-7` claims every link is "a proxy link issued by the playback action, with a
sealed token"; that is stale. Consequences:

- we cannot add headers, control expiry, or relax CORS on the server side;
- a retry mints a *new* URL, so an interrupted transfer can never be continued;
- there is nothing to fall back to when the CDN refuses.

### 2.4 An interrupted download can only restart from zero
`lib/watchStore.ts:380-400` treats a short response as a failure, and `resumeDownload`
(`lib/watchStore.ts:848`) deletes the partial file before restarting. That satisfies "no blind append",
but on a poor connection an 84 MB transfer may never reach the end, because byte 1 is fetched again
every time. There is no `Content-Range` continuation path anywhere.

### 2.5 Every native failure is reported as the same sentence
`pollNative` (`lib/watchStore.ts:508-515`) receives `status: 'failed'` from the module and writes
"The download stopped. Tap retry." The module never surfaces `DownloadManager.COLUMN_REASON` or the
HTTP status, so a 403 from the CDN, a dead link and a full disk all look identical.

### 2.6 A finished download is copied a second time
`settleNativeSuccess` (`lib/watchStore.ts:565-580`) copies the file from `getExternalFilesDir` into
`documentDirectory`, i.e. a second full copy of an 84 MB file, then validates. Peak usage is double the
file size, and the copy can fail *after* a successful download. The source directory is already
app-private, so the copy buys nothing.

### 2.7 Nothing in CI proves a download works
`build-apk.yml:316-330` only asserts that `HallyuDownloader` exists in the DEX. There is no transfer
test, no Range test, no two-quality isolation test, no offline playback test. Acceptance criteria 6
and 7 currently have no automated evidence.

---

## 3. The plan

Each step ships on its own and can be reverted on its own. Nothing here touches playback, the catalog,
auth, or the app shell.

### Step 1 — Give the native downloader the same identity as the player (Android)
`scripts/ci/android-downloader-module.mjs`:

- `addRequestHeader("Referer", "https://moviebox.ph/")` — allowed by `DownloadManager`.
- `setUserAgent(<the same iPhone Safari UA string already used for playback>)` — `setUserAgent` is a
  public `Request` API; `Range` may not be set, `DownloadManager` manages resumption itself.
- `setAllowedOverMetered(true)` and `setVisibleInDownloadsUi(false)` so data connections are not
  silently blocked and the raw file does not appear in the Downloads app.
- `query()` returns `reason` (`COLUMN_REASON`) and, when the failure is HTTP, `COLUMN_ERROR_CODE`-style
  detail, so §2.5 can say "The server refused the download (403)."

One shared constant for the UA/Referer pair, used by `play.tsx`, `makeResumable` and the Kotlin
generator, so the three cannot drift again.

Verification: a node test asserting the generated Kotlin contains both calls and that the UA constant
matches the one used in JS; then the Build APK step; then a real device download.

### Step 2 — Stop copying the file twice (Android)
Keep the `DownloadManager` output in place (it is `getExternalFilesDir`, app-private and playable),
validate it there, and record that URI. Copy only if validation fails and the file is still needed for
evidence. Removes the double-disk requirement and the "finished but could not be saved" failure.

Verification: same device test, checking free space before/after equals the file size, not twice it.

### Step 3 — Issue a download link we control (the actual fix)
Extend the existing `moviebox` edge function with a `download` action:

- mints a 4-hour signed token (`?action=download&t=…`), same secret pattern already used;
- fetches the CDN object **server-side** with the Referer/UA the CDN wants;
- forwards the client's `Range` header and passes back `206`/`416` with `Content-Range`,
  `Content-Length` and `Accept-Ranges` intact;
- sends `Content-Disposition` with a clean filename.

`fetchWatchPlayback` then returns that link as `downloadUrl`. Effects, all at once:

- the CDN sees the one identity it accepts, so the Android native downloader no longer has to imitate a
  browser (Step 1 becomes belt-and-braces);
- the URL is stable and same-origin, so §2.3 and §2.4 stop being blockers;
- the same endpoint becomes the playback fallback when the CDN refuses a browser directly.

Cost, stated honestly: video bytes then leave through Supabase egress instead of the CDN. Mitigation is
built into the design — probe the direct link first with a 1-byte `Range`; use the proxy only when the
direct probe is refused or CORS-blocked. Streams that work today keep costing nothing. **This is the one
decision that is yours**: if proxied egress is unacceptable, the fallback is to move media to a CDN that
serves your users (the pre-`4a64ddc` path is still in git history) and keep this endpoint for downloads
only.

Verification: contract test against a local fixture that enforces `206`/`416`, run in CI without
depending on the third-party CDN.

### Step 4 — Resume by verified continuation, not by restart
- Persist the byte offset on every throttled progress write (already stored as `bytesWritten`).
- On retry against the stable proxy URL: request `Range: bytes=<offset>-`, and continue **only** when
  the response is `206` *and* `Content-Range` starts at `<offset>` *and* the file on disk is exactly
  `<offset>` bytes. Anything else truncates to zero and restarts.
- Reuse Expo `resumeData` again, now that the URL carries no CDN secret.
- Android: `DownloadManager` performs its own continuation; the app only has to not delete the partial.

Verification: unit tests for the accept/restart decision (extends `decideAfterTransfer` in
`lib/watchRules.ts` and `scripts/test-watch.mjs`), plus the 83/84 MB fixture interrupted at ~50 %.

### Step 5 — Downloads on web and iOS PWA
- Storage: `caches.open('hallyu-offline-v1')` in `public/sw.js`, one entry per download keyed by
  `/offline/<key>`; metadata (title, quality, bytes, savedAt) in IndexedDB next to the existing
  `AsyncStorage` records so the Downloads tab keeps its current shape.
- `downloadsSupported()` becomes true on web when `caches` and `Blob` exist.
- Transfer: `fetch` with a `Range`-less full read, streamed into a `Response` written to the cache, with
  progress from `response.body` reader; cancel = `cache.delete`.
- Playback: the player already accepts a URI — pass `/offline/<key>`, and the service worker answers
  from cache when offline. No blob URLs to leak, and airplane mode works.
- Quota: refuse to start when `navigator.storage.estimate()` has less than `size + 200 MB` free.
- Honesty in the UI: iOS may evict site storage; the row says "kept until the browser clears storage"
  rather than "permanent".

Verification: Playwright/manual on the deployed preview — download, go offline, play, remove; plus a
test that a second quality creates a second cache entry and the first still plays.

### Step 6 — Make it provable in CI
New `scripts/ci/downloads-check.mjs` + fixture server (local, not third-party):

1. serve an 83 MB and an 84 MB MP4 with real `Content-Length`, `Accept-Ranges`, `206`, `416`;
2. assert continuation from a byte offset returns exactly the remaining bytes;
3. assert a deliberately wrong offset restarts at zero;
4. assert two qualities of one title write two distinct files and both validate;
5. assert a truncated body is rejected by `validateMp4Layout`;
6. run the same suite against the proxy endpoint once Step 3 lands.

Wired as a blocking step in `build-apk.yml` (it needs no network), and as an evidence-only probe of
the live CDN, matching the split already used by `watch-live-check.mjs`.

### Step 7 — Release and device verification
Release notes in plain language, one release, then the device list from the brief: background download
with the app closed, 83/84 MB transfer, airplane-mode playback, update 1.0.269 → new build.

---

## 4. Verification matrix

| Acceptance criterion | Proof after this plan |
| --- | --- |
| 6. 83/84 MB download with real headers | Step 6 fixture, blocking in CI; device run |
| 7. No blind resume append | Step 4 rules + unit tests + fixture interruption test |
| 8. Two qualities never collide | existing key rule, plus Step 6.4 file-level assertion |
| 9. Android background download | Step 1 + Step 2, production APK, **device only** |
| 10. Downloads tab reachable | already true; Step 5 makes it non-empty on web |
| 11. Download beside Play | already true on Android; becomes true on web after Step 5 |
| 12. Play Offline in airplane mode | Step 2 (Android) and Step 5 (web/iOS), device test |

---

## 5. Risk and rollback

| Change | Risk | Rollback |
| --- | --- | --- |
| Steps 1–2 | low: generator strings + storage target; no schema, no UI | revert one commit, rebuild |
| Step 3 | medium: egress cost, and a proxy must forward Range correctly or downloads truncate | feature flag in the client (`USE_PROXY_DOWNLOAD`); direct link is the fallback and needs no server change |
| Step 4 | medium: a wrong continuation corrupts a file | the `206` + `Content-Range` + on-disk-size triple check; otherwise restart at zero (today's behaviour) |
| Step 5 | medium: service-worker cache growth, iOS eviction | cache version bump `hallyu-offline-v1` → `v2` on activate; storage cap in the UI |

Nothing in this plan alters the catalog client, playback, auth, the store, or the app shell, so no
existing functionality depends on these files changing.

---

## 6. What is needed from you

1. **One decision:** is proxying download bytes through Supabase acceptable (Step 3)? It is the only
   change that removes the CDN refusal permanently. Without it, Steps 1–2 may fix Android and Step 5
   still fixes web/iOS, but a refused CDN stays a refusal.
2. **Device tests** after the release: background download with the app closed, the 83/84 MB transfer,
   airplane-mode playback. I will not report these as working before you run them.
