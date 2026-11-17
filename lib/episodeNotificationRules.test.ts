import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAiredEpisodeNotifications, mergeEpisodeNotifications } from './episodeNotificationRules';
import type { Drama } from './model';

const basePrefs = {
  replies: true,
  likes: true,
  follows: true,
  episodes: true,
  community: true,
  recaps: true,
};

function makeDrama(partial: Partial<Drama> = {}): Drama {
  return {
    id: 'kdrama-1',
    title: 'When Life Gives You Tangerines',
    year: 2025,
    format: 'kdrama',
    mediaType: 'tv',
    region: 'KR',
    originalLanguage: 'ko',
    tone: '#1f2937',
    genres: ['Romance'],
    synopsis: 'Story',
    episodeCount: 16,
    seasons: [{ number: 1, name: 'Season 1', episodeCount: 16 }],
    episodes: [],
    cast: [],
    status: 'airing',
    followerCount: 1200,
    ...partial,
  };
}

test('emits live notification when followed drama episode aired within 48h and not yet watched', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const drama = makeDrama({
    episodes: [
      {
        id: 'ep-5',
        dramaId: 'kdrama-1',
        season: 1,
        number: 5,
        title: 'Winter Tide',
        airDate: '2026-11-17T11:00:00Z',
      },
    ],
  });

  const results = evaluateAiredEpisodeNotifications({
    nowMs: now,
    alreadyNotifiedKeys: new Set(),
    state: {
      prefs: { notifications: basePrefs },
      follows: { dramas: ['kdrama-1'] },
      dramaNotify: {},
      importedDramas: [drama],
      watchlist: {},
      notifications: [],
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].key, 'ep-aired:kdrama-1:1:5');
  assert.equal(results[0].notification.kind, 'episode_live');
  assert.equal(results[0].deepLink, '/episode/kdrama-1/1/5');
});

test('skips already-watched, explicitly opted-out, and previously notified episodes', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const dramaA = makeDrama({
    id: 'd-watched',
    episodes: [{ id: 'e3', dramaId: 'd-watched', season: 1, number: 3, airDate: '2026-11-16T18:00:00Z' }],
  });
  const dramaB = makeDrama({
    id: 'd-opted-out',
    episodes: [{ id: 'e4', dramaId: 'd-opted-out', season: 1, number: 4, airDate: '2026-11-16T18:00:00Z' }],
  });
  const dramaC = makeDrama({
    id: 'd-notified',
    episodes: [{ id: 'e5', dramaId: 'd-notified', season: 1, number: 5, airDate: '2026-11-16T18:00:00Z' }],
  });

  const results = evaluateAiredEpisodeNotifications({
    nowMs: now,
    alreadyNotifiedKeys: new Set(['ep-aired:d-notified:1:5']),
    state: {
      prefs: { notifications: basePrefs },
      follows: { dramas: ['d-watched', 'd-opted-out', 'd-notified'] },
      dramaNotify: { 'd-opted-out': false },
      importedDramas: [dramaA, dramaB, dramaC],
      watchlist: {
        'd-watched': {
          dramaId: 'd-watched',
          status: 'watching',
          currentEpisode: 3,
          season: 1,
          addedAt: '2026-11-10T10:00:00Z',
          updatedAt: '2026-11-16T19:00:00Z',
        },
      },
      notifications: [],
    },
  });

  assert.equal(results.length, 0);
});

test('synthesizes alert from nextEpisodeAt when detailed episode air dates are missing', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const drama = makeDrama({
    id: 'd-thin',
    title: 'Lovely Runner',
    nextEpisodeAt: '2026-11-17T06:00:00Z',
    episodes: [],
  });

  const results = evaluateAiredEpisodeNotifications({
    nowMs: now,
    alreadyNotifiedKeys: new Set(),
    state: {
      prefs: { notifications: basePrefs },
      follows: { dramas: [] },
      dramaNotify: { 'd-thin': true },
      importedDramas: [drama],
      watchlist: {
        'd-thin': {
          dramaId: 'd-thin',
          status: 'watching',
          currentEpisode: 8,
          season: 1,
          addedAt: '2026-11-10T10:00:00Z',
          updatedAt: '2026-11-15T12:00:00Z',
        },
      },
      notifications: [],
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].episode.number, 9);
  assert.equal(results[0].notification.kind, 'episode_aired');
});

test('mergeEpisodeNotifications deduplicates by id and sorts newest first', () => {
  const existing = [
    {
      id: 'ep-aired:d1:1:1',
      group: 'drama' as const,
      kind: 'episode_aired' as const,
      title: 'Old',
      body: 'Body',
      createdAt: '2026-11-16T10:00:00Z',
      read: false,
    },
  ];
  const incoming = [
    { ...existing[0], title: 'Duplicate' },
    {
      id: 'ep-aired:d1:1:2',
      group: 'drama' as const,
      kind: 'episode_live' as const,
      title: 'New',
      body: 'Body 2',
      createdAt: '2026-11-17T10:00:00Z',
      read: false,
    },
  ];
  const merged = mergeEpisodeNotifications(existing, incoming);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'ep-aired:d1:1:2');
});
