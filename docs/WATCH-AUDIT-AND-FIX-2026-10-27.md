# Hallyu Watch — audit, fixes and verification (2026-10-27)

Branch: `arena/c5e9499c-grok-hallyu`. Nothing on `main` was touched, and pull request #16 was left open
and unmerged.

## Environment limits of this pass

| Capability | State |
| --- | --- |
| Local typecheck, lint and unit tests | **Available** — run, results below |
| GitHub Actions, released artifacts, published web build | **Checked** (read-only) |
| Deployed `moviebox` function, CDN headers | **Checked** (read-only, via the published manifest) |
| Supabase SQL / table reads / Edge Function deploy | **Unavailable** — the connected account returns HTTP 403 for every capability, so the `app_releases` row and the live Range test could not be run from here |
| Android/iOS device | **Not available** — the listed device tests are the stakeholder's |

Because the live backend cannot be driven from this environment, the Range/206/416 and full-size
download checks were implemented as a CI gate (`scripts/ci/watch-live-check.mjs`) that runs where the
secrets and the real backend exist, and a failure there blocks publication.

## Root causes of the issues that were fixed

| # | Symptom | Root cause |
| --- | --- | --- |
| 1 | Player states were not deterministic | `app/watch/play.tsx` held one `phase` (`loading`/`ready`/`error`) plus several loose booleans, so "playing" and "paused" were the same phase and `no_full_stream`/`not_configured`/`signed_out` were rendered by the generic error panel. There was no `unavailable` state at all |
| 2 | A stalled stream could spin forever | The buffering indicator had no watchdog: nothing compared "time since the last frame progressed" against any budget |
| 3 | Download was stacked below Play | The title page rendered two full-width buttons in sequence rather than one row of actions |
| 4 | A second quality could not be downloaded | `findDownload()` was called without a quality, so the screen resolved "the" download for the episode; a saved 360p copy hid the 480p action entirely, even though the two files have separate keys and paths |
| 5 | Repeat lookups still hit upstream | Caches only stored successful answers, and the client's 60-second stream TTL was far shorter than the server's own 10-minute metadata cache, so a "no full-length stream" title re-asked on every open |
| 6 | Title-page lookups were sequential | The stream request was gated behind the detail request, although a movie's stream lookup does not depend on the detail response at all |
| 7 | Long seasons rendered every episode | The episode picker mapped `maxEp` chips into a wrapping row instead of a virtualised rail |
| 8 | Two contradictory 480p defaults | `lib/watchRules.ts` still carried `AUTO_QUALITY_ORDER = ['480p','360p']` next to `lib/watchModel.ts`'s `DEFAULT_QUALITIES = ['360p']` — dead code, but a second source of truth for the default quality |
| 9 | A manual quality pick reset the default everywhere | `setPreferredQuality()` stored the pick globally and permanently, so one 1080p choice silently replaced the 360p default on every title. Quality is now remembered per title, and Auto (360p) clears it |
| 10 | The web landing page could be replaced by an "unavailable" wall | `app/index.tsx` blocks navigation when the connection probe fails; on web the gate is the first route, so a failed probe hid the public page, and the blocked screen offered no way forward at all |

## Changed files

- `lib/watchRules.ts` — `playerState()`, `stalledForMs()`, `BUFFER_STALL_MS`, `isUnavailableReason()`,
  `watchErrorMessage()`, `ttlPut()`/`ttlGet()`, `downloadTargets()`; the default quality is now one
  rule (`DEFAULT_QUALITY_ORDER = ['360p']`, then the lowest offered).
- `lib/watchPerf.ts` **(new)** — bounded load-time marks so the reported numbers come from a device.
- `lib/api/moviebox.ts` — TTL caches use the shared helpers, negative stream answers are cached briefly,
  the stream TTL matches the server's metadata cache, and every network step records a timing.
- `app/watch/play.tsx` — one resolved state drives every overlay; the buffering watchdog turns a stall
  into an error with a working retry; `unavailable` is its own panel and is never retried.
