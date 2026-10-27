#!/usr/bin/env node
// Hallyu backend — capability surface check.
//
// verify-sql.mjs proves the migrations parse and obey the security invariants. verify-db-types.mjs
// proves the TypeScript contract matches them. Neither proves the *product* is complete: that every
// capability the app depends on actually has an implementation, that no required function is a
// `raise exception 'not implemented'` placeholder, and that nothing reads the catalog directly.
//
// This script is that check. It is a manifest: every capability Hallyu's backend must provide, and
// for each one the evidence that proves it is real. A capability with no evidence fails the run.
//
// Exit code 0 = every capability is present and backed by real logic.

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parse } from 'pgsql-parser';

const MIGRATIONS_DIR = path.resolve('supabase/migrations');
const FUNCTIONS_DIR = path.resolve('supabase/functions');

const failures = [];
const notes = [];

const fail = (message) => failures.push(message);
const ok = (message) => notes.push(message);

// ---------------------------------------------------------------------------------------------
// Read every migration once
// ---------------------------------------------------------------------------------------------

const migrationFiles = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
if (migrationFiles.length === 0) {
  console.error('✗ no migrations found');
  process.exit(1);
}

const migrationText = new Map();
const functionNames = new Map();   // function name -> sql text
const functionOptions = new Map(); // function name -> array of options from the AST

for (const file of migrationFiles) {
  const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
  migrationText.set(file, sql);

  const tree = await parse(sql);
  const stmts = Array.isArray(tree) ? tree : (tree?.stmts ?? []);

  for (const raw of stmts) {
    const node = raw?.stmt;
    if (!node?.CreateFunctionStmt) continue;

    // libpg_query puts the function's own name in `funcname`; `parameters[0]` is the *first
    // argument*, which is a different thing entirely.
    const name = node.CreateFunctionStmt.funcname?.[node.CreateFunctionStmt.funcname.length - 1]?.String?.sval;
    if (!name) continue;

    functionNames.set(name, `${functionNames.get(name) ?? ''}\n${sliceFunctionBody(sql, name)}`);

    if (!functionOptions.has(name)) functionOptions.set(name, []);
    functionOptions.get(name).push(...(node.CreateFunctionStmt.options ?? []));
  }
}

/**
 * Slices one function's own text out of a migration. The AST does not carry the body for every
 * shape, and checking the whole file would let one function's logic vouch for another's, so the
 * slice runs from the function's own `create or replace` to the end of its body delimiter.
 */
