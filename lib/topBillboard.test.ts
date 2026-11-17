import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTopBillboard, formatBillboardUpdatedAt } from './topBillboard';
import { emptyReactions, type Drama, type FandomId, type Post, type WatchlistItem } from './model';

function drama(id: string, format: FandomId, extra: Partial<Drama> = {}): Drama {
  return {
    id,
    title: `Title ${id}`,
    year: 2026,
    format: format === 'hollywood' ? 'hollywood-movie' : format,
    mediaType: format === 'hollywood' ? 'movie' : 'tv',
    region: format === 'kdrama' ? 'KR' : format === 'cdrama' ? 'CN' : format === 'anime' ? 'JP' : 'US',
    originalLanguage: format === 'kdrama' ? 'ko' : format === 'cdrama' ? 'zh' : format === 'anime' ? 'ja' : 'en',
    tone: '#18181b',
    genres: format === 'anime' ? ['Animation', 'Action'] : ['Drama'],
    synopsis: 'Synopsis',
    episodeCount: 12,
    seasons: [{ number: 1, name: 'S1', episodeCount: 12 }],
    episodes: [],
    cast: [],
    status: 'airing',
    rating: 8.5,
    followerCount: 100,
    ...extra,
  };
}

test('computeTopBillboard ranks #1-#10 combining TMDB trending, active watchers, and recent posts', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const k1 = drama('k1', 'kdrama', { followerCount: 5000, rating: 9.2 });
  const k2 = drama('k2', 'kdrama', { followerCount: 200, rating: 7.5, status: 'completed' });
  const c1 = drama('c1', 'cdrama', { followerCount: 3000, rating: 8.8 });
  const a1 = drama('a1', 'anime', { followerCount: 4000, rating: 9.0 });
  const h1 = drama('h1', 'hollywood', { followerCount: 2500, rating: 8.1 });

  const watchlist: Record<string, WatchlistItem> = {
    k1: {
      dramaId: 'k1',
      status: 'watching',
      currentEpisode: 4,
      season: 1,
      addedAt: '2026-11-10T10:00:00Z',
      updatedAt: '2026-11-17T11:00:00Z',
    },
  };
  const posts: Post[] = [
    {
      id: 'p1',
      authorId: 'u1',
      type: 'review',
      context: { dramaId: 'k1' },
      body: 'Amazing episode',
      hashtags: [],
      mentions: [],
      reactions: { ...emptyReactions(), loved: 1 },
      commentCount: 0,
      saveCount: 0,
      shareCount: 0,
      spoiler: 'none',
      createdAt: '2026-11-17T10:00:00Z',
    },
  ];

  const entries = computeTopBillboard({
    trending: [k1, a1, c1, h1, k2],
    airing: [k1],
    posts,
    watchlist,
    category: 'all',
    nowMs: now,
  });

  assert.equal(entries.length, 5);
  assert.equal(entries[0].rank, 1);
  assert.equal(entries[0].drama.id, 'k1');
  assert.ok(entries[0].watchersCount > k1.followerCount);
  assert.equal(entries[0].isLiveAiring, true);
});

test('computeTopBillboard filters strictly per world and caps at 10', () => {
  const manyK = Array.from({ length: 14 }, (_, i) =>
    drama(`kd-${i}`, 'kdrama', { followerCount: 1000 - i * 10 }),
  );
  const c1 = drama('cd-1', 'cdrama');

  const kdramas = computeTopBillboard({
    trending: [c1, ...manyK],
    byWorld: { kdrama: manyK, cdrama: [c1] },
    category: 'kdrama',
    limit: 10,
  });

  assert.equal(kdramas.length, 10);
  assert.ok(kdramas.every((e) => e.world === 'kdrama'));
  assert.deepEqual(
    kdramas.map((e) => e.rank),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
});

test('computeTopBillboard ensures all represented worlds appear on the All Worlds Top 10 podium', () => {
  const manyK = Array.from({ length: 12 }, (_, i) => drama(`k-${i}`, 'kdrama', { rating: 9.5 }));
  const cTop = drama('c-top', 'cdrama', { rating: 6.0, followerCount: 20, status: 'completed' });
  const aTop = drama('a-top', 'anime', { rating: 6.0, followerCount: 20, status: 'completed' });
  const hTop = drama('h-top', 'hollywood', { rating: 6.0, followerCount: 20, status: 'completed' });

  const entries = computeTopBillboard({
    trending: manyK,
    byWorld: { kdrama: manyK, cdrama: [cTop], anime: [aTop], hollywood: [hTop] },
    category: 'all',
    limit: 10,
  });

  const worlds = new Set(entries.map((e) => e.world));
  assert.equal(entries.length, 10);
  assert.ok(worlds.has('kdrama'));
  assert.ok(worlds.has('cdrama'));
  assert.ok(worlds.has('anime'));
  assert.ok(worlds.has('hollywood'));
});

test('formatBillboardUpdatedAt formats elapsed times clearly', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatBillboardUpdatedAt(null, now), 'Live catalog syncing…');
  assert.equal(formatBillboardUpdatedAt(now - 5_000, now), 'Updated just now');
  assert.equal(formatBillboardUpdatedAt(now - 30_000, now), 'Updated 30s ago');
  assert.equal(formatBillboardUpdatedAt(now - 180_000, now), 'Updated 3m ago');
});