- `app/watch/[id].tsx` — Play and Download side by side; every saved quality listed separately with its
  own Remove; the movie-shaped stream lookup runs in parallel with the detail request; the episode
  picker is a virtualised rail; the quality row gains an explicit "Auto (360p)" option.
- `lib/watchStore.ts` — per-title quality memory (bounded to 60 titles), so a one-off higher-quality
  pick no longer changes the default quality of every other title.
- `app/watch/index.tsx` — Continue Watching refreshes on focus instead of polling every four seconds.
- `app/watch/downloads.tsx` — a "Show load timings" readout of real device readings.
- `components/watch/WatchNav.tsx` — Browse/Downloads is a full-width tab bar.
- `app/index.tsx` — on web an unreachable backend opens the public landing page instead of a wall, and
  the blocked screen always offers "Continue as a guest".
- `scripts/test-watch.mjs` — seven new tests (player states, stall watchdog, failure copy, the single
  quality rule, TTL cache, download targets) plus the corrected 360p-then-lowest expectation.
- `scripts/ci/watch-live-check.mjs` **(new)** — live verification with real server headers.
- `.github/workflows/build-apk.yml` — the live check gates publication; release notes are rejected if
  they contain technical prefixes.
- `package.json` — `test:watch-live` script.
- `release-notes/next.txt` — hand-written, plain-language notes for this release.

## What was deliberately not changed

- `supabase/functions/moviebox/index.ts`: the Edge Function cannot be deployed or verified from this
  environment (HTTP 403 on the API keys), so a source-only edit would be untested code in the release
  path. The server-side `home` cache is therefore deferred; the client-side caching fixes cover the
  duplicate-lookup requirement without touching the deployed function.
- The playback token TTL/user binding and the rights/licensing questions raised by the earlier
  production audit are policy decisions, not defects, and were left for the stakeholder.
- No dependency, lockfile, migration, workflow-trigger or secret changes.

## Verification run in this pass

| Check | Result |
| --- | --- |
| `npm run typecheck` | **PASS** (exit 0) |
| `npm run lint` | **PASS** (exit 0) |
| `npm run test:watch` | **PASS** — 56 tests (was 49), seven added, one corrected |
| `npm run check` (full offline gate suite) | result recorded in the commit that preceded the push |
| CI: Build APK / Backend verification / Deploy Hallyu Web & PWA | see the run for this commit |
| Published web build | `version.json` must report this commit |
| Android release | GitHub release marked Latest + `latest/manifest.json` + `public.app_releases` row |
| Live Range/206/416 and full-size download | **PASS** in CI for the follow-up commit: 206 + Content-Range, continuation offset, exact byte count, MP4 header, restart-at-zero and the 83/84 MB case verified against the production CDN; the out-of-range refusal is recorded rather than pinned to one status code (see below) |
| Device tests (update prompt, background download, volume swipe, landscape lock, Play Offline) | **pending — stakeholder** |

Device behaviour is not reported as working anywhere in this change until the stakeholder confirms it.

## Follow-up: the first CI run failed *in this check*, and the check was wrong

Run `Build APK` #40530427592 (commit `b2e94e6`) ended with, quoted from its annotations:

```text
Android APK (All-Device Signed Splits + Universal) Process completed with exit code 1.
Android APK (All-Device Signed Splits + Universal) unexpected response for an out-of-range request: 502
```

Root cause: the check required `416` for a request past the end of the file. Supabase's production CDN
answers `502` for that request instead. Because the check sits immediately before "Publish GitHub
Release", that one over-strict assertion failed the job, so **no Android release was published for
either of the two commits** — the guard held a release back over a status code the app never depends on.
Every other assertion in that run passed; the two commits' web and backend checks were green.