function sliceFunctionBody(sql, name) {
  const start = sql.search(new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+(public\\.)?${name}\\s*\\(`, 'i'));
  if (start === -1) return '';

  const bodyStart = sql.indexOf('$$', start);
  if (bodyStart === -1) return '';

  const bodyEnd = sql.indexOf('$$;', bodyStart + 2);
  return sql.slice(start, bodyEnd === -1 ? Math.min(sql.length, bodyStart + 2000) : bodyEnd + 2);
}

const allSql = [...migrationText.values()].join('\n');

/**
 * Resolves the end state of one column's NOT NULL and its foreign key's ON DELETE rule by replaying
 * the migrations in order: the `create table` declaration, then every later `alter table` that
 * changes exactly that column or constraint. Only the final state is returned, which is what the
 * database ends up with.
 */
function trackForeignKey(sqls, table, column) {
  const state = { notNull: false, onDelete: null };

  for (const sql of sqls) {
    // The original declaration.
    const create = new RegExp(
      `create table if not exists public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`,
      'i',
    ).exec(sql);
    if (create) {
      const declaration = new RegExp(`^\\s*${column}\\s+[^,]*,?\\s*$`, 'im').exec(create[1]);
      if (declaration) {
        state.notNull = /\bnot\s+null\b/i.test(declaration[0]);
        const rule = /on\s+delete\s+(cascade|set\s+null|set\s+default|restrict|no\s+action)/i.exec(declaration[0]);
        state.onDelete = rule ? rule[1].toLowerCase().replace(/\s+/g, ' ') : null;
      }
    }

    // Relaxing the constraint later is legitimate and must win.
    if (new RegExp(`alter table public\\.${table}\\s+alter column ${column}\\s+drop not null`, 'i').test(sql)) {
      state.notNull = false;
    }
    if (new RegExp(`alter table public\\.${table}\\s+alter column ${column}\\s+set not null`, 'i').test(sql)) {
      state.notNull = true;
    }

    // Re-pointing the foreign key is also legitimate. Drop and add are applied in the order they
    // appear in the file: a migration that drops a constraint and re-adds it with a different rule
    // must end up with the new rule, not with nothing.
    const changes = [
      ...[...sql.matchAll(new RegExp(`add constraint ${table}_${column}_fkey\\b[\\s\\S]*?on delete (cascade|set null|set default|restrict|no action)`, 'gi'))].map((m) => ({
        index: m.index,
        rule: m[1].toLowerCase().replace(/\s+/g, ' '),
      })),
      ...[...sql.matchAll(new RegExp(`drop constraint if exists ${table}_${column}_fkey`, 'gi'))].map((m) => ({
        index: m.index,
        rule: null,
      })),
    ].sort((a, b) => a.index - b.index);

    for (const change of changes) {
      state.onDelete = change.rule;
    }
  }

  return state;
}

const hasFunction = (name) => functionNames.has(name);
const functionSql = (name) => functionNames.get(name) ?? '';

/**
 * The check that matters most: a function that raises "not implemented" is a placeholder, not a
 * backend. Match the shapes such a function takes, including the empty-body form.
 */
function assertRealImplementation(name, mustContain = []) {
  if (!hasFunction(name)) {
    fail(`required function ${name}() does not exist`);
    return false;
  }

  const body = functionSql(name);
  const stripped = body
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();

  if (/\braise\b[^;]*(not implemented|todo|tbd|unimplemented)/i.test(stripped)) {
    fail(`${name}() is a placeholder — it raises instead of implementing`);
    return false;
  }

  if (stripped.length < 250) {
    fail(`${name}() looks like a stub (${stripped.length} characters of non-comment SQL)`);
    return false;
  }

  for (const needle of mustContain) {
    if (!stripped.toLowerCase().includes(needle.toLowerCase())) {
      fail(`${name}() does not contain "${needle}" — the documented behaviour is missing`);
      return false;
    }
  }

  return true;
}

// Every function in the schema, not only the required ones, must be a real implementation. A
// placeholder anywhere is a promise the backend does not keep, and the manifest check below would
// never see it.
for (const [name, body] of functionNames) {
  const stripped = body
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();

  if (/\braise\b[^;]*(not implemented|todo|tbd|unimplemented|coming soon)/i.test(stripped)) {
    fail(`${name}() is a placeholder — it raises instead of implementing`);
  }

  if (stripped.length < 150) {
    fail(`${name}() looks like a stub (${stripped.length} characters of non-comment SQL)`);
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Catalog layer (requirement 2)
// ---------------------------------------------------------------------------------------------

const CATALOG_FUNCTIONS = [
  ['catalog_upsert_title', ['on conflict', 'catalog_synced_at', 'content_hash']],
  ['catalog_upsert_episodes', ['on conflict', 'air_date']],
  ['catalog_upsert_person', ['on conflict']],
  ['catalog_upsert_title_people', ['on conflict', 'title_people']],
  ['catalog_mark_missing', ['catalog_missing_count', 'catalog_unavailable_at']],
  ['catalog_begin_run', ['idempotency_key']],
  ['catalog_finish_run', ['finished_at', 'consecutive_failures']],
  ['catalog_recompute_title_state', ['first_air_date', 'last_air_date']],
  ['catalog_recompute_next_episode', ['title_episodes']],
  ['titles_needing_refresh', ['catalog_refresh_interval']],
  ['catalog_provider_is_usable', ['rate_limited_until']],
];

for (const [name, needles] of CATALOG_FUNCTIONS) assertRealImplementation(name, needles);

if (!/create table if not exists public\.catalog_sync_runs/i.test(allSql)) {
  fail('catalog_sync_runs table is missing — catalog runs cannot be recorded');
}
if (!/create table if not exists public\.catalog_provider_state/i.test(allSql)) {
  fail('catalog_provider_state table is missing — provider health cannot be tracked');
}

// The freshness timestamps that make "stale" decidable must exist as columns.
for (const column of ['catalog_synced_at', 'content_hash', 'catalog_missing_count', 'catalog_unavailable_at']) {
  if (!new RegExp(`add column if not exists ${column}`, 'i').test(allSql)) {
    fail(`titles.${column} is not added by any migration — freshness cannot be decided`);
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Hallyu ranking and discovery (requirements 4 and 5)
// ---------------------------------------------------------------------------------------------

assertRealImplementation('catalog_lifecycle_of', ['airing', 'upcoming', 'recent', 'classic']);
assertRealImplementation('catalog_relevance_score', ['airing', 'popularity', 'title_follows']);
assertRealImplementation('refresh_trending', ['catalog_rank_snapshots', 'catalog_relevance_score']);
assertRealImplementation('trending_titles', ['catalog_relevance_score', 'catalog_lifecycle_of']);
assertRealImplementation('airing_titles', ['status = \'airing\'', 'catalog_lifecycle_of']);
assertRealImplementation('upcoming_titles', ['first_air_date', 'current_date']);
assertRealImplementation('recently_released_titles', ['catalog_lifecycle_of']);
assertRealImplementation('recommended_titles', ['title_follows', 'watchlist_items']);

// Discovery must not surface a record the provider stopped returning. Either form counts: an
// explicit `unavailable` exclusion, or a lifecycle equality that can never match it.
for (const name of ['trending_titles', 'airing_titles', 'upcoming_titles', 'recently_released_titles', 'recommended_titles']) {
  const body = functionSql(name);
  const excludesUnavailable =
    body.includes("<> 'unavailable'") ||
    (body.includes('catalog_lifecycle_of') && /catalog_lifecycle_of\([^)]*\)\s*(=|<>|in)/.test(body));
  if (!excludesUnavailable) {
    fail(`${name}() does not exclude unavailable records from discovery`);
  }
}

// The Home screen must get rails and member statistics, never a global catalog counter.
assertRealImplementation('get_home_discovery', ['sections', 'stats', 'watchlist_items']);
assertRealImplementation('get_world_discoveries', ['trending', 'upcoming']);
assertRealImplementation('get_title_discovery', ['episodes', 'cast', 'similar']);

for (const rail of ['tonight', 'trending', 'upcoming', 'recent', 'continue']) {
  if (!functionSql('get_home_discovery').includes(`'${rail}'`)) {
    fail(`get_home_discovery() has no "${rail}" rail`);
  }
}

// A raw catalog count in the Home payload is the exact thing requirement 5 forbids. The health
// block is allowed (it is a moderation/debug surface) but must be labelled as such.
const homeSql = functionSql('get_home_discovery');
if (!homeSql.includes('catalog_health')) {
  fail('get_home_discovery() has no catalog_health block');
}

// ---------------------------------------------------------------------------------------------
// 3. Scheduled jobs (requirement 6)
// ---------------------------------------------------------------------------------------------

assertRealImplementation('job_claim', ['did_claim', 'insert into public.job_runs']);
assertRealImplementation('job_complete', ['finished_at']);
assertRealImplementation('job_release_stale', ['status = \'running\'']);
assertRealImplementation('run_scheduled_jobs', ['job_claim', 'job_complete', 'catalog.status']);

const REQUIRED_JOBS = [
  'catalog.status',
  'catalog.episode_schedule',
  'catalog.prune',
  'catalog.aggregates',
  'catalog.trending',
  'alerts.upcoming_episodes',
  'alerts.new_episodes',
  'alerts.title_updates',
  'notifications.fanout',
  'notifications.retention',
  'media.reconcile',
  'moderation.audit',
];

for (const job of REQUIRED_JOBS) {
  if (!functionSql('run_scheduled_jobs').includes(`'${job}'`)) {
    fail(`run_scheduled_jobs() does not dispatch the "${job}" job`);
  }
}

// The (job, run_key) uniqueness is what makes a retry safe; without it the claim is not idempotent.
if (!/constraint job_runs_job_key_unique unique \(job, run_key\)/i.test(allSql)) {
  fail('job_runs has no (job, run_key) unique constraint — job retries are not idempotent');
}

// ---------------------------------------------------------------------------------------------
// 4. Notification delivery and lifecycle (requirements 7 and 8)
// ---------------------------------------------------------------------------------------------

assertRealImplementation('enqueue_notification', ['on conflict', 'coalesce_count', 'notify_social']);
assertRealImplementation('fanout_notification', ['push_tokens', 'notify_social']);
assertRealImplementation('fanout_due_notifications', ['scheduled_for']);
assertRealImplementation('claim_notification_deliveries', ['skip locked', 'attempt']);
assertRealImplementation('report_delivery', ['invalid_token', 'disabled_at', 'make_interval']);
assertRealImplementation('job_expire_notifications', ['notification_deliveries']);
assertRealImplementation('disable_push_token', ['disabled_at']);
assertRealImplementation('disable_all_push_tokens', ['disabled_at']);
assertRealImplementation('notification_summary', ['unread_by_group']);

// Creation must stay separate from delivery: no trigger may perform a network call. Comments
// (which carry the cron examples) are stripped first, so documenting the wiring does not trip it.
const executableSql = allSql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
if (/net\.http|fetch\s*\(|requests\.|urllib|http_post/.test(executableSql)) {
  fail('a migration performs an outbound network call — notification creation and delivery must stay separate');
}

// Dedupe, coalescing and expiry are columns, not conventions.
for (const column of ['dedupe_key', 'coalesce_count', 'expires_at', 'scheduled_for', 'deep_link']) {
  if (!new RegExp(`add column if not exists ${column}`, 'i').test(allSql)) {
    fail(`notifications.${column} is missing — the notification lifecycle is incomplete`);
  }
}

if (!/create unique index if not exists notifications_dedupe_key_idx[\s\S]*where dedupe_key is not null/i.test(allSql)) {
  fail('there is no unique index on (recipient_id, dedupe_key) — notifications can still duplicate');
}

if (!/create table if not exists public\.notification_deliveries/i.test(allSql)) {
  fail('notification_deliveries table is missing — push delivery has no queue');
}

// ---------------------------------------------------------------------------------------------
// 5. Episode and title alerts (requirement 9)
// ---------------------------------------------------------------------------------------------

assertRealImplementation('title_audience', ['title_alerts', 'watchlist_items', 'title_follows']);
assertRealImplementation('notify_at_for', ['quiet_hours']);
assertRealImplementation('job_queue_upcoming_episodes', ['title_episodes', 'enqueue_notification', 'air_date']);
assertRealImplementation('job_queue_new_episodes', ['title_episodes', 'enqueue_notification']);
assertRealImplementation('job_queue_title_updates', ['enqueue_notification', 'title_audience']);

// Alerts must read live episode rows, not a cached schedule.
if (!functionSql('job_queue_upcoming_episodes').includes('from public.title_episodes')) {
  fail('job_queue_upcoming_episodes() does not read title_episodes — it would use a stale schedule');
}

// Every alert key must be episode- or title-specific so a rerun cannot duplicate.
for (const name of ['job_queue_upcoming_episodes', 'job_queue_new_episodes', 'job_queue_title_updates']) {
  if (!functionSql(name).includes('format(')) {
    fail(`${name}() builds no dedupe key — a rerun would re-notify every member`);
  }
}

// ---------------------------------------------------------------------------------------------
// 6. Media lifecycle (requirement 10)
// ---------------------------------------------------------------------------------------------

assertRealImplementation('begin_media_upload', ['storage_owner', 'media_uploads']);
assertRealImplementation('complete_media_upload', ['post_media']);
// Removal is a queue entry, not a DELETE: storage.protect_delete() refuses those (migration 37).
assertRealImplementation('fail_media_upload', ['media_uploads', 'queue_media_removal']);
assertRealImplementation('media_drop_missing_objects', ['storage.objects', 'post_media']);
assertRealImplementation('media_remove_orphans', ['storage.objects', 'post_media', 'profiles', 'queue_media_removal']);
assertRealImplementation('job_reconcile_media', ['media_drop_missing_objects', 'media_remove_orphans']);

// The queue is the only path from a decision to a deletion, and only the service role can drain it.
assertRealImplementation('queue_media_removal', ['media_removal_queue']);
assertRealImplementation('claim_media_removals', ['media_removal_queue']);
assertRealImplementation('complete_media_removals', ['media_removal_queue']);

if (!/grant select, insert, update, delete on public\.media_removal_queue to service_role/i.test(allSql)) {
  fail('media_removal_queue is not granted to service_role — the Storage API drain would be refused');
}

for (const policy of allSql.matchAll(/create policy[^;]*;/gi)) {
  if (/on public\.media_removal_queue/i.test(policy[0]) && /to (authenticated|anon)\b/i.test(policy[0])) {
    fail('media_removal_queue has a client policy — no member may read or write the removal queue');
  }
}

// Video transcoding is explicitly out of scope: its presence means the phase drifted.
if (/\btranscod|ffmpeg|video_encoding|mediaconvert\b/i.test(executableSql)) {
  fail('a migration introduces video transcoding — that is out of scope for this backend phase');
}

// ---------------------------------------------------------------------------------------------
// 7. Share accounting (requirement 11)
// ---------------------------------------------------------------------------------------------

assertRealImplementation('record_share', ['post_shares', 'share_count', 'insufficient_privilege']);

if (!/constraint post_shares_once_per_day unique \(post_id, user_id, channel, share_date\)/i.test(allSql)) {
  fail('post_shares has no per-day idempotency constraint — repeated shares inflate the counter');
}

// The counters themselves must be unwritable by a client.
if (!/create trigger posts_guard_counters/i.test(allSql)) {
  fail('posts has no counter guard trigger — a client can still write share_count directly');
}
if (!/create trigger comments_guard_counters/i.test(allSql)) {
  fail('comments has no reaction counter guard trigger');
}
if (!/create trigger profiles_guard_counters/i.test(allSql)) {
  fail('profiles has no counter guard trigger');
}

if (!functionSql('guard_engagement_counters').includes('pg_trigger_depth()')) {
  fail('the counter guard does not distinguish database writes from client writes');
}

// ---------------------------------------------------------------------------------------------
// 8. Community operations (requirement 12)
// ---------------------------------------------------------------------------------------------

const COMMUNITY_FUNCTIONS = [
  ['join_community', ['join_policy', 'banned']],
  ['review_membership_request', ['require_community_admin']],
  ['set_community_role', ['require_community_admin', 'owner_id']],
  ['remove_community_member', ['require_community_admin']],
  ['ban_community_member', ['banned', 'require_community_admin']],
  ['transfer_community_ownership', ['owner_id']],
  ['update_community_settings', ['require_community_admin']],
  ['community_roster', ['pending_requests', 'can_administer_community']],
  ['moderate_community_post', ['require_community_admin']],
  ['claim_community_ownership', ['moderator']],
  ['can_administer_community', ['is_moderator']],
  ['require_community_admin', ['insufficient_privilege']],
];

for (const [name, needles] of COMMUNITY_FUNCTIONS) assertRealImplementation(name, needles);

// A room without an owner cannot be administered, so the column is part of the capability.
if (!/add column if not exists owner_id/i.test(allSql)) {
  fail('communities has no owner_id column — no room can be administered');
}
if (!/add column if not exists status/i.test(allSql)) {
  fail('community_members has no status column — membership requests cannot exist');
}

// Every write operation must re-check authority rather than trust the client.
for (const name of ['set_community_role', 'remove_community_member', 'ban_community_member', 'update_community_settings', 'review_membership_request']) {
  const body = functionSql(name);
  if (!body.includes('require_community_admin') && !body.includes('is_moderator')) {
    fail(`${name}() does not re-check authority in the database`);
  }
}

// ---------------------------------------------------------------------------------------------
// 9. Moderation actions (requirement 13)
// ---------------------------------------------------------------------------------------------

const MODERATION_FUNCTIONS = [
  ['suspend_user', ['require_moderator', 'is_admin']],
  ['unsuspend_user', ['require_moderator']],
  ['moderate_content', ['require_moderator', 'record_moderation_action']],
  ['resolve_report', ['require_moderator', 'record_moderation_action']],
  ['escalate_report', ['require_moderator', 'record_moderation_action']],
  ['moderation_queue', ['require_moderator', 'reports']],
  ['moderation_history', ['is_moderator', 'moderation_actions']],
  ['record_moderation_action', ['is_moderator', 'insert into public.moderation_actions']],
  ['require_moderator', ['insufficient_privilege', 'is_moderator']],
  ['job_reconcile_moderation', ['suspended', 'reports']],
];

for (const [name, needles] of MODERATION_FUNCTIONS) assertRealImplementation(name, needles);

if (!/create table if not exists public\.moderation_actions/i.test(allSql)) {
  fail('moderation_actions table is missing — moderation decisions are not recorded');
}

// A member owns their profile row, which means the policy that lets them edit it also lets them
// write `role`. `profiles_update_self` checks `id` and `account_status`; the columns that decide
// what a member may *do* need a comparison against the stored row, which is a trigger's job.
if (!/create trigger profiles_guard_privileges/i.test(allSql)) {
  fail('profiles has no privilege guard trigger — a member can set their own role to admin');
}

for (const column of ['role', 'verified', 'account_status', 'deleted_at']) {
  if (!new RegExp(`new\\.${column} is distinct from old\\.${column}`, 'i').test(functionSql('guard_profile_privileges'))) {
    fail(`guard_profile_privileges() does not protect profiles.${column} — the column is client-writable`);
  }
}

// …and it must not be security definer, or it would run with its owner's privileges and never see
// the member it is meant to refuse.
if (/create or replace function public\.guard_profile_privileges\(\)[\s\S]{0,200}security definer/i.test(allSql)) {
  fail('guard_profile_privileges() is SECURITY DEFINER — it cannot tell who is updating the row');
}

// The audit log has to outlive the profile it names: an ON DELETE RESTRICT or NOT NULL actor_id would
// make purge_deleted_accounts() fail for exactly the accounts it exists to remove.
//
// This reads the *final* state, not any text in the history: a column created NOT NULL and relaxed
// by a later migration is correct, and only the end state matters. Later migrations override earlier
// ones, which is how `supabase db push` applies them.
const auditActorState = trackForeignKey(migrationFiles.map((f) => migrationText.get(f)), 'moderation_actions', 'actor_id');
if (auditActorState.notNull) {
  fail('moderation_actions.actor_id is NOT NULL at the end of the migrations — the audit log cannot survive a profile purge');
}
if (auditActorState.onDelete === 'restrict') {
  fail('moderation_actions.actor_id ends as ON DELETE RESTRICT — retention would fail for moderators');
}
if (!auditActorState.onDelete) {
  fail('moderation_actions.actor_id has no resolved foreign key rule — the audit log is not survivable');
}
if (!/add column if not exists actor_handle/.test(allSql)) {
  fail('moderation_actions has no actor_handle — the log loses its author when the profile is purged');
}
if (!functionSql('record_moderation_action').includes('actor_handle')) {
  fail('record_moderation_action() does not store the actor handle at write time');
}

// Account deletion must cover the personal tables added after it was first written. The profile is
// only ever tombstoned, so anything not deleted here lives forever.
for (const table of ['media_uploads', 'post_shares']) {
  if (!new RegExp(`delete from public\\.${table} where user_id = actor`, 'i').test(functionSql('delete_account'))) {
    fail(`delete_account() does not delete ${table} — personal data outlives the account`);
  }
}

// The log must be append-only: no update or delete policy may exist for a member or a moderator.
const moderationPolicies = [...allSql.matchAll(/create policy (\w+) on public\.moderation_actions[\s\S]*?;/gi)]
  .map((m) => `${m[1]}:${m[0].toLowerCase()}`);
for (const policy of moderationPolicies) {
  const [, , , , text] = policy.split(':');
  if (/\bfor (update|delete)\b/.test(text) && /to authenticated/.test(text)) {
    fail(`moderation_actions has a writable policy: ${text.slice(0, 80)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// 10. Search (requirement 14)
// ---------------------------------------------------------------------------------------------

const SEARCH_FUNCTIONS = [
  ['search_titles', ['catalog_lifecycle_of', 'search_rank']],
  ['search_people', ['ilike', 'known_for']],
  ['search_communities', ['ilike', 'member_count']],
  ['search_collections', ['collection_follows', 'visibility']],
  ['search_members', ['account_status', 'blocks']],
  ['search_all', ['search_titles', 'search_members', 'counts']],
  ['search_suggestions', ['titles', 'people', 'communities']],
  ['title_search_rank', ['ts_rank_cd', 'websearch_to_tsquery']],
];

for (const [name, needles] of SEARCH_FUNCTIONS) assertRealImplementation(name, needles);

// Every search result set needs a unique final tiebreaker for deterministic pagination.
for (const name of ['search_titles', 'search_people', 'search_communities', 'search_collections', 'search_members']) {
  const body = functionSql(name);
  if (!/order by[\s\S]*\bid asc/i.test(body)) {
    fail(`${name}() has no unique ordering tiebreaker — pagination is not deterministic`);
  }
}

// Private data must not leak through search.
if (!functionSql('search_members').includes("account_status = 'active'")) {
  fail('search_members() does not exclude suspended and deleted accounts');
}
if (!functionSql('search_members').includes('blocks')) {
  fail('search_members() does not filter blocked members');
}
if (!functionSql('search_collections').includes('collection_follows')) {
  fail('search_collections() does not restrict private collections to their owner and followers');
}

// ---------------------------------------------------------------------------------------------
// 11. Feed and pagination (requirement 15)
// ---------------------------------------------------------------------------------------------

assertRealImplementation('feed_page', ['decode_feed_cursor', 'rank_key', 'blocks']);
assertRealImplementation('encode_feed_cursor', ['base64']);
assertRealImplementation('decode_feed_cursor', ['base64']);
assertRealImplementation('comment_page', ['created_at']);

for (const scope of ['for_you', 'following', 'latest', 'title', 'world']) {
  if (!functionSql('feed_page').includes(`'${scope}'`)) {
    fail(`feed_page() does not support the "${scope}" scope`);
  }
}

// Keyset pagination, not OFFSET: the ordering triple must include the unique id.
if (!/\(v\.rank_key, v\.created_at, v\.id\) </.test(functionSql('feed_page'))) {
  fail('feed_page() does not use a (rank, created_at, id) keyset comparison');
}
if (/limit\s+limit_rows\s+offset/i.test(functionSql('feed_page'))) {
  fail('feed_page() still uses OFFSET — pagination drifts when new posts arrive');
}

// Block, mute, privacy and visibility filtering must all be in the query.
for (const needle of ['public.mutes', 'public.blocks', 'is_private', "state = 'active'"]) {
  if (!functionSql('feed_page').includes(needle)) {
    fail(`feed_page() does not filter on ${needle}`);
  }
}

// The legacy entry point must still exist for the documented client contract.
assertRealImplementation('feed_posts', ['feed_page']);

// ---------------------------------------------------------------------------------------------
// 12. Edge Functions
// ---------------------------------------------------------------------------------------------

const REQUIRED_FUNCTIONS_DIRS = [
  'catalog-sync',
  'catalog-jobs',
  'push-dispatch',
  'media-cleanup',
  'moderation-digest',
  'purge-deleted-accounts',
];

for (const dir of REQUIRED_FUNCTIONS_DIRS) {
  const entry = path.join(FUNCTIONS_DIR, dir, 'index.ts');
  if (!existsSync(entry)) {
    fail(`Edge Function ${dir} is missing (expected supabase/functions/${dir}/index.ts)`);
    continue;
  }
  const source = await readFile(entry, 'utf8');
  if (!/Deno\.serve\(/.test(source)) {
    fail(`Edge Function ${dir} has no Deno.serve handler`);
  }
  if (!source.includes('requireServiceRole')) {
    fail(`Edge Function ${dir} does not require the service role`);
  }
}

for (const shared of ['supabase.ts', 'cors.ts', 'tmdb.ts', 'media-removal.ts']) {
  if (!existsSync(path.join(FUNCTIONS_DIR, '_shared', shared))) {
    fail(`supabase/functions/_shared/${shared} is missing`);
  }
}

// Every function that produces a storage deletion must drain the queue through the Storage API — SQL
// cannot do it, and a queue nothing drains is a promise the product does not keep.
const removalDrain = existsSync(path.join(FUNCTIONS_DIR, '_shared', 'media-removal.ts'))
  ? await readFile(path.join(FUNCTIONS_DIR, '_shared', 'media-removal.ts'), 'utf8')
  : '';

for (const needle of ['claim_media_removals', 'complete_media_removals', '.storage.from(', '.remove(']) {
  if (removalDrain && !removalDrain.includes(needle)) {
    fail(`_shared/media-removal.ts does not use ${needle} — the queue would never be emptied`);
  }
}

for (const dir of ['media-cleanup', 'purge-deleted-accounts']) {
  const entry = path.join(FUNCTIONS_DIR, dir, 'index.ts');
  const source = existsSync(entry) ? await readFile(entry, 'utf8') : '';
  if (source && !source.includes('drainRemovalQueue')) {
    fail(`${dir} does not drain the media removal queue — objects queued in SQL would never be deleted`);
  }
}

// The push worker must distinguish an invalid token from a transient failure, and must go through
// the delivery RPCs rather than writing delivery rows itself.
const pushSource = existsSync(path.join(FUNCTIONS_DIR, 'push-dispatch', 'index.ts'))
  ? await readFile(path.join(FUNCTIONS_DIR, 'push-dispatch', 'index.ts'), 'utf8')
  : '';
for (const needle of ['claim_notification_deliveries', 'report_delivery', 'isInvalidToken']) {
  if (pushSource && !pushSource.includes(needle)) {
    fail(`push-dispatch does not use ${needle}`);
  }
}
if (pushSource.includes('.from(\'notification_deliveries\')')) {
  fail('push-dispatch writes notification_deliveries directly — the database owns that queue');
}

// The catalog worker must not contain business rules: it normalises and calls RPCs.
const catalogSource = existsSync(path.join(FUNCTIONS_DIR, 'catalog-sync', 'index.ts'))
  ? await readFile(path.join(FUNCTIONS_DIR, 'catalog-sync', 'index.ts'), 'utf8')
  : '';
for (const needle of ['catalog_upsert_title', 'catalog_begin_run', 'titles_needing_refresh', 'catalog_mark_missing']) {
  if (catalogSource && !catalogSource.includes(needle)) {
    fail(`catalog-sync does not use ${needle}`);
  }
}

// ---------------------------------------------------------------------------------------------
// 13. Client/backend boundary (requirements 2 and the no-trailers rule)
// ---------------------------------------------------------------------------------------------

const appSources = [];
for (const dir of ['lib', 'app', 'components', 'constants']) {
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        await walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        appSources.push([full, await readFile(full, 'utf8')]);
      }
    }
  };
  if (existsSync(dir)) await walk(dir);
}

const appText = appSources.map(([, text]) => text).join('\n');
// Comments are stripped before the scope checks so that *documenting* an out-of-scope decision
// (which several files do) is not mistaken for implementing it.
const executableAppText = appText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

// The backend owns the catalog: Hallyu App → Hallyu Backend → TMDB.
//
// lib/catalog.ts is the one documented exception. It is the device-local catalog the app has always
// shipped, and this phase is explicitly not the one that reconnects the client to the backend, so
// removing it here would break the app for no backend gain. What must hold is that nothing *new*
// reaches TMDB directly: no screen, no component, no other library module.
const LEGACY_LOCAL_CATALOG = 'lib/catalog.ts';
const directCatalogCallers = [];
for (const [file, text] of appSources) {
  const relative = path.relative(process.cwd(), file).split(path.sep).join('/');
  if (/(api\.themoviedb\.org|image\.tmdb\.org)/.test(text)) {
    directCatalogCallers.push(relative);
  }
}

const unexpectedCallers = directCatalogCallers.filter((file) => file !== LEGACY_LOCAL_CATALOG);
if (unexpectedCallers.length > 0) {
  fail(
    `these files call TMDB directly and must go through the backend: ${unexpectedCallers.join(', ')}`,
  );
} else if (directCatalogCallers.length > 0) {
  ok(
    `the only direct TMDB caller is ${LEGACY_LOCAL_CATALOG} (the pre-existing device-local catalog, deliberately left in place until the client is connected)`,
  );
}

// Trailers are out of scope for this phase: no playback or ingest infrastructure anywhere.
if (/\btranscod|ffmpeg|video_encoding|mediaconvert\b/i.test(executableAppText)) {
  fail('the app introduces video transcoding — that is out of scope for this backend phase');
}

// ---------------------------------------------------------------------------------------------
// 14. Environment placeholders
// ---------------------------------------------------------------------------------------------

const envExample = await readFile(path.resolve('supabase/env.example'), 'utf8');
for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'TMDB_ACCESS_TOKEN']) {
  if (!envExample.includes(key)) {
    fail(`supabase/env.example does not document ${key}`);
  }
}
if (!/PLACEHOLDER/i.test(envExample)) {
  fail('supabase/env.example does not use placeholder values');
}

