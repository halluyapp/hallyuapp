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
| 9 | A manual quality pick reset the default everywhere | `setPreferredQuality()` stored the pick globally and permanently, so one 1080p choice silently replaced the 360p default on every title |
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
  picker is a virtualised rail.
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
| Live Range/206/416 and full-size download | runs in CI (`scripts/ci/watch-live-check.mjs`), which now gates publication |
| Device tests (update prompt, background download, volume swipe, landscape lock, Play Offline) | **pending — stakeholder** |

Device behaviour is not reported as working anywhere in this change until the stakeholder confirms it.