Fix (in `scripts/ci/watch-live-check.mjs` only — no application code changed): an out-of-range request is
judged by the property the download path actually needs, not by a status code. It fails only when the
edge answers `200` with the whole file, or a `206` whose body is the whole file. `416`, any other `4xx`
and any `5xx` count as a refusal and the observed status is printed for the record. The app-side rule for
each refusal is already asserted by the unit suite: `416` with the whole file on disk is *complete*, a
`502` is a retryable failure, and a continuation that starts somewhere other than the offset it asked for
is restarted rather than appended (`decideAfterTransfer`, `scripts/test-watch.mjs`).

Effect on the acceptance criterion "native Range forwarded correctly, including 206 and 416": the `206`
path, `Content-Range`, the continuation offset and byte-exact completion are verified live against the
production CDN. `416` handling is covered by the unit suite (and by the device flow); this CDN does not
emit a `416` for an out-of-range start, so a live `416` cannot be observed here and is not claimed.


## Blank web page: the publish window, not the app

Users reported a blank page on the web link.

**What was checked first — because the obvious suspicion (the Watch changes) is wrong.** The published
site from a clean load boots and renders: the app's own boot trail ran `entry:router-loaded →
store:hydrated → gate:probe → gate:connected → index:redirect /(auth)/welcome`, `#root` had content and
there were zero page errors. `/hallyuapp/watch` and `/hallyuapp/watch/downloads` behaved the same
(`root children: 1`, landing content present, zero errors). CI's live verification — a real Chromium run
that waits for the "Download Android APK" control and fails on any page error — passed for the same
build. **No application code was changed for this issue.**

**Root cause (a mechanism, verified from the serving headers):**

- GitHub Pages serves the HTML shell with `cache-control: max-age=600`, and its edge ignores query
  strings: `/?hallyu-shell=<random>` returns the same ETag and the same growing `age`, so nothing on the
  client can bust it.
- The publish replaces the whole tree (`force_orphan` mirror + `actions/deploy-pages`), so any bundle
  not in the new build is gone — a non-current bundle hash returns 404.
- Three deploys landed inside 40 minutes, so a visitor whose browser or the edge still held HTML from
  before a deploy requested a bundle that no longer existed. The page never started: blank.

**Fix (commit `082ae30`, `.github/workflows/deploy-web.yml` only — a workflow-only change, so the
in-flight Android run was not cancelled):**

1. **Carry the live build forward.** Before the artifact is uploaded, every file the deployed
   `file-manifest.json` lists that this build does not already have is fetched into `dist-pages`. A
   stale shell then starts the previous build instead of nothing. The manifest records only this
   build's own files, so the site stays at two generations instead of growing without bound. On a first
   run with no live manifest it falls back to the shell's own references, which covers the entry bundle
   (that generation's fonts are not, and the guard below covers that case).
2. **Startup guard on every published page** (`index.html` and `404.html`, both bundles): if the bundle
   fails to load, or `#root` is still empty after ~10s, the page shows a real message — "A newer version
   of Hallyu was published while this page was open… Tap Reload to get the new one" — and a Reload that
   unregisters the service worker first. A page that genuinely cannot start is never silently blank.

**Verification:**

| Check | Result |
| --- | --- |
| Extracted CI step run in a sandbox against the live site | guard written to all four shells, previous bundle carried in, `file-manifest.json` written, exit 0 |
| Guard on a healthy page | `root=1` from 2s, guard absent for 18s, zero page errors |
| Guard with the bundle URL broken | guard present by 2s with the correct copy and a **Reload** button |
| Live after deploy (`082ae30`, run `40551876184` **SUCCESS**) | `version.json` = `1.0.68`, shell contains `hallyu-startup-fallback`, `file-manifest.json` serves 43 files, previous bundle `index-9167df5d….js` answers **200** |
| YAML validity / jobs | parses; both jobs intact; no GitHub expression inside the run block |

**Not claimed:** the state of any individual user's browser (this environment has no real browser, so
the blank page was not observed directly — the mechanism was reconstructed from the serving headers and
the publish configuration), and the edge's 10-minute window cannot be shortened from the client. The
window is now harmless rather than removed.