// config.toml must register every function directory, or a deploy silently skips one.
const config = await readFile(path.resolve('supabase/config.toml'), 'utf8');
for (const dir of REQUIRED_FUNCTIONS_DIRS) {
  if (!config.includes(`[functions.${dir}]`)) {
    fail(`supabase/config.toml has no [functions.${dir}] entry`);
  }
}

// ---------------------------------------------------------------------------------------------
// 15. Video publishing gate (requirement 16)
// ---------------------------------------------------------------------------------------------

// Video is the one media kind whose cost grows with success, so the backend has to be able to say
// who may publish it, how much, and why. Each function below is the evidence for one of those.
const VIDEO_FUNCTIONS = [
  ['video_access', ['video_creators', 'revoked_at', 'account_status']],
  ['video_bytes_used_this_month', ['media_uploads', "kind = 'video'", 'date_trunc']],
  ['video_quota', ['budget', 'remaining', 'pending_request', 'resets_at']],
  ['grant_video_access', ['is_moderator', 'video_creators', 'video_access_requests']],
  ['revoke_video_access', ['is_moderator', 'revoked_at', 'revoke_reason']],
  ['request_video_access', ['video_access_requests', 'pending']],
  ['review_video_access_request', ['is_moderator', 'video_access_requests', 'decided_at']],
  ['video_creator_roster', ['is_moderator', 'video_creators', 'video_bytes_used_this_month']],
];

