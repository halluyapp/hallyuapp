# Hallyu — Build failure audit and fix plan (29 October 2026)

Scope: why **Build APK has failed on every push since 12:45Z**, what that has cost users, what else
the last ~24 hours of changes broke or left inconsistent, and the exact sequence to fix it without
breaking the published web app or the published Android release.

Branch audited: `arena/c5e9499c-grok-hallyu` at `868408a` (fast-forwarded from `c046c8e`).

---

## 1. Summary

**The app code is not what is failing the build.** TypeScript passes, and the Watch suite passes
90/90. The build fails on exactly one step — the live Watch verification — because that step now
talks **directly to a third-party video CDN** that refuses requests from datacenter IPs.

Result: **nine consecutive Build APK runs failed (12:45Z → 16:07Z)**, and **no Android release has
been published since `apk-269` / 1.0.269 on 28 October 06:45Z**. Roughly nineteen commits of work —
the entire Zarhosting migration, the download rewrite, and the subtitle work — are sitting on the
branch and have never reached a single user. The web app *is* current (version `1.0.85` @ `868408a`).

That combination is the real incident: **users are on 1.0.269, the web is on today's code, and the
Android update path has been silently frozen for a day** — while the failing gate is testing a
third party's WAF, not Hallyu.

---

## 2. Evidence

### 2.1 The failure streak

| Run | Commit | Build APK | Failing step | Annotation |
|---|---|---|---|---|
| 40908453182 | `868408a` | failure | Verify live Watch playback… | `expected 206 or 200 with content length, got 426` + `CDN did not state a total length` |
| 40905664481 | `0f562f2` | failure | same | `got 429` |
| 40904516175 | `44684e8` | failure | *different* — typecheck | `lib/api/moviebox.ts(26,91): Cannot find name 'normaliseDiagnostics'` |
| 40884832699 | `05b07d5` | failure | live check | `got 429` |
| 40880636856 | `8078329` | failure | live check | `502 — edge said {"error":"upstream_error","status":426}` |
| 40879414641 | `8f17f2a` | failure | live check | `got 502` |
| 40878528360 | `7138bcc` | failure | live check | (exit 1) |
| 40877249517 | `baf096d` | failure | live check | `got 429` |
| 40875979594 | `4a64ddc` | failure | live check | `got 429` |

Backend verification and Deploy Web passed on 8 of these 9 commits. Only `44684e8` broke everything,
and it was a genuine (already fixed) TypeScript error — that is the *second* problem, not the
current one.

### 2.2 The root cause, reproduced

The check (`scripts/ci/watch-live-check.mjs`) resolves a title through the Zarhosting API and then
requests the video bytes **straight from the CDN** (`bcdnxw.hakunaymatata.com`). Run from this
machine against the exact signed URL the API returns:

| Request identity | Status |
|---|---|
| no headers | `429` (nginx HTML body) |
| `User-Agent: HallyuApp/1.0` | `429` |
| `HallyuApp/1.0` + `Range: bytes=0-0` | `429` |
| iPhone Safari UA + `Referer: https://moviebox.ph/` | **`426 Forbidden`** (14-byte body) |
| ExoPlayer UA + Referer | `428` |
| Chrome UA + Referer, HTTP/2 | `426` |

The status is chosen by the WAF from the client fingerprint, and every value is a refusal. This
CDN does not serve datacenter/CI IP ranges. GitHub runners are datacenter IPs, so **the gate can
never pass from CI no matter how correct the app is** — and because it runs on *every push to
`arena/…`*, each push also burned more of that IP's rate limit, which is why the signature oscillates
between `429` and `426`.

The API half works perfectly from the same machine:

```
/home     -> 200, 22 rows, first row "Banner" with 13 titles
/search   -> 200, 19 titles
/detail   -> 200, seasons [{se:1,maxEp:5}…]
/stream   -> 200, 4 sources: 1080p/720p/480p/360p, sizes present
normalise* -> rows 22, qualities ["1080p","720p","480p","360p"], pick(null) = 360p  ✔ default rule
CORS       -> OPTIONS 204 + `access-control-allow-origin: *` (web is fine)
```

So browsing, metadata, quality selection and the 360p default are all healthy. Only byte transfer
from that CDN is refused, and only from this class of IP.

### 2.3 What the gate no longer checks

While making the check pass, it was rewritten to sample **64 KB** and to skip the earlier
contractual assertions. It no longer proves:

* an 83/84 MB file downloads end to end,
* a continuation offset is honoured,
* an out-of-range start is refused rather than answered with the whole file,
* a partial followed by a fresh request restarts at byte zero (no blind append),
* the proxy forwards `Range` at all (the proxy is no longer on the path).

So the gate is simultaneously **too strict** (third-party availability blocks releases) and **too
weak** (the acceptance criteria in the brief are no longer verified anywhere).

