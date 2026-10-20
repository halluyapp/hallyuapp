import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

console.log('Verifying Phase 1, Phase 2 & Phase 3 consumer product upgrades...');

// 1. Backend Migration 42 + Database Types Sync
const mig = read('supabase/migrations/20260101124200_42_full_product_polls_dms_ratings_and_filters.sql');
for (const token of [
  'create table if not exists public.post_polls',
  'create table if not exists public.post_poll_votes',
  'create table if not exists public.title_ratings',
  'create table if not exists public.direct_messages',
  'add column if not exists banner_url',
  'create or replace function public.create_post_poll',
  'create or replace function public.vote_post_poll',
  'create or replace function public.rate_title',
  'create or replace function public.send_direct_message',
  'create or replace function public.list_conversations',
  'create or replace function public.list_direct_messages',
  'create or replace function public.discover_catalog',
]) {
  assert(mig.includes(token), `Missing expected backend SQL surface: ${token}`);
}

const dbTypes = read('supabase/types/database.ts');
for (const table of ['post_polls:', 'post_poll_votes:', 'title_ratings:', 'direct_messages:']) {
  assert(dbTypes.includes(table), `Missing typed table in database.ts: ${table}`);
}

// 2. Phase 1 UI/UX surfaces
assert(read('components/ui/Poster.tsx').includes('cinemaGradient'), 'Poster/Backdrop missing cinemaGradient');
assert(read('components/ui/Skeleton.tsx').includes('LinearGradient'), 'Skeleton missing directional shimmer');
assert(read('components/feed/PollBlock.tsx').includes('vote_post_poll') || read('components/feed/PollBlock.tsx').includes('votePoll'), 'PollBlock missing live vote wiring');
assert(read('components/feed/PostCard.tsx').includes('ShareCardModal'), 'PostCard missing ShareCardModal');
assert(read('components/home/UpNextRail.tsx').includes('+1 Ep'), 'UpNextRail missing one-tap +1 Ep action');
assert(read('app/drama/[id].tsx').includes('rateTitleOnServer'), 'Drama hub missing 1-10 community rating sheet');

// 3. Phase 2 UI/UX surfaces
const profileSrc = read('components/profile/ProfileView.tsx');
assert(profileSrc.includes('WATCH DNA'), 'ProfileView missing Watch DNA card');
assert(profileSrc.includes('Top 4 All-Time'), 'ProfileView missing Top 4 showcase');
assert(read('app/edit-profile.tsx').includes('bannerUrl'), 'EditProfile missing custom backdrop picker');
assert(read('app/search.tsx').includes('MULTI-FILTER CATALOG BROWSER'), 'Search missing Multi-Filter Catalog Browser');
assert(read('components/share/ShareCardModal.tsx').includes('sendDirectMessage'), 'ShareCardModal missing 1-tap Send-to-Friend');

// 4. Phase 3 Real-Time Social & Video surfaces
assert(read('app/messages/index.tsx').includes('fetchConversations'), 'Messages Inbox missing conversations loader');
assert(read('app/messages/[handle].tsx').includes('subscribeDirectMessages'), 'DirectMessage thread missing realtime subscription');
assert(read('app/episode/[dramaId]/[season]/[number].tsx').includes('connectLiveEpisodeRoom'), 'EpisodeRoom missing Live Watch Room realtime presence & bursts');
const shortsSrc = read('app/shorts.tsx');
assert(shortsSrc.includes('Scrub video timeline'), 'Shorts missing scrubbable progress bar');
assert(shortsSrc.includes('Comments ·'), 'Shorts missing in-player slide-up comments drawer');

console.log('OVERALL STATUS: PASS (All Phase 1, Phase 2 & Phase 3 surfaces verified)');