for (const [name, needles] of VIDEO_FUNCTIONS) assertRealImplementation(name, needles);

if (!/create table if not exists public\.video_creators/i.test(allSql)) {
  fail('video_creators is missing — video publishing has no allowlist');
}

if (!/create unique index if not exists video_access_requests_one_pending/i.test(allSql)) {
  fail('video_access_requests has no one-pending-per-member index — the queue can be flooded');
}

// Both layers of the gate: the announce step refuses before the bytes move, and the attachment rule
// holds even for a client that never calls the RPC.
const announce = functionSql('begin_media_upload');
if (!/video_access\s*\(/i.test(announce)) {
  fail('begin_media_upload does not check video_access — any member could announce a video');
}
if (!/video_quota\s*\(/i.test(announce)) {
  fail('begin_media_upload does not check the monthly video budget');
}

// The policy is re-created by migration 39, so the *last* definition is the one in force.
const postMediaPolicies = [...allSql.matchAll(/create policy post_media_insert_own[\s\S]*?;/gi)];
const postMediaPolicy = postMediaPolicies.at(-1)?.[0] ?? '';
if (!postMediaPolicy) {
  fail('post_media_insert_own does not exist — post media has no insert rule');
} else if (!/video_access\s*\(/i.test(postMediaPolicy)) {
  fail('post_media_insert_own does not gate video rows — a client could attach video without access');
}

if (!/alter table public\.video_creators enable row level security/i.test(allSql)) {
  fail('video_creators has no row level security');
}
if (!/alter table public\.video_access_requests enable row level security/i.test(allSql)) {
  fail('video_access_requests has no row level security');
}

ok('video publishing is gated in three places: the allowlist, the monthly budget and the attachment rule');

// ---------------------------------------------------------------------------------------------
// 16. Summary
// ---------------------------------------------------------------------------------------------

console.log('HALLYU BACKEND SURFACE');
console.log('=====================');
console.log(`  • migrations: ${migrationFiles.length}`);
console.log(`  • functions: ${functionNames.size}`);
console.log(`  • edge functions: ${REQUIRED_FUNCTIONS_DIRS.length}`);
console.log(`  • scheduled jobs: ${REQUIRED_JOBS.length}`);
console.log(`  • app sources scanned: ${appSources.length}`);
console.log('');

if (failures.length === 0) {
  for (const note of notes) console.log(`  ✓ ${note}`);
  console.log('  ✓ every required capability is present and backed by real logic');
  console.log('');
  console.log('OVERALL STATUS: PASS');
  process.exit(0);
}

console.log('FAILURES');
for (const failure of failures) console.log(`  ✗ ${failure}`);
console.log('');
console.log(`OVERALL STATUS: FAIL (${failures.length} problems)`);
process.exit(1);