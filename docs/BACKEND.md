# Hallyu backend

The Hallyu backend is defined, end to end, by the source in `supabase/`. There is no dashboard step
anywhere: every table, index, constraint, trigger, function, RLS policy, the storage bucket and the
scheduled jobs are created by an ordered migration that replays on a fresh Supabase project.

The backend is **not connected**. There is no credential in this repository, the app still runs
device-local, and connecting it is a later phase. See
[docs/BACKEND-CREDENTIALS.md](BACKEND-CREDENTIALS.md) for the credential map and the connection
sequence, and [docs/BACKEND-CONNECTION-CONTRACT.md](BACKEND-CONNECTION-CONTRACT.md) for what the
client consumes once the project exists.

## The catalog path

```
Hallyu app  ──▶  Hallyu backend  ──▶  TMDB
                       │
                       └─ normalises, caches, ranks, serves
```

The app never calls TMDB. `catalog-sync` fetches, normalises the answer into the payloads migration 24
documents, and hands each payload to an idempotent RPC. Whether a record is written, skipped as
unchanged, or flagged missing is decided in SQL, which is what makes a retry safe. Trailers and video
playback are deliberately out of scope: `titles.trailer_url` still exists, and nothing ingests it.

## Layout

```
supabase/
├── config.toml                     project configuration for `supabase start` / `db reset`
├── migrations/                     40 ordered migrations — the schema, applied in filename order
├── seed.sql                        reference rows only (4 worlds, 1 provider, 4 official rooms)
├── env.example                     every credential name, placeholder values only
├── functions/
│   ├── _shared/                    CORS, service-role client + guard, TMDB client and normalisers
│   ├── catalog-sync/               TMDB ingest: trending, refresh, detail, seasons
│   ├── catalog-jobs/               the scheduler's entry point → run_scheduled_jobs()
│   ├── push-dispatch/              claims deliveries, sends them, records per-delivery outcomes
│   ├── media-cleanup/              reconciles media rows against storage objects
│   ├── purge-deleted-accounts/     retention: hard-deletes tombstoned accounts and their objects
│   └── moderation-digest/          groups open reports into one decision per target
└── types/database.ts               the typed contract (tables, rows, inserts, updates, RPCs, enums)
```

## Migrations, in order

