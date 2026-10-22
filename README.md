# Hallyu

**Hallyu** is a real-time social entertainment platform built around four global fandom worlds — **K-Drama**, **C-Drama**, **Anime**, and **Hollywood Series & Films** — across **Android**, **iPhone / iPad Home-Screen Web App (PWA)**, and **Desktop Web**.

---

## Live Links & Downloads

| Platform / Surface | Live URL | Details |
|---|---|---|
| **Web App & Premiere Landing Page** | **[https://macaulay-spec.github.io/Grok-hallyu/](https://macaulay-spec.github.io/Grok-hallyu/)** | Full browser app, interactive screen previews, smart deep links & iOS installer (`gh-pages` branch auto-deployed by CI) |
| **Android Phone APK — Slim (`arm64-v8a`, Recommended)** | **[Direct Download (`hallyu-arm64.apk` · ~32.7 MB)](https://kzxlbscfkixnswurpkzb.supabase.co/storage/v1/object/public/app-releases/latest/hallyu-arm64.apk)** | Hosted on public Supabase Global CDN (`app-releases`), signed with Hallyu's permanent 4096-bit RSA release certificate |
| **Android Universal APK (`arm64-v8a` + `armeabi-v7a` + `x86_64`)** | **[Latest Signed GitHub Release (`hallyu.apk`)](https://github.com/macaulay-spec/Grok-hallyu/releases/latest)** | Multi-architecture build for all Android devices, tablets, Chromebooks & emulators |
| **Self-Updater Release Manifest** | **[latest/manifest.json](https://kzxlbscfkixnswurpkzb.supabase.co/storage/v1/object/public/app-releases/latest/manifest.json)** | Live SHA-256 checksums, `versionCode`, release notes & binary URLs consumed by the in-app updater |
| **iPhone / iPad (iOS 16.4+)** | Open **[https://macaulay-spec.github.io/Grok-hallyu/](https://macaulay-spec.github.io/Grok-hallyu/)** in **Safari** → tap **Share** → **Add to Home Screen** | Full-screen standalone black status-bar launch + native Apple Web Push notifications (`VAPID`) |
| **Official Support & Inquiries** | **`fixhallyu@gmail.com`** | In-app bug reports & show requests route directly to the `@ceohallyu` Admin Studio |

> **Enabling GitHub Pages on first setup:** In repository **Settings → Pages → Build and deployment**, set **Source** to **Deploy from a branch** and select **`gh-pages` / `/ (root)`**. Every commit cleanly updates `gh-pages` via `.github/workflows/deploy-web.yml`, including SPA `404.html` deep-link routing, `manifest.json`, `sw.js`, and Android App Links verification (`.well-known/assetlinks.json`).

---

## Product Pillars & Live Features

1. **Social-First Home Feed (`app/(tabs)/index.tsx`)**
   - Member thoughts, reviews, episode reactions, short-form videos, and community conversations sit right at the top of Home with zero catalog clutter.
   - Sleek compact discovery strips weave into the timeline every 7 posts without displacing social activity.
   - Instant access to **Direct Messages**, **Global Search**, and **Live Watch Parties** from the Home header.

2. **Four-World Explore & Bayesian 2026 Ranking Engine (`app/(tabs)/explore.tsx`)**
   - Dedicated world tabs and strictly classified rails across **K-Drama**, **C-Drama**, **Anime**, and **Hollywood**.
   - **Pure scripted catalog:** SQL (`public.is_non_scripted_noise`) + TMDB ingestion filters strip daytime talk shows, news broadcasts, reality TV, and soaps from discovery rails.
   - **Bayesian vote-confidence scoring (`public.catalog_relevance_score`):** Combines 2025/2026 airing recency, Bayesian rating prior (`m = 120`), audience vote confidence, episode air-date momentum, and live Hallyu community activity while preventing low-vote entries or legacy procedurals from hijacking `#1` world spots.

3. **Episode Rooms, Spoiler Veils & Collections**
   - Per-episode discussion rooms (`app/drama/[id]/episode/[ep].tsx`) with spoiler-guarded posts, reaction meters, timestamped discussion, watch status tracking, ratings, and shareable curated collections.

4. **Hallyu Live Events Hub (`app/events.tsx` · `public.hallyu_events`)**
   - Scheduled live **Watch Parties**, **Premiere Countdowns** rendered automatically in each member's local timezone, one-tap **RSVPs** (`toggle_event_rsvp`), real-time **Episode Prediction Polls** (`vote_event_poll`), deep links straight into Episode Rooms, and in-app **Admin Event Creation** for `@ceohallyu`.

5. **24/7 Remote Push Notifications Engine (`supabase/functions/push-dispatch/index.ts`)**
   - **Android Native Push:** Real **Google OAuth2 RS256** service-account authentication dispatching **Firebase Cloud Messaging HTTP v1** high-priority payloads (`MAX` importance channels, sound + vibration + lock-screen wake).
   - **iOS PWA & Desktop Web Push:** Native **`RFC 8291` (`aes128gcm`) + `ECDSA P-256 VAPID`** encryption directly inside the Deno Edge Function + `public/sw.js` service worker.
   - **Event & Broadcast Triggers:** Covers comments, replies, likes, follows, **Direct Messages**, **Followed Creator Post Drops**, **10-second debounced `pg_net` instant wake**, **`@ceohallyu` CEO Broadcast Megaphone** (`send_admin_broadcast`), plus an opt-in Android persistent shade banner (**Hallyu Live Pulse**).

6. **Gated Short-Form Video Creator Studio (`app/(tabs)/shorts.tsx` · `app/create.tsx`)**
   - Full-screen vertical video feed backed by signed private media delivery, monthly storage/upload budgets, creator access request sheets, and real-time approval queues inside `@ceohallyu`'s Moderation & Admin Studio.

7. **Commercial Settings, Multi-Language UI & Play-Store-Free Self-Updater (`app/settings/*`)**
   - **Appearance:** Live **True Black (`#000000` OLED)** vs **Cinema Charcoal (`#101116`)** theme switching.
   - **Languages (`lib/i18n.ts`):** Live UI localization across **English**, **한국어**, **中文**, **日本語**, and **Español**.
   - **Data Saver:** Adaptive TMDB poster/backdrop resolution (`w342` vs `w780`/`original`) and media preload throttling.
   - **Account & Privacy:** Change Handle (`change_my_handle`), Change Password, Export Account Data JSON, Blocked/Muted management, and Account Deletion.
   - **In-App Self-Updater (`lib/appUpdater.ts` · `app/settings/updates.tsx`):** Checks `public.get_latest_app_release()`, downloads the slim `arm64-v8a` APK with a live progress bar, verifies its **SHA-256** digest before installation, and hands off seamlessly to Android's package installer for in-place upgrades (`SHA-256` signing cert: `64:20:BE:5B:CF:B5:EA:B5:D7:3A:74:BA:06:B7:94:36:FC:68:B2:69:7E:3E:63:36:16:4B:74:51:CB:15:31:DA`).
   - **Native Bug & Show Request Triage (`app/settings/bug-report.tsx`):** One-tap bug reporting (with automatic `ErrorBoundary` crash prefill) synced straight to `public.support_tickets`.

---

## Connected Backend Architecture (`supabase/`)

Hallyu runs against a live connected **Supabase (`PostgreSQL 16 + Auth + Storage + Realtime + Edge Functions + pg_cron + pg_net`)** backend with **zero secrets stored in Git**:

- **`supabase/migrations/` (`47` ordered SQL migrations):**
  - `51` RLS-protected tables (`row level security` enforced across every public table and partition).
  - `239` SQL functions/RPCs with pinned `search_path = public, pg_temp` on every `SECURITY DEFINER` routine.
  - Partitioned analytics events, full-text search indexes, rate limiters, content moderation queues, `public.hallyu_events`, `public.support_tickets`, `public.app_releases`, and `service_role`-only `public.ci_build_vault`.
- **Supabase Storage Buckets:**
  - `media` (private): Signed upload & playback URLs for member avatars, post images, and short-form creator videos.
  - `app-releases` (public CDN): Hosts `latest/hallyu-arm64.apk` and `latest/manifest.json` so self-updates and direct APK downloads work even when the GitHub repository is set to private.
- **`supabase/functions/` (`6` Deno Edge Functions):**
  - `catalog-sync`: Automated TMDB ingestion, non-scripted noise filtering, episode refresh, `end_year` reconciliation, and Bayesian score recalculation.
  - `push-dispatch`: Dual-engine Firebase FCM HTTP v1 + Web Push (`VAPID`) notification dispatcher.
  - `rork-auth`, `account-purge`, `moderation-digest`, plus shared world/TMDB classifiers (`_shared/`).
- **`supabase/types/database.ts`:** Strictly typed client-to-DB contract verified automatically against every SQL migration.

---

## Local Development

```bash
bun install          # or npm install
cp .env.example .env # populate EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY
npx expo start
```

### Run All 12 Automated Verification Gates

```bash
npm run check
```

`npm run check` runs the full offline verification pipeline end-to-end:

1. `npm run typecheck` — Strict TypeScript check (`tsc --noEmit`)
2. `npm run lint` — ESLint across app, libraries, and scripts
3. `npm run test:fandoms` — Four-world classification invariants (`K-Drama`, `C-Drama`, `Anime`, `Hollywood`)
4. `npm run test:audit` — Deduplicated Explore rail leader & push configuration invariants
5. `npm run test:upgrade` — Phase 1–8 production launch capability verification
6. `npm run test:sql` — Parses all 47 PostgreSQL migrations, RLS policies, and `SECURITY DEFINER` search paths
7. `npm run test:db-types` — Ensures `supabase/types/database.ts` matches SQL schema tables & enums
8. `npm run test:signatures` — RPC signature & PostgREST probe verification
9. `npm run test:apply` — Migration splitter & PostgreSQL error classifier tests
10. `npm run test:backend-surface` — Verifies video creator gating, RPC surface, Edge Function guards, and scheduled jobs
11. `npm run test:secrets` — Scans all tracked repository files to guarantee zero leaked keys/tokens
12. `npm run test:home-render` — Proves `useApp()` referential stability so Home can never enter a render loop

---

## Continuous Integration & Release Pipelines (`.github/workflows/`)

- **`backend-verification.yml`** — Runs offline static checks, replays all 47 migrations against a live `postgres:16` service container, compiles every SQL function body, verifies schema parity (`verify-schema-sync.mjs`), and executes live authenticated CRUD + RLS tests.
- **`deploy-web.yml`** — Exports the production Expo Single-Page Web App (`npx expo export --platform web`), injects iOS Safari standalone PWA & OpenGraph tags (`scripts/ci/enhance-web-html.mjs`), creates `404.html` + `.nojekyll`, and publishes directly to `gh-pages`.
- **`build-apk.yml`** — Materializes ephemeral signing & Firebase credentials at build time (`scripts/ci/load-build-secrets.mjs`), compiles ABI-split **`arm64-v8a` Slim (`~32.7 MB`)** + **Universal** release APKs signed with Hallyu's permanent 4096-bit RSA key, cold-boots and tests real sign-in inside an Android emulator (`boot-check.sh` + `auth-flow-check.mjs`), publishes the GitHub Release, and updates the public Supabase `app-releases` CDN + `public.app_releases` table automatically.