### 2.4 The second, quieter build problem: there is no usable lockfile

* `8f8bcce` deleted `bun.lock`.
* The file it deleted was not a Bun lockfile anyway — its content is npm format
  (`"lockfileVersion": 2`), which Bun rejects with `Unknown lockfile version`.
* CI runs `bun install --frozen-lockfile`, so without a parseable lockfile **every build resolves
  fresh transitive versions**. A single bad patch release can break a signed release build with no
  code change on our side.

Restoring a real lockfile locally (generated, then verified): `bun install` → 1165 packages,
`tsc --noEmit` → **0 errors**, watch suite → **90/90 pass**.

### 2.5 Scope drift and other findings

| # | Finding | Impact |
|---|---|---|
| 1 | **Subtitles were added** (`lib/subtitles.ts`, `lib/api/subtitles.ts`, `lib/watchSubtitleDownload.ts`, player subtitle UI that auto-enables captions, 3 test files, a release-notes bullet). The brief says subtitles are **out of scope**. | Unrequested feature shipping to users; also raises the Watch test count 49 → 90, so "the 49-test suite" in the brief no longer describes the repo. |
| 2 | **Megan removed wholesale** (`lib/api/megan.ts`, `supabase/functions/megan-metadata`, `components/search/MeganFallback.tsx`, drama/search edits, trending/ranking rows dropped). No dangling references remain. | Correct for Watch (brief forbids Megan downloads), but it also changed search/drama behaviour outside Watch with no regression pass on those screens. |
| 3 | **Playback now bypasses the server proxy.** `play.tsx` sends a hardcoded iPhone UA + `moviebox.ph` Referer to the CDN; `lib/api/moviebox.ts` hands the raw signed CDN URL to the player and downloader. The 634-line edge proxy and its sealed tokens are now dead code but still deployed. | No server-side fallback when a device or network is refused (exactly the class of refusal seen in §2.2); signed URLs expire mid-download; two parallel designs to maintain. |
| 4 | `release-notes/next.txt` has accumulated **11 bullets across several releases**, including the subtitle line and a vague "new source" line. | Contradicts "release notes per release, plain language"; the next release would announce old changes again. |
| 5 | `metadata.json` (Rork artifact) added at repo root. | Noise; harmless. |
| 6 | Verified good: 360p default, per-title quality memory, per-quality download keys, restart-from-zero on retry, MP4 layout validation before "complete", no infinite spinner rules, bounded probe (10 s, one retry), error boundary at app root, Downloads reachable inside Watch + from Home, Download beside Play. | These match the brief and are covered by the passing suite. |
| 7 | **Device items still unproven:** background download completion with the app closed, 83/84 MB transfer, volume swipe, landscape lock, airplane-mode offline play, update prompt 1.0.269 → next. | Cannot be verified from CI, especially now that the CDN refuses CI. |

---

## 3. How to fix it — order matters

Guiding rule: **an external service's WAF must never be able to freeze Hallyu's release pipeline,
and a release must never publish unverified Watch bytes.** Both are satisfiable by moving the
verification to a target we control and keeping the third-party check as *evidence*, not as a gate.

### Phase 0 — Unblock the pipeline (no app code touched)

1. **Split the gate into blocking and evidence.**
   * *Blocking (app contract, we control it):* `/home`, `/search`, `/detail`, `/stream` return ≥1 MP4
     with a stated size; the quality list obeys the 360p-then-lowest rule; the range fixture (below)
     returns `206` with the exact byte count, refuses an out-of-range start without a 200 whole-file
     body, honours a continuation offset, and restarts at byte 0 after a partial.
   * *Evidence (third party, cannot be controlled):* the direct CDN probe. Classify the outcome —
     `429/426/428` with no `Content-Range` from a datacenter IP is `external_blocked`, not a build
     defect. Emit it as a **warning annotation + step summary**, never as `exit 1`.
2. **Add a range fixture to the `moviebox` function** (`?action=fixture&bytes=…` or a Supabase
   Storage object): a small deterministic asset streamed with correct `206/416` and `Content-Range`.
   That is what proves Range forwarding and no-blind-append end to end, on infrastructure we own.
   Keep the 83/84 MB real-size run as a **device** test (it is already a stakeholder test) and as a
   manual `workflow_dispatch` job that is allowed to be skipped when `external_blocked`.
3. **Stop running the live CDN check on every push.** Run it on `main` publish and on manual
   dispatch; on `arena/…` pushes run the contract half only. This also stops the rate-limit spiral.
4. **Commit a real `bun.lock`** (already generated and verified locally) and keep
   `--frozen-lockfile` in CI, so a build cannot drift under us.
5. **Roll `release-notes/next.txt` back to this release's notes only** in plain language.

Exit criteria: one push to `arena/…` produces `Build APK = success`, a GitHub release marked
Latest, a matching `latest/manifest.json`, and a release-record row.

