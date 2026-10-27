import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const migration50 = read('supabase/migrations/20260101125000_50_recognition_and_admin_platform.sql');
const dbTypes = read('supabase/types/database.ts');
const modelSrc = read('lib/model.ts');
const recognitionApi = read('lib/api/recognition.ts');
const sealSrc = read('components/recognition/VerificationSeal.tsx');
const crestSrc = read('components/recognition/BadgeCrest.tsx');
const shelfSrc = read('components/recognition/AwardsShelf.tsx');
const adminDashSrc = read('components/admin/AdminDashboard.tsx');

test('1. Pre-launch exclusions, Tonight 9:00 PM WAT launch clock, and synthetic test exclusions hold', () => {
  assert.ok(
    migration50.includes("'2026-10-23 21:00:00+01'::timestamptz"),
    'Launch clock must default to Tonight 9:00 PM Africa/Lagos (2026-10-23 21:00:00+01)',
  );
  assert.ok(
    migration50.includes('set exclude_from_competitions = true') &&
      migration50.includes("lower(handle::text) = 'ceohallyu'"),
    'Pre-launch accounts (@ceohallyu and @darasimi) must be excluded from competition slots',
  );
  assert.ok(
    migration50.includes("'%@example.invalid'"),
    'Synthetic CI/test accounts (*@example.invalid) must be excluded from competition slots',
  );
  assert.ok(
    migration50.includes('auth_created < cfg.launch_starts_at'),
    'Early-member awards must never be issued to accounts created before launch_starts_at',
  );
});

test('2. Concurrency lock, unique serial constraints, and non-reassignment slot retirement hold', () => {
  assert.ok(
    migration50.includes('perform pg_advisory_xact_lock(88421001)'),
    'Early-member slot assignment must serialize concurrent signups with pg_advisory_xact_lock',
  );
  assert.ok(
    migration50.includes('create unique index if not exists user_awards_badge_serial_key'),
    'Numbered slots (#1-#10 and First Arrival #1) must enforce user_awards_badge_serial_key',
  );
  assert.ok(
    /where\s+ua\.badge_id\s*=\s*'founding_ten'\s+and\s+ua\.serial_number\s*=\s*s/.test(migration50),
    'Founding Ten serial selection must check ALL rows (active + retired) so revoked slots never silently renumber existing members',
  );
  assert.ok(
    migration50.includes('case when coalesce(p_release_slot, false) then null else serial_number end'),
    'admin_revoke_badge must retire numbered slots by default unless slot release is explicitly requested and audited',
  );
});

test('3. Privilege escalation triggers, anti-spam rules, and audit immutability hold', () => {
  assert.ok(
    migration50.includes('create or replace function public.guard_profile_privileges()'),
    'guard_profile_privileges() must block self-service tampering of role, verification_tier, verified, and founder flags',
  );
  assert.ok(
    migration50.includes('create trigger recognition_audit_immutable_trg'),
    'recognition_audit_log must reject UPDATE and DELETE at the database trigger layer',
  );
  assert.ok(
    migration50.includes('char_length(btrim(c.body)) >= 15') &&
      migration50.includes('char_length(btrim(p.body)) >= 20'),
    'Achievement evaluator must ignore short spam posts/replies and deleted content',
  );
  assert.ok(
    migration50.includes("p_dedupe_key := 'award:' || p_badge_id || ':' || p_user_id::text"),
    'Award notifications must use deterministic per-user/per-badge deduplication keys',
  );
  assert.ok(
    !migration50.toLowerCase().includes('drama_of_the_month'),
    'Drama of the Month and voting features must remain out of scope in Phase 1',
  );
});

test('4. Separate 2-Tier Verification (Blue vs Red) & bespoke vector SVG crests hold across Web & Android', () => {
  assert.ok(modelSrc.includes("export type VerificationTier = 'none' | 'blue' | 'red';"));
  assert.ok(sealSrc.includes("from 'react-native-svg'"), 'VerificationSeal must render vector SVG');
  assert.ok(sealSrc.includes('Official Hallyu Authority'), 'Red verification seal must define Official Hallyu Authority');
  assert.ok(sealSrc.includes('Authentic Verified Account'), 'Blue verification seal must define Authentic Verified Account');

  assert.ok(crestSrc.includes("from 'react-native-svg'"), 'BadgeCrest must render vector SVG medallions');
  for (const key of [
    'founder_seal',
    'first_arrival',
    'founding_ten',
    'founding_member',
    'day_one',
    'world_passport',
    'premiere_night',
    'watchlist_curator',
    'season_finisher',
    'first_voice',
    'scene_critic',
    'pulse_maker',
    'circle_member',
    'rising_voice',
    'community_pillar',
  ]) {
    assert.ok(crestSrc.includes(`case '${key}':`), `Missing custom vector crest artwork for ${key}`);
  }
  assert.ok(shelfSrc.includes('setFeaturedBadgesOnServer'), 'Profile AwardsShelf must persist pinned showcase badges');
});

test('5. Commercial Admin Console covers all required operational domains and matches typed DB contract', () => {
  for (const rpc of [
    'get_user_recognition',
    'sync_my_recognition',
    'set_featured_badges',
    'submit_verification_request',
    'my_verification_status',
    'admin_dashboard_metrics',
    'admin_search_users',
    'admin_set_verification',
    'admin_list_verification_requests',
    'admin_review_verification_request',
    'admin_grant_badge',
    'admin_revoke_badge',
    'admin_upsert_badge_definition',
    'admin_update_recognition_config',
    'admin_manage_user_account',
    'admin_list_audit_log',
  ]) {
    assert.ok(dbTypes.includes(`${rpc}:`), `Missing typed RPC in database.ts: ${rpc}`);
    assert.ok(recognitionApi.includes(rpc), `Missing client API binding in lib/api/recognition.ts: ${rpc}`);
  }

  for (const section of [
    'overview',
    'launch',
    'users',
    'verification',
    'badges',
    'broadcast',
    'support',
    'creators',
    'reports',
    'communities',
    'audit',
  ]) {
    assert.ok(adminDashSrc.includes(`section === '${section}'`), `Missing AdminDashboard section view: ${section}`);
  }
});