| # | File | What it creates |
| --- | --- | --- |
| 00 | `20260101120000_00_foundation.sql` | `pgcrypto`/`citext`/`pg_trgm`, `set_updated_at()`, `is_moderator()` |
| 01 | `20260101120100_01_reference.sql` | `visibility` enum, `worlds`, `providers` |
| 02 | `20260101120200_02_entertainment_catalog.sql` | `people`, `titles` (+ generated `search_document`), `title_people`, `title_episodes` |
| 03 | `20260101120300_03_profiles.sql` | `profiles`, handle generation, the `auth.users` → profile trigger |
| 04 | `20260101120400_04_user_preferences.sql` | `user_preferences` (one row per member), `title_alerts` |
| 05 | `20260101120500_05_collections.sql` | `collections`, `collection_items` |
| 06 | `20260101120600_06_social_graph.sql` | `follows`, `title_follows`, `person_follows`, `collection_follows`, `blocks`, `mutes` |
| 07 | `20260101120700_07_communities.sql` | `communities`, `community_members` |
| 08 | `20260101120800_08_posts.sql` | `posts`, `post_media` |
| 09 | `20260101120900_09_comments.sql` | `comments` (one level of threading) |
| 10 | `20260101121000_10_reactions.sql` | `reactions` + per-kind counters |
| 11 | `20260101121100_11_saves.sql` | `saves` |
| 12 | `20260101121200_12_watchlist.sql` | `watchlist_items` |
| 13 | `20260101121300_13_notifications.sql` | `notifications` |
| 14 | `20260101121400_14_push_tokens.sql` | `push_tokens` |
| 15 | `20260101121500_15_moderation.sql` | `reports` |
| 16 | `20260101121600_16_analytics.sql` | `analytics_events` (monthly partitions), `ensure_event_partition()` |
| 17 | `20260101121700_17_storage.sql` | the private `media` bucket and its policies |
| 18 | `20260101121800_18_notification_triggers.sql` | notification generation for follow/comment/reply/reaction/collection/moderation |
| 19 | `20260101121900_19_functions_social.sql` | `toggle_reaction`, `toggle_save`, `set_follow`, `set_block`, `set_mute`, `mark_notifications_read`, `register_push_token`, `report_content` |
| 20 | `20260101122000_20_functions_account.sql` | `merge_preferences`, `complete_onboarding`, `upsert_watchlist_item`, `handle_is_available`, `get_bootstrap`, `delete_account` |
| 21 | `20260101122100_21_functions_catalog_feed.sql` | `feed_posts`, `search_titles`, `record_event` |
| 22 | `20260101122200_22_retention.sql` | `purge_deleted_accounts()` + the documented `pg_cron` wiring |
| 23 | `20260101122300_23_catalog_provenance.sql` | freshness columns, `catalog_sync_runs`, `catalog_provider_state`, `titles_needing_refresh()` |
| 24 | `20260101122400_24_catalog_ingest.sql` | the idempotent ingest RPCs and the derived availability state |
| 25 | `20260101122500_25_catalog_ranking.sql` | `catalog_lifecycle_of`, `catalog_relevance_score`, `catalog_rank_snapshots`, `trending_titles`, `airing_titles`, `upcoming_titles`, `recently_released_titles`, `recommended_titles` |
| 26 | `20260101122600_26_home_aggregates.sql` | `get_home_discovery`, `get_world_discoveries`, `get_title_discovery` |
| 27 | `20260101122700_27_scheduled_jobs.sql` | `job_runs`, `job_claim`/`job_complete`, the catalog jobs, `run_scheduled_jobs` |
| 28 | `20260101122800_28_notification_delivery.sql` | `notification_deliveries`, `enqueue_notification`, fan-out, claim/report, retention |
| 29 | `20260101122900_29_episode_alerts.sql` | `title_audience`, `notify_at_for`, the three alert jobs |
| 30 | `20260101123000_30_media_lifecycle.sql` | `media_uploads`, the upload RPCs, storage reconciliation |
| 31 | `20260101123100_31_share_accounting.sql` | `post_shares`, `record_share`, the counter-integrity guards |
| 32 | `20260101123200_32_community_operations.sql` | ownership, membership requests, the community operation RPCs |
| 33 | `20260101123300_33_moderation_actions.sql` | `moderation_actions`, suspend/unsuspend, content actions, report decisions |
| 34 | `20260101123400_34_search.sql` | the federated search across titles, people, rooms, collections and members |
| 35 | `20260101123500_35_feed_pagination.sql` | `feed_page` with keyset cursors, the cursor codec, `comment_page` |
| 36 | `20260101123600_36_audit_and_deletion.sql` | a survivable audit log (`actor_handle`), and `delete_account`/`purge_deleted_accounts` completed for the new tables |
| 37 | `20260101123700_37_storage_removal_queue.sql` | `media_removal_queue` and the claim/complete RPCs — storage deletion goes through the Storage API — plus the `profiles_guard_privileges` trigger |
| 38 | `20260101123800_38_browse_ranking.sql` | `browse_titles` — the ranked browse surface behind Explore, with the sort degrading to the app-wide ordering rather than failing |
| 39 | `20260101123900_39_video_publishing.sql` | `video_creators` (the allowlist), `video_access_requests` (the queue), the grant/revoke/review RPCs, and the video gates on `begin_media_upload` + `post_media` |

## Freshness, ranking and discovery

**Freshness is decided from dates, not from a cached flag.** `catalog_lifecycle_of()` maps a title to
`airing | upcoming | recent | classic | unavailable` using its air dates, its status and whether the
provider still returns it. A record the provider stops returning is flagged and counted
(`catalog_missing_count`), never deleted — posts and watchlist entries still point at it.

**Refresh follows how fast content actually changes.** `catalog_refresh_interval()` asks for an airing
show every 12 hours, an upcoming one every 2 days, a finished one every 14 days.
`titles_needing_refresh()` is the queue; `catalog_upsert_title()` short-circuits on an unchanged
`content_hash`, so a re-run writes nothing.

**Ranking is Hallyu's, not TMDB's.** `catalog_relevance_score()` combines lifecycle (the dominant
term), log-compressed provider popularity, vote-weighted rating, recent episode activity, and real
Hallyu engagement (`title_follows`, `posts`, room membership). Old titles decay further with age. Every
discovery surface sorts on that one function, so Trending, the world rails and For You can never
disagree about the same title.

**The Home screen gets rails, not counters.** `get_home_discovery()` returns five rails (`continue`,
`tonight`, `trending`, `upcoming`, `recent`) and a `stats` block of member-specific numbers — watching,
want to watch, completed, alerts, episodes ahead, unread. It deliberately exposes no global catalog
count; the `catalog_health` block exists for the moderation surface and is labelled as such.

## Notifications, delivery and alerts

Creation and delivery are separate. No trigger performs a network call — `verify-backend-surface.mjs`
fails the build if one appears in a migration.

- `notifications` gains `dedupe_key`, `coalesce_count`, `expires_at`, `scheduled_for` and `deep_link`.
  `enqueue_notification()` is idempotent on `(recipient_id, dedupe_key)`: the same event bumps the
  counter instead of adding a row.
- `notification_deliveries` holds one row per `(notification, device)`. The worker claims with
  `for update skip locked`, so two workers cannot take the same batch.