### Phase 1 — Ship the stranded work (1.0.270)

Publish from a green build, then verify in this order: release is Latest → manifest version/commit
match the build → six APK assets downloadable → in-app update check + push notification fire →
stakeholder device tests (background download with the app closed, 83/84 MB with real headers,
volume swipe, landscape lock, airplane mode, update prompt 1.0.269 → 1.0.270).

Do **not** describe background downloads or the 83/84 MB case as working until those device results
exist.

### Phase 2 — Decide the playback architecture (before more features)

Pick one and remove the other:

* **A. Server proxy as the only media path** (what the sealed-token design was for): the app never
  talks to the CDN; the edge function forwards `Range`, retries `429/5xx`, and answers `416`
  correctly. Pros: one origin, device IP never exposed to the WAF, downloadable links can be
  re-minted server-side on expiry, and CI can test the real path. Cons: Supabase egress carries
  every byte, and the proxy must be proven not to be blocked itself (`426` was seen once).
* **B. Direct CDN with a proxy fallback**: keep the current fast path, and on `403/426/429` or a
  stall, retry the same range through the proxy. Pros: cheapest, fastest. Cons: two paths to test.

Recommendation: **A for downloads, B for playback** — downloads must be reliable and resumable, and
a proxy gives a stable origin plus re-mintable links; playback benefits from the direct path but
needs a fallback so a WAF decision cannot break watching.

### Phase 3 — Correctness and honesty pass

* Re-instate the full contractual assertions (continuation, out-of-range refusal, restart-at-zero,
  full-file byte count) against the fixture, and map each to a unit test in `scripts/test-watch.mjs`.
* Bound every new network call (subtitle fetch, captions, `/home`) with visible error + retry.
* Player: ensure `external_blocked` maps to the existing deterministic `unavailable`/`error` states
  with one message, never a spinner.
* Decide subtitles: **remove from this release** (brief says out of scope) or obtain explicit
  written approval to ship them and update the brief. Default in this plan: remove the player
  subtitle UI and auto-enable, keep the parsing library dormant, drop the release-notes line.
* Regression pass on the screens touched by the Megan removal (search, drama, trending) on web and
  one Android build.

### Phase 4 — Hygiene

Lockfile committed and enforced; dead proxy code either wired back (Phase 2A) or deleted; delete
`metadata.json`; one release-notes file per release; CI step names/comments updated so the gate's
contract is documented where it runs.

---

## 4. Guardrails for whoever executes this

* Never merge PR #16 without an explicit instruction; never publish to Play/App Store.
* Do not "fix" the red build by deleting the check or by making every assertion non-blocking —
  split it by *ownership* (ours vs. third party), and keep the evidence visible.
* Do not weaken `--frozen-lockfile`; fix the lockfile instead.
* Any change to `.github/workflows/deploy-web.yml` does not cancel an in-flight Build APK run, but
  any change elsewhere does (`paths-ignore`); sequence publishing edits accordingly.
* Rotate any secret that was ever displayed; nothing in this audit prints a key or a signed URL.

---

## 5. Acceptance map (brief → current state)

| Brief criterion | State | Where it stands |
|---|---|---|
| 1 Cached Watch home | **met** | `readWatchHomeCache` + memory cache; verified |
| 2 No infinite spinner | **met (unit)** | `playerState`/watchdog rules pass |
| 3 No duplicate lookup | **met (unit)** | `callKeyed` + TTL caches |
| 4 Deterministic player states | **met (unit)** | 5 states, one message each |
| 5 Native Range forwarded | **not proven** | proxy bypassed; CI probe blocked by WAF |
| 6 83/84 MB with real headers | **not proven** | needs device or fixture |
| 7 No blind resume append | **met (code+unit)** | restart from byte 0 |
| 8 Two qualities never collide | **met (code+unit)** | `qualityDownloadKey` |
| 9 Android background downloads | **unverified** | device test only |
| 10 Downloads reachable | **met** | Watch nav + Home card |
| 11 Download beside Play | **met** | title page actions |
| 12 Play Offline in airplane mode | **unverified** | device test only |
| 13 Final report | this document | plus device results when available |

---

## 6. Commands used for this audit (repeatable)

```bash
git fetch && git merge --ff-only FETCH_HEAD
git show 8f8bcce^:bun.lock > /tmp/old-lock            # npm-format: not usable by bun
bun install                                            # 1165 packages; regenerated bun.lock
npx tsc --noEmit                                       # 0 errors
node --test scripts/test-watch.mjs scripts/test-subtitles.mjs \
  scripts/test-watch-subtitles.mjs scripts/test-moviebox-edge.mjs   # 90/90 pass
node /tmp/parse-check.mjs                              # live API + normalisers
curl -sD- -o /dev/null -H 'Range: bytes=0-0' '<signed cdn url>'   # 429/426/428 by UA
```