- An accepted send is marked sent; a transient failure backs off exponentially and retries; a rejected
  token disables the device and fails its remaining deliveries in one transaction.
- Alerts read `title_episodes` live, are keyed per episode, and only reach members who follow, watch or
  have an alert on the title — with the relevant preference on.

## Scheduled jobs

Every job is a function with a run key. `job_claim()` returns the existing run to a second caller with
`did_claim = false`, so a cron tick, a manual run and a retry cannot collide. `run_scheduled_jobs()`
dispatches twelve jobs — catalog status, episode schedule, pruning, aggregates, trending, three alert
jobs, fan-out, notification retention, media reconciliation, moderation reconciliation — and each
failure is recorded without stopping the others.

## Design decisions worth knowing

- **Four edge tables, not one polymorphic `follows`.** A member follows a member, a title, a person
  or a collection. Separate tables mean four real foreign keys, so the database itself refuses a
  follow of something that does not exist.
- **The catalog is a cache, not a mirror.** `titles` and `people` are keyed by
  `(provider_id, external_id, media_type)`. Adding a second provider means inserting a row in
  `providers` — no schema change.
- **Counters are owned by the database.** Every denormalised count is maintained by `AFTER` triggers,
  *and* migration 31 adds `BEFORE UPDATE` guards that reject a client writing any of them directly.
  RLS cannot express "you may update this row but not this column", so the trigger does it.
- **Every privileged operation re-derives authority.** Community and moderation RPCs check
  `can_administer_community()` / `require_moderator()` in the database and write an append-only
  `moderation_actions` row in the same transaction as the change.
- **The audit log outlives the profile it names.** `moderation_actions.actor_id` is nullable with
  `on delete set null` and the moderator's handle is copied into the row at write time. A restrictive
  foreign key here would have made retention fail for exactly the accounts it exists to purge.
- **No arbitrary SQL.** Every function is `SECURITY DEFINER` with `set search_path = public, pg_temp`,
  validates its arguments, and authenticates the caller. The only dynamic SQL in the schema quotes
  identifiers and literals with `%I`/`%L`.
- **Pagination is keyset, not OFFSET.** `feed_page()` orders on a unique `(rank, created_at, id)`
  triple and compares with `<`, so the next page is exactly the rows after the last one seen. The
  legacy `feed_posts()` keeps its signature and walks cursors instead of using OFFSET.
- **Deletion is a two-step promise.** `delete_account()` scrubs the member immediately;
  `purge_deleted_accounts()` hard-deletes the tombstone after the retention window.
- **Events are partitioned and validated.** `analytics_events` is RANGE-partitioned by month with a
  default partition and a BRIN index; `record_event()` validates the name, caps properties at 2 kB and
  requires either a session or an install-scoped anonymous id. Every partition — the default one and
  each month created at run time by `ensure_event_partition()` — carries its own row level security
  flag. A partition read by name is checked against that partition's flag, not the parent's, so
  without it a single over-broad `grant select on all tables in schema public` would expose every
  event; with it, a partition denies everything and the parent's moderator policy still governs
  `select ... from analytics_events`.

## Verification

```sh
node scripts/verify-sql.mjs             # parses all 40 migrations; RLS, search_path, dynamic SQL, credentials
node scripts/verify-db-types.mjs        # proves supabase/types/database.ts matches the migrations
node scripts/verify-backend-surface.mjs # proves every required capability exists and is not a placeholder
node scripts/verify-backend.mjs         # live integration test against a real project
npm run check                           # typecheck, lint, fandom checks, and all offline backend checks
```

`verify-backend-surface.mjs` is the completeness gate: a manifest of every capability Hallyu's backend
must provide, each checked against the migration that implements it, plus a global scan that no
function is a placeholder. `.github/workflows/backend-verification.yml` runs everything on demand, on a
weekly schedule, or as a reusable workflow, reading credentials only from GitHub Secrets.

### What the live suite proves

`verify-backend.mjs` runs against a real project and covers, among others: ingest idempotency (an
identical payload writes nothing, a changed payload updates in place), missing records being flagged
rather than deleted, a stale "upcoming" flag being corrected from its air date, a 20-year-old title
staying out of trending and airing lists, Home rails existing instead of catalog counters, notification
dedupe and coalescing, preferences suppressing a notification at creation, fan-out idempotency, a
rejected token disabling the device, a transient failure scheduling a retry, alerts reaching only
members with a relationship to the title, `record_share` being idempotent per day, direct counter
writes being rejected, community permissions, moderation permissions and the audit log, search privacy,
cursor feed stability, media reconciliation, and job-claim idempotency.

### Known limitation

The migrations are parser-validated offline (`pgsql-parser`, the real PostgreSQL grammar). There is no
Postgres in this workspace, so applying them and running the live suite is the first step after a
project exists. The live suite exits `2` — not `1` — until then, which is how CI tells "no project yet"
apart from "the backend is broken".